from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import DataImportPreview
from app.db.models import (
    ActivityFeedback,
    CompatibilityRule,
    Course,
    Draft,
    Event,
    EventOverride,
    EventSeries,
    EventType,
    Plan,
    SavedFilter,
    Tag,
    Task,
    TaskDependency,
    TaskList,
    TaskListGroup,
    TaskTag,
    TaskTypePolicy,
    User,
    WorkLog,
    WorkLogContext,
)

VERSION = "student-agent/v1"

COLLECTIONS: dict[str, type[Any]] = {
    "tasks": Task,
    "task_list_groups": TaskListGroup,
    "task_lists": TaskList,
    "tags": Tag,
    "courses": Course,
    "event_types": EventType,
    "event_series": EventSeries,
    "events": Event,
    "event_overrides": EventOverride,
    "work_logs": WorkLog,
    "activity_feedback": ActivityFeedback,
    "plans": Plan,
    "drafts": Draft,
    "task_type_policies": TaskTypePolicy,
    "compatibility_rules": CompatibilityRule,
    "saved_filters": SavedFilter,
}


def scalar_row(model: type[Any], obj: Any) -> dict[str, Any]:
    return {
        column.name: getattr(obj, column.name)
        for column in model.__table__.columns
        if column.name != "workspace_id"
    }


def export_payload(db: Session, user: User) -> dict[str, Any]:
    workspace_id = user.workspace_id
    tasks = list(db.scalars(select(Task).where(Task.workspace_id == workspace_id)))
    task_ids = {task.id for task in tasks}
    tags_by_task: dict[str, list[str]] = {task_id: [] for task_id in task_ids}
    predecessors: dict[str, list[str]] = {task_id: [] for task_id in task_ids}
    for dependency in db.scalars(
        select(TaskDependency).where(TaskDependency.workspace_id == workspace_id)
    ):
        if dependency.successor_task_id in task_ids:
            predecessors.setdefault(dependency.successor_task_id, []).append(
                dependency.predecessor_task_id
            )
    for link in db.scalars(select(TaskTag).where(TaskTag.workspace_id == workspace_id)):
        tag = db.get(Tag, link.tag_id)
        if tag and link.task_id in tags_by_task:
            tags_by_task[link.task_id].append(tag.name)

    task_rows = []
    for task in tasks:
        row = scalar_row(Task, task)
        row["tags"] = sorted(tags_by_task.get(task.id, []))
        row["predecessor_ids"] = sorted(predecessors.get(task.id, []))
        task_rows.append(row)

    worklogs = []
    for log in db.scalars(select(WorkLog).where(WorkLog.workspace_id == workspace_id)):
        row = scalar_row(WorkLog, log)
        row["parallel_contexts"] = [
            {
                "object_kind": context.object_kind,
                "object_id": context.object_id,
            }
            for context in db.scalars(
                select(WorkLogContext)
                .where(WorkLogContext.work_log_id == log.id)
                .order_by(WorkLogContext.created_at, WorkLogContext.id)
            )
        ]
        worklogs.append(row)

    payload: dict[str, Any] = {
        "version": VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "profile": {
            "timezone": user.timezone,
            "available_windows": user.available_windows,
            "rest_windows": user.rest_windows,
        },
        "tasks": task_rows,
        "work_logs": worklogs,
    }
    for name, model in COLLECTIONS.items():
        if name in {"tasks", "work_logs"}:
            continue
        rows = list(db.scalars(select(model).where(model.workspace_id == workspace_id)))
        payload[name] = [scalar_row(model, row) for row in rows]
    return payload


