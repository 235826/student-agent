from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import Event, User, Workspace
from app.main import create_app

EVENT = {
    "title": "数据库课",
    "start_at": "2026-10-21T09:00:00+08:00",
    "end_at": "2026-10-21T10:00:00+08:00",
    "timezone": "Asia/Shanghai",
}


def test_auth_csrf_and_errors(authenticated: TestClient) -> None:
    client = authenticated
    assert client.get("/api/v1/auth/me").status_code == 200
    assert (
        client.post(
            "/api/v1/tasks", json={"title": "blocked"}, headers={"X-CSRF-Token": ""}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/v1/tasks", json={"title": "blocked"}, headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/v1/auth/setup", json={"username": "other", "password": "1234567890"}
        ).status_code
        == 409
    )
    bad = client.post("/api/v1/tasks", json={"title": "", "estimate_minutes": -1})
    assert bad.status_code == 422
    assert bad.json()["request_id"]
    assert "input" not in str(bad.json()["errors"])
    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/tasks").status_code == 401
    assert (
        client.post(
            "/api/v1/auth/login", json={"username": "student", "password": "wrong-password"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/auth/login", json={"username": "student", "password": "test-password-123"}
        ).status_code
        == 200
    )


def test_task_lifecycle_and_restart(authenticated: TestClient, settings: Settings) -> None:
    client = authenticated
    response = client.post("/api/v1/tasks", json={"title": "算法作业", "estimate_minutes": 120})
    assert response.status_code == 201
    task = response.json()
    updated = client.put(
        f"/api/v1/tasks/{task['id']}",
        json={"title": "算法作业", "status": "done", "deadline_at": "2026-10-23T23:59:00+08:00"},
    )
    assert updated.status_code == 200
    client.post(f"/api/v1/tasks/{task['id']}/trash")
    assert client.get("/api/v1/tasks").json() == []
    assert client.get("/api/v1/tasks?trashed=true").json()[0]["status"] == "done"
    client.post(f"/api/v1/tasks/{task['id']}/restore")
    app2 = create_app(settings)
    with TestClient(app2, cookies=client.cookies) as restarted:
        persisted = restarted.get("/api/v1/tasks").json()[0]
        assert persisted["id"] == task["id"]
        assert persisted["status"] == "done"
        assert persisted["trashed_at"] is None
    app2.state.engine.dispose()


def test_event_timezone_and_validation(authenticated: TestClient) -> None:
    client = authenticated
    result = client.post("/api/v1/events", json=EVENT)
    assert result.status_code == 201, result.text
    event = result.json()
    assert event["start_at"] == "2026-10-21T01:00:00Z"
    assert client.put("/api/v1/profile", json={"timezone": "America/New_York"}).status_code == 200
    assert client.get("/api/v1/events").json()[0]["start_at"] == event["start_at"]
    assert client.put("/api/v1/profile", json={"timezone": "Not/A_Zone"}).status_code == 422
    assert (
        client.post("/api/v1/events", json={**EVENT, "end_at": EVENT["start_at"]}).status_code
        == 422
    )
    assert (
        client.post("/api/v1/events", json={**EVENT, "start_at": "2026-10-21T09:00:00"}).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/tasks", json={"title": "x", "deadline_at": "2026-10-21T09:00:00"}
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/v1/profile",
            json={"available_windows": [{"weekday": 1, "start": "12:00", "end": "09:00"}]},
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"/api/v1/events/{event['id']}",
            json={**EVENT, "title": "数据库课（改教室）", "location": "A101"},
        ).status_code
        == 200
    )
    assert client.get("/api/v1/events").json()[0]["location"] == "A101"


def test_sqlite_constraints_and_workspace(authenticated: TestClient) -> None:
    engine = authenticated.app.state.engine
    with engine.connect() as conn:
        assert conn.scalar(text("PRAGMA foreign_keys")) == 1
        assert conn.scalar(text("PRAGMA journal_mode")) == "wal"
        assert conn.scalar(text("SELECT version_num FROM alembic_version")) == "0007"
    with Session(engine) as db:
        workspace = Workspace()
        db.add(workspace)
        db.flush()
        event = Event(
            workspace_id=workspace.id, title="另一个工作区", start_at=1, end_at=2, timezone="UTC"
        )
        db.add(event)
        db.commit()
        event_id = event.id
    assert authenticated.put(f"/api/v1/events/{event_id}", json=EVENT).status_code == 404
    with Session(engine) as db:
        db.add(Event(workspace_id="missing", title="invalid", start_at=1, end_at=2, timezone="UTC"))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
        else:
            raise AssertionError("外键约束未生效")
    assert authenticated.get("/health/ready").status_code == 200


