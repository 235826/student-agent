import io
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.import_schemas import ModelDraft
from app.config import Settings
from app.db.models import Course, ImportJob, ImportSource, now_ms
from app.providers.chat_completions import ChatCompletions, ParseFailure, ParseInput
from app.workers.imports import run_once


class Fake:
    def parse(self, source: ParseInput) -> ModelDraft:
        return ModelDraft.model_validate(
            {
                "candidates": [
                    {
                        "key": "task1",
                        "kind": "task",
                        "title": "交报告",
                        "reviewed": True,
                        "deadline_local": "2030-01-10T18:00:00",
                    },
                    {
                        "key": "event1",
                        "kind": "event",
                        "title": "答辩",
                        "start_local": "2030-01-11T09:00:00",
                        "end_local": "2030-01-11T10:00:00",
                    },
                ]
            }
        )


def create(
    client: TestClient, text: str = "2030 年 1 月 10 日 18:00 交报告，次日 9:00 答辩"
) -> dict:
    response = client.post(
        "/api/v1/imports/text",
        json={
            "text": text,
            "confirmed": True,
            "idempotency_key": str(uuid4()),
            "reference_at": "2030-01-01T00:00:00Z",
        },
    )
    assert response.status_code == 202, response.text
    return response.json()


def parsed(client: TestClient) -> dict:
    job = create(client)
    run_once(client.app.state.engine, client.app.state.settings, Fake())
    return client.get(f"/api/v1/imports/{job['id']}").json()


def save(client: TestClient, job: dict, candidates: list | None = None) -> dict:
    candidates = candidates if candidates is not None else job["candidates"]
    for candidate in candidates:
        candidate["reviewed"] = True
    response = client.put(
        f"/api/v1/imports/{job['id']}/draft",
        json={"revision": job["revision"], "candidates": candidates},
    )
    assert response.status_code == 200, response.text
    return response.json()


def publish(client: TestClient, job: dict, key: str | None = None) -> httpx.Response:
    return client.post(
        f"/api/v1/imports/{job['id']}/publish",
        json={
            "revision": job["revision"],
            "confirmed": True,
            "idempotency_key": key or str(uuid4()),
        },
    )


def test_import_preview_atomic_publish_and_dedup(authenticated: TestClient) -> None:
    client = authenticated
    job = parsed(client)
    assert job["status"] == "succeeded"
    assert not job["candidates"][0]["reviewed"]
    assert client.get("/api/v1/tasks").json() == []
    assert publish(client, job).status_code == 422
    job = save(client, job)
    response = publish(client, job)
    assert response.status_code == 200, response.text
    assert len(response.json()["published_records"]) == 2
    assert publish(client, job).status_code == 200
    assert len(client.get("/api/v1/tasks").json()) == 1
    assert len(client.get("/api/v1/events").json()) == 1
    task = client.get("/api/v1/tasks").json()[0]
    assert task["deadline_at"] == "2030-01-10T10:00:00Z"
    assert (
        client.get("/api/v1/imports/origins", params={"object_id": task["id"]}).json()[0]["id"]
        == job["id"]
    )
    assert create(client)["id"] == job["id"]


def test_import_rolls_back_partial_tasks_and_courses(authenticated: TestClient) -> None:
    client = authenticated
    job = parsed(client)
    course = {
        "key": "course",
        "kind": "course",
        "title": "高数",
        "recurrence": {
            "start_date": "2030-01-01",
            "end_date": "2030-01-31",
            "weekdays": [1],
            "start_time": "08:00",
            "end_time": "09:00",
        },
    }
    job = save(
        client,
        job,
        [job["candidates"][0], course, {"key": "bad", "kind": "event", "title": "缺少时间"}],
    )
    assert publish(client, job).status_code == 422
    assert client.get("/api/v1/tasks").json() == []
    assert client.get("/api/v1/events").json() == []
    with Session(client.app.state.engine) as db:
        assert db.scalar(select(Course)) is None
    job = save(client, job, job["candidates"][:2])
    assert publish(client, job).status_code == 200
    assert len(client.get("/api/v1/events").json()) == 5


