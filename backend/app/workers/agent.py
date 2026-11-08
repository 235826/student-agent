"""Single-process global agent worker."""

import logging
import signal
import threading
from pathlib import Path

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import AgentImage, now_ms
from app.db.session import build_engine
from app.modules.agent.runner import expire_actions, run_once
from app.providers.agent_chat import AgentChat


def cleanup_orphan_images(engine: Engine, directory: Path) -> None:
    if not directory.exists():
        return
    with Session(engine) as db:
        orphans = list(
            db.scalars(
                select(AgentImage).where(
                    AgentImage.message_id.is_(None),
                    AgentImage.created_at < now_ms() - 86400000,
                )
            )
        )
        for image in orphans:
            path = directory / image.workspace_id / image.id
            path.unlink(missing_ok=True)
            db.delete(image)
        if orphans:
            db.commit()


def serve(settings: Settings, stopped: threading.Event, engine: Engine | None = None) -> None:
    database = engine or build_engine(settings.database_url)
    provider = AgentChat(settings)
    last_cleanup = 0
    try:
        while not stopped.is_set():
            try:
                run_once(database, settings, provider)
                if now_ms() - last_cleanup > 3600000:
                    expire_actions(database)
                    cleanup_orphan_images(database, settings.agent_image_dir)
                    last_cleanup = now_ms()
            except Exception:
                logging.getLogger("student_agent.agent_worker").error("agent_worker_cycle_failed")
            stopped.wait(2)
    finally:
        if engine is None:
            database.dispose()


if __name__ == "__main__":
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    serve(Settings(), stop)
