import io
import json
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.modules.agent.runner import run_once
from app.providers.agent_chat import AgentReply, ToolCall


def call(name: str, arguments: dict, call_id: str = "call-1") -> AgentReply:
    raw = json.dumps(arguments, ensure_ascii=False)
    return AgentReply(
        content="",
        tool_calls=[ToolCall(id=call_id, name=name, arguments=raw)],
        message={
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": raw},
                }
            ],
        },
    )


def final(text: str = "我已准备好操作，请逐条确认。") -> AgentReply:
    return AgentReply(content=text, message={"role": "assistant", "content": text})


class Scripted:
    def __init__(self, replies: list[AgentReply]):
        self.replies = replies

    def complete(self, messages: list[dict], tools: list[dict], on_delta=None) -> AgentReply:
        assert tools
        assert messages
        if on_delta is not None:
            on_delta(self.replies[0].content)
        return self.replies.pop(0)


def configure(client: TestClient) -> None:
    settings = client.app.state.settings
    settings.llm_base_url = "http://127.0.0.1:9/v1"
    settings.llm_model = "fake"
    settings.llm_supports_tools = True


def conversation(client: TestClient, text: str = "帮我建一个任务") -> dict:
    response = client.post("/api/v1/agent/conversations", json={"consent": True})
    assert response.status_code == 201, response.text
    created = response.json()
    sent = client.post(
        f"/api/v1/agent/conversations/{created['id']}/messages",
        json={"content": text, "idempotency_key": str(uuid4())},
    )
    assert sent.status_code == 202, sent.text
    return {"conversation": created, "run": sent.json()}


def test_agent_creates_task_without_confirmation(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated)
    run_id = session["run"]["run_id"]
    provider = Scripted(
        [
            call(
                "create_task",
                {
                    "title": "写课程报告",
                    "priority": 1,
                    "deadline_at": "2030-01-10T18:00:00+08:00",
                    "estimate_minutes": 90,
                },
            ),
            final(),
        ]
    )
    assert run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        provider,
    )
    detail = authenticated.get(f"/api/v1/agent/runs/{run_id}").json()
    assert detail["run"]["status"] == "succeeded", detail
    assert len(detail["actions"]) == 1
    action = detail["actions"][0]
    assert action["status"] == "executed"
    assert action["operation"] == "create_task"
    assert action["risk"] == "low"
    assert len(authenticated.get("/api/v1/tasks").json()) == 1

    confirmed = authenticated.post(f"/api/v1/agent/actions/{action['id']}/confirm", json={})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "executed"
    tasks = authenticated.get("/api/v1/tasks").json()
    assert len(tasks) == 1
    assert tasks[0]["title"] == "写课程报告"

    again = authenticated.post(f"/api/v1/agent/actions/{action['id']}/confirm", json={})
    assert again.status_code == 200
    assert len(authenticated.get("/api/v1/tasks").json()) == 1


