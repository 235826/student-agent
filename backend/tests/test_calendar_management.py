from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Audit, EventOverride, Workspace


def test_series_edit_delete_preserves_overrides_and_requires_confirmation(
    authenticated: TestClient,
) -> None:
    c = authenticated
    course = c.post("/api/v1/courses", json={"name": "课程"}).json()
    series = c.post(
        "/api/v1/event-series",
        json={
            "course_id": course["id"],
            "start_date": "2030-01-07",
            "end_date": "2030-01-14",
            "weekdays": [0],
            "start_time": "09:00",
            "end_time": "10:00",
            "timezone": "Asia/Shanghai",
            "location": "原地点",
            "idempotency_key": "series-test-create",
        },
    ).json()
    first = series["event_ids"][0]
    event = next(e for e in c.get("/api/v1/events").json() if e["id"] == first)
    body = {
        k: event[k]
        for k in (
            "title",
            "start_at",
            "end_at",
            "timezone",
            "location",
            "locked",
            "course_id",
            "kind",
        )
    }
    body["location"] = "单次地点"
    assert c.put(f"/api/v1/events/{first}", json=body).status_code == 200
    assert (
        c.request("DELETE", f"/api/v1/courses/{course['id']}", json={"confirmed": True}).status_code
        == 409
    )
    assert (
        c.put(
            f"/api/v1/event-series/{series['id']}",
            json={
                "confirmed": True,
                "start_time": "11:00",
                "end_time": "12:00",
                "location": "新地点",
            },
        ).status_code
        == 200
    )
    events = c.get("/api/v1/events").json()
    assert next(e for e in events if e["id"] == first)["location"] == "单次地点"
    assert next(e for e in events if e["id"] != first)["location"] == "新地点"
    assert (
        c.post(
            f"/api/v1/event-series/{series['id']}/attendance",
            json={"confirmed": True, "is_skipped": True},
        ).status_code
        == 200
    )
    assert all(e["is_skipped"] for e in c.get("/api/v1/events").json())
    assert (
        c.request(
            "DELETE", f"/api/v1/event-series/{series['id']}", json={"confirmed": False}
        ).status_code
        == 422
    )
    with Session(c.app.state.engine) as db:
        before = db.scalar(select(Workspace.scheduling_revision))
    assert (
        c.request(
            "DELETE", f"/api/v1/event-series/{series['id']}", json={"confirmed": True}
        ).status_code
        == 204
    )
    assert c.get("/api/v1/events").json() == []
    assert len(c.get("/api/v1/courses").json()) == 1
    with Session(c.app.state.engine) as db:
        assert db.scalar(select(EventOverride.id)) is None
        assert db.scalar(select(Workspace.scheduling_revision)) == before + 1
        assert db.scalar(select(Audit.id).where(Audit.action == "series.delete"))
    assert (
        c.request("DELETE", f"/api/v1/courses/{course['id']}", json={"confirmed": True}).status_code
        == 204
    )


def test_bulk_time_dst_failure_is_atomic(authenticated: TestClient) -> None:
    c = authenticated
    course = c.post("/api/v1/courses", json={"name": "DST"}).json()
    series = c.post(
        "/api/v1/event-series",
        json={
            "course_id": course["id"],
            "start_date": "2030-03-03",
            "end_date": "2030-03-10",
            "weekdays": [6],
            "start_time": "09:00",
            "end_time": "10:00",
            "timezone": "America/New_York",
            "idempotency_key": "series-dst-create",
        },
    ).json()
    before = c.get("/api/v1/events").json()
    response = c.put(
        f"/api/v1/event-series/{series['id']}",
        json={"confirmed": True, "start_time": "02:15", "end_time": "03:15"},
    )
    assert response.status_code == 422
    assert c.get("/api/v1/events").json() == before


def test_deleting_imported_series_keeps_source_links(authenticated: TestClient) -> None:
    c = authenticated
    job = c.post(
        "/api/v1/imports/text",
        json={"text": "课程材料保留", "parse": False, "idempotency_key": "retain-source-test"},
    ).json()
    job = c.put(
        f"/api/v1/imports/{job['id']}/draft",
        json={
            "revision": job["revision"],
            "candidates": [
                {
                    "key": "course",
                    "kind": "course",
                    "title": "课程",
                    "reviewed": True,
                    "recurrence": {
                        "start_date": "2030-01-07",
                        "end_date": "2030-01-14",
                        "weekdays": [0],
                        "start_time": "09:00",
                        "end_time": "10:00",
                    },
                }
            ],
        },
    ).json()
    response = c.post(
        f"/api/v1/imports/{job['id']}/publish",
        json={
            "revision": job["revision"],
            "confirmed": True,
            "idempotency_key": "retain-source-publish",
        },
    )
    assert response.status_code == 200
    series_id = response.json()["published_records"][0]["id"]
    event_id = c.get("/api/v1/events").json()[0]["id"]
    assert (
        c.request(
            "DELETE", f"/api/v1/event-series/{series_id}", json={"confirmed": True}
        ).status_code
        == 204
    )
    for object_id in [series_id, event_id]:
        origin = c.get("/api/v1/imports/origins", params={"object_id": object_id}).json()
        assert origin[0]["source"]["text"] == "课程材料保留"
        assert origin[0]["published_records"][0]["id"] == series_id
    assert c.get(f"/api/v1/imports/{job['id']}").json()["published_revision"] is not None


