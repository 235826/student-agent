"""Single-process global agent worker."""

import logging
import signal
import threading

from sqlalchemy import Engine

from app.config import Settings
from app.db.models import now_ms
from app.db.session import build_engine
from app.modules.agent.runner import expire_actions, run_once
from app.providers.agent_chat import AgentChat


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