def test_agent_rejects_action_without_side_effect(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "删除今天的任务")
    provider = Scripted([call("trash_task", {"task_id": "missing"}), final()])
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        provider,
    )
    action = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"][
        0
    ]
    rejected = authenticated.post(
        f"/api/v1/agent/actions/{action['id']}/reject", json={"reason": "不需要"}
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    confirmed = authenticated.post(f"/api/v1/agent/actions/{action['id']}/confirm", json={})
    assert confirmed.status_code == 409


def test_agent_defaults_and_duplicate_calls(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "加入任务：ML-附录")
    provider = Scripted(
        [
            call("create_task", {"title": "ML-附录"}),
            call("create_task", {"title": "ML-附录"}, "retry"),
            final(),
        ]
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    tasks = authenticated.get("/api/v1/tasks").json()
    assert len(tasks) == 1
    assert tasks[0]["list_id"] is None
    assert tasks[0]["remind_at"] is None
    assert tasks[0]["deadline_at"] is None
    assert tasks[0]["priority"] == 2
    assert tasks[0]["tags"] == []
    actions = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"]
    assert len(actions) == 1
    assert actions[0]["result"]["id"] == tasks[0]["id"]


def test_agent_creates_six_today_tasks_without_reminders(authenticated: TestClient) -> None:
    configure(authenticated)
    conversation(authenticated, "今天加入这几个任务")
    deadline = (
        datetime.now(ZoneInfo("Asia/Shanghai"))
        .replace(
            hour=23,
            minute=59,
            second=59,
            microsecond=0,
        )
        .isoformat()
    )
    titles = ["iai3.5", "ML-ch12", "ML-附录", "ML-ch10", "IAI-lab", "ML-lab"]
    provider = Scripted(
        [
            *(
                call(
                    "create_task",
                    {"title": title, "deadline_at": deadline, "deadline_all_day": True},
                    f"call-{index}",
                )
                for index, title in enumerate(titles)
            ),
            final(),
        ]
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    tasks = authenticated.get("/api/v1/tasks?view=today").json()
    assert sorted(task["title"] for task in tasks) == sorted(titles)
    assert all(task["deadline_all_day"] and task["remind_at"] is None for task in tasks)
    summary = authenticated.get("/api/v1/tasks/summary").json()
    assert summary["today"] == 6
    assert summary["overdue"] == 0


def test_agent_uses_current_list_and_preserves_explicit_choices(authenticated: TestClient) -> None:
    configure(authenticated)
    current = authenticated.post("/api/v1/task-lists", json={"name": "当前清单"}).json()
    other = authenticated.post("/api/v1/task-lists", json={"name": "指定清单"}).json()
    session = conversation(authenticated)
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, Scripted([final()]))
    sent = authenticated.post(
        f"/api/v1/agent/conversations/{session['conversation']['id']}/messages",
        json={
            "content": "添加任务",
            "idempotency_key": str(uuid4()),
            "task_list_id": current["id"],
        },
    )
    assert sent.status_code == 202

    class Capture(Scripted):
        def complete(self, messages, tools, on_delta=None):
            assert "未指定清单时的任务归属：当前清单" in messages[0]["content"]
            return super().complete(messages, tools, on_delta)

    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        Capture(
            [
                call("create_task", {"title": "沿用当前"}),
                call(
                    "create_task",
                    {
                        "title": "明确指定",
                        "list_id": other["id"],
                        "remind_at": "2030-01-10T09:00:00+08:00",
                    },
                ),
                call("create_task", {"title": "明确收件箱", "list_id": None}),
                final(),
            ]
        ),
    )
    tasks = {task["title"]: task for task in authenticated.get("/api/v1/tasks").json()}
    assert tasks["沿用当前"]["list_id"] == current["id"]
    assert tasks["明确指定"]["list_id"] == other["id"]
    assert tasks["明确指定"]["remind_at"] is not None
    assert tasks["明确收件箱"]["list_id"] is None


def test_agent_undo_creation_is_idempotent_and_keeps_task_recoverable(
    authenticated: TestClient,
) -> None:
    configure(authenticated)
    session = conversation(authenticated)
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        Scripted(
            [
                call("create_task", {"title": "可撤销"}),
                final(),
            ]
        ),
    )
    action = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"][
        0
    ]
    for _ in range(2):
        response = authenticated.post(f"/api/v1/agent/actions/{action['id']}/undo", json={})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "undone"
    assert authenticated.get("/api/v1/tasks").json() == []
    trash = authenticated.get("/api/v1/tasks?view=trash").json()
    assert [task["title"] for task in trash] == ["可撤销"]
    assert (
        authenticated.post(f"/api/v1/agent/actions/{action['id']}/confirm", json={}).status_code
        == 409
    )


