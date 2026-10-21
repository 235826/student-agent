from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_planning_foundation import check, event_ref, post, rule, selector, task, task_ref


def profile(c, start="09:00", end="13:00", rest=None, zone="Asia/Shanghai"):
    response = c.put(
        "/api/v1/profile",
        json={
            "timezone": zone,
            "available_windows": [{"weekday": 0, "start": start, "end": end}],
            "rest_windows": rest or [],
        },
    )
    assert response.status_code == 200, response.text


def plan(c, **kwargs):
    return post(
        c,
        "/plans",
        {
            "start_at": "2030-01-07T00:00:00+08:00",
            "end_at": "2030-01-08T00:00:00+08:00",
            "idempotency_key": str(uuid4()),
            **kwargs,
        },
    )


def adopt(c, p):
    return c.post(f"/api/v1/plans/{p['id']}/adopt", json={"confirmed": True})


def test_capacity_missing_estimate_and_determinism(authenticated):
    c = authenticated
    profile(c)
    task(c, "十小时任务", estimate_minutes=600)
    task(c, "未估时")
    a, b = plan(c), plan(c)
    assert a["blocks"] == b["blocks"]
    report = next(r for r in a["reports"] if r["title"] == "十小时任务")
    assert report["scheduled_minutes"] == 240
    assert report["unscheduled_minutes"] == 360
    assert next(r for r in a["reports"] if r["title"] == "未估时")["unscheduled_minutes"] is None
    assert c.get("/api/v1/plans/current").json() is None
    assert adopt(c, a).status_code == 200
    assert adopt(c, a).status_code == 200
    assert adopt(c, b).status_code == 409
    assert len(c.get("/api/v1/plans").json()) == 2


def test_dependencies_deadlines_rest_and_priority(authenticated):
    c = authenticated
    profile(c, rest=[{"weekday": 0, "start": "10:00", "end": "11:00"}])
    first = task(c, "前置", estimate_minutes=60, priority=4)
    task(
        c,
        "后续",
        estimate_minutes=60,
        predecessor_ids=[first["id"]],
        deadline_at="2030-01-07T12:00:00+08:00",
    )
    task(c, "已过截止", estimate_minutes=30, deadline_at="2030-01-06T12:00:00+08:00")
    p = plan(c)
    blocks = {b["title"]: b for b in p["blocks"]}
    assert blocks["前置"]["end_at"] == "2030-01-07T02:00:00Z"
    assert blocks["后续"]["start_at"] == "2030-01-07T03:00:00Z"
    assert "已过截止" not in blocks
    assert all(
        b["end_at"] <= "2030-01-07T02:00:00Z" or b["start_at"] >= "2030-01-07T03:00:00Z"
        for b in p["blocks"]
    )


def test_partial_predecessor_blocks_successor(authenticated):
    c = authenticated
    profile(c, end="10:00")
    a = task(c, "前置", estimate_minutes=120)
    task(c, "后续", estimate_minutes=30, predecessor_ids=[a["id"]])
    p = plan(c)
    r = next(r for r in p["reports"] if r["title"] == "后续")
    assert r["scheduled_minutes"] == 0 and "前置" in r["reason"]


def test_overlap_requires_all_pairs_and_skip(authenticated):
    c = authenticated
    profile(c, end="10:00")
    course = post(c, "/courses", {"name": "数据库"})
    c.patch(
        f"/api/v1/courses/{course['id']}/parallel-policy",
        json={"parallel_policy": "allow_selected"},
    )
    e = post(
        c,
        "/events",
        {
            "title": "课",
            "kind": "course",
            "course_id": course["id"],
            "start_at": "2030-01-07T09:00:00+08:00",
            "end_at": "2030-01-07T10:00:00+08:00",
            "timezone": "Asia/Shanghai",
        },
    )
    a = task(c, "阅读", estimate_minutes=60, parallel_policy="allow_selected")
    b = task(c, "笔记", estimate_minutes=60, parallel_policy="allow_selected")
    for t in [a, b]:
        rule(c, selector("event", e["id"]), selector("task", t["id"]))
    p = plan(c)
    assert sum(r["scheduled_minutes"] for r in p["reports"]) == 60
    rule(c, selector("task", a["id"]), selector("task", b["id"]))
    p = plan(c)
    assert sum(r["scheduled_minutes"] for r in p["reports"]) == 120
    assert check(c, event_ref(e["id"]), task_ref(a["id"]), task_ref(b["id"]))["allowed"]
    c.patch(f"/api/v1/events/{e['id']}/parallel-policy", json={"parallel_policy": "none"})
    assert not plan(c)["blocks"]
    c.patch(f"/api/v1/events/{e['id']}/skip", json={"is_skipped": True, "confirmed": True})
    assert len(plan(c)["blocks"]) == 2


