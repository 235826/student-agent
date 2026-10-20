from typing import Any, TypeVar

from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.db.models import Audit, Owned, User, Workspace

T = TypeVar("T", bound=Owned)


def owned[T: Owned](db: Session, model: type[T], object_id: str, user: User) -> T:
    obj = db.get(model, object_id)
    if obj is None or obj.workspace_id != user.workspace_id:
        raise HTTPException(404, "记录不存在")
    return obj


def record_change(db: Session, user: User, action: str, obj: Any) -> None:
    db.flush()
    db.add(Audit(workspace_id=user.workspace_id, action=action, object_id=obj.id))
    db.execute(
        update(Workspace)
        .where(Workspace.id == user.workspace_id)
        .values(
            scheduling_revision=Workspace.scheduling_revision + 1,
        )
    )
    db.commit()
    db.refresh(obj)