def test_agent_creation_and_receipt_roll_back_together(
    authenticated: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.modules.agent import runner

    configure(authenticated)
    session = conversation(authenticated)
    original = runner.apply_task

    def fail_after_insert(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(runner, "apply_task", fail_after_insert)
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        Scripted(
            [
                call("create_task", {"title": "不应遗留"}),
                final(),
            ]
        ),
    )
    assert authenticated.get("/api/v1/tasks").json() == []
    assert (
        authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"] == []
    )


def test_agent_undo_and_current_list_are_workspace_scoped(authenticated: TestClient) -> None:
    configure(authenticated)
    task_list = authenticated.post("/api/v1/task-lists", json={"name": "私有清单"}).json()
    session = conversation(authenticated)
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        Scripted(
            [
                call("create_task", {"title": "私有任务"}),
                final(),
            ]
        ),
    )
    action = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"][
        0
    ]
    other = authenticated.post(
        "/api/v1/auth/register",
        json={
            "username": "other",
            "password": "other-password-123",
        },
    )
    authenticated.headers["X-CSRF-Token"] = other.json()["csrf_token"]
    assert (
        authenticated.post(f"/api/v1/agent/actions/{action['id']}/undo", json={}).status_code == 404
    )
    own = authenticated.post("/api/v1/agent/conversations", json={"consent": True}).json()
    response = authenticated.post(
        f"/api/v1/agent/conversations/{own['id']}/messages",
        json={
            "content": "添加任务",
            "idempotency_key": str(uuid4()),
            "task_list_id": task_list["id"],
        },
    )
    assert response.status_code == 404


def test_agent_resolves_action_references(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "建清单并在里面加任务")
    provider = Scripted(
        [
            call("create_task_list", {"name": "期末复习"}, "call-list"),
            call(
                "create_task",
                {"title": "复习数据库", "list_id": {"$ref": "k1"}},
                "call-task",
            ),
            final(),
        ]
    )
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        provider,
    )
    actions = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"]
    assert [a["action_key"] for a in actions] == ["k1", "k2"]
    assert actions[1]["depends_on"] == ["k1"]

    blocked = authenticated.post(f"/api/v1/agent/actions/{actions[1]['id']}/confirm", json={})
    assert blocked.status_code == 409

    first = authenticated.post(f"/api/v1/agent/actions/{actions[0]['id']}/confirm", json={})
    assert first.status_code == 200, first.text
    second = authenticated.post(f"/api/v1/agent/actions/{actions[1]['id']}/confirm", json={})
    assert second.status_code == 200, second.text
    task = authenticated.get("/api/v1/tasks").json()[0]
    task_list = authenticated.get("/api/v1/task-lists").json()[0]
    assert task["list_id"] == task_list["id"]


def test_agent_workspace_isolation_and_consent(authenticated: TestClient) -> None:
    configure(authenticated)
    created = authenticated.post("/api/v1/agent/conversations", json={"consent": False})
    assert created.status_code == 422
    created = authenticated.post("/api/v1/agent/conversations", json={"consent": True}).json()
    assert authenticated.get(f"/api/v1/agent/conversations/{created['id']}").status_code == 200
    other = authenticated.post(
        "/api/v1/auth/register",
        json={"username": "other", "password": "other-password-123"},
    )
    assert other.status_code == 201
    authenticated.headers["X-CSRF-Token"] = other.json()["csrf_token"]
    assert authenticated.get(f"/api/v1/agent/conversations/{created['id']}").status_code == 404


