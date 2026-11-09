from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import ValidationError
from sqlalchemy import String, and_, cast, delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.api.schemas import (
    ActivityFeedbackInput,
    ActivityFeedbackOut,
    CompatibilityInput,
    CompatibilityOut,
    CompletionDay,
    CompletionStatsOut,
    ConfirmInput,
    CourseInput,
    CourseOut,
    DeadlineInput,
    DraftInput,
    DraftOut,
    DraftUpdate,
    EventOut,
    EventPolicyInput,
    FlagInput,
    PlanMoveInput,
    PolicyInput,
    PublishInput,
    PurgeOut,
    ReminderInput,
    RuleInput,
    RuleOut,
    SavedFilterInput,
    SavedFilterOut,
    SeriesEdit,
    SeriesInput,
    SeriesOut,
    SkipInput,
    Status,
    TagInput,
    TagOut,
    TaskInput,
    TaskListGroupInput,
    TaskListGroupOut,
    TaskListInput,
    TaskListOrderInput,
    TaskListOut,
    TaskOrderInput,
    TaskOut,
    TaskSummaryOut,
    TaskTitlesInput,
    TaskView,
    TypePolicyInput,
    TypePolicyOut,
    WorkLogContextInput,
    WorkLogContextOut,
    WorkLogInput,
    WorkLogOut,
    WorkLogUpdate,
)
from app.db.models import (
    ActivityFeedback,
    Audit,
    CompatibilityRule,
    Course,
    Draft,
    Event,
    EventOverride,
    EventSeries,
    Plan,
    SavedFilter,
    Tag,
    Task,
    TaskAttachment,
    TaskList,
    TaskListGroup,
    TaskTag,
    TaskTypePolicy,
    User,
    WorkLog,
    WorkLogContext,
    Workspace,
    now_ms,
)
from app.modules.calendar_management import (
    create_series,
    event_view,
    instance_override,
    series_view,
    unambiguous_instant,
)
from app.modules.compatibility import check_compatibility, prepare_rule, rule_view
from app.modules.idempotency import remember, replay
from app.modules.records import owned, record_change, remove_record
from app.modules.security import DB, UserDep
from app.modules.task_management import (
    apply_task,
    generate_next_occurrence,
    require_impact_confirmation,
    task_input,
    task_view,
    validate_links,
)
from app.modules.trash import (
    TRASH_RETENTION_MS,
    purge_old_trash,
    purge_tasks,
    unlink_paths,
)

router = APIRouter(prefix="/api/v1")


@router.get("/task-list-groups", response_model=list[TaskListGroupOut])
def list_task_list_groups(db: DB, user: UserDep) -> list[TaskListGroup]:
    return list(
        db.scalars(
            select(TaskListGroup)
            .where(TaskListGroup.workspace_id == user.workspace_id)
            .order_by(
                TaskListGroup.sort_order,
                TaskListGroup.created_at,
                TaskListGroup.id,
            )
        )
    )


@router.post("/task-list-groups", response_model=TaskListGroupOut, status_code=201)
def create_task_list_group(body: TaskListGroupInput, db: DB, user: UserDep) -> TaskListGroup:
    duplicate = db.scalar(
        select(TaskListGroup.id).where(
            TaskListGroup.workspace_id == user.workspace_id,
            TaskListGroup.name == body.name,
        )
    )
    if duplicate:
        raise HTTPException(409, "文件夹名称已存在")
    last_order = db.scalar(
        select(TaskListGroup.sort_order)
        .where(TaskListGroup.workspace_id == user.workspace_id)
        .order_by(TaskListGroup.sort_order.desc())
        .limit(1)
    )
    group = TaskListGroup(
        workspace_id=user.workspace_id,
        name=body.name,
        sort_order=(last_order or 0) + 1,
    )
    db.add(group)
    record_change(db, user, "task_list_group.create", group)
    return group


@router.put("/task-list-groups/{group_id}", response_model=TaskListGroupOut)
def update_task_list_group(
    group_id: str, body: TaskListGroupInput, db: DB, user: UserDep
) -> TaskListGroup:
    group = owned(db, TaskListGroup, group_id, user)
    duplicate = db.scalar(
        select(TaskListGroup.id).where(
            TaskListGroup.workspace_id == user.workspace_id,
            TaskListGroup.name == body.name,
            TaskListGroup.id != group_id,
        )
    )
    if duplicate:
        raise HTTPException(409, "文件夹名称已存在")
    group.name = body.name
    record_change(db, user, "task_list_group.update", group)
    return group


@router.delete("/task-list-groups/{group_id}", status_code=204)
def delete_task_list_group(group_id: str, db: DB, user: UserDep) -> None:
    group = owned(db, TaskListGroup, group_id, user)
    db.execute(update(TaskList).where(TaskList.group_id == group_id).values(group_id=None))
    remove_record(db, user, "task_list_group.delete", group)


@router.get("/saved-filters", response_model=list[SavedFilterOut])
def list_saved_filters(db: DB, user: UserDep) -> list[SavedFilter]:
    return list(
        db.scalars(
            select(SavedFilter)
            .where(SavedFilter.workspace_id == user.workspace_id)
            .order_by(SavedFilter.created_at, SavedFilter.id)
        )
    )


@router.post("/saved-filters", response_model=SavedFilterOut, status_code=201)
def create_saved_filter(body: SavedFilterInput, db: DB, user: UserDep) -> SavedFilter:
    duplicate = db.scalar(
        select(SavedFilter.id).where(
            SavedFilter.workspace_id == user.workspace_id,
            SavedFilter.name == body.name,
        )
    )
    if duplicate:
        raise HTTPException(409, "筛选名称已存在")
    saved = SavedFilter(
        workspace_id=user.workspace_id,
        name=body.name,
        payload=body.payload.model_dump(),
    )
    db.add(saved)
    record_change(db, user, "saved_filter.create", saved, scheduling=False)
    return saved


