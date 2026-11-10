import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import Engine, delete, func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.agent_schemas import (
    ActionConfirm,
    ActionOut,
    ActionReject,
    AgentCapabilities,
    AgentImageOut,
    ConversationCreate,
    ConversationDetail,
    ConversationOut,
    MessageInput,
    MessageOut,
    RunDetail,
    RunOut,
    RunStart,
)
from app.config import Settings
from app.db.models import (
    AgentAction,
    AgentConversation,
    AgentImage,
    AgentMessage,
    AgentRun,
    Task,
    TaskList,
    WorkerHeartbeat,
    now_ms,
)
from app.modules.agent.executor import execute_action
from app.modules.idempotency import remember, replay
from app.modules.images import MAX_IMAGE_BYTES, validate_image
from app.modules.records import owned, record_change
from app.modules.security import DB, UserDep
from app.modules.task_management import require_impact_confirmation
from app.providers.chat_completions import configured

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


@router.get("/capabilities", response_model=AgentCapabilities)
def capabilities(request: Request, db: DB, user: UserDep) -> AgentCapabilities:
    settings = request.app.state.settings
    heartbeat = db.get(WorkerHeartbeat, "agent")
    window = (settings.agent_timeout_seconds * 2 + 70) * 1000
    online = heartbeat is not None and now_ms() - heartbeat.heartbeat_at < window
    return AgentCapabilities(
        configured=configured(settings),
        tools=settings.llm_supports_tools,
        images=settings.llm_supports_images,
        worker_online=online,
        consent_required=True,
    )


@router.post("/conversations", response_model=ConversationOut, status_code=201)
def create_conversation(body: ConversationCreate, db: DB, user: UserDep) -> AgentConversation:
    if not body.consent:
        raise HTTPException(422, "需要先同意将对话与相关数据发送给模型")
    conversation = AgentConversation(
        workspace_id=user.workspace_id,
        user_id=user.id,
        consent_at=now_ms(),
    )
    db.add(conversation)
    record_change(db, user, "agent.conversation.create", conversation, scheduling=False)
    return conversation


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations(db: DB, user: UserDep) -> list[AgentConversation]:
    return list(
        db.scalars(
            select(AgentConversation)
            .where(AgentConversation.workspace_id == user.workspace_id)
            .order_by(AgentConversation.updated_at.desc(), AgentConversation.id)
            .limit(50)
        )
    )


def image_path(settings: Settings, image: AgentImage) -> Path:
    return Path(settings.agent_image_dir) / image.workspace_id / image.id


def _message_images(db: DB, message_id: str) -> list[AgentImageOut]:
    images = list(
        db.scalars(
            select(AgentImage)
            .where(AgentImage.message_id == message_id)
            .order_by(AgentImage.created_at, AgentImage.id)
        )
    )
    return [AgentImageOut.model_validate(img) for img in images]


@router.post(
    "/conversations/{conversation_id}/images",
    response_model=AgentImageOut,
    status_code=201,
)
def upload_image(
    conversation_id: str,
    request: Request,
    db: DB,
    user: UserDep,
    file: Annotated[UploadFile, File()],
) -> AgentImageOut:
    conversation = owned(db, AgentConversation, conversation_id, user)
    if conversation.consent_at is None:
        raise HTTPException(403, "请先同意将对话与相关数据发送给模型")
    data = file.file.read(MAX_IMAGE_BYTES + 1)
    try:
        media_type = validate_image(data)
    except ValueError as exc:
        message = str(exc)
        status = 413 if "8 MiB" in message else 422
        raise HTTPException(status, message) from None
    image_id = str(uuid4())
    directory = Path(request.app.state.settings.agent_image_dir) / user.workspace_id
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    final = directory / image_id
    temp = directory / f".{image_id}.tmp"
    try:
        with temp.open("xb") as stream:
            stream.write(data)
            stream.flush()
        temp.replace(final)
    except Exception:
        temp.unlink(missing_ok=True)
        final.unlink(missing_ok=True)
        raise
    image = AgentImage(
        id=image_id,
        workspace_id=user.workspace_id,
        conversation_id=conversation.id,
        media_type=media_type,
        size_bytes=len(data),
    )
    db.add(image)
    record_change(db, user, "agent.image.upload", image, scheduling=False)
    return AgentImageOut.model_validate(image)


