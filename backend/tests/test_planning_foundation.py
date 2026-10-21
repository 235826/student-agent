from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db.models import CompatibilityRule, Event, EventOverride, Task, Workspace
from app.db.session import build_engine
from app.main import create_app


def post(client, path, payload, status=201):
    response = client.post("/api/v1" + path, json=payload)
    assert response.status_code == status, response.text
    return response.json()


def task(client, title="任务", **kwargs):
    return post(client, "/tasks", {"title": title, **kwargs})


def update_task(client, record, **kwargs):
    keys = [
        "title",
        "description",
        "status",
        "priority",
        "deadline_at",
        "estimate_minutes",
        "task_type",
        "parent_id",
        "predecessor_ids",
        "parallel_policy",
    ]
    body = {k: record[k] for k in keys}
    return client.put(f"/api/v1/tasks/{record['id']}", json={**body, **kwargs})


def recurring(client, **kwargs):
    course = post(client, "/courses", {"name": "数据库"})
    body = {
        "course_id": course["id"],
        "start_date": "2026-11-02",
        "end_date": "2026-11-16",
        "weekdays": [0],
        "start_time": "09:00",
        "end_time": "10:00",
        "timezone": "Asia/Shanghai",
        "idempotency_key": str(uuid4()),
        **kwargs,
    }
    return course, body, post(client, "/event-series", body)


def event_ref(event_id):
    return {"kind": "event", "id": event_id}


def task_ref(task_id):
    return {"kind": "task", "id": task_id}


def check(client, *refs):
    return post(client, "/compatibility/check", {"activities": refs}, 200)


def rule(client, left, right, decision="allow", override_conflicts=False):
    return post(
        client,
        "/compatibility-rules",
        {
            "left": left,
            "right": right,
            "decision": decision,
            "override_conflicts": override_conflicts,
        },
    )


def selector(scope, key):
    return {"scope": scope, "key": key}


def test_draft_versions_publish_idempotency_and_restart(authenticated, settings):
    c = authenticated
    draft = post(c, "/drafts", {"payload": {"description": "先收集资料"}})
    assert c.get("/api/v1/tasks").json() == []
    publish = {"revision": draft["revision"], "idempotency_key": "publish-test-1"}
    assert c.post(f"/api/v1/drafts/{draft['id']}/publish", json=publish).status_code == 422
    update = c.put(
        f"/api/v1/drafts/{draft['id']}", json={"revision": 1, "payload": {"title": "实验报告"}}
    )
    assert update.status_code == 200
    assert c.post(f"/api/v1/drafts/{draft['id']}/publish", json=publish).status_code == 409
    publish["revision"] = 2
    path = f"/drafts/{draft['id']}/publish"
    first = post(c, path, publish, 200)
    assert post(c, path, publish, 200)["id"] == first["id"]
    assert (
        post(c, path, {**publish, "idempotency_key": "new-publish-key"}, 200)["id"] == first["id"]
    )
    assert len(c.get("/api/v1/tasks").json()) == 1
    other = post(c, "/drafts", {"payload": {"title": "另一项"}})
    assert (
        c.post(f"/api/v1/drafts/{other['id']}/publish", json={**publish, "revision": 1}).status_code
        == 409
    )
    assert (
        c.put(
            f"/api/v1/drafts/{draft['id']}", json={"revision": 2, "payload": {"title": "修改"}}
        ).status_code
        == 409
    )
    app = create_app(settings)
    with TestClient(app, cookies=c.cookies) as restarted:
        assert (
            restarted.get("/api/v1/drafts?status=published").json()[0]["published_task_id"]
            == first["id"]
        )
    app.state.engine.dispose()


def test_concurrent_draft_publish_creates_one_task(authenticated):
    c = authenticated
    draft = post(c, "/drafts", {"payload": {"title": "并发发布"}})

    def publish(index):
        with TestClient(
            c.app,
            cookies=dict(c.cookies),
            headers={"Origin": "http://localhost:5173", "X-CSRF-Token": c.headers["X-CSRF-Token"]},
        ) as other:
            return post(
                other,
                f"/drafts/{draft['id']}/publish",
                {"revision": 1, "idempotency_key": f"concurrent-publish-{index}"},
                200,
            )["id"]

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(publish, range(4)))
    assert len(set(results)) == 1
    assert len(c.get("/api/v1/tasks").json()) == 1


