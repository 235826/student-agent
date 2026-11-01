from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.api.schemas import (
    CompatibilityInput,
    CompatibilityOut,
    ConfirmInput,
    CourseInput,
    CourseOut,
    DeadlineInput,
    DraftInput,
    DraftOut,
    DraftUpdate,
    EventOut,
    EventPolicyInput,
    PolicyInput,
    PublishInput,
    RuleInput,
    RuleOut,
    SeriesEdit,
    SeriesInput,
    SeriesOut,
    SkipInput,
    TagOut,
    TaskInput,
    TaskListInput,
    TaskListOut,
    TaskOrderInput,
    TaskOut,
    TypePolicyInput,
    TypePolicyOut,
    WorkLogInput,
    WorkLogOut,
    WorkLogUpdate,
)
from app.db.models import (
    CompatibilityRule,
    Course,
    Draft,
    Event,
    EventOverride,
    EventSeries,
    Tag,
    Task,
    TaskList,
    TaskTag,
    TaskTypePolicy,
    User,
    WorkLog,
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
    require_impact_confirmation,
    task_input,
    task_view,
    validate_links,
)

router = APIRouter(prefix="/api/v1")


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
    task_list = TaskList(
        workspace_id=user.workspace_id,
        name=body.name,
        color=body.color,
    )
    db.add(task_list)
    record_change(db, user, "task_list.create", task_list)
    return task_list


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
    task_list.name = body.name
    task_list.color = body.color
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


@router.get("/tags", response_model=list[TagOut])
def list_tags(db: DB, user: UserDep) -> list[Tag]:
    return list(
        db.scalars(select(Tag).where(Tag.workspace_id == user.workspace_id).order_by(Tag.name))
    )


@router.delete("/tags/{tag_id}", status_code=204)
def delete_tag(tag_id: str, db: DB, user: UserDep) -> None:
    tag = owned(db, Tag, tag_id, user)
    db.execute(delete(TaskTag).where(TaskTag.tag_id == tag_id))
    remove_record(db, user, "tag.delete", tag)


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(db: DB, user: UserDep, trashed: bool = False) -> list[TaskOut]:
    query = select(Task).where(Task.workspace_id == user.workspace_id)
    query = query.where(Task.trashed_at.is_not(None) if trashed else Task.trashed_at.is_(None))
    return [
        task_view(db, t)
        for t in db.scalars(query.order_by(Task.sort_order, Task.created_at.desc(), Task.id))
    ]


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
def trash_task(task_id: str, db: DB, user: UserDep, confirm_impact: bool = False) -> TaskOut:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is None:
        require_impact_confirmation(db, task, confirm_impact)
        task.trashed_at = now_ms()
        record_change(db, user, "task.trash", task)
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


@router.patch("/tasks/{task_id}/deadline", response_model=TaskOut)
def update_deadline(task_id: str, body: DeadlineInput, db: DB, user: UserDep) -> TaskOut:
    task = active_task(db, user, task_id)
    task.deadline_at = int(body.deadline_at.timestamp() * 1000) if body.deadline_at else None
    task.deadline_all_day = body.deadline_all_day if body.deadline_at else False
    record_change(db, user, "task.deadline", task)
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


@router.get("/tasks/{task_id}/worklogs", response_model=list[WorkLogOut])
def list_worklogs(task_id: str, db: DB, user: UserDep) -> list[WorkLogOut]:
    owned_task(db, user, task_id)
    return [
        WorkLogOut.model_validate(log)
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
        record_change(db, user, "task.complete", task)
    return WorkLogOut.model_validate(log)


@router.put("/worklogs/{worklog_id}", response_model=WorkLogOut)
def update_worklog(worklog_id: str, body: WorkLogUpdate, db: DB, user: UserDep) -> WorkLogOut:
    log = owned(db, WorkLog, worklog_id, user)
    for key, value in body.model_dump(exclude_none=True).items():
        setattr(log, key, value)
    record_change(db, user, "worklog.update", log, scheduling=False)
    return WorkLogOut.model_validate(log)


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
    return event_view(db, event)


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


@router.delete("/events/{event_id}", status_code=204)
def delete_event(event_id: str, body: ConfirmInput, db: DB, user: UserDep) -> None:
    event = owned(db, Event, event_id, user)
    override = instance_override(db, event)
    if override:
        db.delete(override)
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
    for event in db.scalars(select(Event).where(Event.series_id == series.id)):
        db.delete(event)
    db.flush()
    remove_record(db, user, "series.delete", series)