def test_series_notes_details_and_course_rename(authenticated: TestClient) -> None:
    c = authenticated
    course = c.post("/api/v1/courses", json={"name": "原名"}).json()
    series = c.post(
        "/api/v1/event-series",
        json={
            "course_id": course["id"],
            "start_date": "2030-01-07",
            "end_date": "2030-01-14",
            "weekdays": [0],
            "start_time": "09:00",
            "end_time": "10:00",
            "timezone": "Asia/Shanghai",
            "location": "教室 A",
            "note": "系列备注",
            "details": "系列详情",
            "idempotency_key": "notes-series-create",
        },
    ).json()
    assert series["location"] == "教室 A"
    assert series["note"] == "系列备注"
    assert series["details"] == "系列详情"
    first_id, second_id = series["event_ids"]
    events = {event["id"]: event for event in c.get("/api/v1/events").json()}
    assert events[first_id]["note"] == "系列备注"
    assert events[first_id]["details"] == "系列详情"

    first = events[first_id]
    body = {
        key: first[key]
        for key in (
            "title",
            "start_at",
            "end_at",
            "timezone",
            "location",
            "locked",
            "course_id",
            "kind",
        )
    }
    body.update(
        note="单次备注",
        details="单次详情",
        note_scope="single",
        details_scope="single",
    )
    updated = c.put(f"/api/v1/events/{first_id}", json=body)
    assert updated.status_code == 200, updated.text
    assert updated.json()["note"] == "系列备注；单次备注"
    assert updated.json()["details"] == "系列详情\n\n单次详情"
    assert updated.json()["single_note"] == "单次备注"
    assert updated.json()["series_note"] == "系列备注"
    second = next(e for e in c.get("/api/v1/events").json() if e["id"] == second_id)
    assert second["note"] == "系列备注"
    assert second["details"] == "系列详情"

    first = next(e for e in c.get("/api/v1/events").json() if e["id"] == first_id)
    body = {
        key: first[key]
        for key in (
            "title",
            "start_at",
            "end_at",
            "timezone",
            "location",
            "locked",
            "course_id",
            "kind",
        )
    }
    body.update(
        note="新系列备注",
        details="新系列详情",
        note_scope="series",
        details_scope="series",
    )
    updated = c.put(f"/api/v1/events/{first_id}", json=body)
    assert updated.status_code == 200, updated.text
    assert updated.json()["note"] == "新系列备注；单次备注"
    assert updated.json()["details"] == "新系列详情\n\n单次详情"
    assert updated.json()["single_note"] == "单次备注"

    renamed = c.put(f"/api/v1/courses/{course['id']}", json={"name": "新课程"})
    assert renamed.status_code == 200
    events = {event["id"]: event for event in c.get("/api/v1/events").json()}
    assert events[first_id]["title"] == "新课程"
    assert events[second_id]["title"] == "新课程"
    assert events[first_id]["note"] == "新系列备注；单次备注"
    assert events[first_id]["details"] == "新系列详情\n\n单次详情"


def test_standalone_event_notes_details(authenticated: TestClient) -> None:
    c = authenticated
    event = c.post(
        "/api/v1/events",
        json={
            "title": "独立事件",
            "start_at": "2030-02-01T09:00:00+08:00",
            "end_at": "2030-02-01T10:00:00+08:00",
            "note": "短备注",
            "details": "完整详情",
        },
    )
    assert event.status_code == 201, event.text
    assert event.json()["note"] == "短备注"
    assert event.json()["details"] == "完整详情"
    assert event.json()["series_note"] is None


def test_note_only_update_does_not_freeze_series_schedule(authenticated: TestClient) -> None:
    c = authenticated
    course = c.post("/api/v1/courses", json={"name": "课"}).json()
    series = c.post(
        "/api/v1/event-series",
        json={
            "course_id": course["id"],
            "start_date": "2030-04-01",
            "end_date": "2030-04-08",
            "weekdays": [0],
            "start_time": "09:00",
            "end_time": "10:00",
            "timezone": "Asia/Shanghai",
            "location": "原教室",
            "idempotency_key": "note-only-series",
        },
    ).json()
    first_id = series["event_ids"][0]
    first = next(e for e in c.get("/api/v1/events").json() if e["id"] == first_id)
    body = {
        key: first[key]
        for key in (
            "title",
            "start_at",
            "end_at",
            "timezone",
            "location",
            "locked",
            "course_id",
            "kind",
        )
    }
    body.update(note="单次备注", note_scope="single", details_scope="single")
    assert c.put(f"/api/v1/events/{first_id}", json=body).status_code == 200
    response = c.put(
        f"/api/v1/event-series/{series['id']}",
        json={
            "confirmed": True,
            "start_time": "11:00",
            "end_time": "12:00",
            "location": "新教室",
        },
    )
    assert response.status_code == 200, response.text
    events = c.get("/api/v1/events").json()
    local_hours = {
        datetime.fromisoformat(event["start_at"]).astimezone(ZoneInfo("Asia/Shanghai")).hour
        for event in events
    }
    assert local_hours == {11}
    assert all(event["location"] == "新教室" for event in events)
    updated = next(event for event in events if event["id"] == first_id)
    assert updated["note"] == "单次备注"