def test_revision_and_dependency_cycle(authenticated: TestClient) -> None:
    client = authenticated
    job = parsed(client)
    old = dict(job)
    job = save(
        client,
        job,
        [
            {"key": "a", "kind": "task", "title": "A", "predecessor_keys": ["b"]},
            {"key": "b", "kind": "task", "title": "B", "parent_key": "a"},
        ],
    )
    assert publish(client, old).status_code == 409
    assert publish(client, job).status_code == 422
    assert client.get("/api/v1/tasks").json() == []
    job = save(
        client,
        job,
        [
            {"key": "a", "kind": "task", "title": "A", "predecessor_keys": ["b"]},
            {"key": "b", "kind": "task", "title": "B"},
        ],
    )
    assert publish(client, job).status_code == 200
    tasks = client.get("/api/v1/tasks").json()
    assert next(t for t in tasks if t["title"] == "A")["predecessor_ids"]


def test_deleted_source_cannot_be_resurrected_by_worker(authenticated: TestClient) -> None:
    client = authenticated
    job = create(client)

    class DeletingProvider:
        def parse(self, source: ParseInput) -> ModelDraft:
            # A write succeeds while the provider is running: no long-held DB lock.
            response = client.request(
                "DELETE",
                f"/api/v1/imports/{job['id']}/source",
                json={"revision": job["revision"], "confirmed": True},
            )
            assert response.status_code == 200
            return Fake().parse(source)

    run_once(client.app.state.engine, client.app.state.settings, DeletingProvider())
    result = client.get(f"/api/v1/imports/{job['id']}").json()
    assert result["status"] == "cancelled"
    assert result["source"]["text"] == ""
    assert result["candidates"] == []


def test_lease_recovery_and_bounded_retry(authenticated: TestClient) -> None:
    client = authenticated
    job = create(client)
    with Session(client.app.state.engine) as db:
        row = db.get(ImportJob, job["id"])
        row.status, row.lease_until, row.lease_token = "running", now_ms() - 1, "stale"
        db.commit()

    class Failing:
        def parse(self, source: ParseInput) -> ModelDraft:
            raise ParseFailure("连接超时", transient=True)

    for i in range(3):
        run_once(client.app.state.engine, client.app.state.settings, Failing())
        with Session(client.app.state.engine) as db:
            row = db.get(ImportJob, job["id"])
            assert row.attempts == i + 1
            row.next_run_at = 0
            db.commit()
    assert client.get(f"/api/v1/imports/{job['id']}").json()["status"] == "failed"
    assert not run_once(client.app.state.engine, client.app.state.settings, Failing())


def test_provider_backoff_uses_rate_limit_and_retry_after(authenticated: TestClient) -> None:
    client = authenticated
    job = create(client)

    class Limited:
        def parse(self, source: ParseInput) -> ModelDraft:
            raise ParseFailure(
                "当前模型访问量过大，请稍后重试",
                transient=True,
                rate_limited=True,
                retry_after_seconds=120,
            )

    run_once(client.app.state.engine, client.app.state.settings, Limited())
    with Session(client.app.state.engine) as db:
        row = db.get(ImportJob, job["id"])
        assert row.status == "queued"
        assert row.attempts == 1
        assert 119_000 <= row.next_run_at - now_ms() <= 121_000
    assert not run_once(client.app.state.engine, client.app.state.settings, Limited())


def test_image_validation_dedup_private_access_and_delete(
    authenticated: TestClient, tmp_path
) -> None:
    client = authenticated
    client.app.state.settings.source_dir = tmp_path / "sources"
    stream = io.BytesIO()
    Image.new("RGB", (10, 10)).save(stream, format="PNG")
    payload = {
        "confirmed": "true",
        "reference_at": "2030-01-01T00:00:00Z",
        "idempotency_key": str(uuid4()),
    }

    def upload(data: bytes):
        return client.post(
            "/api/v1/imports/image",
            data=payload,
            files={"file": ("../../bad.png", data, "image/png")},
        )

    assert upload(b"not an image").status_code == 422
    assert upload(b"a" * (8 * 1024 * 1024 + 1)).status_code == 413
    result = upload(stream.getvalue())
    assert result.status_code == 202, result.text
    job = result.json()
    assert upload(stream.getvalue()).json()["id"] == job["id"]
    assert len(list((tmp_path / "sources").iterdir())) == 1
    url = f"/api/v1/imports/{job['id']}/source"
    assert client.get(url).content == stream.getvalue()
    with TestClient(client.app) as anonymous:
        assert anonymous.get(url).status_code == 401
    assert (
        client.request(
            "DELETE", url, json={"revision": job["revision"], "confirmed": True}
        ).status_code
        == 200
    )
    assert client.get(url).status_code == 404
    assert list((tmp_path / "sources").iterdir()) == []


