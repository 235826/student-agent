from dataclasses import dataclass
from itertools import combinations
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import (
    ActivityRef,
    CompatibilityOut,
    PairResult,
    RuleInput,
    RuleOut,
    Selector,
)
from app.db.models import CompatibilityRule, Course, Event, Task, TaskTypePolicy, User
from app.modules.calendar_management import event_view, instance_override
from app.modules.idempotency import fingerprint
from app.modules.records import owned
from app.modules.task_management import graph, path_between


@dataclass
class Activity:
    ref: ActivityRef
    course_id: str | None
    task_type: str | None
    policy: str
    policy_source: str
    policy_revision: int
    skipped: bool = False
    unavailable: bool = False


def activity(db: Session, user: User, ref: ActivityRef) -> Activity:
    if ref.kind == "task":
        task = owned(db, Task, ref.id, user)
        source = f"task:{task.id}"
        revision = task.policy_revision
        policy = task.parallel_policy
        if policy is None:
            type_policy = (
                db.scalar(
                    select(TaskTypePolicy).where(
                        TaskTypePolicy.workspace_id == user.workspace_id,
                        TaskTypePolicy.task_type == task.task_type,
                    )
                )
                if task.task_type
                else None
            )
            policy = type_policy.parallel_policy if type_policy else "none"
            source = f"task_type:{task.task_type}" if type_policy else f"default:task:{task.id}"
            revision = type_policy.policy_revision if type_policy else 0
        return Activity(
            ref,
            None,
            task.task_type,
            policy,
            source,
            revision,
            unavailable=task.trashed_at is not None or task.status in {"done", "cancelled"},
        )
    event = owned(db, Event, ref.id, user)
    view = event_view(db, event)
    override = instance_override(db, event)
    policy = view.parallel_policy_override
    source = f"event:{event.id}"
    revision = override.policy_revision if override else event.policy_revision
    if policy is None:
        course = (
            db.get(Course, event.course_id) if event.course_id and event.kind == "course" else None
        )
        policy = course.parallel_policy if course else "none"
        source = f"course:{course.id}" if course else f"default:event:{event.id}"
        revision = course.policy_revision if course else 0
    return Activity(
        ref,
        event.course_id if event.kind == "course" else None,
        None,
        policy,
        source,
        revision,
        skipped=view.is_skipped,
    )


def validate_selector(db: Session, user: User, selector: Selector) -> None:
    if selector.scope == "task":
        owned(db, Task, selector.key, user)
    elif selector.scope == "event":
        owned(db, Event, selector.key, user)
    elif selector.scope == "course":
        owned(db, Course, selector.key, user)


def matches(scope: str, key: str, act: Activity) -> bool:
    if scope == "all":
        return True
    if scope in {"event", "task"}:
        return scope == act.ref.kind and key == act.ref.id
    if scope == "course":
        return act.ref.kind == "event" and key == act.course_id
    return act.ref.kind == "task" and key == act.task_type


def matching_rules(
    db: Session, user: User, a: Activity, b: Activity, exclude: str | None = None
) -> list[CompatibilityRule]:
    result = []
    for rule in db.scalars(
        select(CompatibilityRule).where(
            CompatibilityRule.workspace_id == user.workspace_id,
            CompatibilityRule.status == "confirmed",
            CompatibilityRule.origin == "user_explicit",
        )
    ):
        if rule.id == exclude:
            continue
        if (
            matches(rule.left_scope, rule.left_key, a)
            and matches(rule.right_scope, rule.right_key, b)
            or matches(rule.left_scope, rule.left_key, b)
            and matches(rule.right_scope, rule.right_key, a)
        ):
            result.append(rule)
    return result


def specificity(rule: CompatibilityRule) -> int:
    if rule.left_scope in {"task", "event"} and rule.right_scope in {"task", "event"}:
        return 400
    scores = {"event": 3, "task": 3, "course": 2, "task_type": 1, "all": 0}
    return (100 if "all" in {rule.left_scope, rule.right_scope} else 200) + (
        scores[rule.left_scope] + scores[rule.right_scope]
    )