@router.get("/images/{image_id}")
def serve_image(image_id: str, request: Request, db: DB, user: UserDep) -> FileResponse:
    image = owned(db, AgentImage, image_id, user)
    path = image_path(request.app.state.settings, image)
    if not path.is_file():
        raise HTTPException(404, "图片文件不可用")
    return FileResponse(
        path,
        media_type=image.media_type,
        headers={"Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation(conversation_id: str, db: DB, user: UserDep) -> ConversationDetail:
    conversation = owned(db, AgentConversation, conversation_id, user)
    messages = list(
        db.scalars(
            select(AgentMessage)
            .where(AgentMessage.conversation_id == conversation.id)
            .order_by(AgentMessage.created_at, AgentMessage.id)
        )
    )
    actions = list(
        db.scalars(
            select(AgentAction)
            .where(AgentAction.conversation_id == conversation.id)
            .order_by(AgentAction.created_at, AgentAction.id)
        )
    )
    latest = db.scalar(
        select(AgentRun)
        .where(AgentRun.conversation_id == conversation.id)
        .order_by(AgentRun.created_at.desc())
        .limit(1)
    )
    return ConversationDetail(
        conversation=ConversationOut.model_validate(conversation),
        messages=[
            MessageOut(
                **MessageOut.model_validate(message).model_dump(exclude={"images"}),
                images=_message_images(db, message.id),
            )
            for message in messages
            if message.role in {"user", "assistant"}
        ],
        actions=[ActionOut.model_validate(action) for action in actions],
        latest_run=RunOut.model_validate(latest) if latest else None,
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str, request: Request, db: DB, user: UserDep) -> Response:
    conversation = owned(db, AgentConversation, conversation_id, user)
    for run in db.scalars(select(AgentRun).where(AgentRun.conversation_id == conversation.id)):
        if run.status in {"queued", "running"}:
            run.status = "cancelled"
            run.lease_token = ""
            run.lease_until = 0
    images = list(
        db.scalars(select(AgentImage).where(AgentImage.conversation_id == conversation.id))
    )
    db.execute(delete(AgentAction).where(AgentAction.conversation_id == conversation.id))
    db.execute(delete(AgentImage).where(AgentImage.conversation_id == conversation.id))
    db.execute(delete(AgentMessage).where(AgentMessage.conversation_id == conversation.id))
    db.execute(delete(AgentRun).where(AgentRun.conversation_id == conversation.id))
    db.delete(conversation)
    db.commit()
    for image in images:
        try:
            image_path(request.app.state.settings, image).unlink(missing_ok=True)
        except OSError:
            pass
    return Response(status_code=204)


@router.post("/conversations/{conversation_id}/messages", response_model=RunStart, status_code=202)
def send_message(
    conversation_id: str,
    body: MessageInput,
    request: Request,
    db: DB,
    user: UserDep,
) -> RunStart:
    conversation = owned(db, AgentConversation, conversation_id, user)
    if conversation.consent_at is None:
        raise HTTPException(403, "请先同意将对话与相关数据发送给模型")
    settings = request.app.state.settings
    if not configured(settings) or not settings.llm_supports_tools:
        raise HTTPException(503, "模型尚未配置或未启用工具调用")
    if body.task_list_id is not None:
        owned(db, TaskList, body.task_list_id, user)
    payload = {
        "conversation_id": conversation.id,
        "content": body.content,
        "surface": body.surface,
        "task_list_id": body.task_list_id,
    }
    existing = replay(db, user, body.idempotency_key, payload)
    if existing:
        return RunStart(run_id=existing, conversation_id=conversation.id)
    pending = db.scalar(
        select(AgentRun.id).where(
            AgentRun.conversation_id == conversation.id,
            AgentRun.status.in_(("queued", "running")),
        )
    )
    if pending:
        raise HTTPException(409, "请先等待当前回复完成，或取消后重试")
    message = AgentMessage(
        workspace_id=user.workspace_id,
        conversation_id=conversation.id,
        role="user",
        content=body.content,
    )
    run = AgentRun(
        workspace_id=user.workspace_id,
        user_id=user.id,
        conversation_id=conversation.id,
        status="queued",
        transcript=[],
        next_run_at=0,
        surface=body.surface,
        task_list_id=body.task_list_id,
    )
    db.add(message)
    db.add(run)
    db.flush()
    if body.image_ids:
        linked = list(
            db.scalars(
                select(AgentImage).where(
                    AgentImage.id.in_(body.image_ids),
                    AgentImage.conversation_id == conversation.id,
                    AgentImage.message_id.is_(None),
                )
            )
        )
        for image in linked:
            image.message_id = message.id
    remember(db, user, body.idempotency_key, payload, run.id)
    if conversation.title == "新对话":
        conversation.title = body.content.strip()[:40] or "新对话"
    conversation.updated_at = now_ms()
    record_change(db, user, "agent.message", run, scheduling=False)
    return RunStart(run_id=run.id, conversation_id=conversation.id)


@router.get("/runs/{run_id}", response_model=RunDetail)
def get_run(run_id: str, db: DB, user: UserDep) -> RunDetail:
    run = owned(db, AgentRun, run_id, user)
    actions = list(
        db.scalars(
            select(AgentAction)
            .where(AgentAction.run_id == run.id)
            .order_by(AgentAction.created_at, AgentAction.id)
        )
    )
    return RunDetail(
        run=RunOut.model_validate(run),
        actions=[ActionOut.model_validate(action) for action in actions],
    )


def _run_stream_snapshot(engine: Engine, run_id: str) -> dict[str, object]:
    with Session(engine) as db:
        run = db.get(AgentRun, run_id)
        if run is None:
            return {"status": "missing"}
        pending = db.scalar(
            select(func.count(AgentAction.id)).where(
                AgentAction.run_id == run_id, AgentAction.status == "proposed"
            )
        )
        return {
            "status": run.status,
            "phase": run.phase,
            "partial_content": run.partial_content,
            "pending_actions": pending or 0,
            "updated_at": run.updated_at,
        }


@router.get("/runs/{run_id}/stream")
async def stream_run(
    run_id: str,
    request: Request,
    db: DB,
    user: UserDep,
) -> StreamingResponse:
    owned(db, AgentRun, run_id, user)
    engine = request.app.state.engine

    async def events() -> AsyncIterator[str]:
        previous: dict[str, object] | None = None
        idle = 0
        while True:
            snapshot = await run_in_threadpool(_run_stream_snapshot, engine, run_id)
            if snapshot.get("status") == "missing":
                yield 'data: {"status":"missing"}\n\n'
                return
            if snapshot != previous:
                previous = snapshot
                idle = 0
                yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n"
            else:
                idle += 1
                if idle >= 50:
                    idle = 0
                    yield ": ping\n\n"
            if snapshot["status"] not in {"queued", "running"}:
                return
            await asyncio.sleep(0.2)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
def cancel_run(run_id: str, db: DB, user: UserDep) -> RunOut:
    run = owned(db, AgentRun, run_id, user)
    if run.status in {"queued", "running"}:
        run.status = "cancelled"
        run.lease_token = ""
        run.lease_until = 0
        run.updated_at = now_ms()
        db.commit()
    return RunOut.model_validate(run)


@router.post("/actions/{action_id}/confirm", response_model=ActionOut)
def confirm_action(
    action_id: str,
    body: ActionConfirm,
    request: Request,
    db: DB,
    user: UserDep,
) -> ActionOut:
    action = owned(db, AgentAction, action_id, user)
    if action.status == "executed":
        return ActionOut.model_validate(action)
    if action.status != "proposed":
        raise HTTPException(409, "该操作已处理或已过期，请刷新后重试")
    if action.expires_at < now_ms():
        action.status = "expired"
        db.commit()
        raise HTTPException(409, "该操作已过期，请让 Agent 重新提出")
    siblings = list(db.scalars(select(AgentAction).where(AgentAction.run_id == action.run_id)))
    by_key = {item.action_key: item for item in siblings}
    for key in action.depends_on:
        dependency = by_key.get(key)
        if dependency is None or dependency.status != "executed":
            raise HTTPException(409, "请先确认并执行依赖的前序动作")
    action_results = {
        item.action_key: item.result
        for item in siblings
        if item.status == "executed" and item.result is not None
    }
    try:
        result = execute_action(
            db,
            user,
            request.app.state.settings,
            action.operation,
            action.payload,
            action.id,
            action_results,
        )
    except HTTPException as exc:
        action.status = "failed"
        action.error = str(exc.detail)[:2000]
        db.commit()
        raise
    except Exception:
        action.status = "failed"
        action.error = "操作执行失败，请重试"
        db.commit()
        raise HTTPException(500, "操作执行失败，请重试") from None
    action.status = "executed"
    action.result = result if isinstance(result, dict) else {"value": result}
    action.error = ""
    action.executed_at = now_ms()
    action.updated_at = now_ms()
    db.commit()
    return ActionOut.model_validate(action)


@router.post("/actions/{action_id}/reject", response_model=ActionOut)
def reject_action(action_id: str, body: ActionReject, db: DB, user: UserDep) -> ActionOut:
    action = owned(db, AgentAction, action_id, user)
    if action.status == "rejected":
        return ActionOut.model_validate(action)
    if action.status != "proposed":
        raise HTTPException(409, "该操作已处理或已过期，请刷新后重试")
    action.status = "rejected"
    action.error = body.reason[:2000]
    action.updated_at = now_ms()
    db.commit()
    return ActionOut.model_validate(action)


@router.post("/actions/{action_id}/undo", response_model=ActionOut)
def undo_task_creation(action_id: str, db: DB, user: UserDep) -> ActionOut:
    action = owned(db, AgentAction, action_id, user)
    if action.status == "undone":
        return ActionOut.model_validate(action)
    if action.operation != "create_task" or action.status != "executed" or not action.result:
        raise HTTPException(409, "只有已创建的任务可以撤销")
    task = owned(db, Task, str(action.result.get("id", "")), user)
    if task.trashed_at is None:
        require_impact_confirmation(db, task, False)
        task.trashed_at = now_ms()
    action.status = "undone"
    action.updated_at = now_ms()
    record_change(db, user, "task.trash", task)
    return ActionOut.model_validate(action)
