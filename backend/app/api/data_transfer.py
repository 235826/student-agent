from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.api.schemas import DataImportPreview
from app.modules.data_transfer import export_payload, validate_payload
from app.modules.security import DB, UserDep

router = APIRouter(prefix="/api/v1/data", tags=["data"])


@router.get("/export")
def export_data(db: DB, user: UserDep) -> JSONResponse:
    payload = export_payload(db, user)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return JSONResponse(
        content=payload,
        headers={
            "Content-Disposition": f'attachment; filename="student-agent-{stamp}.json"',
        },
    )


@router.post("/import/validate", response_model=DataImportPreview)
def validate_import(body: dict[str, Any], db: DB, user: UserDep) -> DataImportPreview:
    try:
        return validate_payload(db, user, body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
