import hashlib
import io
import os
import warnings
from datetime import datetime
from typing import Annotated
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError
from sqlalchemy import select

from app.api.import_schemas import (
    ImportAction,
    ImportCapabilities,
    ImportEdit,
    ImportOut,
    ImportPublish,
    ImportRetry,
    ImportText,
    SourceOut,
)
from app.api.schemas import EventInput, SeriesInput, TaskInput
from app.db.models import (
    Course,
    Event,
    ImportJob,
    ImportLink,
    ImportSource,
    Owned,
    User,
    WorkerHeartbeat,
    now_ms,
)
from app.modules.calendar_management import create_series, unambiguous_instant
from app.modules.event_types import ensure_system_types, resolve_event_type
from app.modules.idempotency import remember, replay
from app.modules.records import owned, record_change
from app.modules.security import DB, UserDep
from app.modules.task_management import apply_task
from app.providers.chat_completions import configured

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def view(db: DB, job: ImportJob) -> ImportOut:
    source = db.get(ImportSource, job.source_id)
    assert source is not None
    return ImportOut(
        source=SourceOut.model_validate(source),
        **{name: getattr(job, name) for name in ImportOut.model_fields if name != "source"},
    )


def editable(db: DB, user: User, job_id: str, revision: int) -> ImportJob:
    job = owned(db, ImportJob, job_id, user)
    source = db.get(ImportSource, job.source_id)
    if source is None or source.deleted_at is not None:
        raise HTTPException(409, "来源已删除")
    if job.published_revision is not None:
        raise HTTPException(409, "此批次已入库，请在任务或课表页修改")
    if job.revision != revision:
        raise HTTPException(409, "草稿版本已变化，请刷新后重新校对")
    return job


@router.get("/capabilities", response_model=ImportCapabilities)
def capabilities(request: Request, db: DB, user: UserDep) -> ImportCapabilities:
    settings = request.app.state.settings
    heartbeat = db.get(WorkerHeartbeat, "imports")
    return ImportCapabilities(
        configured=configured(settings),
        images=settings.llm_supports_images,
        worker_online=bool(
            heartbeat
            and now_ms() - heartbeat.heartbeat_at < (settings.llm_timeout_seconds * 2 + 70) * 1000
        ),
    )


@router.get("", response_model=list[ImportOut])
def imports(db: DB, user: UserDep) -> list[ImportOut]:
    jobs = db.scalars(
        select(ImportJob)
        .where(ImportJob.workspace_id == user.workspace_id)
        .order_by(ImportJob.created_at.desc())
        .limit(100)
    )
    return [view(db, job) for job in jobs]


@router.get("/origins", response_model=list[ImportOut])
def origins(object_id: str, db: DB, user: UserDep) -> list[ImportOut]:
    jobs = db.scalars(
        select(ImportJob)
        .join(ImportLink, ImportLink.job_id == ImportJob.id)
        .where(ImportLink.object_id == object_id, ImportLink.workspace_id == user.workspace_id)
    )
    return [view(db, job) for job in jobs.unique()]


def create_job(
    db: DB,
    user: User,
    request: Request,
    body: ImportText,
    image: bytes | None = None,
    media_type: str = "",
) -> ImportOut:
    digest = hashlib.sha256(image if image is not None else body.text.encode()).hexdigest()
    payload = {
        "operation": "import.create",
        "digest": digest,
        "kind": "image" if image is not None else "text",
        "context": body.context,
        "parse": body.parse,
        "reference_at": body.reference_at.isoformat(),
    }
    existing = replay(db, user, body.idempotency_key, payload)
    if existing:
        return view(db, owned(db, ImportJob, existing, user))
    source = db.scalar(
        select(ImportSource).where(
            ImportSource.workspace_id == user.workspace_id, ImportSource.digest == digest
        )
    )
    if source:
        job = db.scalar(select(ImportJob).where(ImportJob.source_id == source.id))
        assert job is not None
        remember(db, user, body.idempotency_key, payload, job.id)
        return view(db, job)
    name = ""
    if image is not None:
        directory = request.app.state.settings.source_dir
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = str(uuid4())
        temporary = directory / (name + ".tmp")
        with temporary.open("xb") as stream:
            os.chmod(temporary, 0o600)
            stream.write(image)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(directory / name)
        # If the transaction fails, the worker removes this orphan after 24h.
    source = ImportSource(
        workspace_id=user.workspace_id,
        kind=payload["kind"],
        digest=digest,
        text=body.text if image is None else "",
        file_name=name,
        media_type=media_type,
    )
    db.add(source)
    db.flush()
    job = ImportJob(
        workspace_id=user.workspace_id,
        source_id=source.id,
        timezone=user.timezone,
        reference_at=int(body.reference_at.timestamp() * 1000),
        context=body.context,
        status="queued" if body.parse else "succeeded",
    )
    db.add(job)
    db.flush()
    remember(db, user, body.idempotency_key, payload, job.id)
    record_change(db, user, "import.create", job, scheduling=False)
    return view(db, job)


@router.post("/text", response_model=ImportOut, status_code=202)
def import_text(body: ImportText, request: Request, db: DB, user: UserDep) -> ImportOut:
    return create_job(db, user, request, body)


