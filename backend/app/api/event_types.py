from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import EventTypeInput, EventTypeOut
from app.db.models import EventType, User
from app.modules.event_types import (
    RESERVED_NAMES,
    archive_event_type,
    ensure_system_types,
    event_type_out,
)
from app.modules.records import owned, record_change
from app.modules.security import DB, UserDep

router = APIRouter(prefix="/api/v1/event-types")


def duplicate_name(db: Session, user: User, name: str, exclude: str | None = None) -> bool:
    query = select(EventType.id).where(
        EventType.workspace_id == user.workspace_id, EventType.name == name
    )
    if exclude:
        query = query.where(EventType.id != exclude)
    return db.scalar(query) is not None


@router.get("", response_model=list[EventTypeOut])
def list_event_types(db: DB, user: UserDep, include_archived: bool = False) -> list[EventTypeOut]:
    ensure_system_types(db, user)
    query = select(EventType).where(EventType.workspace_id == user.workspace_id)
    if not include_archived:
        query = query.where(EventType.archived_at.is_(None))
    types = list(db.scalars(query.order_by(EventType.system_key.is_(None), EventType.created_at)))
    return [event_type_out(db, event_type) for event_type in types]


@router.post("", response_model=EventTypeOut, status_code=201)
def create_event_type(body: EventTypeInput, db: DB, user: UserDep) -> EventTypeOut:
    ensure_system_types(db, user)
    if body.name in RESERVED_NAMES:
        raise HTTPException(409, "该名称是保留类型，请使用其他名称")
    if duplicate_name(db, user, body.name):
        raise HTTPException(409, "事件类型名称已存在")
    event_type = EventType(
        workspace_id=user.workspace_id,
        name=body.name,
        color=body.color,
    )
    db.add(event_type)
    db.flush()
    record_change(db, user, "event_type.create", event_type, scheduling=False)
    return event_type_out(db, event_type)


@router.put("/{event_type_id}", response_model=EventTypeOut)
def update_event_type(
    event_type_id: str, body: EventTypeInput, db: DB, user: UserDep
) -> EventTypeOut:
    event_type = owned(db, EventType, event_type_id, user)
    if event_type.system_key is not None:
        raise HTTPException(409, "内置事件类型不能修改")
    if body.name in RESERVED_NAMES:
        raise HTTPException(409, "该名称是保留类型，请使用其他名称")
    if duplicate_name(db, user, body.name, exclude=event_type.id):
        raise HTTPException(409, "事件类型名称已存在")
    event_type.name = body.name
    event_type.color = body.color
    record_change(db, user, "event_type.update", event_type, scheduling=False)
    return event_type_out(db, event_type)


@router.delete("/{event_type_id}", status_code=204)
def delete_event_type(event_type_id: str, db: DB, user: UserDep) -> Response:
    event_type = archive_event_type(db, user, event_type_id)
    record_change(db, user, "event_type.archive", event_type, scheduling=False)
    return Response(status_code=204)