def test_draft_delete_and_unavailable_dependency(authenticated):
    c = authenticated
    predecessor = task(c)
    draft = post(
        c, "/drafts", {"payload": {"title": "后续", "predecessor_ids": [predecessor["id"]]}}
    )
    c.post(f"/api/v1/tasks/{predecessor['id']}/trash")
    assert (
        c.post(
            f"/api/v1/drafts/{draft['id']}/publish",
            json={"revision": 1, "idempotency_key": "blocked-draft"},
        ).status_code
        == 409
    )
    assert c.delete(f"/api/v1/drafts/{draft['id']}?revision=99").status_code == 409
    assert c.delete(f"/api/v1/drafts/{draft['id']}?revision=1").status_code == 204
    assert c.get("/api/v1/drafts").json() == []
    assert (
        c.post(
            f"/api/v1/drafts/{draft['id']}/publish",
            json={"revision": 2, "idempotency_key": "deleted-draft"},
        ).status_code
        == 409
    )


def test_dependencies_cycles_states_and_impact(authenticated):
    c = authenticated
    a = task(c, "实现算法")
    b = task(c, "实验", predecessor_ids=[a["id"]])
    d = task(c, "报告", predecessor_ids=[b["id"]])
    cycle = update_task(c, a, predecessor_ids=[d["id"]])
    assert cycle.status_code == 409
    assert "实现算法" in cycle.json()["message"] and "报告" in cycle.json()["message"]
    assert update_task(c, b, status="in_progress").status_code == 409
    assert c.post(f"/api/v1/tasks/{a['id']}/trash").status_code == 409
    assert c.post(f"/api/v1/tasks/{a['id']}/trash?confirm_impact=true").status_code == 200
    blocked = next(t for t in c.get("/api/v1/tasks").json() if t["id"] == b["id"])
    assert "已删除" in blocked["blocked_by"][0]
    c.post(f"/api/v1/tasks/{b['id']}/trash?confirm_impact=true")
    assert c.post(f"/api/v1/tasks/{b['id']}/restore").status_code == 409
    assert c.post(f"/api/v1/tasks/{a['id']}/restore").status_code == 200
    assert c.post(f"/api/v1/tasks/{b['id']}/restore").status_code == 200
    assert update_task(c, a, status="cancelled").status_code == 409
    assert update_task(c, a, status="cancelled", confirm_impact=True).status_code == 200
    assert update_task(c, a, status="done").status_code == 200
    assert update_task(c, b, status="in_progress").status_code == 200


def test_parent_cycles_do_not_cascade_delete(authenticated):
    c = authenticated
    parent = task(c, "项目")
    child = task(c, "子任务", parent_id=parent["id"])
    assert update_task(c, parent, parent_id=child["id"]).status_code == 409
    assert c.post(f"/api/v1/tasks/{parent['id']}/trash?confirm_impact=true").status_code == 200
    remaining = c.get("/api/v1/tasks").json()
    assert len(remaining) == 1 and remaining[0]["parent_id"] == parent["id"]


def test_recurring_skip_and_edit_are_single_instance(authenticated):
    c = authenticated
    course, body, series = recurring(c)
    assert len(series["event_ids"]) == 3
    assert post(c, "/event-series", body)["id"] == series["id"]
    assert c.post("/api/v1/event-series", json={**body, "location": "changed"}).status_code == 409
    first, second = series["event_ids"][:2]
    assert c.patch(f"/api/v1/events/{first}/skip", json={"is_skipped": True}).status_code == 422
    assert (
        c.patch(
            f"/api/v1/events/{first}/skip", json={"is_skipped": True, "confirmed": True}
        ).status_code
        == 200
    )
    all_events = c.get("/api/v1/events").json()
    assert [e["is_skipped"] for e in all_events] == [True, False, False]
    original = all_events[0]
    edit = {
        k: original[k]
        for k in [
            "title",
            "start_at",
            "end_at",
            "timezone",
            "location",
            "locked",
            "course_id",
            "kind",
        ]
    }
    edit.update(
        start_at="2026-11-02T11:00:00+08:00", end_at="2026-11-02T12:00:00+08:00", location="B202"
    )
    updated = c.put(f"/api/v1/events/{first}", json=edit)
    assert updated.status_code == 200, updated.text
    assert updated.json()["original_start_at"] == original["start_at"]
    assert updated.json()["start_at"] != original["start_at"]
    assert next(e for e in c.get("/api/v1/events").json() if e["id"] == second)["location"] == ""
    with Session(c.app.state.engine) as db:
        assert db.get(Event, first).start_at != int(
            __import__("datetime").datetime.fromisoformat(edit["start_at"]).timestamp() * 1000
        )
        assert len(list(db.scalars(select(EventOverride)))) == 1
    assert (
        c.patch(
            f"/api/v1/events/{first}/skip", json={"is_skipped": False, "confirmed": True}
        ).json()["is_skipped"]
        is False
    )
    exam = post(
        c,
        "/events",
        {
            "title": "期末考试",
            "start_at": "2026-11-03T09:00:00+08:00",
            "end_at": "2026-11-03T10:00:00+08:00",
            "kind": "exam",
            "course_id": course["id"],
        },
    )
    assert (
        c.patch(
            f"/api/v1/events/{exam['id']}/skip", json={"is_skipped": True, "confirmed": True}
        ).status_code
        == 422
    )