@router.put("/saved-filters/{filter_id}", response_model=SavedFilterOut)
def update_saved_filter(
    filter_id: str, body: SavedFilterInput, db: DB, user: UserDep
) -> SavedFilter:
    saved = owned(db, SavedFilter, filter_id, user)
    duplicate = db.scalar(
        select(SavedFilter.id).where(
            SavedFilter.workspace_id == user.workspace_id,
            SavedFilter.name == body.name,
            SavedFilter.id != filter_id,
        )
    )
    if duplicate:
        raise HTTPException(409, "筛选名称已存在")
    saved.name = body.name
    saved.payload = body.payload.model_dump()
    record_change(db, user, "saved_filter.update", saved, scheduling=False)
    return saved


@router.delete("/saved-filters/{filter_id}", status_code=204)
def delete_saved_filter(filter_id: str, db: DB, user: UserDep) -> None:
    saved = owned(db, SavedFilter, filter_id, user)
    db.delete(saved)
    db.add(
        Audit(
            workspace_id=user.workspace_id,
            action="saved_filter.delete",
            object_id=filter_id,
        )
    )
    db.commit()


@router.get("/task-lists", response_model=list[TaskListOut])
def list_task_lists(db: DB, user: UserDep) -> list[TaskList]:
    return list(
        db.scalars(
            select(TaskList)
            .where(TaskList.workspace_id == user.workspace_id)
            .order_by(TaskList.sort_order, TaskList.created_at, TaskList.id)
        )
    )


@router.post("/task-lists", response_model=TaskListOut, status_code=201)
def create_task_list(body: TaskListInput, db: DB, user: UserDep) -> TaskList:
    duplicate = db.scalar(
        select(TaskList.id).where(
            TaskList.workspace_id == user.workspace_id, TaskList.name == body.name
        )
    )
    if duplicate:
        raise HTTPException(409, "清单名称已存在")
    if body.group_id:
        owned(db, TaskListGroup, body.group_id, user)
    last_order = db.scalar(
        select(TaskList.sort_order)
        .where(TaskList.workspace_id == user.workspace_id)
        .order_by(TaskList.sort_order.desc())
        .limit(1)
    )
    task_list = TaskList(
        workspace_id=user.workspace_id,
        name=body.name,
        color=body.color,
        group_id=body.group_id,
        sort_order=(last_order or 0) + 1,
    )
    db.add(task_list)
    record_change(db, user, "task_list.create", task_list)
    return task_list


@router.post("/task-lists/reorder", response_model=list[TaskListOut])
def reorder_task_lists(body: TaskListOrderInput, db: DB, user: UserDep) -> list[TaskList]:
    if len(set(body.list_ids)) != len(body.list_ids):
        raise HTTPException(422, "清单不能重复")
    lists = list(
        db.scalars(
            select(TaskList).where(
                TaskList.workspace_id == user.workspace_id,
                TaskList.id.in_(body.list_ids),
            )
        )
    )
    if len(lists) != len(body.list_ids):
        raise HTTPException(404, "清单不存在")
    by_id = {item.id: item for item in lists}
    for index, list_id in enumerate(body.list_ids, start=1):
        by_id[list_id].sort_order = index
    record_change(db, user, "task_list.reorder", by_id[body.list_ids[0]], scheduling=False)
    return [by_id[list_id] for list_id in body.list_ids]


@router.put("/task-lists/{list_id}", response_model=TaskListOut)
def update_task_list(list_id: str, body: TaskListInput, db: DB, user: UserDep) -> TaskList:
    task_list = owned(db, TaskList, list_id, user)
    duplicate = db.scalar(
        select(TaskList.id).where(
            TaskList.workspace_id == user.workspace_id,
            TaskList.name == body.name,
            TaskList.id != list_id,
        )
    )
    if duplicate:
        raise HTTPException(409, "清单名称已存在")
    if body.group_id:
        owned(db, TaskListGroup, body.group_id, user)
    task_list.name = body.name
    task_list.color = body.color
    task_list.group_id = body.group_id
    record_change(db, user, "task_list.update", task_list)
    return task_list


@router.delete("/task-lists/{list_id}", status_code=204)
def delete_task_list(list_id: str, db: DB, user: UserDep) -> None:
    task_list = owned(db, TaskList, list_id, user)
    db.execute(
        update(Task)
        .where(Task.workspace_id == user.workspace_id, Task.list_id == list_id)
        .values(list_id=None)
    )
    remove_record(db, user, "task_list.delete", task_list)


def tag_usage(db: DB, user: User) -> dict[str, int]:
    return {
        tag_id: count
        for tag_id, count in db.execute(
            select(TaskTag.tag_id, func.count(TaskTag.id))
            .join(Task, Task.id == TaskTag.task_id)
            .where(
                TaskTag.workspace_id == user.workspace_id,
                Task.trashed_at.is_(None),
            )
            .group_by(TaskTag.tag_id)
        ).all()
    }


@router.get("/tags", response_model=list[TagOut])
def list_tags(db: DB, user: UserDep) -> list[TagOut]:
    usage = tag_usage(db, user)
    return [
        TagOut(id=tag.id, name=tag.name, usage_count=usage.get(tag.id, 0))
        for tag in db.scalars(
            select(Tag).where(Tag.workspace_id == user.workspace_id).order_by(Tag.name, Tag.id)
        )
    ]


@router.put("/tags/{tag_id}", response_model=TagOut)
def rename_tag(tag_id: str, body: TagInput, db: DB, user: UserDep) -> TagOut:
    tag = owned(db, Tag, tag_id, user)
    duplicate = db.scalar(
        select(Tag.id).where(
            Tag.workspace_id == user.workspace_id,
            Tag.name == body.name,
            Tag.id != tag_id,
        )
    )
    if duplicate:
        raise HTTPException(409, "标签名称已存在")
    tag.name = body.name
    record_change(db, user, "tag.update", tag, scheduling=False)
    usage = tag_usage(db, user)
    return TagOut(id=tag.id, name=tag.name, usage_count=usage.get(tag.id, 0))


