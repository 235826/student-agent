from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import EventTypeOut, EventTypeRef
from app.db.models import Event, EventType, User, now_ms
from app.modules.records import owned

SYSTEM_TYPES: tuple[tuple[str, str, str], ...] = (
    ("exam", "考试", "#cf1322"),
    ("meeting", "会议", "#d46b08"),
    ("other", "其他", "#8c8c8c"),
)

RESERVED_NAMES = {"课程", "每周课程", "考试", "会议", "其他"}


def ensure_system_types(db: Session, user: User) -> dict[str, EventType]:
    existing: dict[str, EventType] = {
        event_type.system_key: event_type
        for event_type in db.scalars(
            select(EventType).where(
                EventType.workspace_id == user.workspace_id,
                EventType.system_key.is_not(None),
            )
        )
        if event_type.system_key is not None
    }
    for key, name, color in SYSTEM_TYPES:
        if key not in existing:
            event_type = EventType(
                workspace_id=user.workspace_id,
                name=name,
                color=color,
                system_key=key,
            )
            db.add(event_type)
            db.flush()
            existing[key] = event_type
    return existing


def resolve_event_type(
    db: Session,
    user: User,
    *,
    kind: str,
    event_type_id: str | None,
    series_id: str | None = None,
) -> EventType | None:
    if kind == "course" or series_id:
        if event_type_id:
            raise HTTPException(422, "课程事件不能使用自定义事件类型")
        return None
    if event_type_id:
        event_type = owned(db, EventType, event_type_id, user)
        if event_type.archived_at is not None:
            raise HTTPException(409, "该事件类型已归档，请选择其他类型")
        return event_type
    return ensure_system_types(db, user)["other"]


def event_type_ref(event_type: EventType | None) -> EventTypeRef | None:
    if event_type is None:
        return None
    return EventTypeRef.model_validate(event_type)


def event_type_out(db: Session, event_type: EventType) -> EventTypeOut:
    usage_count = db.scalar(
        select(func.count(Event.id)).where(Event.event_type_id == event_type.id)
    )
    return EventTypeOut.model_validate(
        {
            "id": event_type.id,
            "name": event_type.name,
            "color": event_type.color,
            "system_key": event_type.system_key,
            "archived_at": event_type.archived_at,
            "usage_count": usage_count or 0,
        }
    )


def archive_event_type(db: Session, user: User, event_type_id: str) -> EventType:
    event_type = owned(db, EventType, event_type_id, user)
    if event_type.system_key is not None:
        raise HTTPException(409, "内置事件类型不能归档")
    if event_type.archived_at is None:
        event_type.archived_at = now_ms()
    return event_type
