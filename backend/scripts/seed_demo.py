"""Seed a disposable demo database. Never touches the normal or E2E databases."""

import argparse
import hashlib
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from alembic import command
from alembic.config import Config
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.import_schemas import ImportCandidate
from app.api.schemas import PlanInput, RuleInput, Selector, SeriesInput, TaskInput
from app.db.models import (
    Course,
    Draft,
    Event,
    EventType,
    ImportJob,
    ImportSource,
    TaskTypePolicy,
    User,
    WorkLog,
    Workspace,
)
from app.db.session import build_engine
from app.modules.calendar_management import create_series, instance_override
from app.modules.compatibility import prepare_rule
from app.modules.event_types import ensure_system_types
from app.modules.records import record_change
from app.modules.scheduling import generate
from app.modules.security import hasher
from app.modules.task_management import apply_task

BACKEND = Path(__file__).resolve().parents[1]
PROJECT = BACKEND.parent
DEFAULT_DATABASE = PROJECT / "data" / "demo.db"
ZONE = ZoneInfo("Asia/Shanghai")
DAY = 86400000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--reset", action="store_true", help="rebuild data/demo.db")
    return parser.parse_args()


def migrate(path: Path) -> None:
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))
    config.attributes["database_url"] = f"sqlite:///{path}"
    command.upgrade(config, "head")


def at(base: datetime, days: int, hour: int, minute: int = 0) -> datetime:
    day = (base + timedelta(days=days)).date()
    return datetime.combine(day, time(hour, minute), tzinfo=ZONE)


def add_event(
    db: Session,
    user: User,
    title: str,
    start: datetime,
    end: datetime,
    *,
    kind: str = "other",
    event_type: EventType | None = None,
    course: Course | None = None,
    location: str = "",
    note: str = "",
    details: str = "",
) -> Event:
    event = Event(
        workspace_id=user.workspace_id,
        title=title,
        start_at=int(start.timestamp() * 1000),
        end_at=int(end.timestamp() * 1000),
        timezone=user.timezone,
        location=location,
        note=note,
        details=details,
        kind=kind,
        course_id=course.id if course else None,
        event_type_id=event_type.id if event_type else None,
        locked=True,
    )
    db.add(event)
    db.flush()
    return event


def create_demo_user(
    db: Session, username: str = "demo", password: str = "demo-password-123"
) -> User:
    workspace = Workspace()
    db.add(workspace)
    db.flush()
    user = User(
        workspace_id=workspace.id,
        username=username,
        password_hash=hasher.hash(password),
        timezone="Asia/Shanghai",
        available_windows=[{"weekday": day, "start": "08:30", "end": "21:30"} for day in range(5)]
        + [{"weekday": 5, "start": "09:00", "end": "12:00"}],
        rest_windows=[{"weekday": day, "start": "12:00", "end": "13:30"} for day in range(7)],
    )
    db.add(user)
    db.flush()
    ensure_system_types(db, user)
    return user


