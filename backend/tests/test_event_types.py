from fastapi.testclient import TestClient


def test_event_type_crud_and_course_separation(authenticated: TestClient) -> None:
    c = authenticated
    types = c.get("/api/v1/event-types").json()
    assert {t["system_key"] for t in types} == {"exam", "meeting", "other"}
    exam = next(t for t in types if t["system_key"] == "exam")

    created = c.post(
        "/api/v1/event-types",
        json={"name": "社团活动", "color": "#722ed1"},
    )
    assert created.status_code == 201, created.text
    custom = created.json()
    assert custom["system_key"] is None

    assert c.post("/api/v1/event-types", json={"name": "社团活动"}).status_code == 409
    assert c.post("/api/v1/event-types", json={"name": "课程"}).status_code == 409
    assert c.put(f"/api/v1/event-types/{exam['id']}", json={"name": "考试"}).status_code == 409

    event = c.post(
        "/api/v1/events",
        json={
            "title": "社团迎新",
            "start_at": "2030-01-07T18:00:00+08:00",
            "end_at": "2030-01-07T19:00:00+08:00",
            "kind": "other",
            "event_type_id": custom["id"],
        },
    )
    assert event.status_code == 201, event.text
    assert event.json()["event_type"]["name"] == "社团活动"
    assert event.json()["event_type"]["color"] == "#722ed1"

    course = c.post("/api/v1/courses", json={"name": "课程"}).json()
    invalid = c.post(
        "/api/v1/events",
        json={
            "title": "单次课程",
            "start_at": "2030-01-08T09:00:00+08:00",
            "end_at": "2030-01-08T10:00:00+08:00",
            "kind": "course",
            "course_id": course["id"],
            "event_type_id": custom["id"],
        },
    )
    assert invalid.status_code == 422

    archived = c.delete(f"/api/v1/event-types/{custom['id']}")
    assert archived.status_code == 204
    assert all(t["id"] != custom["id"] for t in c.get("/api/v1/event-types").json())
    assert any(
        t["id"] == custom["id"] for t in c.get("/api/v1/event-types?include_archived=true").json()
    )
    stale = c.post(
        "/api/v1/events",
        json={
            "title": "过期类型",
            "start_at": "2030-01-09T09:00:00+08:00",
            "end_at": "2030-01-09T10:00:00+08:00",
            "kind": "other",
            "event_type_id": custom["id"],
        },
    )
    assert stale.status_code == 409


def test_import_publish_preserves_custom_event_type(authenticated: TestClient) -> None:
    c = authenticated
    custom = c.post(
        "/api/v1/event-types",
        json={"name": "学术讲座", "color": "#1677ff"},
    ).json()
    job = c.post(
        "/api/v1/imports/text",
        json={
            "text": "讲座通知",
            "parse": False,
            "idempotency_key": "event-type-import",
        },
    ).json()
    draft = c.put(
        f"/api/v1/imports/{job['id']}/draft",
        json={
            "revision": job["revision"],
            "candidates": [
                {
                    "key": "lecture",
                    "kind": "event",
                    "title": "AI 与学习",
                    "start_local": "2030-01-10T19:00:00",
                    "end_local": "2030-01-10T20:00:00",
                    "event_type_id": custom["id"],
                    "reviewed": True,
                }
            ],
        },
    )
    assert draft.status_code == 200, draft.text
    published = c.post(
        f"/api/v1/imports/{job['id']}/publish",
        json={
            "revision": draft.json()["revision"],
            "confirmed": True,
            "idempotency_key": "event-type-import-publish",
        },
    )
    assert published.status_code == 200, published.text
    event = next(e for e in c.get("/api/v1/events").json() if e["title"] == "AI 与学习")
    assert event["event_type"]["name"] == "学术讲座"
