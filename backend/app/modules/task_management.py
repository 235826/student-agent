import calendar
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.schemas import TaskInput, TaskOut
from app.db.models import (
    Tag,
    Task,
    TaskAttachment,
    TaskDependency,
    TaskList,
    TaskTag,
    User,
    WorkLog,
    now_ms,
)
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
    data["tags"] = list(
        db.scalars(
            select(Tag.name)
            .join(TaskTag, TaskTag.tag_id == Tag.id)
            .where(TaskTag.task_id == task.id)
            .order_by(Tag.name)
        )
    )
    data["blocked_by"] = []
    data["blocked_by_ids"] = []
    for task_id in predecessors:
        predecessor = db.get(Task, task_id)
        if predecessor and (predecessor.trashed_at is not None or predecessor.status != "done"):
            state = (
                "已删除"
                if predecessor.trashed_at is not None
                else ("已取消" if predecessor.status == "cancelled" else "尚未完成")
            )
            data["blocked_by"].append(f"{predecessor.title}（{state}）")
            data["blocked_by_ids"].append(task_id)
    return TaskOut.model_validate(data)


def task_input(db: Session, task: Task) -> TaskInput:
    view = task_view(db, task)
    return TaskInput.model_validate({k: getattr(view, k) for k in TaskInput.model_fields})


def validate_links(
    db: Session, user: User, body: TaskInput, task: Task | None = None, *, restoring: bool = False
) -> None:
    task_id = task.id if task else ""
    if body.list_id:
        owned(db, TaskList, body.list_id, user)
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


def sync_tags(db: Session, user: User, task: Task, names: list[str]) -> None:
    db.execute(delete(TaskTag).where(TaskTag.task_id == task.id))
    seen: set[str] = set()
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        tag = db.scalar(select(Tag).where(Tag.workspace_id == user.workspace_id, Tag.name == name))
        if tag is None:
            tag = Tag(workspace_id=user.workspace_id, name=name)
            db.add(tag)
            db.flush()
        db.add(TaskTag(workspace_id=user.workspace_id, task_id=task.id, tag_id=tag.id))


def add_recurrence(local: datetime, recurrence: str, step: int) -> datetime:
    if recurrence == "daily":
        target = local.date() + timedelta(days=step)
    elif recurrence == "weekly":
        target = local.date() + timedelta(days=7 * step)
    elif recurrence == "monthly":
        total = local.month - 1 + step
        year = local.year + total // 12
        month = total % 12 + 1
        day = min(local.day, calendar.monthrange(year, month)[1])
        target = local.date().replace(year=year, month=month, day=day)
    elif recurrence == "yearly":
        year = local.year + step
        day = min(local.day, calendar.monthrange(year, local.month)[1])
        target = local.date().replace(year=year, day=day)
    elif recurrence == "weekdays":
        target = local.date()
        remaining = step
        while remaining:
            target += timedelta(days=1)
            if target.weekday() < 5:
                remaining -= 1
    else:
        raise ValueError("unsupported recurrence")
    return local.replace(year=target.year, month=target.month, day=target.day)


def next_deadline_ms(
    deadline_ms: int,
    recurrence: str,
    interval: int,
    from_completion: bool,
    after_ms: int,
    until_ms: int | None,
    user: User,
) -> int | None:
    zone = ZoneInfo(user.timezone)
    original = datetime.fromtimestamp(deadline_ms / 1000, zone)
    if from_completion:
        completed = datetime.fromtimestamp(after_ms / 1000, zone)
        base = completed.replace(
            hour=original.hour,
            minute=original.minute,
            second=original.second,
            microsecond=original.microsecond,
        )
    else:
        base = original
    step = 1
    while step <= 10000:
        candidate = add_recurrence(
            base,
            recurrence,
            step if recurrence == "weekdays" else step * interval,
        )
        candidate_ms = int(candidate.timestamp() * 1000)
        if candidate_ms > after_ms:
            if until_ms is not None and candidate_ms > until_ms:
                return None
            return candidate_ms
        step += 1
    return None


def next_task_values(db: Session, user: User, task: Task, after_ms: int) -> dict[str, Any] | None:
    if not task.recurrence or task.deadline_at is None:
        return None
    if task.recurrence_remaining is not None and task.recurrence_remaining <= 0:
        return None
    deadline = next_deadline_ms(
        task.deadline_at,
        task.recurrence,
        task.recurrence_interval or 1,
        task.recurrence_from_completion,
        after_ms,
        task.recurrence_until,
        user,
    )
    if deadline is None:
        return None
    parent_id = task.parent_id
    if parent_id:
        parent = db.get(Task, parent_id)
        if parent is None or parent.trashed_at is not None or parent.status == "cancelled":
            parent_id = None
    return {
        "title": task.title,
        "description": task.description,
        "links": task.links,
        "priority": task.priority,
        "flagged": task.flagged,
        "deadline_at": deadline,
        "deadline_all_day": task.deadline_all_day,
        "remind_at": (
            deadline + (task.remind_at - task.deadline_at)
            if task.remind_at is not None and task.deadline_at is not None
            else None
        ),
        "estimate_minutes": task.estimate_minutes,
        "task_type": task.task_type,
        "recurrence": task.recurrence,
        "recurrence_interval": task.recurrence_interval,
        "recurrence_from_completion": task.recurrence_from_completion,
        "recurrence_until": task.recurrence_until,
        "recurrence_remaining": (
            task.recurrence_remaining - 1 if task.recurrence_remaining is not None else None
        ),
        "list_id": task.list_id,
        "parent_id": parent_id,
        "parallel_policy": task.parallel_policy,
    }


