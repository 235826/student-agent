from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    Course,
    Draft,
    Event,
    EventType,
    ImportJob,
    Plan,
    Task,
    User,
    Workspace,
)
from app.db.session import build_engine
from scripts.seed_demo import migrate, seed


def test_demo_seed_creates_visible_data(tmp_path: Path) -> None:
    path = tmp_path / "demo.db"
    migrate(path)
    engine = build_engine(f"sqlite:///{path}")
    with Session(engine) as db:
        seed(db, path)
    with Session(engine) as db:
        assert db.scalar(select(func.count(Course.id))) == 4
        assert db.scalar(select(func.count(EventType.id))) == 7
        assert db.scalar(select(func.count(Task.id))) == 6
        assert db.scalar(select(func.count(Draft.id))) == 1
        assert db.scalar(select(func.count(Plan.id))) == 1
        assert db.scalar(select(func.count(ImportJob.id))) == 1
        assert db.scalar(select(Plan.status)) == "adopted"
        assert not list(
            db.scalars(select(Event).where(Event.kind == "other", Event.event_type_id.is_(None)))
        )
        assert not list(
            db.scalars(
                select(Event).where(Event.kind == "course", Event.event_type_id.is_not(None))
            )
        )
    engine.dispose()


def test_demo_account_can_be_appended_to_existing_database(tmp_path: Path) -> None:
    from scripts.seed_demo_account import add_demo_account

    path = tmp_path / "demo.db"
    migrate(path)
    engine = build_engine(f"sqlite:///{path}")
    with Session(engine) as db:
        seed(db, path)
        add_demo_account(db, "demo2", "demo-password-456")
    with Session(engine) as db:
        assert db.scalar(select(func.count(User.id))) == 2
        assert db.scalar(select(func.count(Workspace.id))) == 2
        assert db.scalar(select(func.count(Plan.id))) == 2
        assert db.scalar(select(func.count(ImportJob.id))) == 2
    engine.dispose()
