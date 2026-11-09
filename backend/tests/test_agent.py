import io
import json
from uuid import uuid4

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

    def complete(self, messages: list[dict], tools: list[dict]) -> AgentReply:
        assert tools
        assert messages
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


def test_agent_proposes_then_confirms_task(authenticated: TestClient) -> None:
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
    assert action["status"] == "proposed"
    assert action["operation"] == "create_task"
    assert action["risk"] == "medium"
    assert authenticated.get("/api/v1/tasks").json() == []

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

    def complete(self, messages: list[dict], tools: list[dict]) -> AgentReply:
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
