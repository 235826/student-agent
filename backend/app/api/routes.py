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
    TaskOut,
)
from app.db.models import Course, Event, Task, User, Workspace, now_ms
from app.db.models import Session as LoginSession
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


@router.post("/auth/setup", response_model=AuthOut, status_code=201)
def setup(body: SetupInput, request: Request, response: Response, db: DB) -> AuthOut:
    request.app.state.limiter.check(request.client.host if request.client else "unknown")
    # Serialize first-account creation; the unique singleton also enforces this in the schema.
    db.connection().exec_driver_sql("BEGIN IMMEDIATE")
    if db.scalar(select(User.id)):
        raise HTTPException(409, "账号已初始化，请登录")
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
    data = body.model_dump()
    for key, value in data.items():
        if isinstance(value, datetime):
            data[key] = int(value.timestamp() * 1000)
    return data


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(db: DB, user: UserDep, trashed: bool = False) -> list[Task]:
    query = select(Task).where(Task.workspace_id == user.workspace_id)
    query = query.where(Task.trashed_at.is_not(None) if trashed else Task.trashed_at.is_(None))
    return list(db.scalars(query.order_by(Task.created_at.desc(), Task.id)))


@router.post("/tasks", response_model=TaskOut, status_code=201)
def create_task(body: TaskInput, db: DB, user: UserDep) -> Task:
    task = Task(workspace_id=user.workspace_id, **values(body))
    db.add(task)
    record_change(db, user, "task.create", task)
    return task


@router.put("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, body: TaskInput, db: DB, user: UserDep) -> Task:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is not None:
        raise HTTPException(409, "请先恢复垃圾箱中的任务")
    for key, value in values(body).items():
        setattr(task, key, value)
    record_change(db, user, "task.update", task)
    return task


@router.post("/tasks/{task_id}/trash", response_model=TaskOut)
def trash_task(task_id: str, db: DB, user: UserDep) -> Task:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is None:
        task.trashed_at = now_ms()
        record_change(db, user, "task.trash", task)
    return task


@router.post("/tasks/{task_id}/restore", response_model=TaskOut)
def restore_task(task_id: str, db: DB, user: UserDep) -> Task:
    task = owned(db, Task, task_id, user)
    if task.trashed_at is not None:
        task.trashed_at = None
        record_change(db, user, "task.restore", task)
    return task


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
def list_events(db: DB, user: UserDep) -> list[Event]:
    return list(
        db.scalars(
            select(Event)
            .where(Event.workspace_id == user.workspace_id)
            .order_by(Event.start_at, Event.id)
        )
    )


@router.post("/events", response_model=EventOut, status_code=201)
def create_event(body: EventInput, db: DB, user: UserDep) -> Event:
    if body.course_id:
        owned(db, Course, body.course_id, user)
    event = Event(workspace_id=user.workspace_id, **values(body))
    db.add(event)
    record_change(db, user, "event.create", event)
    return event


@router.put("/events/{event_id}", response_model=EventOut)
def update_event(event_id: str, body: EventInput, db: DB, user: UserDep) -> Event:
    event = owned(db, Event, event_id, user)
    if body.course_id:
        owned(db, Course, body.course_id, user)
    for key, value in values(body).items():
        setattr(event, key, value)
    # A direct user edit is allowed; locked prevents future scheduler movement.
    record_change(db, user, "event.update", event)
    return event