def blockers(a: Activity, b: Activity, rules: list[CompatibilityRule]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = [
        {"rule": r.id, "revision": r.revision} for r in rules if r.decision == "deny"
    ]
    items.extend(
        {"policy": x.policy_source, "revision": x.policy_revision}
        for x in (a, b)
        if x.policy == "none"
    )
    return sorted(items, key=lambda x: str(sorted(x.items())))


def prepare_rule(
    db: Session, user: User, body: RuleInput, rule: CompatibilityRule | None = None
) -> CompatibilityRule:
    validate_selector(db, user, body.left)
    validate_selector(db, user, body.right)
    signature = None
    if body.override_conflicts:
        # Schema ensures these selectors name two concrete activities.
        a = activity(
            db, user, ActivityRef.model_validate({"kind": body.left.scope, "id": body.left.key})
        )
        b = activity(
            db, user, ActivityRef.model_validate({"kind": body.right.scope, "id": body.right.key})
        )
        signature = fingerprint(
            blockers(a, b, matching_rules(db, user, a, b, rule.id if rule else None))
        )
    if rule is None:
        rule = CompatibilityRule(workspace_id=user.workspace_id, revision=1)
        db.add(rule)
    else:
        rule.revision += 1
    rule.left_scope, rule.left_key = body.left.scope, body.left.key
    rule.right_scope, rule.right_key = body.right.scope, body.right.key
    rule.decision, rule.origin, rule.status = body.decision, "user_explicit", "confirmed"
    rule.override_signature = signature
    return rule


def rule_view(rule: CompatibilityRule) -> RuleOut:
    return RuleOut.model_validate(
        {
            "id": rule.id,
            "left": {"scope": rule.left_scope, "key": rule.left_key},
            "right": {"scope": rule.right_scope, "key": rule.right_key},
            "decision": rule.decision,
            "origin": rule.origin,
            "status": rule.status,
            "revision": rule.revision,
            "updated_at": rule.updated_at,
            "override_conflicts": rule.override_signature is not None,
        }
    )


def evaluate_pair(
    db: Session, user: User, a: Activity, b: Activity, edges: dict[str, list[str]]
) -> PairResult:
    result = PairResult(
        left=a.ref,
        right=b.ref,
        allowed=False,
        reason="",
        policy_sources=[a.policy_source, b.policy_source],
    )
    if a.unavailable or b.unavailable:
        result.reason = "已完成、已取消或垃圾箱中的任务不能参与新的并行安排"
        return result
    if a.skipped or b.skipped:
        result.allowed, result.reason = True, "本次课程已明确跳过，不占用个人时间；课程原记录保留"
        return result
    if a.ref.kind == b.ref.kind == "task" and (
        path_between(edges, a.ref.id, b.ref.id) or path_between(edges, b.ref.id, a.ref.id)
    ):
        result.reason = "两项任务存在直接或间接依赖，必须串行完成"
        return result
    rules = matching_rules(db, user, a, b)
    result.rule_ids = sorted(r.id for r in rules)
    if not rules:
        result.reason = "没有用户确认的组合允许规则，默认禁止重叠"
        return result
    top_rank = max(map(specificity, rules))
    top = [r for r in rules if specificity(r) == top_rank]
    if any(r.decision == "deny" for r in top):
        result.reason = "最具体的匹配规则禁止并行（同级允许/禁止冲突时先禁止）"
        return result
    restrictions = blockers(a, b, rules)
    if restrictions:
        if not any(
            specificity(r) == 400 and r.override_signature == fingerprint(restrictions) for r in top
        ):
            result.reason = (
                "存在单项禁止或较泛化的禁止规则；需要明确确认本次组合覆盖，设置变化后须重新确认"
            )
            return result
    result.allowed = True
    result.reason = (
        "双方设置及用户确认的组合规则允许并行"
        if not restrictions
        else "用户明确确认本次具体组合覆盖当前禁止设置"
    )
    return result


def check_compatibility(db: Session, user: User, refs: list[ActivityRef]) -> CompatibilityOut:
    activities = [activity(db, user, ref) for ref in refs]
    edges = graph(db, user)
    pairs = [evaluate_pair(db, user, a, b, edges) for a, b in combinations(activities, 2)]
    return CompatibilityOut(allowed=all(p.allowed for p in pairs), pairs=pairs)