def _list(payload: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = payload.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{key} 必须是对象数组")
    return value


def _ids(items: list[dict[str, Any]]) -> set[str]:
    return {str(item["id"]) for item in items if isinstance(item.get("id"), str) and item["id"]}


def validate_payload(db: Session, user: User, payload: dict[str, Any]) -> DataImportPreview:
    if not isinstance(payload, dict):
        raise ValueError("导入文件必须是 JSON 对象")
    version = str(payload.get("version", ""))
    if version != VERSION:
        raise ValueError(f"不支持的备份版本：{version or '空'}")
    warnings: list[str] = []
    if not isinstance(payload.get("profile"), dict):
        warnings.append("缺少偏好设置，导入时不会覆盖当前设置")
    collections = {
        name: _list(payload, name)
        for name in [
            "tasks",
            "work_logs",
            "task_list_groups",
            "task_lists",
            "tags",
            "courses",
            "event_types",
            "event_series",
            "events",
            "event_overrides",
            "activity_feedback",
            "plans",
            "drafts",
            "task_type_policies",
            "compatibility_rules",
            "saved_filters",
        ]
    }
    counts = {name: len(items) for name, items in collections.items()}

    task_ids = _ids(collections["tasks"])
    list_ids = _ids(collections["task_lists"])
    group_ids = _ids(collections["task_list_groups"])
    course_ids = _ids(collections["courses"])
    series_ids = _ids(collections["event_series"])
    event_ids = _ids(collections["events"])
    event_type_ids = _ids(collections["event_types"])
    worklog_ids = _ids(collections["work_logs"])
    for task in collections["tasks"]:
        for predecessor in task.get("predecessor_ids", []) or []:
            if predecessor not in task_ids:
                warnings.append(f"任务 {task.get('id')} 引用了不在备份中的前置任务 {predecessor}")
        if task.get("list_id") and task["list_id"] not in list_ids:
            warnings.append(f"任务 {task.get('id')} 引用了不在备份中的清单")
        if task.get("parent_id") and task["parent_id"] not in task_ids:
            warnings.append(f"任务 {task.get('id')} 引用了不在备份中的父任务")
    for task_list in collections["task_lists"]:
        if task_list.get("group_id") and task_list["group_id"] not in group_ids:
            warnings.append(f"清单 {task_list.get('id')} 引用了不在备份中的文件夹")
    for series in collections["event_series"]:
        if series.get("course_id") and series["course_id"] not in course_ids:
            warnings.append(f"每周课程 {series.get('id')} 引用了不在备份中的课程")
    for event in collections["events"]:
        if event.get("course_id") and event["course_id"] not in course_ids:
            warnings.append(f"事件 {event.get('id')} 引用了不在备份中的课程")
        if event.get("series_id") and event["series_id"] not in series_ids:
            warnings.append(f"事件 {event.get('id')} 引用了不在备份中的每周课程")
        if event.get("event_type_id") and event["event_type_id"] not in event_type_ids:
            warnings.append(f"事件 {event.get('id')} 引用了不在备份中的事件类型")
    for override in collections["event_overrides"]:
        if override.get("series_id") not in series_ids:
            warnings.append(f"单次调整 {override.get('id')} 引用了不在备份中的每周课程")
    for log in collections["work_logs"]:
        if log.get("task_id") not in task_ids:
            warnings.append(f"工作记录 {log.get('id')} 引用了不在备份中的任务")
        for context in log.get("parallel_contexts", []) or []:
            if not isinstance(context, dict):
                warnings.append(f"工作记录 {log.get('id')} 的并行情境格式不正确")
                continue
            target = context.get("object_id")
            if context.get("object_kind") == "event" and target not in event_ids:
                warnings.append(f"工作记录 {log.get('id')} 引用了不在备份中的事件")
            if context.get("object_kind") == "task" and target not in task_ids:
                warnings.append(f"工作记录 {log.get('id')} 引用了不在备份中的任务")
    for feedback in collections["activity_feedback"]:
        if feedback.get("event_id") not in event_ids:
            warnings.append(f"活动反馈 {feedback.get('id')} 引用了不在备份中的事件")
    if worklog_ids and len(worklog_ids) != len(collections["work_logs"]):
        warnings.append("部分工作记录缺少稳定 ID")

    conflicts: list[str] = []
    for name, model in COLLECTIONS.items():
        incoming = _ids(collections.get(name, []))
        if not incoming:
            continue
        existing = set(
            db.scalars(
                select(model.id).where(
                    model.workspace_id == user.workspace_id,
                    model.id.in_(incoming),
                )
            )
        )
        if existing:
            conflicts.append(f"{name}: {len(existing)} 条记录已存在")
    return DataImportPreview(
        version=version,
        counts=counts,
        warnings=warnings,
        conflicts=conflicts,
    )
