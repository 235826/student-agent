from datetime import UTC, datetime, time
from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


def from_epoch(value: object) -> object:
    if isinstance(value, int):
        return datetime.fromtimestamp(value / 1000, UTC)
    return value


Timestamp = Annotated[datetime, BeforeValidator(from_epoch)]
Title = Annotated[str, Field(min_length=1, max_length=200)]
Status = Literal["todo", "in_progress", "done", "cancelled"]


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, from_attributes=True)


class Credentials(Schema):
    username: Annotated[str, Field(min_length=1, max_length=64)]
    password: Annotated[
        str, StringConstraints(strip_whitespace=False, min_length=10, max_length=128)
    ]


class Window(Schema):
    weekday: Annotated[int, Field(ge=0, le=6)]
    start: time
    end: time

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.start.tzinfo or self.end.tzinfo or self.end <= self.start:
            raise ValueError("时间窗口须为同一天内的本地时间，结束晚于开始")
        return self


class ProfileInput(Schema):
    timezone: str = "Asia/Shanghai"
    available_windows: list[Window] = Field(default_factory=list, max_length=100)
    rest_windows: list[Window] = Field(default_factory=list, max_length=100)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("请输入有效的 IANA 时区") from exc
        return value


class ProfileOut(ProfileInput):
    id: str
    username: str


class SetupInput(Credentials):
    timezone: str = "Asia/Shanghai"

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        return ProfileInput.valid_timezone(value)


class AuthOut(Schema):
    user: ProfileOut
    csrf_token: str


class SetupStatus(Schema):
    initialized: bool


class TaskInput(Schema):
    title: Title
    description: Annotated[str, Field(max_length=20000)] = ""
    status: Status = "todo"
    priority: Annotated[int, Field(ge=1, le=4)] = 2
    deadline_at: datetime | None = None
    estimate_minutes: Annotated[int, Field(gt=0, le=100000)] | None = None
    task_type: Annotated[str, Field(max_length=100)] | None = None

    @field_validator("deadline_at")
    @classmethod
    def aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.utcoffset() is None:
            raise ValueError("截止时间必须包含 UTC 偏移")
        return value


class TaskOut(TaskInput):
    id: str
    deadline_at: Timestamp | None
    trashed_at: Timestamp | None
    created_at: Timestamp
    updated_at: Timestamp


class EventInput(Schema):
    title: Title
    start_at: datetime
    end_at: datetime
    timezone: str = "Asia/Shanghai"
    location: Annotated[str, Field(max_length=500)] = ""
    locked: bool = True
    course_id: str | None = None

    @model_validator(mode="after")
    def valid_time(self) -> Self:
        ProfileInput.valid_timezone(self.timezone)
        if self.start_at.utcoffset() is None or self.end_at.utcoffset() is None:
            raise ValueError("事件时间必须包含 UTC 偏移")
        if self.end_at <= self.start_at:
            raise ValueError("结束时间必须晚于开始时间")
        return self


class EventOut(EventInput):
    id: str
    start_at: Timestamp
    end_at: Timestamp
    created_at: Timestamp
    updated_at: Timestamp


class CourseInput(Schema):
    name: Title
    semester: Annotated[str, Field(max_length=100)] = ""


class CourseOut(CourseInput):
    id: str


class Health(Schema):
    status: str


class ErrorOut(Schema):
    code: str
    message: str
    request_id: str
    errors: list[dict[str, object]] | None = None
