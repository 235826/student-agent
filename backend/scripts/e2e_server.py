"""Start an isolated, fresh E2E database. Never use the default application database."""

import os
import sys
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
uvicorn.run("app.main:create_app", factory=True, host="127.0.0.1", port=8000)
