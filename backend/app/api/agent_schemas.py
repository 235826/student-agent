from typing import Any, Literal

from pydantic import Field

from app.api.schemas import Schema, Timestamp


class AgentCapabilities(Schema):
    configured: bool
    tools: bool
    images: bool = False
    worker_online: bool
    consent_required: bool = True


AgentSurface = Literal["agent", "tasks", "calendar", "planning", "imports", "settings"]


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
    image_ids: list[str] = Field(default_factory=list, max_length=4)
    surface: AgentSurface = "agent"


class RunStart(Schema):
    run_id: str
    conversation_id: str


class AgentImageOut(Schema):
    id: str
    conversation_id: str
    message_id: str | None = None
    media_type: str
    size_bytes: int
    created_at: Timestamp


class MessageOut(Schema):
    id: str
    role: Literal["user", "assistant"]
    content: str
    run_id: str | None = None
    images: list[AgentImageOut] = Field(default_factory=list)
    created_at: Timestamp


class ActionOut(Schema):
    id: str
    run_id: str
    action_key: str
    operation: str
    payload: dict[str, Any]
    preview: dict[str, Any] = Field(default_factory=dict)
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
    phase: str = ""
    partial_content: str = ""
    created_at: Timestamp
    updated_at: Timestamp


class RunDetail(Schema):
    run: RunOut
    actions: list[ActionOut]


class ConversationDetail(Schema):
    conversation: ConversationOut
    messages: list[MessageOut]
    actions: list[ActionOut]
    latest_run: RunOut | None = None


class ActionConfirm(Schema):
    idempotency_key: str | None = Field(default=None, max_length=200)


class ActionReject(Schema):
    reason: str = Field(default="", max_length=500)
