"""Start an isolated, fresh E2E database. Never use the default application database."""

import os
import sys
import threading
from pathlib import Path

import uvicorn
from alembic import command
from alembic.config import Config

backend = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(backend))
os.chdir(backend)
url = os.environ["SA_DATABASE_URL"]
path = Path(url.removeprefix("sqlite:///"))
if path.name != "e2e.db":
    raise RuntimeError("E2E runner only accepts e2e.db")
for suffix in ("", "-wal", "-shm"):
    Path(str(path) + suffix).unlink(missing_ok=True)
cfg = Config(str(backend / "alembic.ini"))
cfg.attributes["database_url"] = url
command.upgrade(cfg, "head")
from app.config import Settings  # noqa: E402 - backend path is installed above
from app.main import create_app  # noqa: E402 - backend path is installed above
from app.modules.security import LoginLimiter  # noqa: E402
from app.workers.imports import serve  # noqa: E402 - backend path is installed above
from scripts.mock_model import server  # noqa: E402 - backend path is installed above

mock = server()
threading.Thread(target=mock.serve_forever, daemon=True).start()
settings = Settings(
    database_url=url,
    llm_base_url=f"http://127.0.0.1:{mock.server_port}/v1",
    llm_model="local-e2e-fixture",
    llm_api_key="",
    llm_supports_images=True,
    source_dir=path.parent / "e2e-sources",
)
stop = threading.Event()
worker = threading.Thread(target=serve, args=(settings, stop), daemon=True)
worker.start()
try:
    app = create_app(settings)
    app.state.limiter = LoginLimiter(limit=100)
    uvicorn.run(app, host="127.0.0.1", port=8000)
finally:
    stop.set()
    worker.join(timeout=5)
    mock.shutdown()
    mock.server_close()