def _png_bytes() -> bytes:
    img = Image.new("RGB", (2, 2), color="red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _upload_image(client: TestClient, conversation_id: str) -> dict:
    response = client.post(
        f"/api/v1/agent/conversations/{conversation_id}/images",
        files={"file": ("test.png", _png_bytes(), "image/png")},
    )
    assert response.status_code == 201, response.text
    return response.json()


class CheckingScripted:
    """Provider that pops replies and optionally checks messages for image content."""

    def __init__(self, replies: list[AgentReply], checker=None):
        self.replies = replies
        self.checker = checker

    def complete(self, messages: list[dict], tools: list[dict], on_delta=None) -> AgentReply:
        assert tools
        assert messages
        if self.checker:
            self.checker(messages)
        return self.replies.pop(0)


def test_agent_injects_chat_images(authenticated: TestClient) -> None:
    configure(authenticated)
    authenticated.app.state.settings.llm_supports_images = True
    conv = authenticated.post("/api/v1/agent/conversations", json={"consent": True}).json()
    image = _upload_image(authenticated, conv["id"])
    sent = authenticated.post(
        f"/api/v1/agent/conversations/{conv['id']}/messages",
        json={
            "content": "看看这张图",
            "idempotency_key": str(uuid4()),
            "image_ids": [image["id"]],
        },
    )
    assert sent.status_code == 202, sent.text
    run_id = sent.json()["run_id"]

    def checker(messages: list[dict]) -> None:
        user_msgs = [m for m in messages if m.get("role") == "user"]
        assert user_msgs, "no user message"
        last = user_msgs[-1]
        content = last.get("content")
        assert isinstance(content, list), f"expected list content, got {type(content)}"
        assert any(p.get("type") == "image_url" for p in content), "no image_url part"

    provider = CheckingScripted(
        [
            AgentReply(
                content="我看到了图片。",
                message={"role": "assistant", "content": "我看到了图片。"},
            )
        ],
        checker,
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    run = authenticated.get(f"/api/v1/agent/runs/{run_id}").json()
    assert run["run"]["status"] == "succeeded", run


def test_agent_read_task_images_tool(authenticated: TestClient) -> None:
    configure(authenticated)
    authenticated.app.state.settings.llm_supports_images = True
    task = authenticated.post("/api/v1/tasks", json={"title": "带附件的任务"}).json()
    authenticated.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("attachment.png", _png_bytes(), "image/png")},
    )
    session = conversation(authenticated, "读取任务图片")
    run_id = session["run"]["run_id"]
    seen_image = {"value": False}

    def checker(messages: list[dict]) -> None:
        for msg in messages:
            content = msg.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "image_url":
                        seen_image["value"] = True

    provider = CheckingScripted(
        [
            call("read_task_images", {"task_id": task["id"]}),
            AgentReply(
                content="我看到了任务附件图片。",
                message={"role": "assistant", "content": "我看到了任务附件图片。"},
            ),
        ],
        checker,
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    run = authenticated.get(f"/api/v1/agent/runs/{run_id}").json()
    assert run["run"]["status"] == "succeeded", run
    assert seen_image["value"], "model never received an image_url part"


def test_agent_image_tools_gated_without_image_support(authenticated: TestClient) -> None:
    configure(authenticated)
    authenticated.app.state.settings.llm_supports_images = False
    from app.modules.agent.tools import tool_schemas

    names = {t["function"]["name"] for t in tool_schemas(include_images=False)}
    assert "read_task_images" not in names
    assert "read_import_image" not in names
    assert "list_task_attachments" in names
    names_img = {t["function"]["name"] for t in tool_schemas(include_images=True)}
    assert "read_task_images" in names_img
    assert "read_import_image" in names_img


def test_agent_event_requires_explicit_type_name(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "明天下午四点考试")
    run_id = session["run"]["run_id"]
    provider = Scripted(
        [
            call(
                "create_event",
                {
                    "title": "软保期末",
                    "start_at": "2027-01-03T08:00:00+08:00",
                    "end_at": "2027-01-03T10:00:00+08:00",
                    "event_type": "考试",
                },
            ),
            final(),
        ]
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    detail = authenticated.get(f"/api/v1/agent/runs/{run_id}").json()
    assert detail["run"]["status"] == "succeeded", detail
    action = detail["actions"][0]
    assert action["status"] == "proposed"
    assert action["payload"]["event_type"] == "考试"
    assert "考试" in action["summary"]

    confirmed = authenticated.post(f"/api/v1/agent/actions/{action['id']}/confirm", json={})
    assert confirmed.status_code == 200, confirmed.text
    events = authenticated.get("/api/v1/events").json()
    assert events[0]["event_type"]["name"] == "考试"


def test_agent_event_rejects_missing_or_unknown_type(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "安排一场考试")
    run_id = session["run"]["run_id"]
    provider = Scripted(
        [
            call(
                "create_event",
                {
                    "title": "软保期末",
                    "start_at": "2027-01-03T08:00:00+08:00",
                    "end_at": "2027-01-03T10:00:00+08:00",
                },
                "call-missing",
            ),
            call(
                "create_event",
                {
                    "title": "数据库期末",
                    "start_at": "2027-01-08T08:00:00+08:00",
                    "end_at": "2027-01-08T10:00:00+08:00",
                    "event_type": "期末考试",
                },
                "call-unknown",
            ),
            final(),
        ]
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    detail = authenticated.get(f"/api/v1/agent/runs/{run_id}").json()
    assert detail["run"]["status"] == "succeeded", detail
    assert detail["actions"] == []
    assert authenticated.get("/api/v1/events").json() == []


def test_agent_updates_event_type_by_name(authenticated: TestClient) -> None:
    configure(authenticated)
    event = authenticated.post(
        "/api/v1/events",
        json={
            "title": "软保期末",
            "start_at": "2027-01-03T08:00:00+08:00",
            "end_at": "2027-01-03T10:00:00+08:00",
            "timezone": "Asia/Shanghai",
        },
    ).json()
    assert event["event_type"]["name"] == "其他"

    session = conversation(authenticated, "把软保期末改成考试")
    run_id = session["run"]["run_id"]
    provider = Scripted(
        [
            call("update_event", {"event_id": event["id"], "event_type": "考试"}),
            final(),
        ]
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    action = authenticated.get(f"/api/v1/agent/runs/{run_id}").json()["actions"][0]
    confirmed = authenticated.post(f"/api/v1/agent/actions/{action['id']}/confirm", json={})
    assert confirmed.status_code == 200, confirmed.text
    updated = authenticated.get("/api/v1/events").json()[0]
    assert updated["event_type"]["name"] == "考试"
    assert updated["title"] == "软保期末"


def test_agent_context_lists_executed_objects(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "明天考试")
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        Scripted(
            [
                call(
                    "create_event",
                    {
                        "title": "软保期末",
                        "start_at": "2027-01-03T08:00:00+08:00",
                        "end_at": "2027-01-03T10:00:00+08:00",
                        "event_type": "考试",
                    },
                ),
                final(),
            ]
        ),
    )
    action = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"][
        0
    ]
    assert (
        authenticated.post(f"/api/v1/agent/actions/{action['id']}/confirm", json={}).status_code
        == 200
    )
    event = authenticated.get("/api/v1/events").json()[0]

    seen: dict[str, str] = {}

    def checker(messages: list[dict]) -> None:
        seen["system"] = str(messages[0].get("content"))

    follow_up = authenticated.post(
        f"/api/v1/agent/conversations/{session['conversation']['id']}/messages",
        json={
            "content": "把刚才创建的事件改成考试",
            "idempotency_key": str(uuid4()),
        },
    )
    assert follow_up.status_code == 202, follow_up.text
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        CheckingScripted([final()], checker),
    )
    assert "最近已执行的对象" in seen["system"]
    assert "软保期末" in seen["system"]
    assert event["id"] in seen["system"]


def test_agent_update_rejects_unknown_event_at_proposal(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "把刚才创建的事件改成考试")
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        Scripted(
            [
                call(
                    "update_event",
                    {
                        "event_id": "6fd37935-31e6-4fe6-b833-4b94d7fb7d36",
                        "event_type": "考试",
                    },
                ),
                final(),
            ]
        ),
    )
    detail = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()
    assert detail["run"]["status"] == "succeeded", detail
    assert detail["actions"] == []