def test_staleness_versions_idempotency_and_restart(authenticated, settings):
    c = authenticated
    profile(c)
    task(c, estimate_minutes=30)
    key = str(uuid4())
    p = plan(c, idempotency_key=key)
    assert plan(c, idempotency_key=key)["id"] == p["id"]
    task(c, "新增任务", estimate_minutes=30)
    assert adopt(c, p).status_code == 409
    assert c.get("/api/v1/plans").json()[0]["stale"]
    fresh = plan(c)
    assert adopt(c, fresh).status_code == 200
    newer = plan(c)
    assert newer["differences"]["unchanged"] == 2
    assert c.get("/api/v1/plans/current").json()["id"] == fresh["id"]
    assert adopt(c, newer).status_code == 200
    assert adopt(c, fresh).status_code == 409
    restarted = create_app(settings)
    with TestClient(restarted, cookies=dict(c.cookies), headers=dict(c.headers)) as other:
        assert other.get("/api/v1/plans/current").json()["id"] == newer["id"]
    restarted.state.engine.dispose()


def test_concurrent_adoption_and_past_draft(authenticated, monkeypatch):
    c = authenticated
    profile(c)
    task(c, estimate_minutes=30)
    a, b = plan(c), plan(c)

    def confirm(p):
        with TestClient(c.app, cookies=dict(c.cookies), headers=dict(c.headers)) as other:
            return adopt(other, p).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(confirm, [a, b])) == [200, 409]
    newer = plan(c)
    monkeypatch.setattr("app.modules.scheduling.now_ms", lambda: 2_000_000_000_000)
    assert adopt(c, newer).status_code == 409


def test_timezones_dst_and_subminute_rest(authenticated):
    c = authenticated
    profile(
        c, zone="America/New_York", rest=[{"weekday": 0, "start": "09:00:30", "end": "09:01:30"}]
    )
    task(c, estimate_minutes=30)
    p = plan(c, start_at="2030-03-04T00:00:00-05:00", end_at="2030-03-12T00:00:00-04:00")
    assert p["blocks"][0]["start_at"] == "2030-03-04T14:02:00Z"
    p2 = plan(c, start_at="2030-03-11T00:00:00-04:00", end_at="2030-03-12T00:00:00-04:00")
    assert p2["blocks"][0]["start_at"] == "2030-03-11T13:02:00Z"


def test_empty_windows_invalid_range_and_confirm_required(authenticated):
    c = authenticated
    task(c, estimate_minutes=30)
    assert not plan(c)["blocks"]
    p = plan(c)
    assert c.post(f"/api/v1/plans/{p['id']}/adopt", json={}).status_code == 422
    assert (
        c.post(
            "/api/v1/plans",
            json={
                "start_at": "2020-01-01T00:00:00Z",
                "end_at": "2020-01-02T00:00:00Z",
                "idempotency_key": str(uuid4()),
            },
        ).status_code
        == 422
    )


def test_replan_diff_preserves_current_and_fixed_event(authenticated):
    c = authenticated
    profile(c)
    task(c, "作业", estimate_minutes=60)
    old = plan(c)
    assert adopt(c, old).status_code == 200
    event = post(
        c,
        "/events",
        {
            "title": "会议",
            "start_at": "2030-01-07T09:00:00+08:00",
            "end_at": "2030-01-07T10:00:00+08:00",
            "timezone": "Asia/Shanghai",
        },
    )
    new = plan(c)
    assert new["differences"]["added"] == 1
    assert new["differences"]["removed"] == 1
    assert new["differences"]["removed_blocks"] == old["blocks"]
    assert new["differences"]["added_blocks"] == new["blocks"]
    assert c.get("/api/v1/plans/current").json()["blocks"] == old["blocks"]
    assert new["blocks"][0]["start_at"] == event["end_at"]
    assert c.get("/api/v1/events").json()[0] == event
