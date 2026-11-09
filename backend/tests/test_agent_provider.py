import json

import httpx

from app.config import Settings
from app.providers.agent_chat import AgentChat


def _settings() -> Settings:
    return Settings(
        llm_base_url="https://example.com/v1",
        llm_model="test-model",
        llm_api_key="secret",
        llm_supports_tools=True,
        agent_timeout_seconds=30,
    )


def test_agent_chat_streams_content_and_tool_calls() -> None:
    events = [
        {"choices": [{"delta": {"content": "你"}}]},
        {"choices": [{"delta": {"content": "好"}}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-1",
                                "function": {"name": "create_task", "arguments": '{"tit'},
                            }
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'le": "复习"}'}}]}}
            ]
        },
        {"choices": [{"delta": {}}]},
    ]
    body = "".join(f"data: {json.dumps(item)}\n\n" for item in events) + "data: [DONE]\n\n"
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, content=body.encode())

    chunks: list[str] = []
    chat = AgentChat(_settings(), transport=httpx.MockTransport(handler))
    reply = chat.complete(
        [{"role": "user", "content": "建任务"}],
        [{"type": "function", "function": {"name": "create_task", "parameters": {}}}],
        chunks.append,
    )
    assert "".join(chunks) == "你好"
    assert reply.content == "你好"
    assert reply.tool_calls[0].name == "create_task"
    assert json.loads(reply.tool_calls[0].arguments) == {"title": "复习"}
    assert seen[0]["stream"] is True
    assert reply.message["tool_calls"][0]["function"]["name"] == "create_task"


def test_agent_chat_rejects_invalid_tool_call() -> None:
    body = (
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"id":"call-1","function":{"arguments":"{}"}}]}}]}\n\n'
        "data: [DONE]\n\n"
    )
    chat = AgentChat(
        _settings(),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body)),
    )
    try:
        chat.complete(
            [{"role": "user", "content": "x"}],
            [{"type": "function", "function": {"name": "x", "parameters": {}}}],
        )
    except Exception as exc:
        assert "无效的工具调用" in str(exc)
    else:
        raise AssertionError("expected failure")
