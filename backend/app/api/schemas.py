from datetime import UTC, date, datetime, time
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
Policy = Literal["none", "allow_selected"]


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
    task_type: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    parent_id: str | None = None
    predecessor_ids: list[str] = Field(default_factory=list, max_length=100)
    parallel_policy: Policy | None = None
    confirm_impact: bool = False

    @field_validator("deadline_at")
    @classmethod
    def aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.utcoffset() is None:
            raise ValueError("截止时间必须包含 UTC 偏移")
        return value


class TaskOut(TaskInput):
    id: str
    predecessor_ids: list[str]
    dependent_ids: list[str]
    child_ids: list[str]
    blocked_by: list[str]
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
    kind: Literal["course", "meeting", "exam", "other"] = "other"

    @model_validator(mode="after")
    def valid_time(self) -> Self:
        ProfileInput.valid_timezone(self.timezone)
        if self.kind == "course" and not self.course_id:
            raise ValueError("课程事件需要关联课程")
        if self.start_at.utcoffset() is None or self.end_at.utcoffset() is None:
            raise ValueError("事件时间必须包含 UTC 偏移")
        if self.end_at <= self.start_at:
            raise ValueError("结束时间必须晚于开始时间")
        return self


class EventOut(EventInput):
    id: str
    series_id: str | None = None
    occurrence_local_date: str | None = None
    is_skipped: bool = False
    parallel_policy_override: Policy | None = None
    original_start_at: Timestamp
    original_end_at: Timestamp
    start_at: Timestamp
    end_at: Timestamp
    created_at: Timestamp
    updated_at: Timestamp


class CourseInput(Schema):
    name: Title
    semester: Annotated[str, Field(max_length=100)] = ""


class CourseOut(CourseInput):
    id: str
    parallel_policy: Policy = "none"


class Health(Schema):
    status: str


class ErrorOut(Schema):
    code: str
    message: str
    request_id: str
    errors: list[dict[str, object]] | None = None


class DraftPayload(TaskInput):
    title: Annotated[str, Field(max_length=200)] = ""


class DraftInput(Schema):
    payload: DraftPayload


class DraftUpdate(DraftInput):
    revision: int


class DraftOut(Schema):
    id: str
    object_type: Literal["task"]
    payload: DraftPayload
    status: Literal["draft", "published", "deleted"]
    revision: int
    published_task_id: str | None
    updated_at: Timestamp


class PublishInput(Schema):
    revision: Annotated[int, Field(gt=0)]
    idempotency_key: Annotated[str, Field(min_length=8, max_length=200)]


class SeriesInput(Schema):
    course_id: str
    start_date: date
    end_date: date
    weekdays: list[Annotated[int, Field(ge=0, le=6)]] = Field(min_length=1, max_length=7)
    start_time: time
    end_time: time
    timezone: str
    location: Annotated[str, Field(max_length=500)] = ""
    idempotency_key: Annotated[str, Field(min_length=8, max_length=200)]

    @model_validator(mode="after")
    def valid_series(self) -> Self:
        ProfileInput.valid_timezone(self.timezone)
        if not 0 <= (self.end_date - self.start_date).days <= 366:
            raise ValueError("课表日期范围须为 0–366 天")
        if self.start_time.tzinfo or self.end_time.tzinfo or self.end_time <= self.start_time:
            raise ValueError("课程时间须为同一天内的本地时间，结束晚于开始")
        self.weekdays = sorted(set(self.weekdays))
        return self


class SeriesOut(Schema):
    id: str
    course_id: str | None
    timezone: str
    dtstart_local: str
    duration_minutes: int
    recurrence_rule: str
    event_ids: list[str]


class SkipInput(Schema):
    is_skipped: bool
    confirmed: Literal[True]


class PolicyInput(Schema):
    parallel_policy: Policy


class EventPolicyInput(Schema):
    parallel_policy: Policy | None


class TypePolicyInput(PolicyInput):
    task_type: Annotated[str, Field(min_length=1, max_length=100)]


class TypePolicyOut(TypePolicyInput):
    id: str


class Selector(Schema):
    scope: Literal["event", "task", "course", "task_type", "all"]
    key: Annotated[str, Field(max_length=100)]

    @model_validator(mode="after")
    def valid_key(self) -> Self:
        if (self.scope == "all" and self.key != "*") or not self.key:
            raise ValueError("泛化范围使用 *，其他范围必须指定对象")
        return self


class RuleInput(Schema):
    left: Selector
    right: Selector
    decision: Literal["allow", "deny"]
    override_conflicts: bool = False

    @model_validator(mode="after")
    def valid_override(self) -> Self:
        if self.override_conflicts and (
            self.decision != "allow"
            or self.left.scope not in {"task", "event"}
            or self.right.scope not in {"task", "event"}
        ):
            raise ValueError("仅具体两项活动的允许规则可以明确覆盖较泛化的禁止设置")
        if self.left == self.right and self.left.scope in {"task", "event"}:
            raise ValueError("不能为同一项活动创建自身并行规则")
        return self


class RuleOut(RuleInput):
    id: str
    origin: str
    status: str
    revision: int
    updated_at: Timestamp


class ActivityRef(Schema):
    kind: Literal["task", "event"]
    id: str


class CompatibilityInput(Schema):
    activities: list[ActivityRef] = Field(min_length=2, max_length=20)

    @model_validator(mode="after")
    def distinct(self) -> Self:
        if len({(a.kind, a.id) for a in self.activities}) != len(self.activities):
            raise ValueError("请选择不同的活动")
        return self


class PairResult(Schema):
    left: ActivityRef
    right: ActivityRef
    allowed: bool
    reason: str
    rule_ids: list[str] = Field(default_factory=list)
    policy_sources: list[str] = Field(default_factory=list)


class CompatibilityOut(Schema):
    allowed: bool
    pairs: list[PairResult]


class PlanInput(Schema):
    start_at: datetime
    end_at: datetime
    min_block_minutes: int = Field(default=25, ge=1, le=90)
    max_block_minutes: int = Field(default=90, ge=1, le=180)
    idempotency_key: str = Field(min_length=8, max_length=200)

    @model_validator(mode="after")
    def valid_range(self) -> Self:
        if self.start_at.tzinfo is None or self.end_at.tzinfo is None:
            raise ValueError("排程起止时间必须包含时区")
        seconds = (self.end_at - self.start_at).total_seconds()
        if not 0 < seconds <= 31 * 86400:
            raise ValueError("排程范围须大于零且不超过 31 天")
        if self.min_block_minutes > self.max_block_minutes:
            raise ValueError("最小工作块不能大于最大工作块")
        return self


class PlanBlockOut(Schema):
    task_id: str
    title: str
    start_at: Timestamp
    end_at: Timestamp


class PlanReport(Schema):
    task_id: str
    title: str
    estimated_minutes: int | None
    scheduled_minutes: int
    unscheduled_minutes: int | None
    reason: str


class PlanDifference(Schema):
    added: int
    removed: int
    unchanged: int
    added_blocks: list[PlanBlockOut]
    removed_blocks: list[PlanBlockOut]


class PlanOut(Schema):
    id: str
    status: str
    source_revision: int
    stale: bool
    base_plan_id: str | None
    start_at: Timestamp
    end_at: Timestamp
    timezone: str
    created_at: Timestamp
    blocks: list[PlanBlockOut]
    reports: list[PlanReport]
    differences: PlanDifference


class AdoptPlan(Schema):
    confirmed: Literal[True]
