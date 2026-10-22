"""Append a demo account and demo workspace to the configured database."""

import argparse
from datetime import datetime
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import Settings
from app.db.models import User
from app.db.session import build_engine
from scripts.seed_demo import ZONE, create_demo_user, seed_data


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--username", default="demo")
    parser.add_argument("--password", default="demo-password-123")
    return parser.parse_args()


def add_demo_account(
    db: Session, username: str = "demo", password: str = "demo-password-123"
) -> User:
    if db.scalar(select(User.id).where(User.username == username)):
        raise SystemExit(f"账号 {username} 已存在，未写入任何数据")
    user = create_demo_user(db, username, password)
    seed_data(db, user, datetime.now(ZONE))
    return user


def main() -> None:
    args = parse_args()
    database_url = (
        f"sqlite:///{args.database.resolve()}" if args.database else Settings().database_url
    )
    engine = build_engine(database_url)
    with Session(engine) as db:
        version = db.scalar(text("SELECT version_num FROM alembic_version"))
        if version != "0007":
            raise SystemExit("数据库尚未迁移到 0007，请先执行 alembic upgrade head")
        add_demo_account(db, args.username, args.password)
    engine.dispose()
    print("演示账号已追加")
    print("账号：", args.username)
    print("密码：", args.password)
    print("数据库：", database_url)


if __name__ == "__main__":
    main()