@router.post("/image", response_model=ImportOut, status_code=202)
def import_image(
    request: Request,
    db: DB,
    user: UserDep,
    file: Annotated[UploadFile, File()],
    idempotency_key: Annotated[str, Form(min_length=8, max_length=200)],
    reference_at: Annotated[datetime, Form()],
    confirmed: Annotated[bool, Form()],
    context: Annotated[str, Form(max_length=4000)] = "",
    parse: Annotated[bool, Form()] = True,
) -> ImportOut:
    if (parse and not confirmed) or reference_at.tzinfo is None:
        raise HTTPException(422, "需要确认发送图片并提供含时区的参考时间")
    data = file.file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "图片不能超过 8 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as decoded:
                if decoded.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError()
                if (
                    decoded.width * decoded.height > 20_000_000
                    or getattr(decoded, "n_frames", 1) != 1
                ):
                    raise ValueError()
                media_type = Image.MIME[decoded.format]
                decoded.verify()
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ):
        raise HTTPException(422, "请上传有效的单帧 PNG/JPEG/WebP 图片，最多 2000 万像素") from None
    body = ImportText(
        text="图片",
        context=context,
        reference_at=reference_at,
        confirmed=confirmed,
        parse=parse,
        idempotency_key=idempotency_key,
    )
    return create_job(db, user, request, body, data, media_type)


@router.get("/{job_id}", response_model=ImportOut)
def get_job(job_id: str, db: DB, user: UserDep) -> ImportOut:
    return view(db, owned(db, ImportJob, job_id, user))


@router.get("/{job_id}/source")
def get_source(job_id: str, request: Request, db: DB, user: UserDep) -> FileResponse:
    job = owned(db, ImportJob, job_id, user)
    source = db.get(ImportSource, job.source_id)
    if source is None or source.deleted_at is not None or not source.file_name:
        raise HTTPException(404, "图片来源不存在或已删除")
    path = request.app.state.settings.source_dir / source.file_name
    if not path.is_file():
        raise HTTPException(404, "来源文件不可用")
    return FileResponse(path, media_type=source.media_type)


@router.put("/{job_id}/draft", response_model=ImportOut)
def save_draft(job_id: str, body: ImportEdit, db: DB, user: UserDep) -> ImportOut:
    job = editable(db, user, job_id, body.revision)
    if job.status in {"queued", "running"}:
        raise HTTPException(409, "请等待解析完成，或先取消解析")
    if len({c.key for c in body.candidates}) != len(body.candidates):
        raise HTTPException(422, "每项草稿的标识必须唯一")
    for candidate in body.candidates:
        if candidate.event_type_id and candidate.kind != "event":
            raise HTTPException(422, "只有单次事件可以设置事件类型")
        if candidate.event_type_id:
            resolve_event_type(
                db,
                user,
                kind="other",
                event_type_id=candidate.event_type_id,
            )
    job.candidates = [c.model_dump(mode="json") for c in body.candidates]
    job.revision += 1
    job.status = "succeeded"
    record_change(db, user, "import.edit", job, scheduling=False)
    return view(db, job)


@router.post("/{job_id}/cancel", response_model=ImportOut)
def cancel(job_id: str, body: ImportAction, db: DB, user: UserDep) -> ImportOut:
    job = editable(db, user, job_id, body.revision)
    job.status = "cancelled"
    job.lease_token = ""
    job.revision += 1
    record_change(db, user, "import.cancel", job, scheduling=False)
    return view(db, job)


@router.post("/{job_id}/retry", response_model=ImportOut)
def retry(job_id: str, body: ImportRetry, db: DB, user: UserDep) -> ImportOut:
    job = editable(db, user, job_id, body.revision)
    if job.status in {"queued", "running"}:
        raise HTTPException(409, "解析仍在进行")
    job.context = body.context
    job.status, job.attempts, job.next_run_at = "queued", 0, 0
    job.candidates, job.warnings, job.error = [], [], ""
    job.revision += 1
    record_change(db, user, "import.retry", job, scheduling=False)
    return view(db, job)


@router.delete("/{job_id}/source", response_model=ImportOut)
def delete_source(
    job_id: str, body: ImportAction, request: Request, db: DB, user: UserDep
) -> ImportOut:
    job = owned(db, ImportJob, job_id, user)
    if job.revision != body.revision:
        raise HTTPException(409, "版本已变化，请刷新后重试")
    source = db.get(ImportSource, job.source_id)
    assert source is not None
    name = source.file_name
    source.text, source.file_name, source.media_type = "", "", ""
    source.digest = str(uuid4())
    source.deleted_at = now_ms()
    job.candidates, job.warnings, job.context, job.error = [], [], "", ""
    job.status, job.lease_token = "cancelled", ""
    job.revision += 1
    record_change(db, user, "import.source.delete", job, scheduling=False)
    if name:
        try:
            (request.app.state.settings.source_dir / name).unlink(missing_ok=True)
        except OSError:
            pass  # Private orphan cleanup retries; source is already inaccessible through API.
    return view(db, job)


