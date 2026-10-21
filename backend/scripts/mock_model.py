"""Local HTTP fixture used only by the isolated Playwright launcher, never the app."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: object) -> None:
        pass

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
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
        response = json.dumps(
            {
                "choices": [
                    {"message": {"content": json.dumps({"candidates": candidates, "warnings": []})}}
                ]
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def server() -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)