def test_rate_limit(client: TestClient) -> None:
    for _ in range(10):
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "none", "password": "1234567890"}
            ).status_code
            == 401
        )
    assert (
        client.post(
            "/api/v1/auth/login", json={"username": "none", "password": "1234567890"}
        ).status_code
        == 429
    )


def test_concurrent_setup_and_writes(settings: Settings) -> None:
    app = create_app(settings)

    def setup(_: int) -> int:
        with TestClient(app, headers={"Origin": "http://localhost:5173"}) as client:
            return client.post(
                "/api/v1/auth/setup", json={"username": "student", "password": "test-password-123"}
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(setup, range(2))) == [201, 409]
    with Session(app.state.engine) as db:
        assert len(list(db.scalars(select(User)))) == 1
    app.state.engine.dispose()


def test_health_requires_migration(tmp_path) -> None:
    app = create_app(Settings(database_url=f"sqlite:///{tmp_path / 'empty.db'}"))
    with TestClient(app) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").status_code == 503
    app.state.engine.dispose()


def test_utc_millisecond_storage(authenticated: TestClient) -> None:
    result = authenticated.post("/api/v1/events", json=EVENT).json()
    with authenticated.app.state.engine.connect() as conn:
        start = conn.scalar(text("SELECT start_at FROM events WHERE id=:id"), {"id": result["id"]})
        assert isinstance(start, int)
        assert start == int(datetime.fromisoformat(EVENT["start_at"]).timestamp() * 1000)


def test_session_expiry_and_password_whitespace(client: TestClient) -> None:
    from app.db.models import Session as LoginSession
    from app.db.models import now_ms

    body = {"username": "student", "password": "  a-password-123  "}
    result = client.post("/api/v1/auth/setup", json=body)
    assert result.status_code == 201
    client.headers["X-CSRF-Token"] = result.json()["csrf_token"]
    cookie = client.cookies.get("student_session")
    assert "HttpOnly" in result.headers["set-cookie"]
    with Session(client.app.state.engine) as db:
        session = db.scalar(select(LoginSession))
        assert session is not None
        assert session.token_hash != cookie
        session.expires_at = now_ms() - 1
        db.commit()
    assert client.get("/api/v1/tasks").status_code == 401
    assert (
        client.post(
            "/api/v1/auth/login", json={**body, "password": body["password"].strip()}
        ).status_code
        == 401
    )
    assert client.post("/api/v1/auth/login", json=body).status_code == 200


def test_concurrent_tasks_are_committed_with_revision(authenticated: TestClient) -> None:
    app = authenticated.app
    cookies = dict(authenticated.cookies)
    csrf = authenticated.headers["X-CSRF-Token"]
    with Session(app.state.engine) as db:
        workspace = db.scalar(select(Workspace))
        assert workspace is not None
        previous = workspace.scheduling_revision

    def create(index: int) -> int:
        with TestClient(
            app,
            cookies=cookies,
            headers={
                "Origin": "http://localhost:5173",
                "X-CSRF-Token": csrf,
            },
        ) as client:
            return client.post("/api/v1/tasks", json={"title": f"任务 {index}"}).status_code

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(create, range(8))) == [201] * 8
    assert len(authenticated.get("/api/v1/tasks").json()) == 8
    with Session(app.state.engine) as db:
        workspace = db.scalar(select(Workspace))
        assert workspace is not None
        assert workspace.scheduling_revision == previous + 8


def test_second_account_has_separate_workspace(authenticated: TestClient) -> None:
    c = authenticated
    first = c.post("/api/v1/tasks", json={"title": "第一个账号的任务"})
    assert first.status_code == 201

    registered = c.post(
        "/api/v1/auth/register",
        json={
            "username": "second",
            "password": "second-password-123",
            "timezone": "Asia/Shanghai",
        },
    )
    assert registered.status_code == 201, registered.text
    assert registered.json()["user"]["username"] == "second"
    c.headers["X-CSRF-Token"] = registered.json()["csrf_token"]
    assert c.get("/api/v1/tasks").json() == []
    assert c.get("/api/v1/event-types").json()
    assert c.post("/api/v1/tasks", json={"title": "第二个账号的任务"}).status_code == 201

    assert (
        c.post(
            "/api/v1/auth/register",
            json={"username": "second", "password": "another-password-123"},
        ).status_code
        == 409
    )

    logged_in = c.post(
        "/api/v1/auth/login",
        json={"username": "student", "password": "test-password-123"},
    )
    assert logged_in.status_code == 200
    c.headers["X-CSRF-Token"] = logged_in.json()["csrf_token"]
    titles = [task["title"] for task in c.get("/api/v1/tasks").json()]
    assert titles == ["第一个账号的任务"]
