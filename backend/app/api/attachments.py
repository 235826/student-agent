from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select

from app.api.schemas import AttachmentOut
from app.db.models import Audit, Task, TaskAttachment
from app.modules.records import owned, record_change
from app.modules.security import DB, UserDep

router = APIRouter(prefix="/api/v1", tags=["attachments"])

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENTS_PER_TASK = 20


def safe_filename(value: str | None) -> str:
    name = Path(value or "附件").name
    cleaned = "".join(char for char in name if char.isprintable() and char not in "\r\n").strip()
    return (cleaned or "附件")[:255]


def attachment_path(request: Request, attachment: TaskAttachment) -> Path:
    return Path(request.app.state.settings.attachment_dir) / attachment.workspace_id / attachment.id


@router.get("/tasks/{task_id}/attachments", response_model=list[AttachmentOut])
def list_attachments(task_id: str, db: DB, user: UserDep) -> list[TaskAttachment]:
    task = owned(db, Task, task_id, user)
    return list(
        db.scalars(
            select(TaskAttachment)
            .where(TaskAttachment.task_id == task.id)
            .order_by(TaskAttachment.created_at, TaskAttachment.id)
        )
    )


@router.post(
    "/tasks/{task_id}/attachments",
    response_model=AttachmentOut,
    status_code=201,
)
def upload_attachment(
    task_id: str,
    request: Request,
    db: DB,
    user: UserDep,
    file: Annotated[UploadFile, File()],
) -> TaskAttachment:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is not None:
        raise HTTPException(409, "请先恢复垃圾箱中的任务")
    count = (
        db.scalar(select(func.count(TaskAttachment.id)).where(TaskAttachment.task_id == task.id))
        or 0
    )
    if count >= MAX_ATTACHMENTS_PER_TASK:
        raise HTTPException(409, f"每个任务最多 {MAX_ATTACHMENTS_PER_TASK} 个附件")

    attachment_id = str(uuid4())
    directory = Path(request.app.state.settings.attachment_dir) / user.workspace_id
    directory.mkdir(parents=True, exist_ok=True)
    final = directory / attachment_id
    temp = directory / f".{attachment_id}.tmp"
    size = 0
    try:
        with temp.open("wb") as target:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES:
                    raise HTTPException(413, "附件不能超过 20 MiB")
                target.write(chunk)
        if size == 0:
            raise HTTPException(422, "附件不能为空")
        temp.replace(final)
    except Exception:
        temp.unlink(missing_ok=True)
        final.unlink(missing_ok=True)
        raise

    attachment = TaskAttachment(
        id=attachment_id,
        workspace_id=user.workspace_id,
        task_id=task.id,
        filename=safe_filename(file.filename),
        media_type=(file.content_type or "")[:200],
        size_bytes=size,
    )
    db.add(attachment)
    try:
        record_change(db, user, "attachment.create", attachment, scheduling=False)
    except Exception:
        final.unlink(missing_ok=True)
        raise
    return attachment


@router.get("/attachments/{attachment_id}")
def download_attachment(
    attachment_id: str, request: Request, db: DB, user: UserDep
) -> FileResponse:
    attachment = owned(db, TaskAttachment, attachment_id, user)
    path = attachment_path(request, attachment)
    if not path.is_file():
        raise HTTPException(404, "附件文件不可用")
    return FileResponse(
        path,
        media_type=attachment.media_type or "application/octet-stream",
        filename=attachment.filename,
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.delete("/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: str, request: Request, db: DB, user: UserDep) -> None:
    attachment = owned(db, TaskAttachment, attachment_id, user)
    path = attachment_path(request, attachment)
    db.delete(attachment)
    db.add(
        Audit(
            workspace_id=user.workspace_id,
            action="attachment.delete",
            object_id=attachment_id,
        )
    )
    db.commit()
    path.unlink(missing_ok=True)
