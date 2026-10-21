from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.api.schemas import AdoptPlan, PlanInput, PlanOut
from app.db.models import Plan
from app.modules.records import owned, record_change
from app.modules.scheduling import current_plan, generate, view
from app.modules.security import DB, UserDep

router = APIRouter(prefix="/api/v1/plans")


@router.get("", response_model=list[PlanOut])
def list_plans(db: DB, user: UserDep) -> list[PlanOut]:
    plans = db.scalars(
        select(Plan)
        .where(Plan.workspace_id == user.workspace_id)
        .order_by(Plan.created_at.desc(), Plan.id)
    )
    return [view(db, user, p) for p in plans]


@router.get("/current", response_model=PlanOut | None)
def current(db: DB, user: UserDep) -> PlanOut | None:
    plan = current_plan(db, user)
    return view(db, user, plan) if plan else None


@router.post("", response_model=PlanOut, status_code=201)
def create(body: PlanInput, db: DB, user: UserDep) -> PlanOut:
    return view(db, user, generate(db, user, body))


@router.post("/{plan_id}/adopt", response_model=PlanOut)
def adopt(plan_id: str, body: AdoptPlan, db: DB, user: UserDep) -> PlanOut:
    plan = owned(db, Plan, plan_id, user)
    if plan.status == "adopted":
        return view(db, user, plan)
    if plan.status != "draft" or view(db, user, plan).stale:
        raise HTTPException(409, "计划已过期或不再是草稿，请根据最新数据重新生成")
    previous = current_plan(db, user)
    if previous:
        previous.status = "superseded"
        db.flush()
    plan.status = "adopted"
    record_change(db, user, "plan.adopt", plan, scheduling=False)
    return view(db, user, plan)
