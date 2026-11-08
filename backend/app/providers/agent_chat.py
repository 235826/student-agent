"""Chat Completions adapter for the global agent. Models can only propose tools."""

import json
import time
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

    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> AgentReply:
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
                    },
                ) as response:
                    if response.status_code != 200:
                        raise provider_failure(response, url.hostname or "")
                    chunks = bytearray()
                    for chunk in response.iter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > 1024 * 1024:
                            raise ParseFailure("模型返回内容过大，请缩短对话后重试")
                        if time.monotonic() - started > config.agent_timeout_seconds:
                            raise ParseFailure("模型请求超时", transient=True)
            envelope = json.loads(chunks)
            message = envelope["choices"][0]["message"]
            content = message.get("content") or ""
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            calls: list[ToolCall] = []
            for item in message.get("tool_calls") or []:
                function = item.get("function") or {}
                name = function.get("name")
                arguments = function.get("arguments", "{}")
                if not isinstance(name, str) or not name:
                    raise ParseFailure("模型返回了无效的工具调用")
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments, ensure_ascii=False)
                calls.append(
                    ToolCall(
                        id=str(item.get("id") or f"call_{len(calls)}"),
                        name=name,
                        arguments=arguments,
                    )
                )
            return AgentReply(content=content, tool_calls=calls, message=message)
        except (httpx.TimeoutException, httpx.NetworkError):
            raise ParseFailure("模型连接失败或超时", transient=True) from None
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
            raise ParseFailure("模型输出不符合工具调用格式，请重试") from None