def generate_next_occurrence(db: Session, user: User, task: Task) -> Task | None:
    values = next_task_values(db, user, task, task.completed_at or now_ms())
    if values is None:
        return None
    last_order = db.scalar(
        select(Task.sort_order)
        .where(Task.workspace_id == user.workspace_id)
        .order_by(Task.sort_order.desc())
        .limit(1)
    )
    subtask_order = 0
    if values["parent_id"]:
        last_subtask = db.scalar(
            select(Task.subtask_order)
            .where(
                Task.workspace_id == user.workspace_id,
                Task.parent_id == values["parent_id"],
            )
            .order_by(Task.subtask_order.desc())
            .limit(1)
        )
        subtask_order = (last_subtask or 0) + 1
    next_task = Task(
        workspace_id=user.workspace_id,
        status="todo",
        recurrence_parent_id=task.id,
        sort_order=(last_order or 0) + 1,
        subtask_order=subtask_order,
        **values,
    )
    db.add(next_task)
    db.flush()
    tag_names = list(
        db.scalars(
            select(Tag.name)
            .join(TaskTag, TaskTag.tag_id == Tag.id)
            .where(TaskTag.task_id == task.id)
            .order_by(Tag.name)
        )
    )
    sync_tags(db, user, next_task, tag_names)
    db.flush()
    return next_task


def remove_generated_next(db: Session, user: User, task: Task, completed_at: int | None) -> None:
    if not task.recurrence or task.deadline_at is None:
        return
    candidate = db.scalar(
        select(Task)
        .where(Task.recurrence_parent_id == task.id)
        .order_by(Task.created_at.desc(), Task.id)
        .limit(1)
    )
    if candidate is None or candidate.status != "todo" or candidate.trashed_at is not None:
        return
    expected = next_task_values(db, user, task, completed_at or task.completed_at or now_ms())
    if expected is None:
        return
    if any(getattr(candidate, key) != value for key, value in expected.items()):
        return
    source_tags = list(
        db.scalars(
            select(Tag.name)
            .join(TaskTag, TaskTag.tag_id == Tag.id)
            .where(TaskTag.task_id == task.id)
            .order_by(Tag.name)
        )
    )
    candidate_tags = list(
        db.scalars(
            select(Tag.name)
            .join(TaskTag, TaskTag.tag_id == Tag.id)
            .where(TaskTag.task_id == candidate.id)
            .order_by(Tag.name)
        )
    )
    if source_tags != candidate_tags:
        return
    has_relations = any(
        db.scalar(select(model.id).where(condition).limit(1))
        for model, condition in (
            (Task, Task.parent_id == candidate.id),
            (Task, Task.recurrence_parent_id == candidate.id),
            (TaskAttachment, TaskAttachment.task_id == candidate.id),
            (TaskDependency, TaskDependency.predecessor_task_id == candidate.id),
            (TaskDependency, TaskDependency.successor_task_id == candidate.id),
            (WorkLog, WorkLog.task_id == candidate.id),
        )
    )
    if has_relations:
        candidate.trashed_at = now_ms()
    else:
        db.execute(delete(TaskTag).where(TaskTag.task_id == candidate.id))
        db.delete(candidate)
    db.flush()


def apply_task(db: Session, user: User, body: TaskInput, task: Task | None = None) -> Task:
    if body.recurrence and not body.deadline_at:
        raise HTTPException(422, "重复任务需要设置截止时间")
    validate_links(db, user, body, task)
    if task and body.status == "cancelled" and task.status != "cancelled":
        require_impact_confirmation(db, task, body.confirm_impact)
    data = body.model_dump(exclude={"predecessor_ids", "confirm_impact", "tags"})
    data["deadline_at"] = int(body.deadline_at.timestamp() * 1000) if body.deadline_at else None
    data["remind_at"] = int(body.remind_at.timestamp() * 1000) if body.remind_at else None
    data["recurrence_until"] = (
        int(body.recurrence_until.timestamp() * 1000) if body.recurrence_until else None
    )
    if not body.deadline_at:
        data["deadline_all_day"] = False
    if not body.recurrence:
        data["recurrence_interval"] = 1
        data["recurrence_from_completion"] = False
        data["recurrence_until"] = None
        data["recurrence_remaining"] = None
    previous_status: str | None = None
    previous_completed_at: int | None = None
    became_done = False
    if task is None:
        task = Task(workspace_id=user.workspace_id, **data)
        last_order = db.scalar(
            select(Task.sort_order)
            .where(Task.workspace_id == user.workspace_id)
            .order_by(Task.sort_order.desc())
            .limit(1)
        )
        task.sort_order = (last_order or 0) + 1
        if body.parent_id:
            last_subtask = db.scalar(
                select(Task.subtask_order)
                .where(
                    Task.workspace_id == user.workspace_id,
                    Task.parent_id == body.parent_id,
                )
                .order_by(Task.subtask_order.desc())
                .limit(1)
            )
            task.subtask_order = (last_subtask or 0) + 1
        if body.status == "done":
            task.completed_at = now_ms()
            became_done = True
        db.add(task)
    else:
        previous_status = task.status
        previous_completed_at = task.completed_at
        if task.parallel_policy != body.parallel_policy:
            task.policy_revision += 1
        for key, value in data.items():
            setattr(task, key, value)
        if body.status == "done" and previous_status != "done":
            task.completed_at = now_ms()
            became_done = True
        elif body.status != "done":
            task.completed_at = None
    db.flush()
    sync_tags(db, user, task, body.tags)
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
    if became_done and task.recurrence:
        generate_next_occurrence(db, user, task)
    if previous_status == "done" and body.status != "done" and task.recurrence:
        remove_generated_next(db, user, task, previous_completed_at)
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
