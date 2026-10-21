from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now_ms() -> int:
    return int(datetime.now(UTC).timestamp() * 1000)


class Base(DeclarativeBase):
    pass


class Record:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_ms)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_ms, onupdate=now_ms)


class Workspace(Record, Base):
    __tablename__ = "workspaces"
    scheduling_revision: Mapped[int] = mapped_column(default=0)


class User(Record, Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("singleton = 1"),)
    singleton: Mapped[int] = mapped_column(default=1, unique=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), unique=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str]
    timezone: Mapped[str] = mapped_column(default="Asia/Shanghai")
    available_windows: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    rest_windows: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)


class Session(Record, Base):
    __tablename__ = "sessions"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(unique=True)
    csrf_token: Mapped[str]
    expires_at: Mapped[int] = mapped_column(BigInteger, index=True)


class Owned(Record):
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)


class Task(Owned, Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint("status IN ('todo','in_progress','done','cancelled')"),
        CheckConstraint("priority BETWEEN 1 AND 4"),
        CheckConstraint("estimate_minutes IS NULL OR estimate_minutes > 0"),
    )
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(default="")
    status: Mapped[str] = mapped_column(default="todo", index=True)
    priority: Mapped[int] = mapped_column(default=2)
    deadline_at: Mapped[int | None] = mapped_column(BigInteger, index=True)
    estimate_minutes: Mapped[int | None]
    task_type: Mapped[str | None]
    trashed_at: Mapped[int | None] = mapped_column(BigInteger, index=True)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), index=True)
    parallel_policy: Mapped[str | None]
    policy_revision: Mapped[int] = mapped_column(default=0, server_default="0")


class Course(Owned, Base):
    __tablename__ = "courses"
    name: Mapped[str] = mapped_column(String(200))
    semester: Mapped[str] = mapped_column(default="")
    parallel_policy: Mapped[str] = mapped_column(default="none")
    policy_revision: Mapped[int] = mapped_column(default=0, server_default="0")


class EventSeries(Owned, Base):
    __tablename__ = "event_series"
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"))
    timezone: Mapped[str]
    dtstart_local: Mapped[str]
    duration_minutes: Mapped[int]
    recurrence_rule: Mapped[str]


class Event(Owned, Base):
    __tablename__ = "events"
    __table_args__ = (
        UniqueConstraint("series_id", "occurrence_local_date"),
        CheckConstraint("end_at > start_at"),
    )
    title: Mapped[str] = mapped_column(String(200))
    start_at: Mapped[int] = mapped_column(BigInteger, index=True)
    end_at: Mapped[int] = mapped_column(BigInteger, index=True)
    timezone: Mapped[str]
    location: Mapped[str] = mapped_column(default="")
    locked: Mapped[bool] = mapped_column(Boolean, default=True)
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"))
    series_id: Mapped[str | None] = mapped_column(ForeignKey("event_series.id"))
    occurrence_local_date: Mapped[str | None]
    kind: Mapped[str] = mapped_column(default="other", server_default="other")
    is_skipped: Mapped[bool] = mapped_column(default=False, server_default="0")
    parallel_policy_override: Mapped[str | None]
    policy_revision: Mapped[int] = mapped_column(default=0, server_default="0")


class EventOverride(Owned, Base):
    __tablename__ = "event_overrides"
    __table_args__ = (UniqueConstraint("series_id", "occurrence_local_date"),)
    series_id: Mapped[str] = mapped_column(ForeignKey("event_series.id"))
    occurrence_local_date: Mapped[str]
    is_skipped: Mapped[bool] = mapped_column(default=False)
    parallel_policy_override: Mapped[str | None]
    policy_revision: Mapped[int] = mapped_column(default=0, server_default="0")
    title: Mapped[str | None]
    location: Mapped[str | None]
    start_at: Mapped[int | None] = mapped_column(BigInteger)
    end_at: Mapped[int | None] = mapped_column(BigInteger)
    timezone: Mapped[str | None]


class TaskDependency(Owned, Base):
    __tablename__ = "task_dependencies"
    __table_args__ = (
        UniqueConstraint("predecessor_task_id", "successor_task_id"),
        CheckConstraint("predecessor_task_id != successor_task_id"),
    )
    predecessor_task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    successor_task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)


