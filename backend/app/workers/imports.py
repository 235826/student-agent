"""Single-process worker. Lease tokens prevent late responses overwriting new work."""

import logging
import signal
import threading
from pathlib import Path
from secrets import randbelow
from typing import Protocol
from uuid import uuid4

from sqlalchemy import Engine, or_, select
from sqlalchemy.orm import Session

from app.api.import_schemas import ModelDraft
from app.config import Settings
from app.db.models import ImportJob, ImportSource, WorkerHeartbeat, now_ms
from app.db.session import build_engine
from app.providers.chat_completions import ChatCompletions, ParseFailure, ParseInput


class Provider(Protocol):
    def parse(self, source: ParseInput) -> ModelDraft: ...


def run_once(engine: Engine, settings: Settings, provider: Provider) -> bool:
    with Session(engine) as db:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        now = now_ms()
        heartbeat = db.get(WorkerHeartbeat, "imports")
        if heartbeat is None:
            db.add(WorkerHeartbeat(name="imports", heartbeat_at=now))
        else:
            heartbeat.heartbeat_at = now
        job = db.scalar(
            select(ImportJob)
            .where(
                or_(
                    (ImportJob.status == "queued") & (ImportJob.next_run_at <= now),
                    (ImportJob.status == "running") & (ImportJob.lease_until < now),
                )
            )
            .order_by(ImportJob.created_at)
            .limit(1)
        )
        if job is None:
            db.commit()
            return False
        source = db.get(ImportSource, job.source_id)
        if source is None or source.deleted_at is not None or job.attempts >= 3:
            job.status = "failed"
            job.error = "任务已失效或达到重试上限"
            db.commit()
            return True
        job.attempts += 1
        job.status = "running"
        job.lease_token = token = str(uuid4())
        job.lease_until = now + (settings.llm_timeout_seconds * 2 + 60) * 1000
        job_id = job.id
        file_name = source.file_name
        request = ParseInput(
            source.text, None, source.media_type, job.context, job.timezone, job.reference_at
        )
        db.commit()
    # Neither disk access nor the external request holds a database transaction.
    result = None
    failure = None
    try:
        if file_name:
            request = ParseInput(
                request.text,
                (settings.source_dir / file_name).read_bytes(),
                request.media_type,
                request.context,
                request.timezone,
                request.reference_at,
            )
        result = provider.parse(request)
    except ParseFailure as exc:
        failure = exc
    except Exception:
        failure = ParseFailure("解析未完成，请检查服务配置或手动整理")
    with Session(engine) as db:
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        job = db.get(ImportJob, job_id)
        if job is None or job.status != "running" or job.lease_token != token:
            return True
        source = db.get(ImportSource, job.source_id)
        if source is None or source.deleted_at is not None:
            return True
        job.lease_until = 0
        job.lease_token = ""
        job.revision += 1
        if result is not None:
            job.candidates = [
                c.model_copy(update={"reviewed": False}).model_dump(mode="json")
                for c in result.candidates
            ]
            job.warnings = result.warnings
            job.error = ""
            job.status = "succeeded"
        else:
            assert failure is not None
            job.error = str(failure)
            job.status = "queued" if failure.transient and job.attempts < 3 else "failed"
            delay = 60 * job.attempts + randbelow(16) if failure.rate_limited else 10 * job.attempts
            delay = max(delay, failure.retry_after_seconds)
            job.next_run_at = now_ms() + delay * 1000
        db.commit()
    return True


def cleanup_orphans(engine: Engine, directory: Path) -> None:
    if not directory.exists():
        return
    with Session(engine) as db:
        referenced = set(db.scalars(select(ImportSource.file_name)))
    for path in directory.iterdir():
        if (
            path.is_file()
            and path.name not in referenced
            and path.stat().st_mtime * 1000 < now_ms() - 86400000
        ):
            path.unlink(missing_ok=True)


def serve(settings: Settings, stopped: threading.Event) -> None:
    engine = build_engine(settings.database_url)
    provider = ChatCompletions(settings)
    last_cleanup = 0
    try:
        while not stopped.is_set():
            try:
                run_once(engine, settings, provider)
                if now_ms() - last_cleanup > 3600000:
                    cleanup_orphans(engine, settings.source_dir)
                    last_cleanup = now_ms()
            except Exception:
                # Never log source content, credentials, or provider response bodies.
                logging.getLogger("student_agent.worker").error("import_worker_cycle_failed")
            stopped.wait(2)
    finally:
        engine.dispose()


if __name__ == "__main__":
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    serve(Settings(), stop)
