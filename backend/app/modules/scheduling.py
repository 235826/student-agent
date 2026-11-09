from datetime import UTC, datetime, time
from itertools import combinations
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import ActivityRef, PairResult, PlanInput, PlanOut
from app.db.models import Event, Plan, Task, TaskDependency, User, WorkLog, Workspace, now_ms
from app.modules.calendar_management import event_view
from app.modules.compatibility import activity, evaluate_pair
from app.modules.idempotency import remember, replay
from app.modules.records import owned, record_change
from app.modules.task_management import graph

MINUTE = 60000


def current_plan(db: Session, user: User) -> Plan | None:
    return db.scalar(
        select(Plan).where(Plan.workspace_id == user.workspace_id, Plan.status == "adopted")
    )


def view(db: Session, user: User, plan: Plan) -> PlanOut:
    current = current_plan(db, user)
    revision = db.get(Workspace, user.workspace_id)
    assert revision is not None
    stale = revision.scheduling_revision != plan.source_revision
    if plan.status == "draft":
        stale |= (current.id if current else None) != plan.base_plan_id
        stale |= plan.start_at < now_ms()
    return PlanOut.model_validate(
        {
            **{
                c.name: getattr(plan, c.name)
                for c in Plan.__table__.columns
                if c.name in PlanOut.model_fields
            },
            "stale": stale,
        }
    )


def adopt_plan(db: Session, user: User, plan_id: str) -> Plan:
    plan = owned(db, Plan, plan_id, user)
    if plan.status == "adopted":
        return plan
    if plan.status != "draft" or view(db, user, plan).stale:
        raise HTTPException(409, "计划已过期或不再是草稿，请根据最新数据重新生成")
    previous = current_plan(db, user)
    if previous:
        previous.status = "superseded"
        db.flush()
    plan.status = "adopted"
    record_change(db, user, "plan.adopt", plan, scheduling=False)
    return plan


