from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    String,
    UniqueConstraint,
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


class Course(Owned, Base):
    __tablename__ = "courses"
    name: Mapped[str] = mapped_column(String(200))
    semester: Mapped[str] = mapped_column(default="")
    parallel_policy: Mapped[str] = mapped_column(default="none")


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


class EventOverride(Owned, Base):
    __tablename__ = "event_overrides"
    __table_args__ = (UniqueConstraint("series_id", "occurrence_local_date"),)
    series_id: Mapped[str] = mapped_column(ForeignKey("event_series.id"))
    occurrence_local_date: Mapped[str]
    is_skipped: Mapped[bool] = mapped_column(default=False)
    parallel_policy_override: Mapped[str | None]


class Audit(Owned, Base):
    __tablename__ = "audit_records"
    action: Mapped[str]
    object_id: Mapped[str]
