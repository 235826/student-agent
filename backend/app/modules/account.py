import shutil
from collections import Counter
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import (
    ActivityFeedback,
    AgentAction,
    AgentConversation,
    AgentImage,
    AgentMessage,
    AgentRun,
    Audit,
    CompatibilityRule,
    Course,
    DeletedWorkspaceAudit,
    Draft,
    Event,
    EventOverride,
    EventSeries,
    EventType,
    IdempotentOperation,
    ImportJob,
    ImportLink,
    ImportSource,
    Plan,
    SavedFilter,
    Tag,
    Task,
    TaskAttachment,
    TaskDependency,
    TaskList,
    TaskListGroup,
    TaskTag,
    TaskTypePolicy,
    User,
    WorkLog,
    WorkLogContext,
    Workspace,
    now_ms,
)
from app.db.models import Session as LoginSession
from app.modules.security import hasher

COOLING_DAYS = 7
AUDIT_RETENTION_DAYS = 30


def deletion_status(user: User) -> tuple[int | None, int | None]:
    return user.deletion_requested_at, user.deletion_due_at


def request_deletion(db: Session, user: User, password: str) -> User:
    try:
        hasher.verify(user.password_hash, password)
    except Exception:
        raise HTTPException(403, "密码不正确") from None
    now = now_ms()
    user.deletion_requested_at = now
    user.deletion_due_at = now + COOLING_DAYS * 24 * 60 * 60 * 1000
    db.execute(delete(LoginSession).where(LoginSession.user_id == user.id))
    db.commit()
    db.refresh(user)
    return user


def cancel_deletion(db: Session, user: User) -> User:
    user.deletion_requested_at = None
    user.deletion_due_at = None
    db.commit()
    db.refresh(user)
    return user


def _delete_files(db: Session, user: User, settings: Settings) -> None:
    source_names = [
        source.file_name
        for source in db.scalars(
            select(ImportSource).where(
                ImportSource.workspace_id == user.workspace_id,
                ImportSource.file_name != "",
            )
        )
    ]
    for name in source_names:
        try:
            (Path(settings.source_dir) / name).unlink(missing_ok=True)
        except OSError:
            pass
    for directory in (
        Path(settings.attachment_dir) / user.workspace_id,
        Path(settings.agent_image_dir) / user.workspace_id,
    ):
        try:
            shutil.rmtree(directory, ignore_errors=True)
        except OSError:
            pass


def purge_user(db: Session, user: User, settings: Settings) -> None:
    workspace_id = user.workspace_id
    audit_counts = Counter(
        db.scalars(select(Audit.action).where(Audit.workspace_id == workspace_id))
    )
    _delete_files(db, user, settings)

    def drop(model: type[object], *conditions: object) -> None:
        db.execute(delete(model).where(*conditions))  # type: ignore[arg-type]

    drop(AgentAction, AgentAction.workspace_id == workspace_id)
    drop(AgentImage, AgentImage.workspace_id == workspace_id)
    drop(AgentMessage, AgentMessage.workspace_id == workspace_id)
    drop(AgentRun, AgentRun.workspace_id == workspace_id)
    drop(AgentConversation, AgentConversation.workspace_id == workspace_id)
    drop(ImportLink, ImportLink.workspace_id == workspace_id)
    drop(ImportJob, ImportJob.workspace_id == workspace_id)
    drop(ImportSource, ImportSource.workspace_id == workspace_id)
    drop(WorkLogContext, WorkLogContext.workspace_id == workspace_id)
    drop(WorkLog, WorkLog.workspace_id == workspace_id)
    drop(ActivityFeedback, ActivityFeedback.workspace_id == workspace_id)
    drop(TaskAttachment, TaskAttachment.workspace_id == workspace_id)
    drop(TaskTag, TaskTag.workspace_id == workspace_id)
    drop(TaskDependency, TaskDependency.workspace_id == workspace_id)
    db.execute(
        update(Draft).where(Draft.workspace_id == workspace_id).values(published_task_id=None)
    )
    drop(Draft, Draft.workspace_id == workspace_id)
    db.execute(update(Plan).where(Plan.workspace_id == workspace_id).values(base_plan_id=None))
    drop(Plan, Plan.workspace_id == workspace_id)
    drop(Task, Task.workspace_id == workspace_id)
    drop(TaskList, TaskList.workspace_id == workspace_id)
    drop(TaskListGroup, TaskListGroup.workspace_id == workspace_id)
    drop(Tag, Tag.workspace_id == workspace_id)
    drop(EventOverride, EventOverride.workspace_id == workspace_id)
    drop(Event, Event.workspace_id == workspace_id)
    drop(EventSeries, EventSeries.workspace_id == workspace_id)
    drop(Course, Course.workspace_id == workspace_id)
    drop(EventType, EventType.workspace_id == workspace_id)
    drop(CompatibilityRule, CompatibilityRule.workspace_id == workspace_id)
    drop(TaskTypePolicy, TaskTypePolicy.workspace_id == workspace_id)
    drop(SavedFilter, SavedFilter.workspace_id == workspace_id)
    drop(IdempotentOperation, IdempotentOperation.workspace_id == workspace_id)
    drop(Audit, Audit.workspace_id == workspace_id)
    drop(LoginSession, LoginSession.user_id == user.id)
    db.delete(user)
    db.delete(db.get(Workspace, workspace_id))
    db.add(
        DeletedWorkspaceAudit(
            deleted_at=now_ms(),
            expires_at=now_ms() + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            actions=dict(audit_counts),
        )
    )
    db.commit()


def purge_due_accounts(db: Session, settings: Settings) -> int:
    users = list(
        db.scalars(
            select(User).where(User.deletion_due_at.is_not(None), User.deletion_due_at <= now_ms())
        )
    )
    for user in users:
        purge_user(db, user, settings)
    db.execute(delete(DeletedWorkspaceAudit).where(DeletedWorkspaceAudit.expires_at <= now_ms()))
    db.commit()
    return len(users)