def generate(db: Session, user: User, body: PlanInput) -> Plan:
    payload = {
        "operation": "plan.generate",
        **body.model_dump(mode="json", exclude={"idempotency_key"}),
    }
    existing = replay(db, user, body.idempotency_key, payload)
    if existing:
        return owned(db, Plan, existing, user)
    start = int(body.start_at.timestamp() * 1000)
    end = int(body.end_at.timestamp() * 1000)
    if start < now_ms():
        raise HTTPException(422, "排程开始时间不能早于当前时间")
    tasks = list(db.scalars(select(Task).where(Task.workspace_id == user.workspace_id)))
    active = {
        t.id: t
        for t in tasks
        if t.trashed_at is None
        and t.archived_at is None
        and t.status in {"todo", "in_progress"}
    }
    if len(active) > 500:
        raise HTTPException(422, "单次排程最多支持 500 项未完成任务")
    predecessors: dict[str, list[str]] = {key: [] for key in active}
    for dep in db.scalars(
        select(TaskDependency).where(TaskDependency.workspace_id == user.workspace_id)
    ):
        if dep.successor_task_id in active:
            predecessors[dep.successor_task_id].append(dep.predecessor_task_id)
    events = [
        event_view(db, e)
        for e in db.scalars(select(Event).where(Event.workspace_id == user.workspace_id))
    ]
    events = [
        e
        for e in events
        if not e.is_skipped
        and e.end_at.timestamp() * 1000 > start
        and e.start_at.timestamp() * 1000 < end
    ]
    refs = {t.id: ActivityRef(kind="task", id=t.id) for t in active.values()}
    refs.update({e.id: ActivityRef(kind="event", id=e.id) for e in events})
    activities = {key: activity(db, user, ref) for key, ref in refs.items()}
    event_by_id = {e.id: e for e in events}
    edges = graph(db, user)
    pair_cache: dict[tuple[str, str], PairResult] = {}

    def pair_result(a: str, b: str) -> PairResult:
        key = (a, b) if a < b else (b, a)
        if key not in pair_cache:
            pair_cache[key] = evaluate_pair(
                db, user, activities[a], activities[b], edges
            )
        return pair_cache[key]

    def compatible(ids: list[str]) -> bool:
        for a, b in combinations(sorted(set(ids)), 2):
            if not pair_result(a, b).allowed:
                return False
        return True

    zone = ZoneInfo(user.timezone)
    available = [
        (w["weekday"], time.fromisoformat(w["start"]), time.fromisoformat(w["end"]))
        for w in user.available_windows
    ]
    rest = [
        (w["weekday"], time.fromisoformat(w["start"]), time.fromisoformat(w["end"]))
        for w in user.rest_windows
    ]
    slots: dict[int, list[str]] = {}
    first = ((start + MINUTE - 1) // MINUTE) * MINUTE
    event_intervals = sorted(
        (
            int(event.start_at.timestamp() * 1000),
            int(event.end_at.timestamp() * 1000),
            event.id,
        )
        for event in events
    )
    event_index = 0
    active_events: list[tuple[int, int, str]] = []
    for instant in range(first, end - MINUTE + 1, MINUTE):
        local = datetime.fromtimestamp(instant / 1000, UTC).astimezone(zone)
        finish = datetime.fromtimestamp((instant + MINUTE - 1) / 1000, UTC).astimezone(zone)
        while (
            event_index < len(event_intervals)
            and event_intervals[event_index][0] < instant + MINUTE
        ):
            active_events.append(event_intervals[event_index])
            event_index += 1
        if active_events:
            active_events = [event for event in active_events if event[1] > instant]
        if not any(
            day == local.weekday() and lower <= local.time() and finish.time() < upper
            for day, lower, upper in available
        ):
            continue
        if any(
            day == local.weekday() and lower <= finish.time() and upper > local.time()
            for day, lower, upper in rest
        ):
            continue
        slots[instant] = [event[2] for event in active_events]
    blocks: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    logged: dict[str, int] = {}
    for log in db.scalars(select(WorkLog).where(WorkLog.workspace_id == user.workspace_id)):
        logged[log.task_id] = logged.get(log.task_id, 0) + log.actual_minutes
    completed: dict[str, int] = {
        t.id: start for t in tasks if t.status == "done" and t.trashed_at is None
    }
    pending = dict(active)
    while pending:
        ready = [t for t in pending.values() if all(p not in pending for p in predecessors[t.id])]
        if not ready:
            raise HTTPException(409, "任务依赖存在循环，无法排程")
        task = min(
            ready,
            key=lambda t: (
                t.deadline_at if t.deadline_at is not None else 2**63,
                -t.priority,
                t.created_at,
                t.id,
            ),
        )
        del pending[task.id]
        logged_minutes = logged.get(task.id, 0)
        remaining = (
            max(task.estimate_minutes - logged_minutes, 0)
            if task.estimate_minutes is not None
            else None
        )
        reason = "已安排全部剩余工时"
        if remaining is None:
            reason = "缺少预计用时，请补充后重新生成"
        elif remaining == 0:
            reason = "实际耗时已达到预计用时，无需继续安排"
        elif any(p not in completed for p in predecessors[task.id]):
            reason = "前置任务未完整排入计划、已取消或已删除"
        else:
            earliest = max([start] + [completed[p] for p in predecessors[task.id]])
            deadline = min(end, task.deadline_at if task.deadline_at is not None else end)
            run: list[int] = []
            candidates = [s for s in slots if s >= earliest and s + MINUTE <= deadline]
            for instant in candidates + [end + MINUTE]:
                valid = (
                    instant in slots
                    and instant < deadline
                    and compatible([task.id, *slots[instant]])
                )
                if run and (
                    not valid or instant != run[-1] + MINUTE or len(run) == body.max_block_minutes
                ):
                    amount = min(len(run), remaining)
                    if amount >= min(body.min_block_minutes, remaining):
                        chosen = run[:amount]
                        local_start = datetime.fromtimestamp(
                            chosen[0] / 1000, UTC
                        ).astimezone(zone)
                        window = next(
                            (
                                (day, lower, upper)
                                for day, lower, upper in available
                                if day == local_start.weekday()
                                and lower <= local_start.time() < upper
                            ),
                            None,
                        )
                        parallel: list[dict[str, Any]] = []
                        event_ids = sorted(
                            {
                                event_id
                                for slot in chosen
                                for event_id in slots[slot]
                                if event_id in event_by_id
                            }
                        )
                        task_ids = sorted(
                            {
                                task_id
                                for slot in chosen
                                for task_id in slots[slot]
                                if task_id in active
                            }
                        )
                        for event_id in event_ids:
                            result = pair_result(task.id, event_id)
                            if not result.allowed:
                                continue
                            event = event_by_id[event_id]
                            parallel.append(
                                {
                                    "kind": "event",
                                    "id": event.id,
                                    "title": event.title,
                                    "start_at": int(event.start_at.timestamp() * 1000),
                                    "end_at": int(event.end_at.timestamp() * 1000),
                                    "reason": result.reason,
                                    "rule_ids": result.rule_ids,
                                    "policy_sources": result.policy_sources,
                                }
                            )
                        for parallel_task_id in task_ids:
                            result = pair_result(task.id, parallel_task_id)
                            if not result.allowed:
                                continue
                            parallel_task = active[parallel_task_id]
                            parallel.append(
                                {
                                    "kind": "task",
                                    "id": parallel_task.id,
                                    "title": parallel_task.title,
                                    "reason": result.reason,
                                    "rule_ids": result.rule_ids,
                                    "policy_sources": result.policy_sources,
                                }
                            )
                        parallel_ids = {
                            item["id"]
                            for item in parallel
                            if item["kind"] == "event"
                        }
                        fixed_events: list[dict[str, Any]] = []
                        if window:
                            window_start = int(
                                datetime.combine(
                                    local_start.date(), window[1], tzinfo=zone
                                ).timestamp()
                                * 1000
                            )
                            window_end = int(
                                datetime.combine(
                                    local_start.date(), window[2], tzinfo=zone
                                ).timestamp()
                                * 1000
                            )
                            for event in events:
                                if event.id in parallel_ids:
                                    continue
                                event_start = int(event.start_at.timestamp() * 1000)
                                event_end = int(event.end_at.timestamp() * 1000)
                                if event_start < window_end and event_end > window_start:
                                    fixed_events.append(
                                        {
                                            "id": event.id,
                                            "title": event.title,
                                            "start_at": event_start,
                                            "end_at": event_end,
                                        }
                                    )
                        fixed_total = len(fixed_events)
                        fixed_events = fixed_events[:10]
                        basis: dict[str, Any] = {
                            "priority": task.priority,
                            "deadline_at": task.deadline_at,
                            "estimate_minutes": task.estimate_minutes,
                            "logged_minutes": logged_minutes,
                            "fixed_events": fixed_events,
                            "fixed_event_total": fixed_total,
                            "window": (
                                {
                                    "weekday": window[0],
                                    "start": window[1].strftime("%H:%M"),
                                    "end": window[2].strftime("%H:%M"),
                                }
                                if window
                                else None
                            ),
                            "parallel_with": parallel,
                            "summary": (
                                "在可用时段内安排，并与已确认允许的固定活动并行"
                                if parallel
                                else "在可用时段内按截止时间、优先级和创建顺序安排"
                            ),
                        }
                        blocks.append(
                            {
                                "task_id": task.id,
                                "title": task.title,
                                "start_at": chosen[0],
                                "end_at": chosen[-1] + MINUTE,
                                "basis": basis,
                            }
                        )
                        for slot in chosen:
                            slots[slot].append(task.id)
                        remaining -= amount
                        if remaining == 0:
                            completed[task.id] = chosen[-1] + MINUTE
                            break
                    run = []
                if valid:
                    run.append(instant)
            if remaining:
                if not user.available_windows:
                    reason = "未设置每周可用时间，请先补充设置"
                elif deadline <= earliest:
                    reason = "截止时间已早于排程开始或前置任务的计划完成时间"
                else:
                    reason = (
                        "截止时间前或所选范围内可用容量不足（含休息、活动冲突及最小工作块限制）"
                    )
        scheduled = (task.estimate_minutes or 0) - (remaining or 0)
        reports.append(
            {
                "task_id": task.id,
                "title": task.title,
                "estimated_minutes": task.estimate_minutes,
                "logged_minutes": logged_minutes,
                "scheduled_minutes": scheduled,
                "unscheduled_minutes": remaining,
                "reason": reason,
            }
        )
    current = current_plan(db, user)

    def keys(items: list[dict[str, Any]]) -> set[tuple[str, int, int]]:
        return {(b["task_id"], b["start_at"], b["end_at"]) for b in items}

    before, after = keys(current.blocks if current else []), keys(blocks)
    workspace = db.get(Workspace, user.workspace_id)
    assert workspace is not None
    plan = Plan(
        workspace_id=user.workspace_id,
        source_revision=workspace.scheduling_revision,
        base_plan_id=current.id if current else None,
        start_at=start,
        end_at=end,
        timezone=user.timezone,
        blocks=blocks,
        reports=reports,
        differences={
            "added": len(after - before),
            "removed": len(before - after),
            "unchanged": len(before & after),
            "added_blocks": [
                b for b in blocks if (b["task_id"], b["start_at"], b["end_at"]) not in before
            ],
            "removed_blocks": [
                b
                for b in (current.blocks if current else [])
                if (b["task_id"], b["start_at"], b["end_at"]) not in after
            ],
        },
    )
    db.add(plan)
    db.flush()
    remember(db, user, body.idempotency_key, payload, plan.id)
    record_change(db, user, "plan.generate", plan, scheduling=False)
    return plan