@router.delete("/tags/{tag_id}", status_code=204)
def delete_tag(tag_id: str, db: DB, user: UserDep) -> None:
    tag = owned(db, Tag, tag_id, user)
    db.execute(delete(TaskTag).where(TaskTag.tag_id == tag_id))
    remove_record(db, user, "tag.delete", tag)


def task_day_bounds(user: User) -> tuple[int, int]:
    now = datetime.now(UTC)
    local = now.astimezone(ZoneInfo(user.timezone))
    tomorrow = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(now.timestamp() * 1000), int(tomorrow.timestamp() * 1000)


def query_ms(value: datetime | None, label: str) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        raise HTTPException(422, f"{label}必须包含 UTC 偏移")
    return int(value.timestamp() * 1000)


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(
    db: DB,
    user: UserDep,
    trashed: bool = False,
    view: TaskView = "all",
    q: str | None = None,
    status: Status | None = None,
    list_id: str | None = None,
    tag: str | None = None,
    flagged: bool | None = None,
    due_from: datetime | None = None,
    due_to: datetime | None = None,
    limit: int | None = Query(default=None, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[TaskOut]:
    scope: TaskView = "trash" if trashed else view
    now_ms, tomorrow_ms = task_day_bounds(user)
    query = select(Task).where(Task.workspace_id == user.workspace_id)
    if scope == "trash":
        query = query.where(Task.trashed_at.is_not(None))
    else:
        query = query.where(Task.trashed_at.is_(None))
        if scope == "archived":
            query = query.where(Task.archived_at.is_not(None))
        else:
            query = query.where(Task.archived_at.is_(None))

    active = Task.status.notin_(["done", "cancelled"])
    if scope == "today":
        query = query.where(
            active,
            or_(
                Task.status == "in_progress",
                and_(
                    Task.deadline_at.is_not(None),
                    Task.deadline_at < tomorrow_ms,
                ),
            ),
        )
    elif scope == "scheduled":
        query = query.where(active, Task.deadline_at.is_not(None))
    elif scope == "unscheduled":
        query = query.where(active, Task.deadline_at.is_(None))
    elif scope == "flagged":
        query = query.where(Task.flagged.is_(True), Task.status != "cancelled")
    elif scope == "done":
        query = query.where(Task.status == "done")

    if status:
        query = query.where(Task.status == status)
    if list_id:
        query = query.where(
            Task.list_id.is_(None) if list_id == "inbox" else Task.list_id == list_id
        )
    if q:
        query = query.where(
            or_(
                Task.title.contains(q, autoescape=True),
                Task.description.contains(q, autoescape=True),
                cast(Task.links, String).contains(q, autoescape=True),
                Task.id.in_(
                    select(TaskTag.task_id)
                    .join(Tag, Tag.id == TaskTag.tag_id)
                    .where(
                        Tag.workspace_id == user.workspace_id,
                        Tag.name.contains(q, autoescape=True),
                    )
                ),
                Task.id.in_(
                    select(TaskAttachment.task_id).where(
                        TaskAttachment.workspace_id == user.workspace_id,
                        TaskAttachment.filename.contains(q, autoescape=True),
                    )
                ),
            )
        )
    if tag:
        query = query.where(
            Task.id.in_(
                select(TaskTag.task_id)
                .join(Tag, Tag.id == TaskTag.tag_id)
                .where(
                    Tag.workspace_id == user.workspace_id,
                    Tag.name == tag,
                )
            )
        )
    if flagged is not None:
        query = query.where(Task.flagged.is_(flagged))
    from_ms = query_ms(due_from, "截止范围起点")
    to_ms = query_ms(due_to, "截止范围终点")
    if from_ms is not None:
        query = query.where(Task.deadline_at.is_not(None), Task.deadline_at >= from_ms)
    if to_ms is not None:
        query = query.where(Task.deadline_at.is_not(None), Task.deadline_at <= to_ms)

    query = query.order_by(Task.sort_order, Task.created_at.desc(), Task.id).offset(offset)
    if limit is not None:
        query = query.limit(limit)
    return [task_view(db, task) for task in db.scalars(query)]


@router.get("/tasks/summary", response_model=TaskSummaryOut)
def task_summary(db: DB, user: UserDep) -> TaskSummaryOut:
    now_ms, tomorrow_ms = task_day_bounds(user)
    base = (
        Task.workspace_id == user.workspace_id,
        Task.trashed_at.is_(None),
        Task.archived_at.is_(None),
    )
    active = (*base, Task.status.notin_(["done", "cancelled"]))

    def count(*conditions: Any) -> int:
        return db.scalar(select(func.count(Task.id)).where(*conditions)) or 0

    return TaskSummaryOut(
        active=count(*active),
        today=count(
            *active,
            or_(
                Task.status == "in_progress",
                and_(
                    Task.deadline_at.is_not(None),
                    Task.deadline_at < tomorrow_ms,
                ),
            ),
        ),
        overdue=count(
            *active,
            Task.deadline_at.is_not(None),
            Task.deadline_at < now_ms,
        ),
        flagged=count(
            *base,
            Task.flagged.is_(True),
            Task.status != "cancelled",
        ),
        trashed=count(
            Task.workspace_id == user.workspace_id,
            Task.trashed_at.is_not(None),
        ),
    )


@router.get("/stats/completion", response_model=CompletionStatsOut)
def completion_stats(
    db: DB,
    user: UserDep,
    days: int = Query(default=14, ge=1, le=90),
) -> CompletionStatsOut:
    now = datetime.now(UTC)
    zone = ZoneInfo(user.timezone)
    local = now.astimezone(zone)
    today_start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=local.weekday())
    month_start = today_start.replace(day=1)
    range_start = today_start - timedelta(days=days - 1)
    range_start_ms = int(range_start.timestamp() * 1000)
    query_start = min(range_start, week_start, month_start)
    now_ms = int(now.timestamp() * 1000)
    rows = db.execute(
        select(Task.id, Task.completed_at, Task.estimate_minutes).where(
            Task.workspace_id == user.workspace_id,
            Task.trashed_at.is_(None),
            Task.completed_at.is_not(None),
            Task.completed_at >= int(query_start.timestamp() * 1000),
            Task.completed_at <= now_ms,
        )
    ).all()
    counts: dict[str, int] = {}
    estimate_minutes = 0
    task_ids: list[str] = []
    for task_id, completed_at, estimate in rows:
        if completed_at is None:
            continue
        if completed_at < range_start_ms:
            continue
        task_ids.append(task_id)
        estimate_minutes += estimate or 0
        date = datetime.fromtimestamp(completed_at / 1000, zone).date().isoformat()
        counts[date] = counts.get(date, 0) + 1
    actual_minutes = 0
    if task_ids:
        actual_minutes = (
            db.scalar(
                select(func.coalesce(func.sum(WorkLog.actual_minutes), 0)).where(
                    WorkLog.task_id.in_(task_ids)
                )
            )
            or 0
        )
    days_out = [
        CompletionDay(
            date=(today_start.date() - timedelta(days=offset)).isoformat(),
            count=counts.get((today_start.date() - timedelta(days=offset)).isoformat(), 0),
        )
        for offset in reversed(range(days))
    ]

    def since(boundary: datetime) -> int:
        boundary_ms = int(boundary.timestamp() * 1000)
        return sum(1 for _, completed_at, _ in rows if completed_at and completed_at >= boundary_ms)

    return CompletionStatsOut(
        today=since(today_start),
        week=since(week_start),
        month=since(month_start),
        days=days_out,
        estimate_minutes=estimate_minutes,
        actual_minutes=actual_minutes,
    )


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str, db: DB, user: UserDep) -> TaskOut:
    return task_view(db, owned(db, Task, task_id, user))