def seed_data(db: Session, user: User, now: datetime) -> None:
    system = ensure_system_types(db, user)

    custom_specs = [
        ("社团活动", "#9254de"),
        ("学术讲座", "#1677ff"),
        ("实习面试", "#13c2c2"),
        ("实验展示", "#eb2f96"),
    ]
    custom = {
        name: EventType(workspace_id=user.workspace_id, name=name, color=color)
        for name, color in custom_specs
    }
    for event_type in custom.values():
        db.add(event_type)
    db.flush()

    courses = {
        name: Course(workspace_id=user.workspace_id, name=name, semester="2026 秋")
        for name in ("高等数学", "数据结构", "大学英语", "物理实验")
    }
    courses["高等数学"].parallel_policy = "allow_selected"
    for course in courses.values():
        db.add(course)
    db.flush()

    week_start = now.date() - timedelta(days=now.weekday())
    series_specs = [
        ("高等数学", [0, 2], 8, 0, 9, 40, "教学楼 A201"),
        ("数据结构", [1, 3], 10, 0, 11, 40, "实验楼 B305"),
        ("大学英语", [2], 14, 0, 15, 40, "外语楼 C102"),
        ("物理实验", [4], 14, 0, 16, 0, "物理实验中心 204"),
    ]
    series_list = []
    for index, (name, weekdays, hour, minute, end_hour, end_minute, location) in enumerate(
        series_specs
    ):
        series = create_series(
            db,
            user,
            SeriesInput(
                course_id=courses[name].id,
                start_date=week_start - timedelta(days=14),
                end_date=week_start + timedelta(days=56),
                weekdays=weekdays,
                start_time=time(hour, minute),
                end_time=time(end_hour, end_minute),
                timezone=user.timezone,
                location=location,
                note="课程调整请关注通知",
                details=f"{name}每周安排",
                idempotency_key=f"demo-series-{index}",
            ),
            commit=False,
        )
        series_list.append(series)

    skip = next(
        e
        for e in db.scalars(select(Event).where(Event.series_id == series_list[0].id))
        if e.start_at > int(now.timestamp() * 1000)
    )
    override = instance_override(db, skip, create=True)
    assert override is not None
    override.is_skipped = True
    override.note = "本周请假"

    add_event(
        db,
        user,
        "高数补课",
        at(now, 5, 10),
        at(now, 5, 11, 40),
        kind="course",
        course=courses["高等数学"],
        location="教学楼 A201",
        note="补上第 6 周内容",
    )
    add_event(
        db,
        user,
        "期中考试",
        at(now, 7, 9),
        at(now, 7, 11),
        event_type=system["exam"],
        location="教学楼 A101",
        note="闭卷",
        details="覆盖前六章，允许携带计算器。",
    )
    add_event(
        db,
        user,
        "班会",
        at(now, 4, 16),
        at(now, 4, 17),
        event_type=system["meeting"],
        location="学院会议室",
        note="确认实习材料",
    )
    add_event(
        db,
        user,
        "社团迎新",
        at(now, 6, 18),
        at(now, 6, 20),
        event_type=custom["社团活动"],
        location="大学生活动中心",
        note="负责签到",
        details="提前 30 分钟到场布置。",
    )
    add_event(
        db,
        user,
        "AI 与学习讲座",
        at(now, 3, 19),
        at(now, 3, 20, 30),
        event_type=custom["学术讲座"],
        location="图书馆报告厅",
        note="可盖章",
    )
    add_event(
        db,
        user,
        "实习面试",
        at(now, 2, 15),
        at(now, 2, 15, 45),
        event_type=custom["实习面试"],
        location="线上会议",
        note="准备项目介绍",
        details="链接会在面试前发送。",
    )
    add_event(
        db,
        user,
        "医院复查",
        at(now, 9, 16),
        at(now, 9, 17),
        event_type=system["other"],
        location="校医院",
    )
    add_event(
        db,
        user,
        "实验展示",
        at(now, 11, 10),
        at(now, 11, 12),
        event_type=custom["实验展示"],
        location="实验楼中庭",
    )

    db.add(
        TaskTypePolicy(
            workspace_id=user.workspace_id,
            task_type="review",
            parallel_policy="allow_selected",
            policy_revision=1,
        )
    )
    prepare_rule(
        db,
        user,
        RuleInput(
            left=Selector(scope="course", key=courses["高等数学"].id),
            right=Selector(scope="task_type", key="review"),
            decision="allow",
        ),
    )

    apply_task(
        db,
        user,
        TaskInput(
            title="提交英语作文",
            description="修改后提交到课程平台",
            priority=4,
            deadline_at=at(now, -1, 22),
            estimate_minutes=60,
            task_type="writing",
        ),
    )
    homework = apply_task(
        db,
        user,
        TaskInput(
            title="完成高数习题 3.4",
            description="重点复习极限与连续性",
            priority=4,
            deadline_at=at(now, 0, 22),
            estimate_minutes=90,
            task_type="homework",
        ),
    )
    review = apply_task(
        db,
        user,
        TaskInput(
            title="复习数据结构",
            description="整理树与图的遍历笔记",
            priority=3,
            deadline_at=at(now, 1, 21),
            estimate_minutes=120,
            task_type="review",
            predecessor_ids=[homework.id],
        ),
    )
    report = apply_task(
        db,
        user,
        TaskInput(
            title="物理实验报告",
            description="完成数据处理和误差分析",
            priority=3,
            deadline_at=at(now, 3, 20),
            estimate_minutes=150,
            task_type="lab",
        ),
    )
    apply_task(
        db,
        user,
        TaskInput(
            title="整理实验数据",
            description="整理原始测量值并绘图",
            priority=2,
            deadline_at=at(now, 2, 20),
            estimate_minutes=45,
            task_type="lab",
            parent_id=report.id,
            predecessor_ids=[review.id],
        ),
    )
    apply_task(
        db,
        user,
        TaskInput(
            title="预约实习面试",
            description="确认时间和线上链接",
            priority=2,
            status="done",
            deadline_at=at(now, -2, 18),
            estimate_minutes=30,
            task_type="career",
        ),
    )
    db.add(
        WorkLog(
            workspace_id=user.workspace_id,
            task_id=review.id,
            actual_minutes=30,
            cause="interrupted",
            note="先花了半小时整理旧笔记",
            reflection="晚上注意力一般，明天换到上午继续",
        )
    )
    db.add(
        Draft(
            workspace_id=user.workspace_id,
            payload=TaskInput(
                title="阅读《深入理解计算机系统》",
                description="先读第 1 章，整理读书笔记",
                priority=2,
                estimate_minutes=90,
                task_type="reading",
            ).model_dump(mode="json"),
            status="draft",
            revision=1,
        )
    )

    plan = generate(
        db,
        user,
        PlanInput(
            start_at=at(now, 1, 8),
            end_at=at(now, 8, 22),
            min_block_minutes=25,
            max_block_minutes=90,
            idempotency_key="demo-plan-generate",
        ),
    )
    plan.status = "adopted"
    record_change(db, user, "plan.adopt", plan, scheduling=False)

    text = "下周三 19:00 学术讲座；周五 16:30 社团例会。"
    source = ImportSource(
        workspace_id=user.workspace_id,
        kind="text",
        digest=hashlib.sha256(text.encode()).hexdigest(),
        text=text,
    )
    db.add(source)
    db.flush()
    candidates = [
        ImportCandidate(
            key="lecture",
            kind="event",
            title="职业规划讲座",
            start_local=at(now, 7, 19).replace(tzinfo=None),
            end_local=at(now, 7, 20, 30).replace(tzinfo=None),
            event_type_id=custom["学术讲座"].id,
            location="图书馆报告厅",
            reviewed=False,
        ),
        ImportCandidate(
            key="club",
            kind="event",
            title="社团例会",
            start_local=at(now, 9, 16, 30).replace(tzinfo=None),
            end_local=at(now, 9, 18).replace(tzinfo=None),
            event_type_id=custom["社团活动"].id,
            location="大学生活动中心",
            reviewed=False,
        ),
    ]
    db.add(
        ImportJob(
            workspace_id=user.workspace_id,
            source_id=source.id,
            status="succeeded",
            context="演示用待校对材料",
            timezone=user.timezone,
            reference_at=int(now.timestamp() * 1000),
            revision=1,
            candidates=[candidate.model_dump(mode="json") for candidate in candidates],
        )
    )
    db.flush()
    db.commit()


def seed(db: Session, path: Path) -> None:
    now = datetime.now(ZONE)
    user = create_demo_user(db)
    seed_data(db, user, now)
    print("演示数据已创建")
    print("数据库：", path)
    print("账号：demo")
    print("密码：demo-password-123")
    print(
        "启动：SA_DATABASE_URL=sqlite:///"
        + str(path)
        + " uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000"
    )


def main() -> None:
    args = parse_args()
    path = args.database.resolve()
    if path.name != "demo.db":
        raise SystemExit("只允许创建名为 demo.db 的独立演示数据库")
    if path.exists():
        if not args.reset:
            raise SystemExit("演示库已存在；如需重建请加 --reset")
        path.unlink()
        for suffix in ("-wal", "-shm"):
            Path(str(path) + suffix).unlink(missing_ok=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    migrate(path)
    engine = build_engine(f"sqlite:///{path}")
    with Session(engine) as db:
        seed(db, path)
    engine.dispose()


if __name__ == "__main__":
    main()