def test_agent_update_preview_shows_target(authenticated: TestClient) -> None:
    configure(authenticated)
    event = authenticated.post(
        "/api/v1/events",
        json={
            "title": "软保期末",
            "start_at": "2027-01-03T08:00:00+08:00",
            "end_at": "2027-01-03T10:00:00+08:00",
            "timezone": "Asia/Shanghai",
        },
    ).json()
    session = conversation(authenticated, "把软保期末改成考试")
    run_once(
        authenticated.app.state.engine,
        authenticated.app.state.settings,
        Scripted(
            [
                call("update_event", {"event_id": event["id"], "event_type": "考试"}),
                final(),
            ]
        ),
    )
    action = authenticated.get(f"/api/v1/agent/runs/{session['run']['run_id']}").json()["actions"][
        0
    ]
    assert action["summary"] == "修改事件「软保期末」"
    assert action["preview"]["target"] == "软保期末"
    assert action["preview"]["event_type"] == "其他 → 考试"
    assert action["preview"]["start_at"].startswith("2027-01-03T08:00:00")


def test_agent_tool_groups_reduce_schema(authenticated: TestClient) -> None:
    from app.modules.agent.tools import (
        groups_for_surface,
        tool_schema_chars,
        tool_schemas,
    )

    all_names = {item["function"]["name"] for item in tool_schemas()}
    calendar = tool_schemas(groups=groups_for_surface("calendar"))
    calendar_names = {item["function"]["name"] for item in calendar}
    assert "create_event" in calendar_names
    assert "create_task" not in calendar_names
    assert "load_tool_group" in calendar_names
    assert tool_schema_chars() < 32000
    assert len(all_names) == 64
    assert len({item["function"]["name"] for item in tool_schemas(include_images=True)}) == 66


