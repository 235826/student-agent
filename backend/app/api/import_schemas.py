from datetime import UTC, date, datetime, time
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator

from app.api.schemas import Schema, Timestamp

ShortText = Annotated[str, Field(max_length=2000)]
Key = Annotated[str, Field(min_length=1, max_length=64)]


class RecurrenceDraft(Schema):
    start_date: date | None = None
    end_date: date | None = None
    weekdays: list[Annotated[int, Field(ge=0, le=6)]] = Field(default_factory=list, max_length=7)
    start_time: time | None = None
    end_time: time | None = None


class ImportCandidate(Schema):
    key: Key
    kind: Literal["task", "event", "course"]
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=20000)
    priority: int = Field(default=2, ge=1, le=4)
    estimate_minutes: int | None = Field(default=None, gt=0, le=100000)
    estimate_is_suggestion: bool = True
    deadline_local: datetime | None = None
    start_local: datetime | None = None
    end_local: datetime | None = None
    location: str = Field(default="", max_length=500)
    event_kind: Literal["meeting", "exam", "other"] = "other"
    parent_key: Key | None = None
    predecessor_keys: list[Key] = Field(default_factory=list, max_length=100)
    recurrence: RecurrenceDraft | None = None
    evidence: dict[Key, ShortText] = Field(default_factory=dict, max_length=30)
    uncertainties: list[ShortText] = Field(default_factory=list, max_length=30)
    selected: bool = True
    reviewed: bool = False

    @field_validator("deadline_local", "start_local", "end_local")
    @classmethod
    def local_time(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is not None:
            raise ValueError("草稿时间使用导入时区的本地时间，不附带偏移")
        return value


class ModelDraft(Schema):
    candidates: list[ImportCandidate] = Field(default_factory=list, max_length=100)
    warnings: list[ShortText] = Field(default_factory=list, max_length=50)


class ImportText(Schema):
    text: str = Field(min_length=1, max_length=20000)
    context: str = Field(default="", max_length=4000)
    reference_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    idempotency_key: str = Field(min_length=8, max_length=200)
    confirmed: bool = False
    parse: bool = True

    @model_validator(mode="after")
    def consent(self) -> "ImportText":
        if self.parse and not self.confirmed:
            raise ValueError("解析前需要明确同意发送给模型")
        return self

    @field_validator("reference_at")
    @classmethod
    def aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("参考时间必须包含时区")
        return value


class ImportEdit(Schema):
    revision: int = Field(gt=0)
    candidates: list[ImportCandidate] = Field(max_length=100)


class ImportAction(Schema):
    revision: int = Field(gt=0)
    confirmed: Literal[True]


class ImportPublish(ImportAction):
    idempotency_key: str = Field(min_length=8, max_length=200)


class ImportRetry(ImportAction):
    context: str = Field(default="", max_length=4000)


class SourceOut(Schema):
    id: str
    kind: str
    text: str
    deleted_at: Timestamp | None


class ImportOut(Schema):
    id: str
    source: SourceOut
    status: str
    attempts: int
    revision: int
    timezone: str
    reference_at: Timestamp
    context: str
    candidates: list[ImportCandidate]
    warnings: list[str]
    error: str
    published_records: list[dict[str, str]]
    published_revision: int | None
    created_at: Timestamp


class ImportCapabilities(Schema):
    configured: bool
    images: bool
    worker_online: bool
