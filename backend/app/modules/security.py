import hashlib
import secrets
from collections import defaultdict, deque
from threading import Lock
from time import monotonic
from typing import Annotated

from argon2 import PasswordHasher
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Session as LoginSession
from app.db.models import User, now_ms
from app.db.session import get_db

DB = Annotated[Session, Depends(get_db)]
hasher = PasswordHasher()
COOKIE = "student_session"


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class LoginLimiter:
    def __init__(self) -> None:
        self.attempts: dict[str, deque[float]] = defaultdict(deque)
        self.lock = Lock()

    def check(self, key: str) -> None:
        now = monotonic()
        with self.lock:
            for address in list(self.attempts):
                times = self.attempts[address]
                while times and times[0] < now - 300:
                    times.popleft()
                if not times:
                    del self.attempts[address]
            times = self.attempts[key]
            if len(times) >= 10:
                raise HTTPException(429, "尝试次数过多，请五分钟后重试")
            times.append(now)


def current_session(request: Request, db: DB) -> LoginSession:
    token = request.cookies.get(COOKIE, "")
    session = db.scalar(select(LoginSession).where(LoginSession.token_hash == digest(token)))
    if not session or session.expires_at <= now_ms():
        raise HTTPException(401, "请先登录")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        if not secrets.compare_digest(request.headers.get("X-CSRF-Token", ""), session.csrf_token):
            raise HTTPException(403, "请求校验失败，请刷新后重试")
    return session


SessionDep = Annotated[LoginSession, Depends(current_session)]


def current_user(db: DB, session: SessionDep) -> User:
    user = db.get(User, session.user_id)
    if not user:
        raise HTTPException(401, "账号不存在")
    return user


UserDep = Annotated[User, Depends(current_user)]
