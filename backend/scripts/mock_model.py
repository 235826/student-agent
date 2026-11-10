"""Local HTTP fixture used only by the isolated Playwright launcher, never the app."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: object) -> None:
        pass

    def json(self, payload: object) -> None:
        response = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def agent(self, body: dict) -> None:
        messages = body["messages"]
        if any(item.get("role") == "tool" for item in messages):
            executed = any(
                item.get("role") == "tool"
                and json.loads(item.get("content", "{}")).get("status") == "executed"
                for item in messages
            )
            self.json(
                {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": (
                                    "已加入任务，放在收件箱，未设置提醒。可在卡片中修改或撤销。"
                                    if executed
                                    else "我已经提出操作，请逐条确认。"
                                ),
                            }
                        }
                    ]
                }
            )
            return
        user_msg = next(
            (item for item in reversed(messages) if item.get("role") == "user"),
            None,
        )
        content = user_msg.get("content", "") if user_msg else ""
        if isinstance(content, list) and any(
            part.get("type") == "image_url" for part in content if isinstance(part, dict)
        ):
            self.json(
                {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "我看到了你发送的图片。",
                            }
                        }
                    ]
                }
            )
            return
        text = content if isinstance(content, str) else ""
        title = text.split("：", 1)[-1].split(":", 1)[-1].strip() or "测试任务"
        arguments = json.dumps({"title": title, "estimate_minutes": 30}, ensure_ascii=False)
        self.json(
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "type": "function",
                                    "function": {
                                        "name": "create_task",
                                        "arguments": arguments,
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        )

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if "tools" in body:
            self.agent(body)
            return
        content = body["messages"][1]["content"]
        source = json.loads(content[0]["text"])
        if "E2E_FAIL" in source["source_text"]:
            self.send_response(400)
            self.end_headers()
            return
        if len(content) == 2:
            candidates = [
                {
                    "key": f"course{i}",
                    "kind": "course",
                    "title": f"{source['user_context']}-课程{i}",
                    "recurrence": {
                        "start_date": "2030-01-07",
                        "end_date": "2030-01-07",
                        "weekdays": [0],
                        "start_time": f"{8 + i * 2:02d}:00",
                        "end_time": f"{9 + i * 2:02d}:00",
                    },
                    "evidence": {"recurrence": "测试图片课程时间"},
                }
                for i in range(3)
            ]
        else:
            title = source["source_text"]
            candidates = [
                {
                    "key": "report",
                    "kind": "task",
                    "title": title,
                    "estimate_minutes": 60,
                    "estimate_is_suggestion": True,
                    "evidence": {"title": title},
                }
            ]
        self.json(
            {
                "choices": [
                    {"message": {"content": json.dumps({"candidates": candidates, "warnings": []})}}
                ]
            }
        )


def server() -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)
