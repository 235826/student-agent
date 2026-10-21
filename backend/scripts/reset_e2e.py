"""Clear only the explicitly named E2E database between serial browser scenarios."""

import sqlite3
import sys
from pathlib import Path

path = Path(sys.argv[1]).resolve()
expected = Path(__file__).resolve().parents[2] / "data" / "e2e.db"
if path != expected or not path.is_file():
    raise RuntimeError("Only the repository data/e2e.db may be reset")
with sqlite3.connect(path) as db:
    # This connection is exclusive to test cleanup. The worker uses its own FK-enabled connection.
    db.execute("PRAGMA foreign_keys=OFF")
    db.execute("BEGIN IMMEDIATE")
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    for (name,) in tables:
        if name not in {"alembic_version", "worker_heartbeats"} and not name.startswith("sqlite_"):
            safe_name = name.replace('"', '""')
            db.execute(f'DELETE FROM "{safe_name}"')
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
