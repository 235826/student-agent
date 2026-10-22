import secrets
from datetime import datetime
from typing import Any

from argon2.exceptions import VerificationError
from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import select

from app.api.schemas import (
    AuthOut,
    CourseInput,
    CourseOut,
    Credentials,
    EventInput,
    EventOut,
    ProfileInput,
    ProfileOut,
    SetupInput,
    SetupStatus,
    TaskInput,
)
from app.db.models import Course, Event, User, Workspace, now_ms
from app.db.models import Session as LoginSession
from app.modules.calendar_management import event_view, update_event_record
from app.modules.event_types import ensure_system_types, resolve_event_type
from app.modules.records import owned, record_change
from app.modules.security import COOKIE, DB, SessionDep, UserDep, digest, hasher

router = APIRouter(prefix="/api/v1")


def login_response(user: User, request: Request, response: Response, db: DB) -> AuthOut:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    lifetime = request.app.state.settings.session_hours * 3600
    old_token = request.cookies.get(COOKIE)
    if old_token:
        old = db.scalar(select(LoginSession).where(LoginSession.token_hash == digest(old_token)))
        if old:
            db.delete(old)
    db.add(
        LoginSession(
            user_id=user.id,
            token_hash=digest(token),
            csrf_token=csrf,
            expires_at=now_ms() + lifetime * 1000,
        )
    )
    db.commit()
    response.set_cookie(
        COOKIE,
        token,
        max_age=lifetime,
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="strict",
    )
    return AuthOut(user=ProfileOut.model_validate(user), csrf_token=csrf)


@router.get("/auth/status", response_model=SetupStatus)
def setup_status(db: DB) -> SetupStatus:
    return SetupStatus(initialized=db.scalar(select(User.id)) is not None)


def create_account(db: DB, body: SetupInput) -> User:
    if db.scalar(select(User.id).where(User.username == body.username)):
        raise HTTPException(409, "用户名已存在")
    workspace = Workspace()
    db.add(workspace)
    db.flush()
    user = User(
        username=body.username,
        password_hash=hasher.hash(body.password),
        workspace_id=workspace.id,
        timezone=body.timezone,
    )
    db.add(user)
    db.flush()
    ensure_system_types(db, user)
    db.flush()
    return user


@router.post("/auth/setup", response_model=AuthOut, status_code=201)
def setup(body: SetupInput, request: Request, response: Response, db: DB) -> AuthOut:
    request.app.state.limiter.check(request.client.host if request.client else "unknown")
    if db.scalar(select(User.id)):
        raise HTTPException(409, "账号已初始化，请登录")
    user = create_account(db, body)
    return login_response(user, request, response, db)


@router.post("/auth/register", response_model=AuthOut, status_code=201)
def register(body: SetupInput, request: Request, response: Response, db: DB) -> AuthOut:
    request.app.state.limiter.check(request.client.host if request.client else "unknown")
    user = create_account(db, body)
    return login_response(user, request, response, db)


@router.post("/auth/login", response_model=AuthOut)
def login(body: Credentials, request: Request, response: Response, db: DB) -> AuthOut:
    request.app.state.limiter.check(request.client.host if request.client else "unknown")
    user = db.scalar(select(User).where(User.username == body.username))
    try:
        hasher.verify(user.password_hash if user else request.app.state.dummy_hash, body.password)
    except VerificationError:
        raise HTTPException(401, "用户名或密码错误") from None
    if user is None:
        raise HTTPException(401, "用户名或密码错误")
    return login_response(user, request, response, db)


@router.get("/auth/me", response_model=AuthOut)
def me(user: UserDep, session: SessionDep) -> AuthOut:
    return AuthOut(user=ProfileOut.model_validate(user), csrf_token=session.csrf_token)


@router.post("/auth/logout", status_code=204)
def logout(response: Response, db: DB, session: SessionDep) -> None:
    db.delete(session)
    db.commit()
    response.delete_cookie(COOKIE)


@router.get("/profile", response_model=ProfileOut)
def profile(user: UserDep) -> User:
    return user


@router.put("/profile", response_model=ProfileOut)
def update_profile(body: ProfileInput, db: DB, user: UserDep) -> User:
    for key, value in body.model_dump(mode="json").items():
        setattr(user, key, value)
    record_change(db, user, "profile.update", user)
    return user


def values(body: TaskInput | EventInput) -> dict[str, Any]:
    data = body.model_dump(exclude={"note_scope", "details_scope"})
    for key, value in data.items():
        if isinstance(value, datetime):
            data[key] = int(value.timestamp() * 1000)
    return data


@router.get("/courses", response_model=list[CourseOut])
def list_courses(db: DB, user: UserDep) -> list[Course]:
    return list(db.scalars(select(Course).where(Course.workspace_id == user.workspace_id)))


@router.post("/courses", response_model=CourseOut, status_code=201)
def create_course(body: CourseInput, db: DB, user: UserDep) -> Course:
    course = Course(workspace_id=user.workspace_id, **body.model_dump())
    db.add(course)
    record_change(db, user, "course.create", course)
    return course


@router.get("/events", response_model=list[EventOut])
def list_events(db: DB, user: UserDep) -> list[EventOut]:
    return [
        event_view(db, e)
        for e in db.scalars(
            select(Event)
            .where(Event.workspace_id == user.workspace_id)
            .order_by(Event.start_at, Event.id)
        )
    ]


@router.post("/events", response_model=EventOut, status_code=201)
def create_event(body: EventInput, db: DB, user: UserDep) -> EventOut:
    if body.course_id:
        owned(db, Course, body.course_id, user)
    event_type = resolve_event_type(db, user, kind=body.kind, event_type_id=body.event_type_id)
    data = values(body)
    data["event_type_id"] = event_type.id if event_type else None
    event = Event(workspace_id=user.workspace_id, **data)
    db.add(event)
    record_change(db, user, "event.create", event)
    return event_view(db, event)


@router.put("/events/{event_id}", response_model=EventOut)
def update_event(event_id: str, body: EventInput, db: DB, user: UserDep) -> EventOut:
    event = owned(db, Event, event_id, user)
    update_event_record(db, user, event, body)
    return event_view(db, event)