def test_weekly_local_time_across_dst_and_ambiguous_atomic_rejection(authenticated):
    c = authenticated
    _, _, series = recurring(
        c, start_date="2026-10-26", end_date="2026-11-02", timezone="America/New_York"
    )
    times = [
        e["start_at"] for e in c.get("/api/v1/events").json() if e["series_id"] == series["id"]
    ]
    assert times == ["2026-10-26T13:00:00Z", "2026-11-02T14:00:00Z"]
    course = post(c, "/courses", {"name": "DST课程"})
    payload = {
        "course_id": course["id"],
        "start_date": "2026-11-01",
        "end_date": "2026-11-08",
        "weekdays": [6],
        "start_time": "01:30",
        "end_time": "02:30",
        "timezone": "America/New_York",
        "idempotency_key": "ambiguous-series",
    }
    response = c.post("/api/v1/event-series", json=payload)
    assert response.status_code == 422 and "歧义" in response.json()["message"]
    assert len(c.get("/api/v1/events").json()) == 2


def setup_compatible(c):
    course, _, series = recurring(c)
    reading = task(c, "阅读论文", task_type="reading")
    c.patch(
        f"/api/v1/courses/{course['id']}/parallel-policy",
        json={"parallel_policy": "allow_selected"},
    )
    c.put(
        "/api/v1/task-type-policies",
        json={"task_type": "reading", "parallel_policy": "allow_selected"},
    )
    allowed = rule(c, selector("course", course["id"]), selector("task_type", "reading"))
    return course, series, reading, allowed


def test_compatibility_defaults_symmetry_and_instance_deny(authenticated):
    c = authenticated
    course, series, reading, _ = setup_compatible(c)
    event = event_ref(series["event_ids"][0])
    read = task_ref(reading["id"])
    assert check(c, event, read)["allowed"] is True
    assert check(c, read, event)["allowed"] is True
    coding = task(c, "编码", task_type="coding", parallel_policy="allow_selected")
    assert check(c, event, task_ref(coding["id"]))["allowed"] is False
    c.patch(f"/api/v1/events/{event['id']}/parallel-policy", json={"parallel_policy": "none"})
    assert check(c, event, read)["allowed"] is False
    assert check(c, event_ref(series["event_ids"][1]), read)["allowed"] is True
    c.patch(f"/api/v1/events/{event['id']}/skip", json={"is_skipped": True, "confirmed": True})
    assert check(c, event, read)["allowed"] is True
    c.patch(f"/api/v1/events/{event['id']}/skip", json={"is_skipped": False, "confirmed": True})
    assert check(c, event, read)["allowed"] is False