@router.post("/{job_id}/publish", response_model=ImportOut)
def publish(job_id: str, body: ImportPublish, db: DB, user: UserDep) -> ImportOut:
    payload = {"operation": "import.publish", "job_id": job_id, "revision": body.revision}
    existing = replay(db, user, body.idempotency_key, payload)
    if existing:
        return view(db, owned(db, ImportJob, existing, user))
    current = owned(db, ImportJob, job_id, user)
    if current.published_revision is not None:
        if current.published_revision != body.revision:
            raise HTTPException(409, "此批次已经确认入库")
        return view(db, current)
    job = editable(db, user, job_id, body.revision)
    if job.status != "succeeded":
        raise HTTPException(409, "请先完成并保存草稿")
    from app.api.import_schemas import ImportCandidate

    candidates = [ImportCandidate.model_validate(c) for c in job.candidates if c["selected"]]
    if not candidates or any(not c.reviewed or not c.title.strip() for c in candidates):
        raise HTTPException(422, "请为每个选中条目填写标题并确认已校对")
    zone = ZoneInfo(job.timezone)
    ids: dict[str, str] = {}
    records: list[dict[str, str]] = []
    obj: Owned
    pending = list(candidates)
    try:
        while pending:
            progressed = False
            for candidate in pending[:]:
                refs = candidate.predecessor_keys + (
                    [candidate.parent_key] if candidate.parent_key else []
                )
                if refs and candidate.kind != "task":
                    raise HTTPException(422, "只有任务可以设置父任务和依赖")
                if any(
                    not any(c.key == ref and c.kind == "task" for c in candidates) for ref in refs
                ):
                    raise HTTPException(422, "父任务和依赖必须引用本批次选中的任务")
                if any(ref not in ids for ref in refs):
                    continue
                if candidate.kind == "task":
                    obj = apply_task(
                        db,
                        user,
                        TaskInput(
                            title=candidate.title,
                            description=candidate.description,
                            priority=candidate.priority,
                            estimate_minutes=candidate.estimate_minutes,
                            deadline_at=unambiguous_instant(candidate.deadline_local, zone)
                            if candidate.deadline_local
                            else None,
                            parent_id=ids[candidate.parent_key] if candidate.parent_key else None,
                            predecessor_ids=[ids[k] for k in candidate.predecessor_keys],
                        ),
                    )
                    object_kind = "task"
                elif candidate.kind == "event":
                    if candidate.start_local is None or candidate.end_local is None:
                        raise HTTPException(422, "事件需要明确的开始和结束时间")
                    system_types = ensure_system_types(db, user)
                    event_type_id = candidate.event_type_id or system_types[candidate.event_kind].id
                    event_type = resolve_event_type(
                        db,
                        user,
                        kind="other",
                        event_type_id=event_type_id,
                    )
                    event = EventInput(
                        title=candidate.title,
                        start_at=unambiguous_instant(candidate.start_local, zone),
                        end_at=unambiguous_instant(candidate.end_local, zone),
                        timezone=job.timezone,
                        location=candidate.location,
                        kind="other",
                        event_type_id=event_type.id if event_type else None,
                    )
                    obj = Event(
                        workspace_id=user.workspace_id,
                        **event.model_dump(
                            exclude={"start_at", "end_at", "note_scope", "details_scope"}
                        ),
                        start_at=int(event.start_at.timestamp() * 1000),
                        end_at=int(event.end_at.timestamp() * 1000),
                    )
                    db.add(obj)
                    db.flush()
                    object_kind = "event"
                else:
                    if candidate.recurrence is None:
                        raise HTTPException(422, "课程需要学期日期、星期和节次时间")
                    course = Course(workspace_id=user.workspace_id, name=candidate.title)
                    db.add(course)
                    db.flush()
                    series = SeriesInput.model_validate(
                        {
                            **candidate.recurrence.model_dump(),
                            "course_id": course.id,
                            "timezone": job.timezone,
                            "location": candidate.location,
                            "idempotency_key": f"import-series:{job.id}:{candidate.key}",
                        }
                    )
                    obj = create_series(db, user, series, commit=False)
                    object_kind = "series"
                    for event_id in db.scalars(select(Event.id).where(Event.series_id == obj.id)):
                        db.add(
                            ImportLink(
                                workspace_id=user.workspace_id,
                                job_id=job.id,
                                object_kind="event",
                                object_id=event_id,
                            )
                        )
                ids[candidate.key] = obj.id
                records.append({"key": candidate.key, "kind": object_kind, "id": obj.id})
                db.add(
                    ImportLink(
                        workspace_id=user.workspace_id,
                        job_id=job.id,
                        object_kind=object_kind,
                        object_id=obj.id,
                    )
                )
                pending.remove(candidate)
                progressed = True
            if not progressed:
                raise HTTPException(422, "任务父子关系或依赖关系存在循环")
    except ValidationError:
        raise HTTPException(422, "请检查任务、事件或课程的时间与必填信息；本批次尚未入库") from None
    job.published_records = records
    job.published_revision = body.revision
    remember(db, user, body.idempotency_key, payload, job.id)
    record_change(db, user, "import.publish", job)
    return view(db, job)
