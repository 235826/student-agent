"""Agent run loop executed by the background worker."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from secrets import randbelow
from typing import Any, Protocol
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import Engine, func, or_, select
from sqlalchemy.orm import Session

from app.api import event_types as event_types_api
from app.config import Settings
from app.db.models import (
    AgentAction,
    AgentConversation,
    AgentImage,
    AgentMessage,
    AgentRun,
    TaskList,
    User,
    WorkerHeartbeat,
    now_ms,
)
from app.modules.agent.executor import collect_refs, placeholder_refs
from app.modules.agent.prompt import system_message
from app.modules.agent.tools import (
    TOOLS,
    LoadGroupArgs,
    ToolContext,
    check_tool,
    execute_tool,
    group_catalog,
    groups_for_surface,
    tool_names_for_groups,
    tool_render,
    tool_risk,
    tool_schemas,
    validate_tool,
)
from app.modules.records import record_change
from app.modules.task_management import apply_task, task_view
from app.providers.agent_chat import AgentReply
from app.providers.chat_completions import ParseFailure

MAX_RESULT_CHARS = 24000
MAX_TRANSCRIPT_MESSAGES = 80


class Provider(Protocol):
    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str], None] | None = None,
    ) -> AgentReply: ...


class RunCancelled(Exception):
    pass


def _encode_image(path: str, media_type: str) -> str:
    data = Path(path).read_bytes()
    return f"data:{media_type};base64,{base64.b64encode(data).decode()}"


def _sanitize_for_transcript(message: dict[str, Any]) -> dict[str, Any]:
    """Strip base64 image data from a message before storing in the transcript."""
    content = message.get("content")
    if isinstance(content, list):
        cleaned: list[dict[str, Any]] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "image_url":
                cleaned.append({"type": "text", "text": "[图片已省略]"})
            else:
                cleaned.append(part)
        return {**message, "content": cleaned}
    return message


def _serialize(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str)
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "…（结果过长已截断）"
    return text


def _tool_message(call_id: str, name: str, value: Any) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "name": name,
        "content": _serialize(value),
    }


def _extract_images(result: Any) -> list[dict[str, str]]:
    """Pop ``_images`` from a tool result dict, returning the image refs."""
    if not isinstance(result, dict):
        return []
    images = result.pop("_images", [])
    if not isinstance(images, list):
        return []
    return [
        {"path": img["path"], "media_type": img["media_type"], "label": img.get("label", "")}
        for img in images
        if isinstance(img, dict) and "path" in img and "media_type" in img
    ]


def _lease_ok(engine: Engine, run_id: str, token: str) -> bool:
    with Session(engine) as db:
        run = db.get(AgentRun, run_id)
        return run is not None and run.status == "running" and run.lease_token == token


def _update_progress(
    engine: Engine,
    run_id: str,
    token: str,
    *,
    partial: str | None = None,
    phase: str | None = None,
) -> None:
    with Session(engine) as db:
        run = db.get(AgentRun, run_id)
        if run is None or run.status != "running" or run.lease_token != token:
            return
        if partial is not None:
            run.partial_content = partial[-24000:]
        if phase is not None:
            run.phase = phase[:200]
        run.updated_at = now_ms()
        db.commit()


def _recent_context(db: Session, conversation_id: str) -> str:
    actions = list(
        db.scalars(
            select(AgentAction)
            .where(
                AgentAction.conversation_id == conversation_id,
                AgentAction.status == "executed",
            )
            .order_by(AgentAction.executed_at.desc(), AgentAction.created_at.desc())
            .limit(10)
        )
    )
    lines: list[str] = []
    for action in reversed(actions):
        result = action.result or {}
        if not isinstance(result, dict):
            result = {}
        line = f"- {action.summary}"
        object_id = result.get("id")
        if isinstance(object_id, str) and object_id:
            line += f" id={object_id}"
        for key, label in (("start_at", "开始"), ("end_at", "结束"), ("deadline_at", "截止")):
            value = result.get(key)
            if isinstance(value, str) and value:
                line += f" {label}={value}"
        event_type = result.get("event_type")
        if isinstance(event_type, dict):
            name = event_type.get("name")
            if isinstance(name, str) and name:
                line += f" 类型={name}"
        lines.append(line)
    return "\n".join(lines)


def _read_tool(
    engine: Engine, settings: Settings, user_id: str, name: str, raw: dict[str, Any]
) -> Any:
    with Session(engine, expire_on_commit=False) as db:
        user = db.get(User, user_id)
        if user is None:
            return {"error": "账号不存在"}
        context = ToolContext(db, user, settings)
        try:
            return execute_tool(context, name, raw)
        except Exception as exc:  # Keep the loop alive; the model can explain or retry.
            detail = getattr(exc, "detail", None) or "查询失败"
            return {"error": str(detail)}


def _propose_action(
    engine: Engine,
    settings: Settings,
    run_id: str,
    token: str,
    name: str,
    raw: dict[str, Any],
) -> dict[str, Any]:
    with Session(engine) as db:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        run = db.get(AgentRun, run_id)
        if run is None or run.status != "running" or run.lease_token != token:
            db.rollback()
            raise RunCancelled()
        if name == "create_task" and "list_id" not in raw and run.task_list_id:
            task_list = db.get(TaskList, run.task_list_id)
            if task_list is not None and task_list.workspace_id == run.workspace_id:
                raw = {**raw, "list_id": task_list.id}
        actions = list(db.scalars(select(AgentAction).where(AgentAction.run_id == run_id)))
        for action in actions:
            if action.operation == name and action.payload == raw:
                return {
                    "status": action.status,
                    "action_key": action.action_key,
                    "summary": action.summary,
                    "duplicate": True,
                    "result": action.result,
                }
        if len(actions) >= settings.agent_max_actions:
            db.rollback()
            return {
                "error": f"本轮最多提出 {settings.agent_max_actions} 个操作，请先确认现有操作。"
            }
        try:
            args = validate_tool(name, placeholder_refs(raw))
            user = db.get(User, run.user_id)
            if user is None:
                raise HTTPException(404, "账号不存在")
            context = ToolContext(db=db, user=user, settings=settings)
            check_tool(context, name, args)
            summary, preview = tool_render(context, name, args)
        except Exception as exc:
            db.rollback()
            detail = getattr(exc, "detail", None) or str(exc) or "参数校验失败"
            return {"error": f"工具参数不合法，请修正后重试：{detail}"}
        action_key = f"k{len(actions) + 1}"
        action = AgentAction(
            workspace_id=run.workspace_id,
            run_id=run_id,
            conversation_id=run.conversation_id,
            action_key=action_key,
            operation=name,
            payload=raw,
            preview=preview,
            summary=summary,
            risk=tool_risk(name),
            status="proposed",
            depends_on=collect_refs(raw),
            expires_at=now_ms() + settings.agent_action_ttl_seconds * 1000,
        )
        db.add(action)
        if (
            name == "create_task"
            and not action.depends_on
            and not raw.get("parent_id")
            and not raw.get("predecessor_ids")
            and not raw.get("recurrence")
        ):
            # Commit the task and its action receipt together, including on worker retries.
            from app.api.schemas import TaskInput

            try:
                task = apply_task(db, user, TaskInput.model_validate(raw))
                db.flush()
                action.status = "executed"
                action.result = task_view(db, task).model_dump(mode="json")
                action.executed_at = now_ms()
                action.risk = "low"
                record_change(db, user, "task.create", task)
            except Exception as exc:
                db.rollback()
                detail = getattr(exc, "detail", None) or "创建任务失败"
                return {"error": str(detail)}
            return {
                "status": "executed",
                "action_key": action.action_key,
                "summary": action.summary,
                "result": action.result,
            }
        db.commit()
        return {
            "status": "proposed",
            "action_key": action.action_key,
            "summary": action.summary,
            "risk": action.risk,
        }


def _execute(
    engine: Engine, settings: Settings, provider: Provider, run_id: str, token: str
) -> None:
    with Session(engine) as db:
        run = db.get(AgentRun, run_id)
        if run is None or run.status != "running" or run.lease_token != token:
            return
        user = db.get(User, run.user_id)
        if user is None:
            raise ParseFailure("账号不存在")
        conversation = db.get(AgentConversation, run.conversation_id)
        if conversation is None:
            raise ParseFailure("会话不存在")
        history = list(
            db.scalars(
                select(AgentMessage)
                .where(AgentMessage.conversation_id == run.conversation_id)
                .order_by(AgentMessage.created_at, AgentMessage.id)
            )
        )
        history = (
            history[-settings.agent_history_messages :] if settings.agent_history_messages else []
        )
        now = datetime.now(ZoneInfo(user.timezone))
        recent_actions = _recent_context(db, run.conversation_id)
        event_types = "、".join(
            item.name for item in event_types_api.list_event_types(db=db, user=user)
        )
        loaded_groups = groups_for_surface(run.surface)
        task_list = db.get(TaskList, run.task_list_id) if run.task_list_id else None
        task_list_name = (
            task_list.name
            if task_list is not None and task_list.workspace_id == run.workspace_id
            else "收件箱"
        )
        db.commit()
        messages: list[dict[str, Any]] = [
            system_message(
                now.isoformat(),
                user.timezone,
                event_types=event_types,
                recent_actions=recent_actions,
                tool_groups=group_catalog(),
                task_list_name=task_list_name,
            ),
        ]
        latest_user_id: str | None = None
        for message in history:
            if message.role == "user":
                latest_user_id = message.id
            messages.append({"role": message.role, "content": message.content})
        if settings.llm_supports_images and latest_user_id is not None:
            images = list(
                db.scalars(
                    select(AgentImage)
                    .where(AgentImage.message_id == latest_user_id)
                    .order_by(AgentImage.created_at, AgentImage.id)
                )
            )
            if images:
                for msg in reversed(messages):
                    if msg.get("role") == "user":
                        parts: list[dict[str, Any]] = [{"type": "text", "text": msg["content"]}]
                        for image in images:
                            path = settings.agent_image_dir / image.workspace_id / image.id
                            if path.is_file():
                                parts.append(
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": _encode_image(str(path), image.media_type)
                                        },
                                    }
                                )
                        msg["content"] = parts
                        break
        user_id = run.user_id

    transcript: list[dict[str, Any]] = []
    final_text = ""
    steps = 0
    include_images = settings.llm_supports_images
    for step in range(settings.agent_max_steps):
        if not _lease_ok(engine, run_id, token):
            raise RunCancelled()
        _update_progress(engine, run_id, token, partial="", phase="正在理解你的请求")
        chunks: list[str] = []
        last_write = [0.0]

        def on_delta(
            text: str,
            pieces: list[str] = chunks,
            last: list[float] = last_write,
        ) -> None:
            pieces.append(text)
            now = time.monotonic()
            if now - last[0] >= 0.25:
                last[0] = now
                _update_progress(engine, run_id, token, partial="".join(pieces))

        reply = provider.complete(
            messages,
            tool_schemas(include_images=include_images, groups=loaded_groups),
            on_delta,
        )
        steps = step + 1
        assistant = dict(reply.message or {})
        assistant.setdefault("role", "assistant")
        assistant.setdefault("content", reply.content)
        messages.append(assistant)
        transcript.append(_sanitize_for_transcript(assistant))
        if not reply.tool_calls:
            final_text = reply.content.strip()
            break
        if not _lease_ok(engine, run_id, token):
            raise RunCancelled()
        _update_progress(engine, run_id, token, phase="正在查询并准备操作")
        for call in reply.tool_calls:
            tool = TOOLS.get(call.name)
            try:
                raw = json.loads(call.arguments or "{}")
                if not isinstance(raw, dict):
                    raise ValueError("工具参数必须是对象")
            except (ValueError, TypeError):
                result: Any = {"error": "工具参数不是有效的 JSON 对象"}
            else:
                if call.name == "load_tool_group":
                    try:
                        requested = LoadGroupArgs.model_validate(raw)
                    except Exception as exc:
                        result = {"error": f"工具分组参数不合法：{exc}"}
                    else:
                        loaded_groups.update(requested.groups)
                        result = {
                            "loaded": sorted(requested.groups),
                            "tools": tool_names_for_groups(loaded_groups),
                        }
                elif tool is None:
                    result = {"error": "未知工具"}
                elif tool.kind == "read":
                    result = _read_tool(engine, settings, user_id, call.name, raw)
                else:
                    result = _propose_action(engine, settings, run_id, token, call.name, raw)
            tool_images = _extract_images(result)
            tool_msg = _tool_message(call.id, call.name, result)
            messages.append(tool_msg)
            transcript.append(tool_msg)
            if tool_images:
                parts = [{"type": "text", "text": "以下是工具返回的图片："}]
                for ref in tool_images:
                    try:
                        parts.append(
                            {
                                "type": "image_url",
                                "image_url": {"url": _encode_image(ref["path"], ref["media_type"])},
                            }
                        )
                    except OSError:
                        pass
                synthetic = {"role": "user", "content": parts}
                messages.append(synthetic)
                transcript.append(_sanitize_for_transcript(synthetic))
    else:
        final_text = "本轮工具调用已达到上限。请先逐条确认已提出的操作，或继续发送消息。"

    if not _lease_ok(engine, run_id, token):
        raise RunCancelled()
    with Session(engine) as db:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        run = db.get(AgentRun, run_id)
        if run is None or run.status != "running" or run.lease_token != token:
            db.rollback()
            return
        run.status = "succeeded"
        run.error = ""
        run.lease_until = 0
        run.lease_token = ""
        run.phase = ""
        run.partial_content = ""
        run.transcript = transcript[-MAX_TRANSCRIPT_MESSAGES:]
        run.step_count = steps
        run.updated_at = now_ms()
        db.add(
            AgentMessage(
                workspace_id=run.workspace_id,
                conversation_id=run.conversation_id,
                run_id=run.id,
                role="assistant",
                content=final_text or "本轮处理结果见下方卡片，可修改或撤销已创建的任务。",
            )
        )
        conversation = db.get(AgentConversation, run.conversation_id)
        if conversation is not None:
            conversation.updated_at = now_ms()
        db.commit()


def _retry_or_fail(engine: Engine, run_id: str, token: str, failure: ParseFailure) -> None:
    with Session(engine) as db:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        run = db.get(AgentRun, run_id)
        if run is None or run.status != "running" or run.lease_token != token:
            db.rollback()
            return
        run.lease_until = 0
        run.lease_token = ""
        run.error = str(failure)
        run.phase = ""
        run.partial_content = ""
        if failure.transient and run.attempts < 3:
            run.status = "queued"
            delay = 10 * run.attempts + (randbelow(16) if failure.rate_limited else 0)
            delay = max(delay, failure.retry_after_seconds)
            run.next_run_at = now_ms() + delay * 1000
        else:
            run.status = "failed"
            db.add(
                AgentMessage(
                    workspace_id=run.workspace_id,
                    conversation_id=run.conversation_id,
                    run_id=run.id,
                    role="assistant",
                    content=f"本轮没有完成：{failure}",
                )
            )
            conversation = db.get(AgentConversation, run.conversation_id)
            if conversation is not None:
                conversation.updated_at = now_ms()
        db.commit()


def expire_actions(engine: Engine) -> None:
    with Session(engine) as db:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        now = now_ms()
        for action in db.scalars(
            select(AgentAction).where(
                AgentAction.status == "proposed", AgentAction.expires_at < now
            )
        ):
            action.status = "expired"
        db.commit()


def run_once(engine: Engine, settings: Settings, provider: Provider) -> bool:
    with Session(engine) as db:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        now = now_ms()
        heartbeat = db.get(WorkerHeartbeat, "agent")
        if heartbeat is None:
            db.add(WorkerHeartbeat(name="agent", heartbeat_at=now))
        else:
            heartbeat.heartbeat_at = now
        run = db.scalar(
            select(AgentRun)
            .where(
                or_(
                    (AgentRun.status == "queued") & (AgentRun.next_run_at <= now),
                    (AgentRun.status == "running") & (AgentRun.lease_until < now),
                )
            )
            .order_by(AgentRun.created_at)
            .limit(1)
        )
        if run is None:
            db.commit()
            return False
        if run.attempts >= 3:
            run.status = "failed"
            run.error = "任务已达到重试上限"
            db.commit()
            return True
        run.attempts += 1
        run.status = "running"
        run.lease_token = token = str(uuid4())
        run.lease_until = now + (settings.agent_timeout_seconds * 2 + 60) * 1000
        run_id = run.id
        db.commit()
    try:
        _execute(engine, settings, provider, run_id, token)
    except RunCancelled:
        pass
    except ParseFailure as exc:
        _retry_or_fail(engine, run_id, token, exc)
    except Exception:
        _retry_or_fail(engine, run_id, token, ParseFailure("Agent 运行未完成，请稍后重试"))
    return True


def pending_actions(db: Session, run_id: str) -> int:
    return (
        db.scalar(
            select(func.count(AgentAction.id)).where(
                AgentAction.run_id == run_id, AgentAction.status == "proposed"
            )
        )
        or 0
    )