class Draft(Owned, Base):
    __tablename__ = "drafts"
    object_type: Mapped[str] = mapped_column(default="task")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(default="draft")
    revision: Mapped[int] = mapped_column(default=1)
    published_task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), unique=True)


class IdempotentOperation(Owned, Base):
    __tablename__ = "idempotent_operations"
    __table_args__ = (UniqueConstraint("workspace_id", "key"),)
    key: Mapped[str]
    request_hash: Mapped[str]
    result_id: Mapped[str]


class TaskTypePolicy(Owned, Base):
    __tablename__ = "task_type_policies"
    __table_args__ = (UniqueConstraint("workspace_id", "task_type"),)
    task_type: Mapped[str]
    parallel_policy: Mapped[str]
    policy_revision: Mapped[int] = mapped_column(default=1)


class CompatibilityRule(Owned, Base):
    __tablename__ = "compatibility_rules"
    left_scope: Mapped[str]
    left_key: Mapped[str]
    right_scope: Mapped[str]
    right_key: Mapped[str]
    decision: Mapped[str]
    origin: Mapped[str] = mapped_column(default="user_explicit")
    status: Mapped[str] = mapped_column(default="confirmed")
    revision: Mapped[int] = mapped_column(default=1)
    override_signature: Mapped[str | None]


class Audit(Owned, Base):
    __tablename__ = "audit_records"
    action: Mapped[str]
    object_id: Mapped[str]


class Plan(Owned, Base):
    __tablename__ = "plans"
    __table_args__ = (
        CheckConstraint("status IN ('draft','adopted','superseded')"),
        CheckConstraint("end_at > start_at"),
        Index(
            "uq_plans_current_workspace",
            "workspace_id",
            unique=True,
            sqlite_where=text("status = 'adopted'"),
        ),
    )
    status: Mapped[str] = mapped_column(default="draft")
    source_revision: Mapped[int]
    base_plan_id: Mapped[str | None] = mapped_column(ForeignKey("plans.id"))
    start_at: Mapped[int] = mapped_column(BigInteger)
    end_at: Mapped[int] = mapped_column(BigInteger)
    timezone: Mapped[str]
    blocks: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    reports: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    differences: Mapped[dict[str, Any]] = mapped_column(JSON)


class ImportSource(Owned, Base):
    __tablename__ = "import_sources"
    __table_args__ = (UniqueConstraint("workspace_id", "digest"),)
    kind: Mapped[str]
    digest: Mapped[str]
    text: Mapped[str] = mapped_column(default="")
    file_name: Mapped[str] = mapped_column(default="")
    media_type: Mapped[str] = mapped_column(default="")
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)


class ImportJob(Owned, Base):
    __tablename__ = "import_jobs"
    source_id: Mapped[str] = mapped_column(ForeignKey("import_sources.id"), unique=True)
    status: Mapped[str] = mapped_column(default="queued", index=True)
    attempts: Mapped[int] = mapped_column(default=0)
    next_run_at: Mapped[int] = mapped_column(BigInteger, default=0)
    lease_until: Mapped[int] = mapped_column(BigInteger, default=0)
    lease_token: Mapped[str] = mapped_column(default="")
    context: Mapped[str] = mapped_column(default="")
    timezone: Mapped[str]
    reference_at: Mapped[int] = mapped_column(BigInteger)
    revision: Mapped[int] = mapped_column(default=1)
    candidates: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    warnings: Mapped[list[str]] = mapped_column(JSON, default=list)
    error: Mapped[str] = mapped_column(default="")
    published_records: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    published_revision: Mapped[int | None]


class ImportLink(Owned, Base):
    __tablename__ = "import_links"
    job_id: Mapped[str] = mapped_column(ForeignKey("import_jobs.id"))
    object_kind: Mapped[str]
    object_id: Mapped[str] = mapped_column(index=True)


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"
    name: Mapped[str] = mapped_column(primary_key=True)
    heartbeat_at: Mapped[int] = mapped_column(BigInteger)
