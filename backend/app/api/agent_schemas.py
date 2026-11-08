from typing import Any, Literal

from pydantic import Field

from app.api.schemas import Schema, Timestamp


class AgentCapabilities(Schema):
    configured: bool
    tools: bool
    worker_online: bool
    consent_required: bool = True


class ConversationCreate(Schema):
    consent: bool


class ConversationOut(Schema):
    id: str
    title: str
    consent_at: Timestamp | None
    created_at: Timestamp
    updated_at: Timestamp


class MessageInput(Schema):
    content: str = Field(min_length=1, max_length=8000)
    idempotency_key: str = Field(min_length=8, max_length=200)


class RunStart(Schema):
    run_id: str
    conversation_id: str


class MessageOut(Schema):
    id: str
    role: Literal["user", "assistant"]
    content: str
    run_id: str | None = None
    created_at: Timestamp


class ActionOut(Schema):
    id: str
    action_key: str
    operation: str
    payload: dict[str, Any]
    summary: str
    risk: Literal["low", "medium", "high"]
    status: Literal["proposed", "confirmed", "rejected", "executed", "failed", "expired"]
    depends_on: list[str]
    result: dict[str, Any] | None = None
    error: str = ""
    expires_at: Timestamp
    executed_at: Timestamp | None = None
    created_at: Timestamp


class RunOut(Schema):
    id: str
    conversation_id: str
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    error: str
    step_count: int
    created_at: Timestamp
    updated_at: Timestamp


class RunDetail(Schema):
    run: RunOut
    actions: list[ActionOut]


class ConversationDetail(Schema):
    conversation: ConversationOut
    messages: list[MessageOut]
    actions: list[ActionOut]


class ActionConfirm(Schema):
    idempotency_key: str | None = Field(default=None, max_length=200)


class ActionReject(Schema):
    reason: str = Field(default="", max_length=500)
