import hashlib
import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import IdempotentOperation, User


def fingerprint(payload: Any) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def replay(db: Session, user: User, key: str, payload: Any) -> str | None:
    operation = db.scalar(
        select(IdempotentOperation).where(
            IdempotentOperation.workspace_id == user.workspace_id, IdempotentOperation.key == key
        )
    )
    if operation:
        if operation.request_hash != fingerprint(payload):
            raise HTTPException(409, "同一幂等键不能用于不同的操作或内容")
        return operation.result_id
    return None


def remember(db: Session, user: User, key: str, payload: Any, result_id: str) -> None:
    db.add(
        IdempotentOperation(
            workspace_id=user.workspace_id,
            key=key,
            request_hash=fingerprint(payload),
            result_id=result_id,
        )
    )
