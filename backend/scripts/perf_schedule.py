"""Reproducible P0 scheduling performance check: 100 tasks + 500 events."""

import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import monotonic
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import Event, Task, User
from app.main import create_app

backend = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="student-agent-perf-") as directory:
    root = Path(directory)
    settings = Settings(
        database_url=f"sqlite:///{root / 'perf.db'}",
        attachment_dir=root / "attachments",
        agent_image_dir=root / "agent-images",
        source_dir=root / "sources",
    )
    config = Config(str(backend / "alembic.ini"))
    config.attributes["database_url"] = settings.database_url
    command.upgrade(config, "head")
    app = create_app(settings)
    with TestClient(app, headers={"Origin": "http://localhost:5173"}) as client:
        response = client.post(
            "/api/v1/auth/setup",
            json={"username": "perf", "password": "test-password-123"},
        )
        client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
        client.put(
            "/api/v1/profile",
            json={
                "timezone": "Asia/Shanghai",
                "available_windows": [
                    {"weekday": day, "start": "08:00", "end": "22:00"} for day in range(7)
                ],
                "rest_windows": [],
            },
        )
        with Session(app.state.engine) as db:
            user = db.query(User).one()
            start = datetime(2030, 1, 7, tzinfo=UTC)
            for index in range(100):
                db.add(
                    Task(
                        workspace_id=user.workspace_id,
                        title=f"任务 {index}",
                        estimate_minutes=60,
                        deadline_at=int((start + timedelta(days=20)).timestamp() * 1000),
                    )
                )
            for index in range(500):
                event_start = start + timedelta(hours=index * 3)
                db.add(
                    Event(
                        workspace_id=user.workspace_id,
                        title=f"事件 {index}",
                        start_at=int(event_start.timestamp() * 1000),
                        end_at=int((event_start + timedelta(hours=1)).timestamp() * 1000),
                        timezone="Asia/Shanghai",
                        locked=True,
                    )
                )
            db.commit()
        began = monotonic()
        plan = client.post(
            "/api/v1/plans",
            json={
                "start_at": "2030-01-07T00:00:00+08:00",
                "end_at": "2030-02-07T00:00:00+08:00",
                "idempotency_key": str(uuid4()),
            },
        )
        elapsed = monotonic() - began
        print(
            f"status={plan.status_code} elapsed={elapsed:.3f}s "
            f"blocks={len(plan.json().get('blocks', []))}"
        )
        if plan.status_code != 201 or elapsed > 2.0:
            sys.exit(1)
    app.state.engine.dispose()
