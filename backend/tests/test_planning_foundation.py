import calendar
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

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
        "links",
        "status",
        "priority",
        "flagged",
        "deadline_at",
        "deadline_all_day",
        "estimate_minutes",
        "task_type",
        "recurrence",
        "recurrence_interval",
        "recurrence_from_completion",
        "recurrence_until",
        "recurrence_remaining",
        "list_id",
        "tags",
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


def test_task_lists_assign_and_delete(authenticated):
    c = authenticated
    study = post(c, "/task-lists", {"name": "学习", "color": "#123456"})
    life = post(c, "/task-lists", {"name": "生活"})
    assert c.post("/api/v1/task-lists", json={"name": "学习"}).status_code == 409
    assert c.post("/api/v1/task-lists", json={"name": "坏颜色", "color": "red"}).status_code == 422

    record = task(c, "写作业", list_id=study["id"])
    assert record["list_id"] == study["id"]
    renamed = c.put(
        f"/api/v1/task-lists/{study['id']}",
        json={"name": "课程", "color": "#abcdef"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "课程" and renamed.json()["color"] == "#abcdef"
    stored = next(t for t in c.get("/api/v1/tasks").json() if t["id"] == record["id"])
    assert stored["list_id"] == study["id"]

    assert c.delete(f"/api/v1/task-lists/{study['id']}").status_code == 204
    inbox = next(t for t in c.get("/api/v1/tasks").json() if t["id"] == record["id"])
    assert inbox["list_id"] is None
    assert [item["id"] for item in c.get("/api/v1/task-lists").json()] == [life["id"]]

    foreign = post(c, "/task-lists", {"name": "另一个"})
    assert (
        c.put(
            f"/api/v1/task-lists/{foreign['id']}",
            json={"name": "生活"},
        ).status_code
        == 409
    )


def test_task_list_reorder_and_new_list_appends(authenticated):
    c = authenticated
    lists = [post(c, "/task-lists", {"name": f"清单{index}"}) for index in range(3)]
    ids = [item["id"] for item in lists]
    assert [item["sort_order"] for item in lists] == [1, 2, 3]
    assert [item["id"] for item in c.get("/api/v1/task-lists").json()] == ids

    reordered = c.post(
        "/api/v1/task-lists/reorder",
        json={"list_ids": [ids[2], ids[0], ids[1]]},
    )
    assert reordered.status_code == 200, reordered.text
    assert [item["id"] for item in reordered.json()] == [ids[2], ids[0], ids[1]]
    assert [item["id"] for item in c.get("/api/v1/task-lists").json()] == [
        ids[2],
        ids[0],
        ids[1],
    ]

    appended = post(c, "/task-lists", {"name": "新清单"})
    assert appended["sort_order"] == 4
    assert (
        c.post("/api/v1/task-lists/reorder", json={"list_ids": [ids[0], ids[0]]}).status_code == 422
    )
    assert (
        c.post(
            "/api/v1/task-lists/reorder",
            json={"list_ids": [ids[0], "missing"]},
        ).status_code
        == 404
    )


def test_task_summary_counts(authenticated):
    c = authenticated
    now = datetime.now(UTC)
    task(c, "逾期", deadline_at=(now - timedelta(days=1)).isoformat())
    task(c, "进行中", status="in_progress")
    task(c, "未来", deadline_at=(now + timedelta(days=7)).isoformat())
    task(c, "标记", flagged=True)
    task(c, "完成", status="done")
    trashed = task(c, "垃圾")
    c.post(f"/api/v1/tasks/{trashed['id']}/trash")

    summary = c.get("/api/v1/tasks/summary")
    assert summary.status_code == 200, summary.text
    assert summary.json() == {
        "active": 4,
        "today": 2,
        "overdue": 1,
        "flagged": 1,
        "trashed": 1,
    }


def test_task_filters_and_views(authenticated):
    c = authenticated
    now = datetime.now(UTC)
    math_list = post(c, "/task-lists", {"name": "数学"})
    reading_list = post(c, "/task-lists", {"name": "阅读"})
    math = task(
        c,
        "数学作业",
        description="微分方程练习",
        list_id=math_list["id"],
        tags=["数学"],
        deadline_at=(now + timedelta(days=2)).isoformat(),
        flagged=True,
    )
    reading = task(
        c,
        "阅读论文",
        list_id=reading_list["id"],
        tags=["阅读"],
    )
    done = task(
        c,
        "已完成作业",
        status="done",
        list_id=math_list["id"],
        tags=["数学"],
    )
    inbox = task(c, "收件箱任务")
    trashed = task(c, "垃圾任务")
    c.post(f"/api/v1/tasks/{trashed['id']}/trash")

    def ids(**params: str) -> set[str]:
        response = c.get("/api/v1/tasks", params=params)
        assert response.status_code == 200, response.text
        return {item["id"] for item in response.json()}

    assert ids(q="微分") == {math["id"]}
    assert ids(q="数学") == {math["id"], done["id"]}
    assert ids(view="scheduled") == {math["id"]}
    assert ids(view="unscheduled") == {reading["id"], inbox["id"]}
    assert ids(view="done") == {done["id"]}
    assert ids(view="flagged") == {math["id"]}
    assert ids(view="trash") == {trashed["id"]}
    assert ids(list_id=math_list["id"]) == {math["id"], done["id"]}
    assert ids(list_id="inbox") == {inbox["id"]}
    assert ids(tag="数学") == {math["id"], done["id"]}
    assert ids(status="done") == {done["id"]}
    assert ids(flagged="true") == {math["id"]}
    assert ids(
        due_from=(now + timedelta(days=1)).isoformat(),
        due_to=(now + timedelta(days=3)).isoformat(),
    ) == {math["id"]}


def test_task_pagination(authenticated):
    c = authenticated
    for index in range(5):
        task(c, f"分页{index}")
    first = c.get("/api/v1/tasks", params={"limit": 2})
    assert first.status_code == 200
    assert [item["title"] for item in first.json()] == ["分页0", "分页1"]
    second = c.get("/api/v1/tasks", params={"limit": 2, "offset": 2})
    assert [item["title"] for item in second.json()] == ["分页2", "分页3"]
    assert c.get("/api/v1/tasks", params={"limit": 0}).status_code == 422
    assert c.get("/api/v1/tasks", params={"limit": 201}).status_code == 422
    assert c.get("/api/v1/tasks", params={"offset": -1}).status_code == 422


def test_task_search_includes_tags_links_and_attachments(authenticated):
    c = authenticated
    record = task(
        c,
        "带资料任务",
        tags=["数学"],
        links=["https://example.com/notes"],
    )
    other = task(c, "无关任务")
    upload = c.post(
        f"/api/v1/tasks/{record['id']}/attachments",
        files={"file": ("作业说明.txt", b"hello", "text/plain")},
    )
    assert upload.status_code == 201, upload.text

    def search(value: str) -> set[str]:
        response = c.get("/api/v1/tasks", params={"q": value})
        assert response.status_code == 200, response.text
        return {item["id"] for item in response.json()}

    assert search("数学") == {record["id"]}
    assert search("example.com") == {record["id"]}
    assert search("作业说明") == {record["id"]}
    assert search("无关任务") == {other["id"]}


def test_task_detail_titles_and_get_task(authenticated):
    c = authenticated
    parent = task(c, "父任务")
    child = task(c, "子任务", parent_id=parent["id"])
    trashed = task(c, "已删除任务")
    c.post(f"/api/v1/tasks/{trashed['id']}/trash")

    detail = c.get(f"/api/v1/tasks/{parent['id']}")
    assert detail.status_code == 200 and detail.json()["title"] == "父任务"
    assert c.get("/api/v1/tasks/missing").status_code == 404
    assert c.get(f"/api/v1/tasks/{trashed['id']}").status_code == 200

    titles = c.post(
        "/api/v1/tasks/titles",
        json={"ids": [parent["id"], child["id"], trashed["id"], "missing"]},
    )
    assert titles.status_code == 200, titles.text
    assert titles.json() == {
        parent["id"]: "父任务",
        child["id"]: "子任务",
        trashed["id"]: "已删除任务",
    }


def test_recurring_task_generation_undo_and_edit(authenticated):
    c = authenticated
    habit_list = post(c, "/task-lists", {"name": "习惯"})
    due = datetime.now(UTC).replace(microsecond=0) + timedelta(days=2)
    record = task(
        c,
        "每日阅读",
        recurrence="daily",
        deadline_at=due.isoformat(),
        tags=["阅读"],
        list_id=habit_list["id"],
        estimate_minutes=30,
    )
    done = c.post(f"/api/v1/tasks/{record['id']}/complete")
    assert done.status_code == 200, done.text
    tasks = c.get("/api/v1/tasks").json()
    assert len(tasks) == 2
    next_task = next(item for item in tasks if item["id"] != record["id"])
    assert next_task["title"] == "每日阅读"
    assert next_task["status"] == "todo"
    assert next_task["recurrence"] == "daily"
    assert next_task["tags"] == ["阅读"]
    assert next_task["list_id"] == habit_list["id"]
    assert next_task["estimate_minutes"] == 30
    next_deadline = datetime.fromisoformat(next_task["deadline_at"].replace("Z", "+00:00"))
    assert next_deadline == due + timedelta(days=1)

    c.post(f"/api/v1/tasks/{record['id']}/complete")
    assert len(c.get("/api/v1/tasks").json()) == 2

    reopened = c.post(f"/api/v1/tasks/{record['id']}/reopen")
    assert reopened.status_code == 200
    tasks = c.get("/api/v1/tasks").json()
    assert len(tasks) == 1 and tasks[0]["id"] == record["id"]
    assert tasks[0]["status"] == "todo"

    c.post(f"/api/v1/tasks/{record['id']}/complete")
    tasks = c.get("/api/v1/tasks").json()
    assert len(tasks) == 2
    edited = next(item for item in tasks if item["id"] != record["id"])
    update = update_task(c, edited, title="自定义下一次")
    assert update.status_code == 200, update.text
    c.post(f"/api/v1/tasks/{record['id']}/reopen")
    titles = {item["title"] for item in c.get("/api/v1/tasks").json()}
    assert titles == {"每日阅读", "自定义下一次"}


def test_recurring_task_worklog_and_requires_deadline(authenticated):
    c = authenticated
    assert (
        c.post("/api/v1/tasks", json={"title": "无截止重复", "recurrence": "daily"}).status_code
        == 422
    )
    due = datetime.now(UTC).replace(microsecond=0) + timedelta(days=2)
    record = task(
        c,
        "每周复盘",
        recurrence="weekly",
        deadline_at=due.isoformat(),
    )
    log = c.post(
        f"/api/v1/tasks/{record['id']}/worklogs",
        json={"actual_minutes": 30, "complete": True},
    )
    assert log.status_code == 201, log.text
    tasks = c.get("/api/v1/tasks").json()
    assert len(tasks) == 2
    next_task = next(item for item in tasks if item["id"] != record["id"])
    assert next_task["recurrence"] == "weekly"
    next_deadline = datetime.fromisoformat(next_task["deadline_at"].replace("Z", "+00:00"))
    assert next_deadline == due + timedelta(days=7)
    assert update_task(c, record, deadline_at=None).status_code == 422


def test_recurring_task_monthly_clamps_day(authenticated):
    c = authenticated
    zone = ZoneInfo("Asia/Shanghai")
    now_local = datetime.now(UTC).astimezone(zone)
    year = now_local.year
    due_local = datetime(year, 1, 31, 9, 0, tzinfo=zone)
    if due_local <= now_local:
        year += 1
        due_local = datetime(year, 1, 31, 9, 0, tzinfo=zone)
    record = task(
        c,
        "月度报告",
        recurrence="monthly",
        deadline_at=due_local.isoformat(),
    )
    c.post(f"/api/v1/tasks/{record['id']}/complete")
    tasks = c.get("/api/v1/tasks").json()
    next_task = next(item for item in tasks if item["id"] != record["id"])
    next_local = datetime.fromisoformat(next_task["deadline_at"].replace("Z", "+00:00")).astimezone(
        zone
    )
    expected_day = calendar.monthrange(year, 2)[1]
    assert (
        next_local.year,
        next_local.month,
        next_local.day,
        next_local.hour,
    ) == (year, 2, expected_day, 9)


def test_task_links_dedupe_validation_and_recurrence(authenticated):
    c = authenticated
    record = task(
        c,
        "资料",
        links=[
            "https://example.com/a",
            "https://example.com/a",
            "http://example.org",
        ],
    )
    assert record["links"] == ["https://example.com/a", "http://example.org"]
    assert (
        c.post(
            "/api/v1/tasks",
            json={"title": "坏链接", "links": ["javascript:alert(1)"]},
        ).status_code
        == 422
    )

    updated = update_task(c, record, links=["https://docs.example.com"])
    assert updated.status_code == 200, updated.text
    assert updated.json()["links"] == ["https://docs.example.com"]

    due = datetime.now(UTC).replace(microsecond=0) + timedelta(days=2)
    recurring = task(
        c,
        "每周资料",
        recurrence="weekly",
        deadline_at=due.isoformat(),
        links=["https://example.com/week"],
    )
    c.post(f"/api/v1/tasks/{recurring['id']}/complete")
    next_task = next(
        item
        for item in c.get("/api/v1/tasks").json()
        if item["title"] == "每周资料" and item["status"] == "todo"
    )
    assert next_task["links"] == ["https://example.com/week"]


def test_completion_stats(authenticated):
    c = authenticated
    record = task(c, "统计任务", estimate_minutes=90)
    assert c.post(f"/api/v1/tasks/{record['id']}/complete").status_code == 200
    log = c.post(
        f"/api/v1/tasks/{record['id']}/worklogs",
        json={"actual_minutes": 45},
    )
    assert log.status_code == 201, log.text

    stats = c.get("/api/v1/stats/completion", params={"days": 7})
    assert stats.status_code == 200, stats.text
    data = stats.json()
    assert data["today"] == 1
    assert data["week"] == 1
    assert data["month"] == 1
    assert data["estimate_minutes"] == 90
    assert data["actual_minutes"] == 45
    assert len(data["days"]) == 7
    today = datetime.now(UTC).astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()
    assert data["days"][-1] == {"date": today, "count": 1}

    c.post(f"/api/v1/tasks/{record['id']}/reopen")
    cleared = c.get("/api/v1/stats/completion", params={"days": 7}).json()
    assert cleared["today"] == 0
    assert cleared["estimate_minutes"] == 0
    assert cleared["actual_minutes"] == 0


def test_permanent_delete_cleans_relations_and_files(authenticated, settings):
    c = authenticated
    parent = task(c, "待清理", tags=["数学"])
    child = task(c, "保留子任务", parent_id=parent["id"])
    upload = c.post(
        f"/api/v1/tasks/{parent['id']}/attachments",
        files={"file": ("note.txt", b"hello", "text/plain")},
    )
    assert upload.status_code == 201
    assert c.delete(f"/api/v1/tasks/{parent['id']}/permanent").status_code == 409
    assert c.post(f"/api/v1/tasks/{parent['id']}/trash?confirm_impact=true").status_code == 200
    assert c.delete(f"/api/v1/tasks/{parent['id']}/permanent").status_code == 204
    assert c.get(f"/api/v1/tasks/{parent['id']}").status_code == 404
    remaining = c.get("/api/v1/tasks").json()
    assert [item["id"] for item in remaining] == [child["id"]]
    assert remaining[0]["parent_id"] is None
    assert not [path for path in settings.attachment_dir.rglob("*") if path.is_file()]


def test_purge_trash_and_auto_cleanup(authenticated):
    c = authenticated
    old = task(c, "旧垃圾")
    c.post(f"/api/v1/tasks/{old['id']}/trash")
    with Session(c.app.state.engine) as db:
        record = db.get(Task, old["id"])
        assert record is not None
        record.trashed_at = int(datetime.now(UTC).timestamp() * 1000) - 31 * 24 * 60 * 60 * 1000
        db.commit()

    trigger = task(c, "触发清理")
    c.post(f"/api/v1/tasks/{trigger['id']}/trash")
    trash = c.get("/api/v1/tasks", params={"view": "trash"}).json()
    assert [item["id"] for item in trash] == [trigger["id"]]

    other = task(c, "另一个垃圾")
    c.post(f"/api/v1/tasks/{other['id']}/trash")
    purged = c.post("/api/v1/tasks/trash/purge")
    assert purged.status_code == 200, purged.text
    assert purged.json() == {"deleted": 2}
    assert c.get("/api/v1/tasks", params={"view": "trash"}).json() == []


def test_subtask_order_and_reorder(authenticated):
    c = authenticated
    parent = task(c, "项目")
    first = task(c, "阶段一", parent_id=parent["id"])
    second = task(c, "阶段二", parent_id=parent["id"])
    third = task(c, "阶段三", parent_id=parent["id"])
    assert [first["subtask_order"], second["subtask_order"], third["subtask_order"]] == [
        1,
        2,
        3,
    ]

    reordered = c.post(
        f"/api/v1/tasks/{parent['id']}/subtasks/reorder",
        json={"task_ids": [third["id"], first["id"], second["id"]]},
    )
    assert reordered.status_code == 200, reordered.text
    assert [item["id"] for item in reordered.json()] == [
        third["id"],
        first["id"],
        second["id"],
    ]
    assert [item["subtask_order"] for item in reordered.json()] == [1, 2, 3]

    other = task(c, "另一个任务")
    assert (
        c.post(
            f"/api/v1/tasks/{parent['id']}/subtasks/reorder",
            json={"task_ids": [other["id"]]},
        ).status_code
        == 404
    )
    assert (
        c.post(
            f"/api/v1/tasks/{parent['id']}/subtasks/reorder",
            json={"task_ids": [first["id"], first["id"]]},
        ).status_code
        == 422
    )


def test_recurring_interval_weekdays_and_yearly(authenticated):
    c = authenticated
    zone = ZoneInfo("Asia/Shanghai")
    due = datetime(2030, 5, 10, 9, 0, tzinfo=zone)

    biweekly = task(
        c,
        "双周任务",
        recurrence="weekly",
        recurrence_interval=2,
        deadline_at=due.isoformat(),
    )
    c.post(f"/api/v1/tasks/{biweekly['id']}/complete")
    next_biweekly = next(
        item
        for item in c.get("/api/v1/tasks").json()
        if item["title"] == "双周任务" and item["status"] == "todo"
    )
    assert datetime.fromisoformat(next_biweekly["deadline_at"].replace("Z", "+00:00")).astimezone(
        zone
    ) == due + timedelta(weeks=2)

    now_local = datetime.now(UTC).astimezone(zone)
    days = (4 - now_local.weekday()) % 7
    friday = (now_local + timedelta(days=days)).replace(hour=9, minute=0, second=0, microsecond=0)
    if friday <= now_local:
        friday += timedelta(days=7)
    weekdays = task(
        c,
        "工作日任务",
        recurrence="weekdays",
        deadline_at=friday.isoformat(),
    )
    c.post(f"/api/v1/tasks/{weekdays['id']}/complete")
    next_weekday = next(
        item
        for item in c.get("/api/v1/tasks").json()
        if item["title"] == "工作日任务" and item["status"] == "todo"
    )
    next_weekday_local = datetime.fromisoformat(
        next_weekday["deadline_at"].replace("Z", "+00:00")
    ).astimezone(zone)
    assert next_weekday_local == friday + timedelta(days=3)
    assert next_weekday_local.weekday() == 0

    yearly = task(
        c,
        "年度任务",
        recurrence="yearly",
        deadline_at=due.isoformat(),
    )
    c.post(f"/api/v1/tasks/{yearly['id']}/complete")
    next_yearly = next(
        item
        for item in c.get("/api/v1/tasks").json()
        if item["title"] == "年度任务" and item["status"] == "todo"
    )
    assert datetime.fromisoformat(next_yearly["deadline_at"].replace("Z", "+00:00")).astimezone(
        zone
    ) == due.replace(year=2031)


def test_recurring_until_remaining_and_from_completion(authenticated):
    c = authenticated
    zone = ZoneInfo("Asia/Shanghai")
    now_local = datetime.now(UTC).astimezone(zone)
    due = (now_local + timedelta(days=2)).replace(hour=9, minute=0, second=0, microsecond=0)

    stopped = task(
        c,
        "到截止",
        recurrence="daily",
        deadline_at=due.isoformat(),
        recurrence_until=due.isoformat(),
    )
    c.post(f"/api/v1/tasks/{stopped['id']}/complete")
    assert not [
        item
        for item in c.get("/api/v1/tasks").json()
        if item["title"] == "到截止" and item["status"] == "todo"
    ]

    limited = task(
        c,
        "限次数",
        recurrence="daily",
        deadline_at=due.isoformat(),
        recurrence_remaining=1,
    )
    c.post(f"/api/v1/tasks/{limited['id']}/complete")
    next_limited = next(
        item
        for item in c.get("/api/v1/tasks").json()
        if item["title"] == "限次数" and item["status"] == "todo"
    )
    assert next_limited["recurrence_remaining"] == 0
    c.post(f"/api/v1/tasks/{next_limited['id']}/complete")
    assert len([item for item in c.get("/api/v1/tasks").json() if item["title"] == "限次数"]) == 2

    from_completion = task(
        c,
        "按完成日",
        recurrence="daily",
        deadline_at=due.isoformat(),
        recurrence_from_completion=True,
    )
    c.post(f"/api/v1/tasks/{from_completion['id']}/complete")
    next_completion = next(
        item
        for item in c.get("/api/v1/tasks").json()
        if item["title"] == "按完成日" and item["status"] == "todo"
    )
    next_completion_local = datetime.fromisoformat(
        next_completion["deadline_at"].replace("Z", "+00:00")
    ).astimezone(zone)
    assert next_completion_local.date() == (now_local + timedelta(days=1)).date()
    assert next_completion_local.hour == 9


def test_list_groups_and_saved_filters(authenticated):
    c = authenticated
    group = post(c, "/task-list-groups", {"name": "学习"})
    assert c.post("/api/v1/task-list-groups", json={"name": "学习"}).status_code == 409
    renamed = c.put(f"/api/v1/task-list-groups/{group['id']}", json={"name": "课程"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "课程"

    task_list = post(
        c,
        "/task-lists",
        {"name": "数学", "group_id": group["id"]},
    )
    assert task_list["group_id"] == group["id"]

    saved = post(
        c,
        "/saved-filters",
        {
            "name": "今日作业",
            "payload": {"view": "today", "q": "作业", "sort": "deadline"},
        },
    )
    assert saved["payload"]["view"] == "today"
    assert saved["payload"]["q"] == "作业"
    listed = c.get("/api/v1/saved-filters").json()
    assert [item["name"] for item in listed] == ["今日作业"]
    updated = c.put(
        f"/api/v1/saved-filters/{saved['id']}",
        json={"name": "今日作业2", "payload": {"view": "all"}},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "今日作业2"
    assert updated.json()["payload"]["view"] == "all"
    assert c.delete(f"/api/v1/saved-filters/{saved['id']}").status_code == 204
    assert c.get("/api/v1/saved-filters").json() == []

    assert c.delete(f"/api/v1/task-list-groups/{group['id']}").status_code == 204
    stored = next(
        item for item in c.get("/api/v1/task-lists").json() if item["id"] == task_list["id"]
    )
    assert stored["group_id"] is None


def test_task_flag_toggle_and_preserve(authenticated):
    c = authenticated
    record = task(c, "重点任务", flagged=True)
    assert record["flagged"] is True

    off = c.patch(f"/api/v1/tasks/{record['id']}/flag", json={"flagged": False})
    assert off.status_code == 200, off.text
    assert off.json()["flagged"] is False
    assert (
        next(item for item in c.get("/api/v1/tasks").json() if item["id"] == record["id"])[
            "flagged"
        ]
        is False
    )

    on = c.patch(f"/api/v1/tasks/{record['id']}/flag", json={"flagged": True})
    assert on.status_code == 200
    done = c.post(f"/api/v1/tasks/{record['id']}/complete")
    assert done.status_code == 200 and done.json()["flagged"] is True

    c.post(f"/api/v1/tasks/{record['id']}/trash")
    assert c.patch(f"/api/v1/tasks/{record['id']}/flag", json={"flagged": False}).status_code == 409


def test_task_reorder_and_new_task_appends(authenticated):
    c = authenticated
    records = [task(c, f"任务{index}") for index in range(3)]
    ids = [record["id"] for record in records]
    assert [record["sort_order"] for record in records] == [1, 2, 3]
    assert [item["id"] for item in c.get("/api/v1/tasks").json()] == ids

    reordered = c.post("/api/v1/tasks/reorder", json={"task_ids": [ids[2], ids[0], ids[1]]})
    assert reordered.status_code == 200, reordered.text
    assert [item["id"] for item in reordered.json()] == [ids[2], ids[0], ids[1]]
    assert [item["id"] for item in c.get("/api/v1/tasks").json()] == [
        ids[2],
        ids[0],
        ids[1],
    ]

    appended = task(c, "新任务")
    assert appended["sort_order"] == 4
    assert c.post("/api/v1/tasks/reorder", json={"task_ids": [ids[0], ids[0]]}).status_code == 422
    assert (
        c.post("/api/v1/tasks/reorder", json={"task_ids": [ids[0], "missing"]}).status_code == 404
    )
    c.post(f"/api/v1/tasks/{ids[0]}/trash")
    assert c.post("/api/v1/tasks/reorder", json={"task_ids": [ids[0], ids[1]]}).status_code == 404


def test_tag_usage_rename_and_trash(authenticated):
    c = authenticated
    first = task(c, "任务一", tags=["数学", "阅读"])
    task(c, "任务二", tags=["数学"])
    tags = {tag["name"]: tag for tag in c.get("/api/v1/tags").json()}
    assert tags["数学"]["usage_count"] == 2
    assert tags["阅读"]["usage_count"] == 1

    renamed = c.put(f"/api/v1/tags/{tags['数学']['id']}", json={"name": "高数"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "高数"
    assert renamed.json()["usage_count"] == 2
    assert c.put(f"/api/v1/tags/{tags['阅读']['id']}", json={"name": "高数"}).status_code == 409
    stored = next(item for item in c.get("/api/v1/tasks").json() if item["id"] == first["id"])
    assert set(stored["tags"]) == {"高数", "阅读"}

    c.post(f"/api/v1/tasks/{first['id']}/trash")
    tags = {tag["name"]: tag for tag in c.get("/api/v1/tags").json()}
    assert tags["高数"]["usage_count"] == 1
    assert tags["阅读"]["usage_count"] == 0


def test_task_tags_sync_and_delete(authenticated):
    c = authenticated
    record = task(c, "阅读", tags=["数学", "阅读", "数学"])
    assert set(record["tags"]) == {"数学", "阅读"}
    assert {tag["name"] for tag in c.get("/api/v1/tags").json()} == {"数学", "阅读"}

    updated = update_task(c, record, tags=["阅读", "编程"])
    assert updated.status_code == 200, updated.text
    assert set(updated.json()["tags"]) == {"阅读", "编程"}
    tags = c.get("/api/v1/tags").json()
    assert {tag["name"] for tag in tags} == {"数学", "阅读", "编程"}

    math = next(tag for tag in tags if tag["name"] == "数学")
    assert c.delete(f"/api/v1/tags/{math['id']}").status_code == 204
    assert {tag["name"] for tag in c.get("/api/v1/tags").json()} == {"阅读", "编程"}
    stored = next(t for t in c.get("/api/v1/tasks").json() if t["id"] == record["id"])
    assert set(stored["tags"]) == {"阅读", "编程"}


def test_quick_complete_reopen_and_all_day_deadline(authenticated):
    c = authenticated
    record = task(
        c,
        "写作业",
        deadline_at="2026-11-02T23:59:00+08:00",
        deadline_all_day=True,
    )
    assert record["deadline_all_day"] is True
    assert record["completed_at"] is None

    done = c.post(f"/api/v1/tasks/{record['id']}/complete")
    assert done.status_code == 200, done.text
    done_task = done.json()
    assert done_task["status"] == "done"
    assert done_task["completed_at"] is not None
    first_completed_at = done_task["completed_at"]
    assert c.post(f"/api/v1/tasks/{record['id']}/complete").json()["completed_at"] == (
        first_completed_at
    )

    reopened = c.post(f"/api/v1/tasks/{record['id']}/reopen").json()
    assert reopened["status"] == "todo"
    assert reopened["completed_at"] is None

    deadline = c.patch(
        f"/api/v1/tasks/{record['id']}/deadline",
        json={"deadline_at": "2026-11-02T23:59:00+08:00", "deadline_all_day": True},
    )
    assert deadline.status_code == 200, deadline.text
    assert deadline.json()["deadline_all_day"] is True
    assert deadline.json()["deadline_at"] == "2026-11-02T15:59:00Z"
    cleared = c.patch(f"/api/v1/tasks/{record['id']}/deadline", json={"deadline_at": None}).json()
    assert cleared["deadline_at"] is None and cleared["deadline_all_day"] is False
    assert (
        c.patch(
            f"/api/v1/tasks/{record['id']}/deadline",
            json={"deadline_at": "2026-11-02T23:59:00"},
        ).status_code
        == 422
    )

    predecessor = task(c, "前置")
    blocked = task(c, "后续", predecessor_ids=[predecessor["id"]])
    assert c.post(f"/api/v1/tasks/{blocked['id']}/complete").status_code == 409


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
    exam_type = next(t for t in c.get("/api/v1/event-types").json() if t["system_key"] == "exam")
    exam = post(
        c,
        "/events",
        {
            "title": "期末考试",
            "start_at": "2026-11-03T09:00:00+08:00",
            "end_at": "2026-11-03T10:00:00+08:00",
            "kind": "other",
            "event_type_id": exam_type["id"],
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