@router.post("/tasks/titles", response_model=dict[str, str])
def task_titles(body: TaskTitlesInput, db: DB, user: UserDep) -> dict[str, str]:
    if not body.ids:
        return {}
    rows = db.execute(
        select(Task.id, Task.title).where(
            Task.workspace_id == user.workspace_id,
            Task.id.in_(body.ids),
        )
    ).all()
    return {task_id: title for task_id, title in rows}


@router.delete("/tasks/{task_id}/permanent", status_code=204)
def purge_task(
    task_id: str,
    request: Request,
    db: DB,
    user: UserDep,
) -> None:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is None:
        raise HTTPException(409, "只能永久删除垃圾箱中的任务")
    paths, _ = purge_tasks(
        db,
        user.workspace_id,
        [task.id],
        request.app.state.settings.attachment_dir,
    )
    db.commit()
    unlink_paths(paths)


@router.post("/tasks/trash/purge", response_model=PurgeOut)
def purge_trash(
    request: Request,
    db: DB,
    user: UserDep,
) -> PurgeOut:
    ids = list(
        db.scalars(
            select(Task.id).where(
                Task.workspace_id == user.workspace_id,
                Task.trashed_at.is_not(None),
            )
        )
    )
    paths, deleted = purge_tasks(
        db,
        user.workspace_id,
        ids,
        request.app.state.settings.attachment_dir,
    )
    db.commit()
    unlink_paths(paths)
    return PurgeOut(deleted=deleted)


@router.post("/tasks/{parent_id}/subtasks/reorder", response_model=list[TaskOut])
def reorder_subtasks(
    parent_id: str,
    body: TaskOrderInput,
    db: DB,
    user: UserDep,
) -> list[TaskOut]:
    parent = owned(db, Task, parent_id, user)
    if len(set(body.task_ids)) != len(body.task_ids):
        raise HTTPException(422, "子任务不能重复")
    tasks = list(
        db.scalars(
            select(Task).where(
                Task.workspace_id == user.workspace_id,
                Task.parent_id == parent.id,
                Task.trashed_at.is_(None),
                Task.id.in_(body.task_ids),
            )
        )
    )
    if len(tasks) != len(body.task_ids):
        raise HTTPException(404, "子任务不存在")
    by_id = {task.id: task for task in tasks}
    for index, task_id in enumerate(body.task_ids, start=1):
        by_id[task_id].subtask_order = index
    record_change(
        db,
        user,
        "subtask.reorder",
        by_id[body.task_ids[0]],
        scheduling=False,
    )
    return [task_view(db, by_id[task_id]) for task_id in body.task_ids]


@router.post("/tasks/reorder", response_model=list[TaskOut])
def reorder_tasks(body: TaskOrderInput, db: DB, user: UserDep) -> list[TaskOut]:
    if len(set(body.task_ids)) != len(body.task_ids):
        raise HTTPException(422, "任务不能重复")
    tasks = list(
        db.scalars(
            select(Task).where(
                Task.workspace_id == user.workspace_id,
                Task.trashed_at.is_(None),
                Task.id.in_(body.task_ids),
            )
        )
    )
    if len(tasks) != len(body.task_ids):
        raise HTTPException(404, "任务不存在")
    by_id = {task.id: task for task in tasks}
    for index, task_id in enumerate(body.task_ids, start=1):
        by_id[task_id].sort_order = index
    record_change(db, user, "task.reorder", by_id[body.task_ids[0]], scheduling=False)
    return [task_view(db, by_id[task_id]) for task_id in body.task_ids]


@router.post("/tasks", response_model=TaskOut, status_code=201)
def create_task(body: TaskInput, db: DB, user: UserDep) -> TaskOut:
    task = apply_task(db, user, body)
    record_change(db, user, "task.create", task)
    return task_view(db, task)


