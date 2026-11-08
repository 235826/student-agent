"""Resolve Agent action references and execute one confirmed action."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import User
from app.modules.agent.tools import ToolContext, execute_tool

PLACEHOLDER = "00000000-0000-0000-0000-000000000000"


def placeholder_refs(value: Any) -> Any:
    if isinstance(value, dict):
        if set(value) == {"$ref"}:
            return PLACEHOLDER
        return {key: placeholder_refs(item) for key, item in value.items()}
    if isinstance(value, list):
        return [placeholder_refs(item) for item in value]
    return value


def collect_refs(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        if set(value) == {"$ref"} and isinstance(value["$ref"], str):
            found.append(value["$ref"])
        else:
            for item in value.values():
                found.extend(collect_refs(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(collect_refs(item))
    return found


def resolve_refs(value: Any, results: dict[str, dict[str, Any]]) -> Any:
    if isinstance(value, dict):
        if set(value) == {"$ref"}:
            key = value["$ref"]
            result = results.get(key)
            if result is None:
                raise HTTPException(409, "依赖的步骤尚未确认执行，请先完成前面的动作")
            if "id" not in result:
                raise HTTPException(409, "依赖的步骤没有可引用的对象 ID，请调整操作")
            return result["id"]
        return {key: resolve_refs(item, results) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_refs(item, results) for item in value]
    return value


def execute_action(
    db: Session,
    user: User,
    settings: Settings,
    operation: str,
    payload: dict[str, Any],
    action_id: str,
    action_results: dict[str, dict[str, Any]],
) -> Any:
    resolved = resolve_refs(payload, action_results)
    context = ToolContext(db, user, settings, action_results)
    return execute_tool(context, operation, resolved, action_id)