def test_agent_stream_reports_finished_run(authenticated: TestClient) -> None:
    configure(authenticated)
    session = conversation(authenticated, "测试流式状态")
    run_id = session["run"]["run_id"]
    with authenticated.app.state.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE agent_runs SET status = 'succeeded', phase = '', partial_content = '' "
            "WHERE id = ?",
            (run_id,),
        )
    response = authenticated.get(f"/api/v1/agent/runs/{run_id}/stream")
    assert response.status_code == 200, response.text
    assert '"status": "succeeded"' in response.text


class ToolRecorder:
    def __init__(self, replies: list[AgentReply], seen: list[set[str]]):
        self.replies = replies
        self.seen = seen

    def complete(self, messages: list[dict], tools: list[dict], on_delta=None) -> AgentReply:
        self.seen.append({item["function"]["name"] for item in tools})
        return self.replies.pop(0)


def test_agent_loads_tool_group_on_demand(authenticated: TestClient) -> None:
    configure(authenticated)
    created = authenticated.post("/api/v1/agent/conversations", json={"consent": True}).json()
    sent = authenticated.post(
        f"/api/v1/agent/conversations/{created['id']}/messages",
        json={
            "content": "在日历页加个复习任务",
            "idempotency_key": str(uuid4()),
            "surface": "calendar",
        },
    )
    assert sent.status_code == 202, sent.text
    seen: list[set[str]] = []
    provider = ToolRecorder(
        [
            call("load_tool_group", {"groups": ["tasks"]}),
            call("create_task", {"title": "复习"}, "call-task"),
            final(),
        ],
        seen,
    )
    run_once(authenticated.app.state.engine, authenticated.app.state.settings, provider)
    assert "create_task" not in seen[0]
    assert "load_tool_group" in seen[0]
    assert "create_task" in seen[1]
    actions = authenticated.get(f"/api/v1/agent/runs/{sent.json()['run_id']}").json()["actions"]
    assert [item["operation"] for item in actions] == ["create_task"]