def test_cancel_manual_fallback_and_delete_after_publish(authenticated: TestClient) -> None:
    client = authenticated
    job = create(client)
    result = client.post(
        f"/api/v1/imports/{job['id']}/cancel", json={"revision": 1, "confirmed": True}
    )
    job = save(client, result.json(), [{"kind": "task", "key": "manual", "title": "人工整理"}])
    assert publish(client, job).status_code == 200
    result = client.request(
        "DELETE",
        f"/api/v1/imports/{job['id']}/source",
        json={"revision": job["revision"], "confirmed": True},
    )
    assert result.status_code == 200
    assert len(client.get("/api/v1/tasks").json()) == 1
    with Session(client.app.state.engine) as db:
        assert db.scalar(select(ImportSource)).text == ""


@pytest.mark.parametrize("image", [False, True])
def test_chat_protocol_and_evidence(image: bool) -> None:
    settings = Settings(
        llm_base_url="https://example.test/v1",
        llm_model="configured-model",
        llm_api_key="secret",
        llm_supports_images=True,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        assert body["model"] == "configured-model"
        assert body["response_format"] == {"type": "json_object"}
        assert (len(body["messages"][1]["content"]) == 2) == image
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "candidates": [
                                        {
                                            "key": "a",
                                            "kind": "task",
                                            "title": "test",
                                            "reviewed": True,
                                            "deadline_local": "2030-01-01T09:00:00",
                                        }
                                    ]
                                }
                            )
                        }
                    }
                ]
            },
        )

    result = ChatCompletions(settings, httpx.MockTransport(handler)).parse(
        ParseInput("test", b"image" if image else None, "image/png", "", "Asia/Shanghai", 0)
    )
    assert not result.candidates[0].reviewed
    assert result.candidates[0].deadline_local is None


@pytest.mark.parametrize("status,transient", [(401, False), (429, True), (503, True)])
def test_provider_errors_never_expose_response(status: int, transient: bool) -> None:
    settings = Settings(llm_base_url="https://example.test/v1", llm_model="model")
    provider = ChatCompletions(
        settings,
        httpx.MockTransport(lambda _: httpx.Response(status, text="private secret response")),
    )
    with pytest.raises(ParseFailure) as caught:
        provider.parse(ParseInput("", None, "", "", "Asia/Shanghai", 0))
    assert caught.value.transient == transient
    assert "secret" not in str(caught.value)


@pytest.mark.parametrize(
    "code,transient,message",
    [
        ("1305", True, "当前模型访问量过大"),
        ("1302", True, "速率限制"),
        ("1113", False, "欠费"),
        ("1308", False, "额度"),
        ("1311", False, "没有此模型的访问权限"),
    ],
)
def test_bigmodel_429_business_codes_are_safe(code: str, transient: bool, message: str) -> None:
    settings = Settings(llm_base_url="https://open.bigmodel.cn/api/paas/v4", llm_model="model")
    provider = ChatCompletions(
        settings,
        httpx.MockTransport(
            lambda _: httpx.Response(
                429,
                json={"error": {"code": code, "message": "private secret response"}},
                headers={"Retry-After": "120"},
            )
        ),
    )
    with pytest.raises(ParseFailure) as caught:
        provider.parse(ParseInput("", None, "", "", "Asia/Shanghai", 0))
    assert caught.value.transient == transient
    assert message in str(caught.value)
    assert "secret" not in str(caught.value)
    assert caught.value.retry_after_seconds == 120
