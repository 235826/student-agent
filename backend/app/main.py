import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.event_types import router as event_types_router
from app.api.imports import router as imports_router
from app.api.planning_foundation import router as planning_router
from app.api.routes import router
from app.api.scheduling import router as scheduling_router
from app.api.schemas import ErrorOut, Health
from app.config import Settings
from app.db.session import build_engine
from app.modules.security import LoginLimiter, hasher

logger = logging.getLogger("student_agent")
if not logger.handlers:
    logger.addHandler(logging.StreamHandler())
logger.setLevel(logging.INFO)
logger.propagate = False


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or Settings()
    app = FastAPI(
        title="Student Agent",
        version="0.1.0",
        responses={code: {"model": ErrorOut} for code in (401, 403, 404, 409, 422, 429, 503)},
    )
    app.state.settings = config
    app.state.engine = build_engine(config.database_url)
    app.state.limiter = LoginLimiter()
    app.state.dummy_hash = hasher.hash(secrets.token_urlsafe(24))

    def error(
        request: Request,
        status: int,
        code: str,
        message: str,
        errors: list[dict[str, object]] | None = None,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status,
            content={
                "code": code,
                "message": message,
                "request_id": request.state.request_id,
                "errors": errors,
            },
        )

    @app.middleware("http")
    async def boundary(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request.state.request_id = str(uuid4())
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("origin") not in config.allowed_origins:
                return error(request, 403, "origin_rejected", "请求来源不受信任")
        try:
            response = await call_next(request)
        except Exception:
            # Avoid exception messages, payloads and headers which may contain private data.
            logger.error(json.dumps({"request_id": request.state.request_id, "event": "unhandled"}))
            response = error(request, 500, "internal_error", "服务暂时出错，请重试")
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        logger.info(
            json.dumps(
                {
                    "request_id": request.state.request_id,
                    "method": request.method,
                    "status": response.status_code,
                }
            )
        )
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return error(request, exc.status_code, f"http_{exc.status_code}", str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        issues = [
            {"loc": list(e["loc"]), "message": e["msg"], "type": e["type"]} for e in exc.errors()
        ]
        return error(request, 422, "validation_error", "请检查输入内容", issues)

    @app.exception_handler(IntegrityError)
    async def integrity_error(request: Request, _: IntegrityError) -> JSONResponse:
        return error(request, 409, "conflict", "数据冲突，操作未保存，请刷新后重试")

    @app.exception_handler(OperationalError)
    async def database_error(request: Request, _: OperationalError) -> JSONResponse:
        return error(request, 503, "database_unavailable", "数据库暂不可用，请稍后重试")

    @app.get("/health/live", response_model=Health)
    def live() -> Health:
        return Health(status="ok")

    @app.get("/health/ready", response_model=Health)
    def ready() -> Health:
        try:
            with app.state.engine.connect() as connection:
                version = connection.scalar(text("SELECT version_num FROM alembic_version"))
                if version != "0008":
                    raise HTTPException(503, "数据库版本不匹配，请执行迁移")
        except OperationalError:
            raise HTTPException(503, "数据库尚未就绪，请执行迁移") from None
        return Health(status="ready")

    app.include_router(router)
    app.include_router(event_types_router)
    app.include_router(imports_router)
    app.include_router(planning_router)
    app.include_router(scheduling_router)
    return app