@router.put("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, body: TaskInput, db: DB, user: UserDep) -> TaskOut:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is not None:
        raise HTTPException(409, "请先恢复垃圾箱中的任务")
    apply_task(db, user, body, task)
    record_change(db, user, "task.update", task)
    return task_view(db, task)


@router.post("/tasks/{task_id}/trash", response_model=TaskOut)
def trash_task(
    task_id: str,
    request: Request,
    db: DB,
    user: UserDep,
    confirm_impact: bool = False,
) -> TaskOut:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is None:
        require_impact_confirmation(db, task, confirm_impact)
        task.trashed_at = now_ms()
        paths, _ = purge_old_trash(
            db,
            user.workspace_id,
            request.app.state.settings.attachment_dir,
            now_ms() - TRASH_RETENTION_MS,
        )
        record_change(db, user, "task.trash", task)
        unlink_paths(paths)
    return task_view(db, task)


@router.post("/tasks/{task_id}/restore", response_model=TaskOut)
def restore_task(task_id: str, db: DB, user: UserDep) -> TaskOut:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is not None:
        validate_links(db, user, task_input(db, task), task, restoring=True)
        task.trashed_at = None
        record_change(db, user, "task.restore", task)
    return task_view(db, task)


def active_task(db: Session, user: User, task_id: str) -> Task:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is not None:
        raise HTTPException(409, "请先恢复垃圾箱中的任务")
    return task


@router.post("/tasks/{task_id}/complete", response_model=TaskOut)
def complete_task(task_id: str, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    if task.status != "done":
        body = task_input(db, task).model_copy(update={"status": "done"})
        apply_task(db, user, body, task)
        record_change(db, user, "task.complete", task)
    return task_view(db, task)


@router.post("/tasks/{task_id}/reopen", response_model=TaskOut)
def reopen_task(task_id: str, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    if task.status != "todo":
        body = task_input(db, task).model_copy(update={"status": "todo"})
        apply_task(db, user, body, task)
        record_change(db, user, "task.reopen", task)
    return task_view(db, task)


@router.post("/tasks/{task_id}/archive", response_model=TaskOut)
def archive_task(task_id: str, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    if task.archived_at is None:
        task.archived_at = now_ms()
        record_change(db, user, "task.archive", task)
    return task_view(db, task)


@router.post("/tasks/{task_id}/unarchive", response_model=TaskOut)
def unarchive_task(task_id: str, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    if task.archived_at is not None:
        task.archived_at = None
        record_change(db, user, "task.unarchive", task)
    return task_view(db, task)


@router.patch("/tasks/{task_id}/deadline", response_model=TaskOut)
def update_deadline(task_id: str, body: DeadlineInput, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    task.deadline_at = int(body.deadline_at.timestamp() * 1000) if body.deadline_at else None
    task.deadline_all_day = body.deadline_all_day if body.deadline_at else False
    record_change(db, user, "task.deadline", task)
    return task_view(db, task)


@router.patch("/tasks/{task_id}/reminder", response_model=TaskOut)
def update_reminder(task_id: str, body: ReminderInput, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    task.remind_at = int(body.remind_at.timestamp() * 1000) if body.remind_at else None
    record_change(db, user, "task.reminder", task, scheduling=False)
    return task_view(db, task)


@router.post("/tasks/plan/move", response_model=list[TaskOut])
def move_task_in_plan(body: PlanMoveInput, db: DB, user: UserDep) -> list[TaskOut]:
    task = active_task(db, user, body.task_id)
    ordered_ids = list(dict.fromkeys(body.ordered_task_ids))
    if task.id not in ordered_ids:
        ordered_ids.append(task.id)
    tasks = list(
        db.scalars(
            select(Task).where(
                Task.workspace_id == user.workspace_id,
                Task.trashed_at.is_(None),
                Task.id.in_(ordered_ids),
            )
        )
    )
    if len(tasks) != len(ordered_ids):
        raise HTTPException(404, "任务不存在")
    by_id = {item.id: item for item in tasks}
    target = by_id[task.id]
    old_deadline = target.deadline_at
    target.deadline_at = int(body.deadline_at.timestamp() * 1000) if body.deadline_at else None
    target.deadline_all_day = body.deadline_all_day if body.deadline_at else False
    for index, task_id in enumerate(ordered_ids, start=1):
        by_id[task_id].sort_order = index
    record_change(
        db,
        user,
        "task.plan.move",
        target,
        scheduling=old_deadline != target.deadline_at,
    )
    return [task_view(db, by_id[task_id]) for task_id in ordered_ids]


@router.patch("/tasks/{task_id}/flag", response_model=TaskOut)
def update_flag(task_id: str, body: FlagInput, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    task.flagged = body.flagged
    record_change(db, user, "task.flag", task, scheduling=False)
    return task_view(db, task)


@router.patch("/tasks/{task_id}/parallel-policy", response_model=TaskOut)
def task_policy(task_id: str, body: EventPolicyInput, db: DB, user: UserDep) -> TaskOut:
    task = owned(db, Task, task_id, user)
    task.parallel_policy = body.parallel_policy
    task.policy_revision += 1
    record_change(db, user, "task.policy", task)
    return task_view(db, task)


def owned_task(db: Session, user: User, task_id: str) -> Task:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is not None:
        raise HTTPException(409, "垃圾箱中的任务不能记录工作日志")
    return task


def worklog_view(db: Session, log: WorkLog) -> WorkLogOut:
    contexts: list[WorkLogContextOut] = []
    for context in db.scalars(
        select(WorkLogContext)
        .where(WorkLogContext.work_log_id == log.id)
        .order_by(WorkLogContext.created_at, WorkLogContext.id)
    ):
        if context.object_kind == "event":
            event = db.get(Event, context.object_id)
            if event is None:
                continue
            view = event_view(db, event)
            contexts.append(
                WorkLogContextOut(
                    object_kind="event",
                    object_id=event.id,
                    title=view.title,
                    start_at=view.start_at,
                    end_at=view.end_at,
                )
            )
        else:
            task = db.get(Task, context.object_id)
            if task is None:
                continue
            contexts.append(
                WorkLogContextOut(
                    object_kind="task",
                    object_id=task.id,
                    title=task.title,
                )
            )
    return WorkLogOut.model_validate(
        {
            **{
                c.name: getattr(log, c.name)
                for c in WorkLog.__table__.columns
                if c.name in WorkLogOut.model_fields
            },
            "parallel_contexts": contexts,
        }
    )


def replace_worklog_contexts(
    db: Session,
    user: User,
    log: WorkLog,
    items: list[WorkLogContextInput],
) -> None:
    keys = [(item.object_kind, item.object_id) for item in items]
    if len(set(keys)) != len(keys):
        raise HTTPException(422, "并行情境不能重复")
    db.execute(delete(WorkLogContext).where(WorkLogContext.work_log_id == log.id))
    for item in items:
        if item.object_kind == "task":
            task = owned(db, Task, item.object_id, user)
            if task.id == log.task_id:
                raise HTTPException(422, "不能把任务自身作为并行情境")
        else:
            owned(db, Event, item.object_id, user)
        db.add(
            WorkLogContext(
                workspace_id=user.workspace_id,
                work_log_id=log.id,
                object_kind=item.object_kind,
                object_id=item.object_id,
            )
        )
    db.flush()


@router.get("/tasks/{task_id}/worklogs", response_model=list[WorkLogOut])
def list_worklogs(task_id: str, db: DB, user: UserDep) -> list[WorkLogOut]:
    owned_task(db, user, task_id)
    return [
        worklog_view(db, log)
        for log in db.scalars(
            select(WorkLog)
            .where(
                WorkLog.workspace_id == user.workspace_id,
                WorkLog.task_id == task_id,
            )
            .order_by(WorkLog.created_at.desc(), WorkLog.id)
        )
    ]


@router.post("/tasks/{task_id}/worklogs", response_model=WorkLogOut, status_code=201)
def add_worklog(task_id: str, body: WorkLogInput, db: DB, user: UserDep) -> WorkLogOut:
    task = owned_task(db, user, task_id)
    log = WorkLog(
        workspace_id=user.workspace_id,
        task_id=task.id,
        actual_minutes=body.actual_minutes,
        cause=body.cause,
        note=body.note,
        reflection=body.reflection,
        started_at=int(body.started_at.timestamp() * 1000) if body.started_at else None,
        ended_at=int(body.ended_at.timestamp() * 1000) if body.ended_at else None,
    )
    db.add(log)
    db.flush()
    replace_worklog_contexts(db, user, log, body.parallel_contexts)
    record_change(db, user, "worklog.create", log)
    if body.complete:
        if task.status != "done":
            validate_links(
                db,
                user,
                task_input(db, task).model_copy(update={"status": "done"}),
                task,
            )
            task.completed_at = now_ms()
            task.status = "done"
            if task.recurrence:
                generate_next_occurrence(db, user, task)
        task.status = "done"
        record_change(db, user, "task.complete", task)
    return worklog_view(db, log)


@router.put("/worklogs/{worklog_id}", response_model=WorkLogOut)
def update_worklog(worklog_id: str, body: WorkLogUpdate, db: DB, user: UserDep) -> WorkLogOut:
    log = owned(db, WorkLog, worklog_id, user)
    data = body.model_dump(exclude_none=True, exclude={"parallel_contexts"})
    for key, value in data.items():
        setattr(log, key, value)
    if body.parallel_contexts is not None:
        replace_worklog_contexts(db, user, log, body.parallel_contexts)
    record_change(db, user, "worklog.update", log, scheduling=False)
    return worklog_view(db, log)


@router.delete("/worklogs/{worklog_id}", status_code=204)
def delete_worklog(worklog_id: str, db: DB, user: UserDep) -> None:
    log = owned(db, WorkLog, worklog_id, user)
    db.execute(delete(WorkLogContext).where(WorkLogContext.work_log_id == log.id))
    db.add(Audit(workspace_id=user.workspace_id, action="worklog.delete", object_id=log.id))
    db.delete(log)
    db.execute(
        update(Workspace)
        .where(Workspace.id == user.workspace_id)
        .values(scheduling_revision=Workspace.scheduling_revision + 1)
    )
    db.commit()


@router.get("/drafts", response_model=list[DraftOut])
def list_drafts(
    db: DB, user: UserDep, status: Literal["draft", "published"] = "draft"
) -> list[Draft]:
    return list(
        db.scalars(
            select(Draft)
            .where(Draft.workspace_id == user.workspace_id, Draft.status == status)
            .order_by(Draft.updated_at.desc())
        )
    )


@router.post("/drafts", response_model=DraftOut, status_code=201)
def create_draft(body: DraftInput, db: DB, user: UserDep) -> Draft:
    draft = Draft(workspace_id=user.workspace_id, payload=body.payload.model_dump(mode="json"))
    db.add(draft)
    record_change(db, user, "draft.create", draft, scheduling=False)
    return draft


def editable_draft(db: DB, user: UserDep, draft_id: str, revision: int) -> Draft:
    draft = owned(db, Draft, draft_id, user)
    if draft.status != "draft" or draft.revision != revision:
        raise HTTPException(409, "草稿已发布、删除或被修改，请刷新后重试")
    return draft


@router.put("/drafts/{draft_id}", response_model=DraftOut)
def edit_draft(draft_id: str, body: DraftUpdate, db: DB, user: UserDep) -> Draft:
    draft = editable_draft(db, user, draft_id, body.revision)
    draft.payload = body.payload.model_dump(mode="json")
    draft.revision += 1
    record_change(db, user, "draft.update", draft, scheduling=False)
    return draft


@router.delete("/drafts/{draft_id}", status_code=204)
def delete_draft(draft_id: str, revision: int, db: DB, user: UserDep) -> None:
    draft = editable_draft(db, user, draft_id, revision)
    draft.status = "deleted"
    draft.revision += 1
    record_change(db, user, "draft.delete", draft, scheduling=False)


@router.post("/drafts/{draft_id}/publish", response_model=TaskOut)
def publish_draft(draft_id: str, body: PublishInput, db: DB, user: UserDep) -> TaskOut:
    payload = {"operation": "draft.publish", "draft_id": draft_id, "revision": body.revision}
    previous = replay(db, user, body.idempotency_key, payload)
    if previous:
        return task_view(db, owned(db, Task, previous, user))
    draft = owned(db, Draft, draft_id, user)
    if draft.revision != body.revision or draft.status == "deleted":
        raise HTTPException(409, "草稿版本过期或已删除，请重新预览后发布")
    if draft.published_task_id:
        task = owned(db, Task, draft.published_task_id, user)
        remember(db, user, body.idempotency_key, payload, task.id)
        db.commit()
        return task_view(db, task)
    try:
        task_input = TaskInput.model_validate(draft.payload)
    except ValidationError:
        raise HTTPException(422, "草稿尚不完整，请补充有效标题及任务字段后发布") from None
    task = apply_task(db, user, task_input)
    draft.status, draft.published_task_id = "published", task.id
    remember(db, user, body.idempotency_key, payload, task.id)
    record_change(db, user, "draft.publish", draft)
    return task_view(db, task)


@router.post("/event-series", response_model=SeriesOut, status_code=201)
def add_series(body: SeriesInput, db: DB, user: UserDep) -> SeriesOut:
    return series_view(db, create_series(db, user, body))


@router.get("/event-series", response_model=list[SeriesOut])
def list_series(db: DB, user: UserDep) -> list[SeriesOut]:
    return [
        series_view(db, s)
        for s in db.scalars(
            select(EventSeries).where(EventSeries.workspace_id == user.workspace_id)
        )
    ]


@router.patch("/events/{event_id}/skip", response_model=EventOut)
def skip_event(event_id: str, body: SkipInput, db: DB, user: UserDep) -> EventOut:
    event = owned(db, Event, event_id, user)
    if event.kind != "course":
        raise HTTPException(422, "仅课程可标记单次不参加；考试和其他事项不能跳过")
    target = instance_override(db, event, create=True) if event.series_id else event
    assert target is not None
    target.is_skipped = body.is_skipped
    record_change(db, user, "event.skip" if body.is_skipped else "event.restore_attendance", event)
    result = event_view(db, event)
    if not body.is_skipped:
        plan = db.scalar(
            select(Plan).where(
                Plan.workspace_id == user.workspace_id,
                Plan.status == "adopted",
            )
        )
        start = int(result.start_at.timestamp() * 1000)
        end = int(result.end_at.timestamp() * 1000)
        result.replan_suggested = bool(
            plan
            and any(
                block["start_at"] < end and block["end_at"] > start
                for block in plan.blocks
                if isinstance(block, dict)
            )
        )
    return result


@router.patch("/events/{event_id}/parallel-policy", response_model=EventOut)
def event_policy(event_id: str, body: EventPolicyInput, db: DB, user: UserDep) -> EventOut:
    event = owned(db, Event, event_id, user)
    target = instance_override(db, event, create=True) if event.series_id else event
    assert target is not None
    target.parallel_policy_override = body.parallel_policy
    target.policy_revision += 1
    record_change(db, user, "event.policy", event)
    return event_view(db, event)


@router.patch("/courses/{course_id}/parallel-policy", response_model=CourseOut)
def course_policy(course_id: str, body: PolicyInput, db: DB, user: UserDep) -> Course:
    course = owned(db, Course, course_id, user)
    course.parallel_policy = body.parallel_policy
    course.policy_revision += 1
    record_change(db, user, "course.policy", course)
    return course


@router.get("/task-type-policies", response_model=list[TypePolicyOut])
def type_policies(db: DB, user: UserDep) -> list[TaskTypePolicy]:
    return list(
        db.scalars(select(TaskTypePolicy).where(TaskTypePolicy.workspace_id == user.workspace_id))
    )


@router.put("/task-type-policies", response_model=TypePolicyOut)
def type_policy(body: TypePolicyInput, db: DB, user: UserDep) -> TaskTypePolicy:
    policy = db.scalar(
        select(TaskTypePolicy).where(
            TaskTypePolicy.workspace_id == user.workspace_id,
            TaskTypePolicy.task_type == body.task_type,
        )
    )
    if policy is None:
        policy = TaskTypePolicy(workspace_id=user.workspace_id, **body.model_dump())
        db.add(policy)
    else:
        policy.parallel_policy = body.parallel_policy
        policy.policy_revision += 1
    record_change(db, user, "task_type.policy", policy)
    return policy


@router.get("/compatibility-rules", response_model=list[RuleOut])
def list_rules(db: DB, user: UserDep) -> list[RuleOut]:
    return [
        rule_view(r)
        for r in db.scalars(
            select(CompatibilityRule)
            .where(CompatibilityRule.workspace_id == user.workspace_id)
            .order_by(CompatibilityRule.created_at)
        )
    ]


@router.post("/compatibility-rules", response_model=RuleOut, status_code=201)
def add_rule(body: RuleInput, db: DB, user: UserDep) -> RuleOut:
    rule = prepare_rule(db, user, body)
    record_change(db, user, "rule.create", rule)
    return rule_view(rule)


@router.put("/compatibility-rules/{rule_id}", response_model=RuleOut)
def edit_rule(rule_id: str, body: RuleInput, db: DB, user: UserDep) -> RuleOut:
    rule = prepare_rule(db, user, body, owned(db, CompatibilityRule, rule_id, user))
    record_change(db, user, "rule.update", rule)
    return rule_view(rule)


@router.delete("/compatibility-rules/{rule_id}", status_code=204)
def disable_rule(rule_id: str, db: DB, user: UserDep) -> None:
    rule = owned(db, CompatibilityRule, rule_id, user)
    rule.status = "disabled"
    rule.revision += 1
    record_change(db, user, "rule.disable", rule)


@router.post("/compatibility/check", response_model=CompatibilityOut)
def compatibility(body: CompatibilityInput, db: DB, user: UserDep) -> CompatibilityOut:
    return check_compatibility(db, user, body.activities)


@router.put("/courses/{course_id}", response_model=CourseOut)
def edit_course(course_id: str, body: CourseInput, db: DB, user: UserDep) -> Course:
    course = owned(db, Course, course_id, user)
    old_name = course.name
    course.name, course.semester = body.name, body.semester
    if body.name != old_name:
        events = list(db.scalars(select(Event).where(Event.course_id == course.id)))
        for event in events:
            event.title = body.name
        series_ids = {event.series_id for event in events if event.series_id}
        if series_ids:
            for override in db.scalars(
                select(EventOverride).where(EventOverride.series_id.in_(series_ids))
            ):
                if override.title is not None:
                    override.title = body.name
    record_change(db, user, "course.update", course)
    return course


@router.delete("/courses/{course_id}", status_code=204)
def delete_course(course_id: str, body: ConfirmInput, db: DB, user: UserDep) -> None:
    course = owned(db, Course, course_id, user)
    if db.scalar(select(Event.id).where(Event.course_id == course.id)) or db.scalar(
        select(EventSeries.id).where(EventSeries.course_id == course.id)
    ):
        raise HTTPException(409, "请先明确删除课程下的系列和单次事件，再删除空课程")
    remove_record(db, user, "course.delete", course)


@router.get("/events/{event_id}/feedback", response_model=ActivityFeedbackOut | None)
def get_event_feedback(event_id: str, db: DB, user: UserDep) -> ActivityFeedback | None:
    owned(db, Event, event_id, user)
    return db.scalar(
        select(ActivityFeedback).where(
            ActivityFeedback.workspace_id == user.workspace_id,
            ActivityFeedback.event_id == event_id,
        )
    )


@router.post("/events/{event_id}/feedback", response_model=ActivityFeedbackOut, status_code=201)
def create_event_feedback(
    event_id: str, body: ActivityFeedbackInput, db: DB, user: UserDep
) -> ActivityFeedback:
    owned(db, Event, event_id, user)
    existing = db.scalar(
        select(ActivityFeedback).where(
            ActivityFeedback.workspace_id == user.workspace_id,
            ActivityFeedback.event_id == event_id,
        )
    )
    if existing:
        raise HTTPException(409, "该事件已有反馈，请直接修改")
    feedback = ActivityFeedback(
        workspace_id=user.workspace_id,
        event_id=event_id,
        rating=body.rating,
        tags=body.tags,
        reflection=body.reflection,
    )
    db.add(feedback)
    record_change(db, user, "activity_feedback.create", feedback, scheduling=False)
    return feedback


@router.put("/events/{event_id}/feedback", response_model=ActivityFeedbackOut)
def update_event_feedback(
    event_id: str, body: ActivityFeedbackInput, db: DB, user: UserDep
) -> ActivityFeedback:
    owned(db, Event, event_id, user)
    feedback = db.scalar(
        select(ActivityFeedback).where(
            ActivityFeedback.workspace_id == user.workspace_id,
            ActivityFeedback.event_id == event_id,
        )
    )
    if feedback is None:
        raise HTTPException(404, "该事件还没有反馈")
    feedback.rating = body.rating
    feedback.tags = body.tags
    feedback.reflection = body.reflection
    record_change(db, user, "activity_feedback.update", feedback, scheduling=False)
    return feedback


@router.delete("/events/{event_id}/feedback", status_code=204)
def delete_event_feedback(event_id: str, db: DB, user: UserDep) -> None:
    owned(db, Event, event_id, user)
    feedback = db.scalar(
        select(ActivityFeedback).where(
            ActivityFeedback.workspace_id == user.workspace_id,
            ActivityFeedback.event_id == event_id,
        )
    )
    if feedback is None:
        return
    db.add(
        Audit(
            workspace_id=user.workspace_id,
            action="activity_feedback.delete",
            object_id=feedback.id,
        )
    )
    db.delete(feedback)
    db.commit()


@router.delete("/events/{event_id}", status_code=204)
def delete_event(event_id: str, body: ConfirmInput, db: DB, user: UserDep) -> None:
    event = owned(db, Event, event_id, user)
    override = instance_override(db, event)
    if override:
        db.delete(override)
    db.execute(delete(ActivityFeedback).where(ActivityFeedback.event_id == event.id))
    remove_record(db, user, "event.delete", event)


@router.put("/event-series/{series_id}", response_model=SeriesOut)
def edit_series(series_id: str, body: SeriesEdit, db: DB, user: UserDep) -> SeriesOut:
    series = owned(db, EventSeries, series_id, user)
    zone = ZoneInfo(series.timezone)
    events = list(db.scalars(select(Event).where(Event.series_id == series.id)))
    for event in events:
        day = date.fromisoformat(event.occurrence_local_date or "")
        start = unambiguous_instant(datetime.combine(day, body.start_time), zone)
        end = unambiguous_instant(datetime.combine(day, body.end_time), zone)
        event.start_at, event.end_at = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
        event.location = body.location
    first = datetime.fromisoformat(series.dtstart_local).date()
    series.dtstart_local = datetime.combine(first, body.start_time).isoformat()
    series.location = body.location
    series.note = body.note
    series.details = body.details
    series.duration_minutes = int(
        (
            datetime.combine(first, body.end_time) - datetime.combine(first, body.start_time)
        ).total_seconds()
        / 60
    )
    record_change(db, user, "series.update", series)
    return series_view(db, series)


@router.post("/event-series/{series_id}/attendance", response_model=SeriesOut)
def series_attendance(series_id: str, body: SkipInput, db: DB, user: UserDep) -> SeriesOut:
    series = owned(db, EventSeries, series_id, user)
    for event in db.scalars(select(Event).where(Event.series_id == series.id)):
        override = instance_override(db, event, create=True)
        assert override is not None
        override.is_skipped = body.is_skipped
    record_change(db, user, "series.attendance", series)
    return series_view(db, series)


@router.delete("/event-series/{series_id}", status_code=204)
def delete_series(series_id: str, body: ConfirmInput, db: DB, user: UserDep) -> None:
    series = owned(db, EventSeries, series_id, user)
    for override in db.scalars(select(EventOverride).where(EventOverride.series_id == series.id)):
        db.delete(override)
    event_ids = list(db.scalars(select(Event.id).where(Event.series_id == series.id)))
    if event_ids:
        db.execute(delete(ActivityFeedback).where(ActivityFeedback.event_id.in_(event_ids)))
    for event in db.scalars(select(Event).where(Event.series_id == series.id)):
        db.delete(event)
    db.flush()
    remove_record(db, user, "series.delete", series)
