from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import User


def task(client: TestClient, title: str = "任务", **kwargs):
    response = client.post("/api/v1/tasks", json={"title": title, **kwargs})
    assert response.status_code == 201, response.text
    return response.json()


def event(client: TestClient, title: str = "数据库课"):
    response = client.post(
        "/api/v1/events",
        json={
            "title": title,
            "start_at": "2030-01-07T09:00:00+08:00",
            "end_at": "2030-01-07T10:00:00+08:00",
            "timezone": "Asia/Shanghai",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_worklog_contexts_and_activity_feedback(authenticated: TestClient) -> None:
    client = authenticated
    record = task(client, "阅读论文", estimate_minutes=60)
    course = event(client)
    created = client.post(
        f"/api/v1/tasks/{record['id']}/worklogs",
        json={
            "actual_minutes": 45,
            "reflection": "在数据库课读论文容易分心",
            "parallel_contexts": [
                {"object_kind": "event", "object_id": course["id"]},
            ],
        },
    )
    assert created.status_code == 201, created.text
    log = created.json()
    assert log["parallel_contexts"][0]["title"] == "数据库课"
    assert log["parallel_contexts"][0]["object_kind"] == "event"

    listed = client.get(f"/api/v1/tasks/{record['id']}/worklogs")
    assert listed.status_code == 200
    assert listed.json()[0]["reflection"] == "在数据库课读论文容易分心"

    updated = client.put(
        f"/api/v1/worklogs/{log['id']}",
        json={
            "reflection": "改成在图书馆读论文更专注",
            "parallel_contexts": [],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["reflection"] == "改成在图书馆读论文更专注"
    assert updated.json()["parallel_contexts"] == []

    feedback = client.post(
        f"/api/v1/events/{course['id']}/feedback",
        json={"rating": 3, "tags": ["分心"], "reflection": "课堂进度偏快"},
    )
    assert feedback.status_code == 201, feedback.text
    assert client.get(f"/api/v1/events/{course['id']}/feedback").json()["rating"] == 3
    changed = client.put(
        f"/api/v1/events/{course['id']}/feedback",
        json={"rating": 4, "tags": [], "reflection": "第二次更适应"},
    )
    assert changed.status_code == 200
    assert changed.json()["rating"] == 4
    assert client.delete(f"/api/v1/events/{course['id']}/feedback").status_code == 204
    assert client.get(f"/api/v1/events/{course['id']}/feedback").json() is None

    assert client.delete(f"/api/v1/worklogs/{log['id']}").status_code == 204
    assert client.get(f"/api/v1/tasks/{record['id']}/worklogs").json() == []


def test_task_archive_and_plan_basis(authenticated: TestClient) -> None:
    client = authenticated
    record = task(client, "归档任务", estimate_minutes=30)
    archived = client.post(f"/api/v1/tasks/{record['id']}/archive")
    assert archived.status_code == 200, archived.text
    assert archived.json()["archived_at"] is not None
    assert client.get("/api/v1/tasks").json() == []
    assert [item["id"] for item in client.get("/api/v1/tasks?view=archived").json()] == [
        record["id"]
    ]
    restored = client.post(f"/api/v1/tasks/{record['id']}/unarchive")
    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None

    client.put(
        "/api/v1/profile",
        json={
            "timezone": "Asia/Shanghai",
            "available_windows": [{"weekday": 0, "start": "09:00", "end": "10:00"}],
            "rest_windows": [],
        },
    )
    plan = client.post(
        "/api/v1/plans",
        json={
            "start_at": "2030-01-07T00:00:00+08:00",
            "end_at": "2030-01-08T00:00:00+08:00",
            "idempotency_key": str(uuid4()),
        },
    )
    assert plan.status_code == 201, plan.text
    block = plan.json()["blocks"][0]
    assert block["basis"]["summary"]
    assert block["basis"]["estimate_minutes"] == 30
    assert block["basis"]["window"]["start"] == "09:00"


def test_export_validation_and_account_deletion(authenticated: TestClient) -> None:
    client = authenticated
    record = task(client, "导出任务", tags=["作业"], estimate_minutes=30)
    client.post(
        f"/api/v1/tasks/{record['id']}/worklogs",
        json={"actual_minutes": 20, "reflection": "顺利"},
    )
    exported = client.get("/api/v1/data/export")
    assert exported.status_code == 200
    assert "attachment" in exported.headers["content-disposition"]
    payload = exported.json()
    assert payload["version"] == "student-agent/v1"
    assert payload["tasks"][0]["tags"] == ["作业"]
    assert payload["work_logs"][0]["parallel_contexts"] == []

    preview = client.post("/api/v1/data/import/validate", json=payload)
    assert preview.status_code == 200, preview.text
    assert preview.json()["counts"]["tasks"] == 1
    assert any("tasks" in conflict for conflict in preview.json()["conflicts"])

    requested = client.post(
        "/api/v1/account/deletion",
        json={"password": "test-password-123", "confirmed": True},
    )
    assert requested.status_code == 200, requested.text
    assert client.get("/api/v1/tasks").status_code == 401

    login = client.post(
        "/api/v1/auth/login",
        json={"username": "student", "password": "test-password-123"},
    )
    assert login.status_code == 200, login.text
    client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    me = client.get("/api/v1/auth/me").json()["user"]
    assert me["deletion_due_at"]
    assert client.post("/api/v1/tasks", json={"title": "冷静期阻止"}).status_code == 423
    assert client.post("/api/v1/account/deletion/cancel").status_code == 200
    assert client.post("/api/v1/tasks", json={"title": "取消后新建"}).status_code == 201


def test_expired_account_is_purged_on_login(authenticated: TestClient) -> None:
    client = authenticated
    task(client, "待删除任务", tags=["隐私"])
    client.post(
        "/api/v1/account/deletion",
        json={"password": "test-password-123", "confirmed": True},
    )
    with Session(client.app.state.engine) as db:
        user = db.scalar(select(User).where(User.username == "student"))
        assert user is not None
        user.deletion_due_at = int((datetime.now(UTC) - timedelta(minutes=1)).timestamp() * 1000)
        db.commit()
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "student", "password": "test-password-123"},
    )
    assert response.status_code == 401
    assert client.get("/api/v1/auth/status").json() == {"initialized": False}


def test_text_and_markdown_file_import(authenticated: TestClient) -> None:
    client = authenticated
    reference = datetime.now(UTC).isoformat()
    key = str(uuid4())
    response = client.post(
        "/api/v1/imports/file",
        files={
            "file": (
                "作业.md",
                "# 实验报告\n\n下周五前提交实验报告。".encode(),
                "text/markdown",
            )
        },
        data={
            "context": "",
            "reference_at": reference,
            "idempotency_key": key,
            "confirmed": "false",
            "parse": "false",
        },
    )
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["status"] == "succeeded"
    assert job["source"]["kind"] == "file"
    assert "实验报告" in job["source"]["text"]
    source = client.get(f"/api/v1/imports/{job['id']}/source")
    assert source.status_code == 200
    assert source.content.startswith(b"#")

    bad = client.post(
        "/api/v1/imports/file",
        files={"file": ("扫描.pdf", b"not-a-pdf", "application/pdf")},
        data={
            "context": "",
            "reference_at": reference,
            "idempotency_key": str(uuid4()),
            "confirmed": "false",
            "parse": "false",
        },
    )
    assert bad.status_code == 422
    assert "PDF" in bad.text
