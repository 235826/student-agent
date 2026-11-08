from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import delete, select

from app.api.agent_schemas import (
    ActionConfirm,
    ActionOut,
    ActionReject,
    AgentCapabilities,
    ConversationCreate,
    ConversationDetail,
    ConversationOut,
    MessageInput,
    MessageOut,
    RunDetail,
    RunOut,
    RunStart,
)
from app.db.models import (
    AgentAction,
    AgentConversation,
    AgentMessage,
    AgentRun,
    WorkerHeartbeat,
    now_ms,
)
from app.modules.agent.executor import execute_action
from app.modules.idempotency import remember, replay
from app.modules.records import owned, record_change
from app.modules.security import DB, UserDep
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
    return ConversationDetail(
        conversation=ConversationOut.model_validate(conversation),
        messages=[
            MessageOut.model_validate(message)
            for message in messages
            if message.role in {"user", "assistant"}
        ],
        actions=[ActionOut.model_validate(action) for action in actions],
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str, db: DB, user: UserDep) -> Response:
    conversation = owned(db, AgentConversation, conversation_id, user)
    for run in db.scalars(select(AgentRun).where(AgentRun.conversation_id == conversation.id)):
        if run.status in {"queued", "running"}:
            run.status = "cancelled"
            run.lease_token = ""
            run.lease_until = 0
    db.execute(delete(AgentAction).where(AgentAction.conversation_id == conversation.id))
    db.execute(delete(AgentMessage).where(AgentMessage.conversation_id == conversation.id))
    db.execute(delete(AgentRun).where(AgentRun.conversation_id == conversation.id))
    db.delete(conversation)
    db.commit()
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
    payload = {"conversation_id": conversation.id, "content": body.content}
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
    )
    db.add(message)
    db.add(run)
    db.flush()
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
