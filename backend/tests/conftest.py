from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

ORIGIN = "http://localhost:5173"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    settings = Settings(database_url=f"sqlite:///{tmp_path / 'test.db'}")
    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.attributes["database_url"] = settings.database_url
    command.upgrade(cfg, "head")
    return settings


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app = create_app(settings)
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        yield client
    app.state.engine.dispose()


@pytest.fixture
def authenticated(client: TestClient) -> TestClient:
    response = client.post(
        "/api/v1/auth/setup",
        json={
            "username": "student",
            "password": "test-password-123",
        },
    )
    assert response.status_code == 201, response.text
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return client