def test_exact_override_requires_confirmation_and_tracks_later_denials(authenticated):
    c = authenticated
    _, series, reading, _ = setup_compatible(c)
    event = event_ref(series["event_ids"][0])
    read = task_ref(reading["id"])
    c.patch(f"/api/v1/events/{event['id']}/parallel-policy", json={"parallel_policy": "none"})
    exact = rule(c, selector("event", event["id"]), selector("task", read["id"]))
    assert check(c, event, read)["allowed"] is False
    payload = {k: exact[k] for k in ["left", "right", "decision"]}
    payload["override_conflicts"] = True
    assert c.put(f"/api/v1/compatibility-rules/{exact['id']}", json=payload).status_code == 200
    assert check(c, event, read)["allowed"] is True
    c.patch(f"/api/v1/events/{event['id']}/parallel-policy", json={"parallel_policy": "none"})
    assert check(c, event, read)["allowed"] is False
    c.put(f"/api/v1/compatibility-rules/{exact['id']}", json=payload)
    assert check(c, event, read)["allowed"] is True
    rule(c, selector("task", read["id"]), selector("event", event["id"]), "deny")
    assert check(c, event, read)["allowed"] is False


def test_all_pairs_dependencies_and_inferred_rules(authenticated):
    c = authenticated
    _, series, reading, allowed = setup_compatible(c)
    event = event_ref(series["event_ids"][0])
    read = task_ref(reading["id"])
    another = task(c, "另一篇论文", task_type="reading")
    result = check(c, event, read, task_ref(another["id"]))
    assert len(result["pairs"]) == 3 and result["allowed"] is False
    rule(c, selector("task_type", "reading"), selector("task_type", "reading"))
    assert check(c, event, read, task_ref(another["id"]))["allowed"] is True
    assert update_task(c, another, predecessor_ids=[reading["id"]]).status_code == 200
    assert check(c, read, task_ref(another["id"]))["allowed"] is False
    with Session(c.app.state.engine) as db:
        stored = db.get(CompatibilityRule, allowed["id"])
        stored.origin = "agent_inferred"
        db.commit()
    assert check(c, event, read)["allowed"] is False


def test_rule_restart_disable_and_workspace_isolation(authenticated, settings):
    c = authenticated
    _, series, reading, allowed = setup_compatible(c)
    app = create_app(settings)
    with TestClient(
        app,
        cookies=dict(c.cookies),
        headers={"Origin": "http://localhost:5173", "X-CSRF-Token": c.headers["X-CSRF-Token"]},
    ) as restarted:
        assert (
            check(restarted, event_ref(series["event_ids"][0]), task_ref(reading["id"]))["allowed"]
            is True
        )
        assert restarted.delete(f"/api/v1/compatibility-rules/{allowed['id']}").status_code == 204
        assert (
            check(restarted, event_ref(series["event_ids"][0]), task_ref(reading["id"]))["allowed"]
            is False
        )
    app.state.engine.dispose()
    with Session(c.app.state.engine) as db:
        workspace = Workspace()
        db.add(workspace)
        db.flush()
        foreign = Task(title="私人任务", workspace_id=workspace.id)
        db.add(foreign)
        db.commit()
        foreign_id = foreign.id
    assert (
        c.post(
            "/api/v1/tasks", json={"title": "跨工作区", "predecessor_ids": [foreign_id]}
        ).status_code
        == 404
    )
    assert (
        c.post(
            "/api/v1/compatibility-rules",
            json={
                "left": selector("task", foreign_id),
                "right": selector("task", reading["id"]),
                "decision": "allow",
            },
        ).status_code
        == 404
    )


def test_upgrade_preserves_v1_records_and_constraints(tmp_path):
    url = f"sqlite:///{tmp_path / 'upgrade.db'}"
    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.attributes["database_url"] = url
    command.upgrade(cfg, "0001")
    engine = build_engine(url)
    with engine.begin() as db:
        db.execute(
            text(
                "INSERT INTO workspaces(id,scheduling_revision,created_at,updated_at) "
                "VALUES ('w',0,0,0)"
            )
        )
        db.execute(
            text(
                "INSERT INTO tasks(id,workspace_id,title,description,status,priority,"
                "created_at,updated_at) "
                "VALUES ('t','w','已有任务','','todo',2,0,0)"
            )
        )
    command.upgrade(cfg, "head")
    with engine.connect() as db:
        assert db.execute(text("SELECT title,parallel_policy,parent_id FROM tasks")).one() == (
            "已有任务",
            None,
            None,
        )
        assert db.execute(text("PRAGMA foreign_key_check")).all() == []
        sql = db.scalar(text("SELECT sql FROM sqlite_master WHERE name='tasks'"))
        assert "CHECK (priority BETWEEN 1 AND 4)" in sql
    engine.dispose()
