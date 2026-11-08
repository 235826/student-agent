"""Controlled tool catalog for the global agent."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, time
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import event_types as event_types_api
from app.api import imports as imports_api
from app.api import planning_foundation as planning
from app.api import routes as base_routes
from app.api.import_schemas import ImportText
from app.api.schemas import (
    CompatibilityInput,
    CourseInput,
    DeadlineInput,
    DraftInput,
    DraftPayload,
    EventInput,
    EventTypeInput,
    FlagInput,
    PlanInput,
    ProfileInput,
    PublishInput,
    ReminderInput,
    RuleInput,
    SavedFilterInput,
    Schema,
    SeriesEdit,
    SeriesInput,
    SkipInput,
    TagInput,
    TaskInput,
    TaskListGroupInput,
    TaskListInput,
    TypePolicyInput,
    Window,
    WorkLogInput,
    WorkLogUpdate,
)
from app.config import Settings
from app.db.models import (
    Event,
    ImportJob,
    ImportSource,
    Task,
    TaskAttachment,
    User,
    now_ms,
)
from app.modules import scheduling
from app.modules.calendar_management import event_view
from app.modules.records import owned, record_change
from app.modules.task_management import task_input, task_view
from app.modules.trash import (
    TRASH_RETENTION_MS,
    purge_old_trash,
    purge_tasks,
    unlink_paths,
)

READ: Literal["read"] = "read"
WRITE: Literal["write"] = "write"
Risk = Literal["low", "medium", "high"]


@dataclass
class ToolContext:
    db: Session
    user: User
    settings: Settings
    action_results: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    kind: Literal["read", "write"]
    args: type[Schema]
    execute: Callable[..., Any]
    summarize: Callable[[Any], str]
    risk: Risk = "low"
    image_only: bool = False


@dataclass(frozen=True)
class ImageRef:
    path: str
    media_type: str
    label: str


def _id(value: Any) -> str:
    return str(getattr(value, "id", value))


def _dump(value: Any) -> Any:
    if isinstance(value, list):
        return [_dump(item) for item in value]
    if isinstance(value, ImageRef):
        return {"path": value.path, "media_type": value.media_type, "label": value.label}
    if isinstance(value, dict):
        return {key: _dump(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    table = getattr(value, "__table__", None)
    if table is not None:
        return {column.name: getattr(value, column.name) for column in table.columns}
    return value


def _text(value: Any) -> str:
    return str(getattr(value, "title", None) or getattr(value, "name", None) or _id(value))


class TaskIdArgs(Schema):
    task_id: str = Field(min_length=1, max_length=36)


class UpdateTaskArgs(Schema):
    task_id: str = Field(min_length=1, max_length=36)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    links: list[str] | None = Field(default=None, max_length=20)
    status: Literal["todo", "in_progress", "done", "cancelled"] | None = None
    priority: int | None = Field(default=None, ge=1, le=4)
    flagged: bool | None = None
    deadline_at: datetime | None = None
    deadline_all_day: bool | None = None
    remind_at: datetime | None = None
    estimate_minutes: int | None = Field(default=None, gt=0, le=100000)
    task_type: str | None = Field(default=None, min_length=1, max_length=100)
    recurrence: Literal["daily", "weekly", "monthly", "yearly", "weekdays"] | None = None
    recurrence_interval: int | None = Field(default=None, ge=1, le=52)
    recurrence_from_completion: bool | None = None
    recurrence_until: datetime | None = None
    recurrence_remaining: int | None = Field(default=None, ge=0, le=100000)
    list_id: str | None = None
    tags: list[str] | None = Field(default=None, max_length=20)
    parent_id: str | None = None
    predecessor_ids: list[str] | None = Field(default=None, max_length=100)
    parallel_policy: Literal["none", "allow_selected"] | None = None


class DeadlineArgs(Schema):
    task_id: str
    deadline_at: datetime | None = None
    deadline_all_day: bool = False


class ReminderArgs(Schema):
    task_id: str
    remind_at: datetime | None = None


class FlagArgs(Schema):
    task_id: str
    flagged: bool


class WorkLogArgs(Schema):
    task_id: str
    actual_minutes: int = Field(gt=0, le=100000)
    cause: Literal[
        "underestimated",
        "scope_changed",
        "interrupted",
        "scheduling_issue",
        "other",
        "unknown",
    ] = "unknown"
    note: str = Field(default="", max_length=2000)
    reflection: str = Field(default="", max_length=5000)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    complete: bool = False


class WorkLogUpdateArgs(Schema):
    worklog_id: str
    cause: (
        Literal[
            "underestimated",
            "scope_changed",
            "interrupted",
            "scheduling_issue",
            "other",
            "unknown",
        ]
        | None
    ) = None
    note: str | None = Field(default=None, max_length=2000)
    reflection: str | None = Field(default=None, max_length=5000)


class UpdateTaskListArgs(TaskListInput):
    list_id: str


class UpdateEventArgs(Schema):
    event_id: str
    title: str | None = Field(default=None, min_length=1, max_length=200)
    start_at: datetime | None = None
    end_at: datetime | None = None
    timezone: str | None = None
    location: str | None = Field(default=None, max_length=500)
    note: str | None = Field(default=None, max_length=120)
    details: str | None = Field(default=None, max_length=5000)
    note_scope: Literal["single", "series"] | None = None
    details_scope: Literal["single", "series"] | None = None
    locked: bool | None = None
    course_id: str | None = None
    event_type_id: str | None = None
    kind: Literal["course", "other"] | None = None


class SkipEventArgs(Schema):
    event_id: str
    is_skipped: bool


class UpdateCourseArgs(CourseInput):
    course_id: str


class CreateSeriesArgs(Schema):
    course_id: str
    start_date: date
    end_date: date
    weekdays: list[int] = Field(min_length=1, max_length=7)
    start_time: time
    end_time: time
    timezone: str
    location: str = Field(default="", max_length=500)
    note: str = Field(default="", max_length=120)
    details: str = Field(default="", max_length=5000)


class UpdateSeriesArgs(Schema):
    series_id: str
    start_time: time
    end_time: time
    location: str = Field(default="", max_length=500)
    note: str = Field(default="", max_length=120)
    details: str = Field(default="", max_length=5000)


class SeriesAttendanceArgs(Schema):
    series_id: str
    is_skipped: bool


class UpdateProfileArgs(Schema):
    timezone: str | None = None
    available_windows: list[Window] | None = None
    rest_windows: list[Window] | None = None


class CreatePlanArgs(Schema):
    start_at: datetime
    end_at: datetime
    min_block_minutes: int = Field(default=25, ge=1, le=90)
    max_block_minutes: int = Field(default=90, ge=1, le=180)


class StartImportArgs(Schema):
    text: str = Field(min_length=1, max_length=20000)
    context: str = Field(default="", max_length=4000)
    reference_at: datetime | None = None


class PublishDraftArgs(Schema):
    draft_id: str
    revision: int = Field(gt=0)


class TaskListIdArgs(Schema):
    list_id: str


class GroupIdArgs(Schema):
    group_id: str


class TagIdArgs(Schema):
    tag_id: str


class FilterIdArgs(Schema):
    filter_id: str


class EventIdArgs(Schema):
    event_id: str


class CourseIdArgs(Schema):
    course_id: str


class SeriesIdArgs(Schema):
    series_id: str


class RuleIdArgs(Schema):
    rule_id: str


class EventTypeIdArgs(Schema):
    event_type_id: str


class PlanIdArgs(Schema):
    plan_id: str


class JobIdArgs(Schema):
    job_id: str


class RenameTagArgs(Schema):
    tag_id: str
    name: str = Field(min_length=1, max_length=50)


class UpdateEventTypeArgs(EventTypeInput):
    event_type_id: str


class UpdateTaskListGroupArgs(TaskListGroupInput):
    group_id: str


class UpdateSavedFilterArgs(SavedFilterInput):
    filter_id: str


class ReadTasksArgs(Schema):
    view: Literal["all", "today", "scheduled", "unscheduled", "flagged", "done", "trash"] = "all"
    q: str | None = Field(default=None, max_length=200)
    status: Literal["todo", "in_progress", "done", "cancelled"] | None = None
    list_id: str | None = None
    tag: str | None = Field(default=None, max_length=50)
    flagged: bool | None = None
    limit: int = Field(default=50, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class ReadEventsArgs(Schema):
    from_at: datetime | None = None
    to_at: datetime | None = None
    limit: int = Field(default=50, ge=1, le=200)


class CompatibilityArgs(CompatibilityInput):
    pass


class NoArgs(Schema):
    pass


def current_task_input(db: Session, user: User, task_id: str) -> TaskInput:
    task = owned(db, Task, task_id, user)
    return task_input(db, task)


def current_event_input(db: Session, user: User, event_id: str) -> EventInput:
    event = owned(db, Event, event_id, user)
    view = event_view(db, event)
    return EventInput.model_validate({key: getattr(view, key) for key in EventInput.model_fields})


def _read_tasks(ctx: ToolContext, args: ReadTasksArgs) -> Any:
    return planning.list_tasks(
        db=ctx.db,
        user=ctx.user,
        view=args.view,
        q=args.q,
        status=args.status,
        list_id=args.list_id,
        tag=args.tag,
        flagged=args.flagged,
        limit=args.limit,
        offset=args.offset,
    )


def _read_task(ctx: ToolContext, args: TaskIdArgs) -> Any:
    return planning.get_task(args.task_id, db=ctx.db, user=ctx.user)


def _read_events(ctx: ToolContext, args: ReadEventsArgs) -> Any:
    query = select(Event).where(Event.workspace_id == ctx.user.workspace_id)
    if args.from_at is not None:
        query = query.where(Event.end_at > int(args.from_at.timestamp() * 1000))
    if args.to_at is not None:
        query = query.where(Event.start_at < int(args.to_at.timestamp() * 1000))
    events = ctx.db.scalars(query.order_by(Event.start_at).limit(args.limit))
    return [event_view(ctx.db, event) for event in events]


def _read_plan(ctx: ToolContext, _: NoArgs) -> Any:
    plan = scheduling.current_plan(ctx.db, ctx.user)
    return scheduling.view(ctx.db, ctx.user, plan) if plan else None


def _read_imports(ctx: ToolContext, _: NoArgs) -> Any:
    return imports_api.imports(db=ctx.db, user=ctx.user)


IMAGE_MEDIA_PREFIXES = ("image/",)


def _is_image_media(media_type: str) -> bool:
    return media_type.startswith(IMAGE_MEDIA_PREFIXES)


def _list_task_attachments(ctx: ToolContext, args: TaskIdArgs) -> Any:
    task = owned(ctx.db, Task, args.task_id, ctx.user)
    attachments = list(
        ctx.db.scalars(
            select(TaskAttachment)
            .where(TaskAttachment.task_id == task.id)
            .order_by(TaskAttachment.created_at, TaskAttachment.id)
        )
    )
    return [
        {
            "id": a.id,
            "filename": a.filename,
            "media_type": a.media_type,
            "size_bytes": a.size_bytes,
            "is_image": _is_image_media(a.media_type),
        }
        for a in attachments
    ]


def _read_task_images(ctx: ToolContext, args: TaskIdArgs) -> Any:
    task = owned(ctx.db, Task, args.task_id, ctx.user)
    attachments = list(
        ctx.db.scalars(
            select(TaskAttachment)
            .where(TaskAttachment.task_id == task.id)
            .order_by(TaskAttachment.created_at, TaskAttachment.id)
        )
    )
    images: list[ImageRef] = []
    labels: list[dict[str, str]] = []
    for a in attachments:
        if not _is_image_media(a.media_type):
            continue
        path = str(ctx.settings.attachment_dir / a.workspace_id / a.id)
        if not Path(path).is_file():
            continue
        images.append(ImageRef(path=path, media_type=a.media_type, label=a.filename))
        labels.append({"filename": a.filename, "media_type": a.media_type})
    return {"task_id": task.id, "images": labels, "_images": images}


def _read_import_image(ctx: ToolContext, args: JobIdArgs) -> Any:
    job = owned(ctx.db, ImportJob, args.job_id, ctx.user)
    source = ctx.db.get(ImportSource, job.source_id)
    if source is None or source.deleted_at is not None or not source.file_name:
        return {"error": "该导入记录没有图片来源"}
    if not _is_image_media(source.media_type):
        return {"error": "该导入来源不是图片"}
    path = str(ctx.settings.source_dir / source.file_name)
    if not Path(path).is_file():
        return {"error": "来源文件不可用"}
    return {
        "job_id": job.id,
        "media_type": source.media_type,
        "_images": [ImageRef(path=path, media_type=source.media_type, label=source.file_name)],
    }


def _create_task(ctx: ToolContext, args: TaskInput) -> Any:
    return planning.create_task(args, ctx.db, ctx.user)


def _update_task(ctx: ToolContext, args: UpdateTaskArgs) -> Any:
    current = current_task_input(ctx.db, ctx.user, args.task_id)
    data = current.model_dump(mode="json")
    data.update(
        {
            key: value
            for key, value in args.model_dump(mode="json", exclude_unset=True).items()
            if key != "task_id"
        }
    )
    body = TaskInput.model_validate(data).model_copy(update={"confirm_impact": True})
    return planning.update_task(args.task_id, body, ctx.db, ctx.user)


def _complete_task(ctx: ToolContext, args: TaskIdArgs) -> Any:
    return planning.complete_task(args.task_id, ctx.db, ctx.user)


def _reopen_task(ctx: ToolContext, args: TaskIdArgs) -> Any:
    return planning.reopen_task(args.task_id, ctx.db, ctx.user)


def _deadline(ctx: ToolContext, args: DeadlineArgs) -> Any:
    return planning.update_deadline(
        args.task_id,
        DeadlineInput(deadline_at=args.deadline_at, deadline_all_day=args.deadline_all_day),
        ctx.db,
        ctx.user,
    )


def _reminder(ctx: ToolContext, args: ReminderArgs) -> Any:
    return planning.update_reminder(
        args.task_id, ReminderInput(remind_at=args.remind_at), ctx.db, ctx.user
    )


def _flag(ctx: ToolContext, args: FlagArgs) -> Any:
    return planning.update_flag(args.task_id, FlagInput(flagged=args.flagged), ctx.db, ctx.user)


def _trash(ctx: ToolContext, args: TaskIdArgs) -> Any:
    task = owned(ctx.db, Task, args.task_id, ctx.user)
    if task.trashed_at is None:
        task.trashed_at = now_ms()
        paths, _ = purge_old_trash(
            ctx.db,
            ctx.user.workspace_id,
            ctx.settings.attachment_dir,
            now_ms() - TRASH_RETENTION_MS,
        )
        record_change(ctx.db, ctx.user, "task.trash", task)
        unlink_paths(paths)
    return task_view(ctx.db, task)


def _restore(ctx: ToolContext, args: TaskIdArgs) -> Any:
    return planning.restore_task(args.task_id, ctx.db, ctx.user)


def _purge(ctx: ToolContext, args: TaskIdArgs) -> Any:
    task = owned(ctx.db, Task, args.task_id, ctx.user)
    if task.trashed_at is None:
        raise HTTPException(409, "只能永久删除垃圾箱中的任务")
    paths, _ = purge_tasks(ctx.db, ctx.user.workspace_id, [task.id], ctx.settings.attachment_dir)
    ctx.db.commit()
    unlink_paths(paths)
    return {"id": task.id, "deleted": True}


def _purge_trash(ctx: ToolContext, _: NoArgs) -> Any:
    ids = list(
        ctx.db.scalars(
            select(Task.id).where(
                Task.workspace_id == ctx.user.workspace_id,
                Task.trashed_at.is_not(None),
            )
        )
    )
    paths, deleted = purge_tasks(ctx.db, ctx.user.workspace_id, ids, ctx.settings.attachment_dir)
    ctx.db.commit()
    unlink_paths(paths)
    return {"deleted": deleted}


def _worklog(ctx: ToolContext, args: WorkLogArgs) -> Any:
    return planning.add_worklog(
        args.task_id,
        WorkLogInput(
            actual_minutes=args.actual_minutes,
            cause=args.cause,
            note=args.note,
            reflection=args.reflection,
            started_at=args.started_at,
            ended_at=args.ended_at,
            complete=args.complete,
        ),
        ctx.db,
        ctx.user,
    )


def _update_worklog(ctx: ToolContext, args: WorkLogUpdateArgs) -> Any:
    return planning.update_worklog(
        args.worklog_id,
        WorkLogUpdate(cause=args.cause, note=args.note, reflection=args.reflection),
        ctx.db,
        ctx.user,
    )


def _create_task_list(ctx: ToolContext, args: TaskListInput) -> Any:
    return planning.create_task_list(args, ctx.db, ctx.user)


def _update_task_list(ctx: ToolContext, args: UpdateTaskListArgs) -> Any:
    return planning.update_task_list(
        args.list_id,
        TaskListInput(name=args.name, color=args.color, group_id=args.group_id),
        ctx.db,
        ctx.user,
    )


def _delete_task_list(ctx: ToolContext, args: TaskListIdArgs) -> Any:
    planning.delete_task_list(args.list_id, ctx.db, ctx.user)
    return {"id": args.list_id, "deleted": True}


def _create_group(ctx: ToolContext, args: TaskListGroupInput) -> Any:
    return planning.create_task_list_group(args, ctx.db, ctx.user)


def _update_group(ctx: ToolContext, args: UpdateTaskListGroupArgs) -> Any:
    return planning.update_task_list_group(
        args.group_id, TaskListGroupInput(name=args.name), ctx.db, ctx.user
    )


def _delete_group(ctx: ToolContext, args: GroupIdArgs) -> Any:
    planning.delete_task_list_group(args.group_id, ctx.db, ctx.user)
    return {"id": args.group_id, "deleted": True}


def _rename_tag(ctx: ToolContext, args: RenameTagArgs) -> Any:
    return planning.rename_tag(args.tag_id, TagInput(name=args.name), ctx.db, ctx.user)


def _delete_tag(ctx: ToolContext, args: TagIdArgs) -> Any:
    planning.delete_tag(args.tag_id, ctx.db, ctx.user)
    return {"id": args.tag_id, "deleted": True}


def _create_filter(ctx: ToolContext, args: SavedFilterInput) -> Any:
    return planning.create_saved_filter(args, ctx.db, ctx.user)


def _update_filter(ctx: ToolContext, args: UpdateSavedFilterArgs) -> Any:
    return planning.update_saved_filter(
        args.filter_id,
        SavedFilterInput(name=args.name, payload=args.payload),
        ctx.db,
        ctx.user,
    )


def _delete_filter(ctx: ToolContext, args: FilterIdArgs) -> Any:
    planning.delete_saved_filter(args.filter_id, ctx.db, ctx.user)
    return {"id": args.filter_id, "deleted": True}


def _create_event(ctx: ToolContext, args: EventInput) -> Any:
    return base_routes.create_event(args, ctx.db, ctx.user)


def _update_event(ctx: ToolContext, args: UpdateEventArgs) -> Any:
    current = current_event_input(ctx.db, ctx.user, args.event_id)
    data = current.model_dump(mode="json")
    data.update(
        {
            key: value
            for key, value in args.model_dump(mode="json", exclude_unset=True).items()
            if key != "event_id"
        }
    )
    return base_routes.update_event(
        args.event_id, EventInput.model_validate(data), ctx.db, ctx.user
    )


def _delete_event(ctx: ToolContext, args: EventIdArgs) -> Any:
    planning.delete_event(args.event_id, base_routes_confirm(), ctx.db, ctx.user)
    return {"id": args.event_id, "deleted": True}


def _skip_event(ctx: ToolContext, args: SkipEventArgs) -> Any:
    return planning.skip_event(
        args.event_id,
        SkipInput(is_skipped=args.is_skipped, confirmed=True),
        ctx.db,
        ctx.user,
    )


def _create_course(ctx: ToolContext, args: CourseInput) -> Any:
    return base_routes.create_course(args, ctx.db, ctx.user)


def _update_course(ctx: ToolContext, args: UpdateCourseArgs) -> Any:
    return planning.edit_course(
        args.course_id, CourseInput(name=args.name, semester=args.semester), ctx.db, ctx.user
    )


def _delete_course(ctx: ToolContext, args: CourseIdArgs) -> Any:
    planning.delete_course(args.course_id, base_routes_confirm(), ctx.db, ctx.user)
    return {"id": args.course_id, "deleted": True}


def _create_series(ctx: ToolContext, args: CreateSeriesArgs, action_id: str = "") -> Any:
    body = SeriesInput(
        course_id=args.course_id,
        start_date=args.start_date,
        end_date=args.end_date,
        weekdays=args.weekdays,
        start_time=args.start_time,
        end_time=args.end_time,
        timezone=args.timezone,
        location=args.location,
        note=args.note,
        details=args.details,
        idempotency_key=f"agent-series:{action_id}",
    )
    return planning.add_series(body, ctx.db, ctx.user)


def _update_series(ctx: ToolContext, args: UpdateSeriesArgs) -> Any:
    return planning.edit_series(
        args.series_id,
        SeriesEdit(
            confirmed=True,
            start_time=args.start_time,
            end_time=args.end_time,
            location=args.location,
            note=args.note,
            details=args.details,
        ),
        ctx.db,
        ctx.user,
    )


def _delete_series(ctx: ToolContext, args: SeriesIdArgs) -> Any:
    planning.delete_series(args.series_id, base_routes_confirm(), ctx.db, ctx.user)
    return {"id": args.series_id, "deleted": True}


def _series_attendance(ctx: ToolContext, args: SeriesAttendanceArgs) -> Any:
    return planning.series_attendance(
        args.series_id,
        SkipInput(is_skipped=args.is_skipped, confirmed=True),
        ctx.db,
        ctx.user,
    )


def _update_profile(ctx: ToolContext, args: UpdateProfileArgs) -> Any:
    data = {
        "timezone": ctx.user.timezone,
        "available_windows": ctx.user.available_windows,
        "rest_windows": ctx.user.rest_windows,
    }
    data.update(args.model_dump(exclude_unset=True))
    return base_routes.update_profile(ProfileInput.model_validate(data), ctx.db, ctx.user)


def _create_rule(ctx: ToolContext, args: RuleInput) -> Any:
    return planning.add_rule(args, ctx.db, ctx.user)


def _disable_rule(ctx: ToolContext, args: RuleIdArgs) -> Any:
    planning.disable_rule(args.rule_id, ctx.db, ctx.user)
    return {"id": args.rule_id, "disabled": True}


def _type_policy(ctx: ToolContext, args: TypePolicyInput) -> Any:
    return planning.type_policy(args, ctx.db, ctx.user)


def _create_event_type(ctx: ToolContext, args: EventTypeInput) -> Any:
    return event_types_api.create_event_type(args, ctx.db, ctx.user)


def _update_event_type(ctx: ToolContext, args: UpdateEventTypeArgs) -> Any:
    return event_types_api.update_event_type(
        args.event_type_id, EventTypeInput(name=args.name, color=args.color), ctx.db, ctx.user
    )


def _archive_event_type(ctx: ToolContext, args: EventTypeIdArgs) -> Any:
    event_types_api.delete_event_type(args.event_type_id, ctx.db, ctx.user)
    return {"id": args.event_type_id, "archived": True}


def _generate_plan(ctx: ToolContext, args: CreatePlanArgs, action_id: str = "") -> Any:
    plan = scheduling.generate(
        ctx.db,
        ctx.user,
        PlanInput(
            start_at=args.start_at,
            end_at=args.end_at,
            min_block_minutes=args.min_block_minutes,
            max_block_minutes=args.max_block_minutes,
            idempotency_key=f"agent-plan:{action_id}",
        ),
    )
    return scheduling.view(ctx.db, ctx.user, plan)


def _adopt_plan(ctx: ToolContext, args: PlanIdArgs) -> Any:
    return scheduling.view(ctx.db, ctx.user, scheduling.adopt_plan(ctx.db, ctx.user, args.plan_id))


def _start_import(ctx: ToolContext, args: StartImportArgs, action_id: str = "") -> Any:
    body = ImportText(
        text=args.text,
        context=args.context,
        reference_at=args.reference_at or datetime.now().astimezone(),
        idempotency_key=f"agent-import:{action_id}",
        confirmed=True,
        parse=True,
    )
    return imports_api.create_job(ctx.db, ctx.user, ctx.settings, body)


def _create_draft(ctx: ToolContext, args: DraftPayload) -> Any:
    return planning.create_draft(DraftInput(payload=args), ctx.db, ctx.user)


def _publish_draft(ctx: ToolContext, args: PublishDraftArgs, action_id: str = "") -> Any:
    return planning.publish_draft(
        args.draft_id,
        PublishInput(revision=args.revision, idempotency_key=f"agent-draft:{action_id}"),
        ctx.db,
        ctx.user,
    )


def base_routes_confirm() -> Any:
    from app.api.schemas import ConfirmInput

    return ConfirmInput(confirmed=True)


def _summary(prefix: str) -> Callable[[Any], str]:
    return lambda args: prefix


TOOLS: dict[str, ToolSpec] = {}


def register(tool: ToolSpec) -> None:
    TOOLS[tool.name] = tool


def tool_schemas(include_images: bool = False) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.args.model_json_schema(),
            },
        }
        for tool in TOOLS.values()
        if include_images or not tool.image_only
    ]


# Read tools
register(
    ToolSpec(
        "get_profile",
        "读取当前用户的时区、每周可用时间和休息时间。",
        READ,
        NoArgs,
        lambda ctx, _: base_routes.profile(ctx.user),
        _summary("读取个人设置"),
    )
)
register(
    ToolSpec(
        "get_task_summary",
        "读取今日、逾期、旗标、垃圾箱等任务数量汇总。",
        READ,
        NoArgs,
        lambda ctx, _: planning.task_summary(db=ctx.db, user=ctx.user),
        _summary("读取任务汇总"),
    )
)
register(
    ToolSpec(
        "search_tasks",
        "按视图、关键词、状态、清单、标签、旗标筛选任务，最多返回 100 条。",
        READ,
        ReadTasksArgs,
        _read_tasks,
        _summary("查询任务"),
    )
)
register(
    ToolSpec(
        "get_task",
        "读取单个任务详情，包括子任务、依赖、标签和阻塞信息。",
        READ,
        TaskIdArgs,
        _read_task,
        _summary("读取任务详情"),
    )
)
register(
    ToolSpec(
        "list_task_lists",
        "列出全部任务清单及其文件夹。",
        READ,
        NoArgs,
        lambda ctx, _: planning.list_task_lists(db=ctx.db, user=ctx.user),
        _summary("读取清单"),
    )
)
register(
    ToolSpec(
        "list_task_list_groups",
        "列出清单文件夹。",
        READ,
        NoArgs,
        lambda ctx, _: planning.list_task_list_groups(db=ctx.db, user=ctx.user),
        _summary("读取清单文件夹"),
    )
)
register(
    ToolSpec(
        "list_tags",
        "列出全部标签及使用次数。",
        READ,
        NoArgs,
        lambda ctx, _: planning.list_tags(db=ctx.db, user=ctx.user),
        _summary("读取标签"),
    )
)
register(
    ToolSpec(
        "list_saved_filters",
        "列出保存的任务筛选。",
        READ,
        NoArgs,
        lambda ctx, _: planning.list_saved_filters(db=ctx.db, user=ctx.user),
        _summary("读取保存筛选"),
    )
)
register(
    ToolSpec(
        "list_events",
        "按时间范围列出事件和课程，最多 200 条。",
        READ,
        ReadEventsArgs,
        _read_events,
        _summary("查询日历"),
    )
)
register(
    ToolSpec(
        "list_courses",
        "列出课程。",
        READ,
        NoArgs,
        lambda ctx, _: base_routes.list_courses(db=ctx.db, user=ctx.user),
        _summary("读取课程"),
    )
)
register(
    ToolSpec(
        "list_series",
        "列出重复课程系列。",
        READ,
        NoArgs,
        lambda ctx, _: planning.list_series(db=ctx.db, user=ctx.user),
        _summary("读取重复课程"),
    )
)
register(
    ToolSpec(
        "list_event_types",
        "列出事件类型。",
        READ,
        NoArgs,
        lambda ctx, _: event_types_api.list_event_types(db=ctx.db, user=ctx.user),
        _summary("读取事件类型"),
    )
)
register(
    ToolSpec(
        "get_current_plan",
        "读取当前已采用的学习计划。",
        READ,
        NoArgs,
        _read_plan,
        _summary("读取当前计划"),
    )
)
register(
    ToolSpec(
        "list_imports",
        "列出导入记录与草稿状态。",
        READ,
        NoArgs,
        _read_imports,
        _summary("读取导入记录"),
    )
)
register(
    ToolSpec(
        "list_task_attachments",
        "列出任务的全部附件元数据，包括文件名、类型和大小。",
        READ,
        TaskIdArgs,
        _list_task_attachments,
        _summary("读取任务附件"),
    )
)
register(
    ToolSpec(
        "read_task_images",
        "读取任务附件中的全部图片，图片会随回复一起发送给模型。",
        READ,
        TaskIdArgs,
        _read_task_images,
        _summary("读取任务图片"),
        image_only=True,
    )
)
register(
    ToolSpec(
        "read_import_image",
        "读取导入来源的原始图片，图片会随回复一起发送给模型。",
        READ,
        JobIdArgs,
        _read_import_image,
        _summary("读取导入图片"),
        image_only=True,
    )
)
register(
    ToolSpec(
        "list_drafts",
        "列出可编辑的任务草稿。",
        READ,
        NoArgs,
        lambda ctx, _: planning.list_drafts(db=ctx.db, user=ctx.user),
        _summary("读取任务草稿"),
    )
)
register(
    ToolSpec(
        "check_compatibility",
        "检查两项活动是否可以并行。",
        READ,
        CompatibilityArgs,
        lambda ctx, args: planning.compatibility(args, ctx.db, ctx.user),
        _summary("检查并行兼容性"),
    )
)

# Task write tools
register(
    ToolSpec(
        "create_task",
        "创建任务。可设置截止、优先级、标签、清单、预计用时、重复和依赖。",
        WRITE,
        TaskInput,
        _create_task,
        lambda args: f"创建任务「{args.title}」",
        "medium",
    )
)
register(
    ToolSpec(
        "update_task",
        "修改任务。只需提供要修改的字段，其余保持当前值。",
        WRITE,
        UpdateTaskArgs,
        _update_task,
        lambda args: f"修改任务「{args.title or args.task_id}」",
        "medium",
    )
)
register(
    ToolSpec(
        "complete_task",
        "把任务标记为完成。",
        WRITE,
        TaskIdArgs,
        _complete_task,
        lambda args: "完成任务",
        "medium",
    )
)
register(
    ToolSpec(
        "reopen_task",
        "把已完成任务恢复为待办。",
        WRITE,
        TaskIdArgs,
        _reopen_task,
        lambda args: "恢复任务为待办",
        "medium",
    )
)
register(
    ToolSpec(
        "set_task_deadline",
        "修改任务截止时间或清除截止。",
        WRITE,
        DeadlineArgs,
        _deadline,
        lambda args: "修改任务截止时间",
        "medium",
    )
)
register(
    ToolSpec(
        "set_task_reminder",
        "修改或清除任务提醒时间。",
        WRITE,
        ReminderArgs,
        _reminder,
        lambda args: "修改任务提醒",
        "low",
    )
)
register(
    ToolSpec(
        "flag_task",
        "设置或取消任务旗标。",
        WRITE,
        FlagArgs,
        _flag,
        lambda args: "设置任务旗标",
        "low",
    )
)
register(
    ToolSpec(
        "trash_task",
        "把任务移入垃圾箱，可在 30 天内恢复。",
        WRITE,
        TaskIdArgs,
        _trash,
        lambda args: "移入垃圾箱",
        "medium",
    )
)
register(
    ToolSpec(
        "restore_task",
        "从垃圾箱恢复任务。",
        WRITE,
        TaskIdArgs,
        _restore,
        lambda args: "恢复垃圾箱中的任务",
        "medium",
    )
)
register(
    ToolSpec(
        "purge_task",
        "永久删除垃圾箱中的单个任务，不可恢复。",
        WRITE,
        TaskIdArgs,
        _purge,
        lambda args: "永久删除单个任务（不可恢复）",
        "high",
    )
)
register(
    ToolSpec(
        "purge_trash",
        "清空垃圾箱，永久删除全部任务，不可恢复。",
        WRITE,
        NoArgs,
        _purge_trash,
        lambda _: "清空垃圾箱（不可恢复）",
        "high",
    )
)
register(
    ToolSpec(
        "add_worklog",
        "记录任务实际耗时、原因和反思，可选择同时完成任务。",
        WRITE,
        WorkLogArgs,
        _worklog,
        lambda args: f"记录 {args.actual_minutes} 分钟实际用时",
        "medium",
    )
)
register(
    ToolSpec(
        "update_worklog",
        "修改工作日志的原因、备注或反思。",
        WRITE,
        WorkLogUpdateArgs,
        _update_worklog,
        lambda args: "修改工作日志",
        "medium",
    )
)

# Lists, groups, tags and filters
register(
    ToolSpec(
        "create_task_list",
        "创建任务清单。",
        WRITE,
        TaskListInput,
        _create_task_list,
        lambda args: f"创建清单「{args.name}」",
        "low",
    )
)
register(
    ToolSpec(
        "update_task_list",
        "修改清单名称、颜色或所属文件夹。",
        WRITE,
        UpdateTaskListArgs,
        _update_task_list,
        lambda args: f"修改清单「{args.name}」",
        "medium",
    )
)
register(
    ToolSpec(
        "delete_task_list",
        "删除清单，任务会保留但不再属于该清单。",
        WRITE,
        TaskListIdArgs,
        _delete_task_list,
        lambda args: "删除清单",
        "medium",
    )
)
register(
    ToolSpec(
        "create_task_list_group",
        "创建清单文件夹。",
        WRITE,
        TaskListGroupInput,
        _create_group,
        lambda args: f"创建清单文件夹「{args.name}」",
        "low",
    )
)
register(
    ToolSpec(
        "update_task_list_group",
        "重命名清单文件夹。",
        WRITE,
        UpdateTaskListGroupArgs,
        _update_group,
        lambda args: f"重命名清单文件夹「{args.name}」",
        "medium",
    )
)
register(
    ToolSpec(
        "delete_task_list_group",
        "删除清单文件夹，清单会保留。",
        WRITE,
        GroupIdArgs,
        _delete_group,
        lambda args: "删除清单文件夹",
        "medium",
    )
)
register(
    ToolSpec(
        "rename_tag",
        "重命名标签。",
        WRITE,
        RenameTagArgs,
        _rename_tag,
        lambda args: f"重命名标签为「{args.name}」",
        "medium",
    )
)
register(
    ToolSpec(
        "delete_tag",
        "删除标签。",
        WRITE,
        TagIdArgs,
        _delete_tag,
        lambda args: "删除标签",
        "medium",
    )
)
register(
    ToolSpec(
        "create_saved_filter",
        "保存当前任务筛选。",
        WRITE,
        SavedFilterInput,
        _create_filter,
        lambda args: f"保存筛选「{args.name}」",
        "low",
    )
)
register(
    ToolSpec(
        "update_saved_filter",
        "修改保存的任务筛选。",
        WRITE,
        UpdateSavedFilterArgs,
        _update_filter,
        lambda args: f"修改筛选「{args.name}」",
        "medium",
    )
)
register(
    ToolSpec(
        "delete_saved_filter",
        "删除保存的筛选。",
        WRITE,
        FilterIdArgs,
        _delete_filter,
        lambda args: "删除保存筛选",
        "medium",
    )
)

# Calendar writes
register(
    ToolSpec(
        "create_event",
        "创建单次事件，例如会议、考试或其他安排。",
        WRITE,
        EventInput,
        _create_event,
        lambda args: f"创建事件「{args.title}」",
        "medium",
    )
)
register(
    ToolSpec(
        "update_event",
        "修改单次事件，只需提供要修改的字段。",
        WRITE,
        UpdateEventArgs,
        _update_event,
        lambda args: f"修改事件「{args.title or args.event_id}」",
        "medium",
    )
)
register(
    ToolSpec(
        "delete_event",
        "删除单次事件，不可恢复。",
        WRITE,
        EventIdArgs,
        _delete_event,
        lambda args: "删除事件（不可恢复）",
        "high",
    )
)
register(
    ToolSpec(
        "skip_event",
        "标记或恢复单次课程不参加。",
        WRITE,
        SkipEventArgs,
        _skip_event,
        lambda args: "标记课程是否参加",
        "medium",
    )
)
register(
    ToolSpec(
        "create_course",
        "创建课程。通常还需要创建重复课程系列。",
        WRITE,
        CourseInput,
        _create_course,
        lambda args: f"创建课程「{args.name}」",
        "medium",
    )
)
register(
    ToolSpec(
        "update_course",
        "修改课程名称或学期。",
        WRITE,
        UpdateCourseArgs,
        _update_course,
        lambda args: f"修改课程「{args.name}」",
        "medium",
    )
)
register(
    ToolSpec(
        "delete_course",
        "删除空课程，不可恢复；课程下不能有事件或系列。",
        WRITE,
        CourseIdArgs,
        _delete_course,
        lambda args: "删除课程（不可恢复）",
        "high",
    )
)
register(
    ToolSpec(
        "create_series",
        "创建每周重复课程系列，系统会展开为各周事件。",
        WRITE,
        CreateSeriesArgs,
        _create_series,
        lambda args: "创建重复课程系列",
        "medium",
    )
)
register(
    ToolSpec(
        "update_series",
        "修改重复课程系列的时间、地点和备注。",
        WRITE,
        UpdateSeriesArgs,
        _update_series,
        lambda args: "修改重复课程系列",
        "medium",
    )
)
register(
    ToolSpec(
        "delete_series",
        "删除重复课程系列及其全部事件，不可恢复。",
        WRITE,
        SeriesIdArgs,
        _delete_series,
        lambda args: "删除重复课程系列（不可恢复）",
        "high",
    )
)
register(
    ToolSpec(
        "set_series_attendance",
        "批量标记整个重复课程系列是否参加。",
        WRITE,
        SeriesAttendanceArgs,
        _series_attendance,
        lambda args: "批量设置课程出勤",
        "medium",
    )
)

# Rules, settings and event types
register(
    ToolSpec(
        "update_profile",
        "修改时区、每周可用时间或休息时间。",
        WRITE,
        UpdateProfileArgs,
        _update_profile,
        lambda args: "修改个人设置与可用时间",
        "high",
    )
)
register(
    ToolSpec(
        "create_compatibility_rule",
        "创建活动并行兼容规则。",
        WRITE,
        RuleInput,
        _create_rule,
        lambda args: "创建并行兼容规则",
        "high",
    )
)
register(
    ToolSpec(
        "disable_compatibility_rule",
        "停用并行兼容规则。",
        WRITE,
        RuleIdArgs,
        _disable_rule,
        lambda args: "停用并行兼容规则",
        "high",
    )
)
register(
    ToolSpec(
        "set_task_type_policy",
        "设置任务类型的默认并行策略。",
        WRITE,
        TypePolicyInput,
        _type_policy,
        lambda args: f"设置任务类型「{args.task_type}」并行策略",
        "high",
    )
)
register(
    ToolSpec(
        "create_event_type",
        "创建自定义事件类型。",
        WRITE,
        EventTypeInput,
        _create_event_type,
        lambda args: f"创建事件类型「{args.name}」",
        "low",
    )
)
register(
    ToolSpec(
        "update_event_type",
        "修改自定义事件类型。",
        WRITE,
        UpdateEventTypeArgs,
        _update_event_type,
        lambda args: f"修改事件类型「{args.name}」",
        "medium",
    )
)
register(
    ToolSpec(
        "archive_event_type",
        "归档自定义事件类型。",
        WRITE,
        EventTypeIdArgs,
        _archive_event_type,
        lambda args: "归档事件类型",
        "medium",
    )
)

# Plans, imports and drafts
register(
    ToolSpec(
        "generate_plan",
        "根据任务、截止、依赖和可用时间生成学习计划草稿。",
        WRITE,
        CreatePlanArgs,
        _generate_plan,
        lambda args: "生成学习计划草稿",
        "medium",
    )
)
register(
    ToolSpec(
        "adopt_plan",
        "采用一份计划草稿作为当前计划。",
        WRITE,
        PlanIdArgs,
        _adopt_plan,
        lambda args: "采用学习计划",
        "high",
    )
)
register(
    ToolSpec(
        "start_text_import",
        "把一段文本发送给模型解析为任务/事件/课程草稿，需要用户确认数据外发。",
        WRITE,
        StartImportArgs,
        _start_import,
        lambda args: "发起文本导入解析（会把内容发送给模型）",
        "high",
    )
)
register(
    ToolSpec(
        "create_draft",
        "保存一个任务草稿，稍后再发布。",
        WRITE,
        DraftPayload,
        _create_draft,
        lambda args: f"保存任务草稿「{args.title}」",
        "low",
    )
)
register(
    ToolSpec(
        "publish_draft",
        "发布任务草稿为正式任务。",
        WRITE,
        PublishDraftArgs,
        _publish_draft,
        lambda args: "发布任务草稿",
        "medium",
    )
)


def execute_tool(ctx: ToolContext, name: str, raw: dict[str, Any], action_id: str = "") -> Any:
    tool = TOOLS.get(name)
    if tool is None:
        raise HTTPException(404, "未知的 Agent 工具")
    if tool.kind == READ:
        return _dump(tool.execute(ctx, tool.args.model_validate(raw)))
    handler = tool.execute
    if name in {"create_series", "generate_plan", "start_text_import", "publish_draft"}:
        return _dump(handler(ctx, tool.args.model_validate(raw), action_id))
    return _dump(handler(ctx, tool.args.model_validate(raw)))


def validate_tool(name: str, raw: dict[str, Any]) -> Schema:
    tool = TOOLS.get(name)
    if tool is None:
        raise HTTPException(404, "未知的 Agent 工具")
    return tool.args.model_validate(raw)


def tool_summary(name: str, args: Schema) -> str:
    tool = TOOLS.get(name)
    if tool is None:
        return name
    return tool.summarize(args)


def tool_risk(name: str) -> Risk:
    tool = TOOLS.get(name)
    return tool.risk if tool else "high"
