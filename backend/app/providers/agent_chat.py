"""Chat Completions adapter for the global agent. Models can only propose tools."""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.config import Settings
from app.providers.chat_completions import (
    ParseFailure,
    configured,
    provider_failure,
)


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class AgentReply:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    message: dict[str, Any] = field(default_factory=dict)


class AgentChat:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        self.settings = settings
        self.transport = transport

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_delta: Callable[[str], None] | None = None,
    ) -> AgentReply:
        config = self.settings
        if not configured(config):
            raise ParseFailure("尚未配置模型地址和模型名")
        if not config.llm_supports_tools:
            raise ParseFailure("当前模型未启用工具调用，请在服务端配置后重试")
        if not tools:
            raise ParseFailure("没有可用的 Agent 工具")
        url = urlsplit(config.llm_base_url)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.query:
            raise ParseFailure("模型地址配置无效")
        if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ParseFailure("远程模型接口必须使用 HTTPS")
        try:
            started = time.monotonic()
            content_parts: list[str] = []
            calls: dict[int, dict[str, Any]] = {}
            with httpx.Client(
                timeout=config.llm_timeout_seconds,
                transport=self.transport,
                follow_redirects=False,
            ) as client:
                with client.stream(
                    "POST",
                    config.llm_base_url.rstrip("/") + "/chat/completions",
                    headers=(
                        {"Authorization": f"Bearer {config.llm_api_key.get_secret_value()}"}
                        if config.llm_api_key.get_secret_value()
                        else {}
                    ),
                    json={
                        "model": config.llm_model,
                        "messages": messages,
                        "tools": tools,
                        "tool_choice": "auto",
                        "stream": True,
                    },
                ) as response:
                    if response.status_code != 200:
                        raise provider_failure(response, url.hostname or "")
                    for line in response.iter_lines():
                        if time.monotonic() - started > config.agent_timeout_seconds:
                            raise ParseFailure("模型请求超时", transient=True)
                        line = line.strip()
                        if not line:
                            continue
                        if line.startswith("data:"):
                            data = line[5:].strip()
                            if data == "[DONE]":
                                break
                        elif line.startswith("{"):
                            data = line
                        else:
                            continue
                        try:
                            envelope = json.loads(data)
                        except ValueError:
                            continue
                        choices = envelope.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get("delta")
                        if delta is None and isinstance(choice.get("message"), dict):
                            full = choice["message"]
                            delta = {
                                "content": full.get("content"),
                                "tool_calls": [
                                    {**item, "index": index}
                                    for index, item in enumerate(full.get("tool_calls") or [])
                                ],
                            }
                        if not isinstance(delta, dict):
                            continue
                        text = delta.get("content")
                        if isinstance(text, str) and text:
                            content_parts.append(text)
                            if on_delta is not None:
                                on_delta(text)
                        for item in delta.get("tool_calls") or []:
                            index = item.get("index", 0)
                            if not isinstance(index, int):
                                index = 0
                            slot = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                            if item.get("id"):
                                slot["id"] = str(item["id"])
                            function = item.get("function") or {}
                            if function.get("name"):
                                slot["name"] = str(function["name"])
                            arguments = function.get("arguments")
                            if isinstance(arguments, str):
                                slot["arguments"] += arguments
            content = "".join(content_parts)
            tool_calls: list[ToolCall] = []
            for index in sorted(calls):
                slot = calls[index]
                name = slot["name"]
                if not name:
                    raise ParseFailure("模型返回了无效的工具调用")
                arguments = slot["arguments"] or "{}"
                tool_calls.append(
                    ToolCall(
                        id=slot["id"] or f"call_{index}",
                        name=name,
                        arguments=arguments,
                    )
                )
            message: dict[str, Any] = {
                "role": "assistant",
                "content": content or None,
            }
            if tool_calls:
                message["tool_calls"] = [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {"name": call.name, "arguments": call.arguments},
                    }
                    for call in tool_calls
                ]
            return AgentReply(content=content, tool_calls=tool_calls, message=message)
        except (httpx.TimeoutException, httpx.NetworkError):
            raise ParseFailure("模型连接失败或超时", transient=True) from None
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
            raise ParseFailure("模型输出不符合工具调用格式，请重试") from None
