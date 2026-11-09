from pathlib import Path

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.db.models import (
    Audit,
    Draft,
    Task,
    TaskAttachment,
    TaskDependency,
    TaskTag,
    WorkLog,
    WorkLogContext,
)

TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000


def purge_tasks(
    db: Session,
    workspace_id: str,
    task_ids: list[str],
    attachment_dir: Path | None,
) -> tuple[list[Path], int]:
    if not task_ids:
        return [], 0
    ids = list(
        db.scalars(
            select(Task.id).where(
                Task.workspace_id == workspace_id,
                Task.id.in_(task_ids),
            )
        )
    )
    if not ids:
        return [], 0
    attachments = list(db.scalars(select(TaskAttachment).where(TaskAttachment.task_id.in_(ids))))
    paths = (
        [Path(attachment_dir) / item.workspace_id / item.id for item in attachments]
        if attachment_dir
        else []
    )
    db.execute(delete(TaskAttachment).where(TaskAttachment.task_id.in_(ids)))
    db.execute(delete(TaskTag).where(TaskTag.task_id.in_(ids)))
    log_ids = list(db.scalars(select(WorkLog.id).where(WorkLog.task_id.in_(ids))))
    if log_ids:
        db.execute(
            delete(WorkLogContext).where(WorkLogContext.work_log_id.in_(log_ids))
        )
    db.execute(delete(WorkLog).where(WorkLog.task_id.in_(ids)))
    db.execute(
        delete(TaskDependency).where(
            or_(
                TaskDependency.predecessor_task_id.in_(ids),
                TaskDependency.successor_task_id.in_(ids),
            )
        )
    )
    db.execute(update(Task).where(Task.parent_id.in_(ids)).values(parent_id=None))
    db.execute(
        update(Task).where(Task.recurrence_parent_id.in_(ids)).values(recurrence_parent_id=None)
    )
    db.execute(update(Draft).where(Draft.published_task_id.in_(ids)).values(published_task_id=None))
    db.flush()
    for task_id in ids:
        db.add(
            Audit(
                workspace_id=workspace_id,
                action="task.purge",
                object_id=task_id,
            )
        )
    db.execute(delete(Task).where(Task.id.in_(ids)))
    db.flush()
    return paths, len(ids)


def purge_old_trash(
    db: Session,
    workspace_id: str,
    attachment_dir: Path | None,
    older_than_ms: int,
) -> tuple[list[Path], int]:
    ids = list(
        db.scalars(
            select(Task.id).where(
                Task.workspace_id == workspace_id,
                Task.trashed_at.is_not(None),
                Task.trashed_at < older_than_ms,
            )
        )
    )
    return purge_tasks(db, workspace_id, ids, attachment_dir)


def unlink_paths(paths: list[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)
