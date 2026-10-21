from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.schemas import TaskInput, TaskOut
from app.db.models import Task, TaskDependency, User
from app.modules.records import owned


def graph(db: Session, user: User) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for edge in db.scalars(
        select(TaskDependency).where(TaskDependency.workspace_id == user.workspace_id)
    ):
        result.setdefault(edge.predecessor_task_id, []).append(edge.successor_task_id)
    return result


def path_between(edges: dict[str, list[str]], start: str, end: str) -> list[str] | None:
    stack = [(start, [start])]
    visited: set[str] = set()
    while stack:
        current, path = stack.pop()
        if current == end:
            return path
        if current in visited:
            continue
        visited.add(current)
        stack.extend((n, [*path, n]) for n in edges.get(current, []))
    return None


def task_view(db: Session, task: Task) -> TaskOut:
    data: dict[str, Any] = {c.name: getattr(task, c.name) for c in Task.__table__.columns}
    data = {k: v for k, v in data.items() if k in TaskOut.model_fields}
    predecessors = list(
        db.scalars(
            select(TaskDependency.predecessor_task_id).where(
                TaskDependency.successor_task_id == task.id
            )
        )
    )
    data["predecessor_ids"] = predecessors
    data["dependent_ids"] = list(
        db.scalars(
            select(TaskDependency.successor_task_id).where(
                TaskDependency.predecessor_task_id == task.id
            )
        )
    )
    data["child_ids"] = list(db.scalars(select(Task.id).where(Task.parent_id == task.id)))
    data["blocked_by"] = []
    for task_id in predecessors:
        predecessor = db.get(Task, task_id)
        if predecessor and (predecessor.trashed_at is not None or predecessor.status != "done"):
            state = (
                "已删除"
                if predecessor.trashed_at is not None
                else ("已取消" if predecessor.status == "cancelled" else "尚未完成")
            )
            data["blocked_by"].append(f"{predecessor.title}（{state}）")
    return TaskOut.model_validate(data)


def validate_links(
    db: Session, user: User, body: TaskInput, task: Task | None = None, *, restoring: bool = False
) -> None:
    task_id = task.id if task else ""
    if body.parent_id:
        parent = owned(db, Task, body.parent_id, user)
        if parent.trashed_at is not None or parent.status == "cancelled":
            raise HTTPException(409, "父任务已删除或取消，请先恢复或解除关联")
        chain = [task_id] if task_id else []
        current: Task | None = parent
        while current:
            if current.id in chain:
                raise HTTPException(409, "父子任务形成循环：" + " → ".join([*chain, current.id]))
            chain.append(current.id)
            current = db.get(Task, current.parent_id) if current.parent_id else None
    if len(set(body.predecessor_ids)) != len(body.predecessor_ids):
        raise HTTPException(422, "前置任务不能重复")
    edges = graph(db, user)
    for predecessor_id in body.predecessor_ids:
        predecessor = owned(db, Task, predecessor_id, user)
        # Existing unavailable edges may be retained during unrelated editing, but not newly added.
        existing = task and db.scalar(
            select(TaskDependency.id).where(
                TaskDependency.predecessor_task_id == predecessor_id,
                TaskDependency.successor_task_id == task_id,
            )
        )
        if (restoring or not existing) and (
            predecessor.trashed_at is not None or predecessor.status == "cancelled"
        ):
            raise HTTPException(409, f"前置任务“{predecessor.title}”已删除或取消，请先恢复")
        cycle = path_between(edges, task_id, predecessor_id) if task_id else None
        if cycle:
            labels = [item.title for i in cycle if (item := db.get(Task, i)) is not None]
            raise HTTPException(409, "依赖形成循环：" + " → ".join([*labels, labels[0]]))
        if (
            body.status in {"in_progress", "done"}
            and (task is None or body.status != task.status or not existing)
            and (predecessor.status != "done" or predecessor.trashed_at is not None)
        ):
            raise HTTPException(409, f"请先完成前置任务“{predecessor.title}”")


def apply_task(db: Session, user: User, body: TaskInput, task: Task | None = None) -> Task:
    validate_links(db, user, body, task)
    if task and body.status == "cancelled" and task.status != "cancelled":
        require_impact_confirmation(db, task, body.confirm_impact)
    data = body.model_dump(exclude={"predecessor_ids", "confirm_impact"})
    if body.deadline_at:
        data["deadline_at"] = int(body.deadline_at.timestamp() * 1000)
    if task is None:
        task = Task(workspace_id=user.workspace_id, **data)
        db.add(task)
    else:
        if task.parallel_policy != body.parallel_policy:
            task.policy_revision += 1
        for key, value in data.items():
            setattr(task, key, value)
    db.flush()
    db.execute(delete(TaskDependency).where(TaskDependency.successor_task_id == task.id))
    for predecessor_id in body.predecessor_ids:
        db.add(
            TaskDependency(
                workspace_id=user.workspace_id,
                predecessor_task_id=predecessor_id,
                successor_task_id=task.id,
            )
        )
    db.flush()
    return task


def require_impact_confirmation(db: Session, task: Task, confirmed: bool) -> None:
    children = list(
        db.scalars(select(Task.title).where(Task.parent_id == task.id, Task.trashed_at.is_(None)))
    )
    dependents = list(
        db.scalars(
            select(Task.title)
            .join(TaskDependency, TaskDependency.successor_task_id == Task.id)
            .where(TaskDependency.predecessor_task_id == task.id, Task.trashed_at.is_(None))
        )
    )
    if (children or dependents) and not confirmed:
        raise HTTPException(
            409,
            "此操作影响关联任务："
            + "、".join(children + dependents)
            + "。子任务和依赖将保留，后续任务可能被阻塞，请明确确认。",
        )
