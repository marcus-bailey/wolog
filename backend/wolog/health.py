"""Health: healthy only when the database answers."""

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import Engine, text
from sqlalchemy.exc import SQLAlchemyError

router = APIRouter(tags=["health"])


class Health(BaseModel):
    status: str


@router.get("/health", responses={503: {"model": Health}})
def health(request: Request, response: Response) -> Health:
    engine: Engine = request.app.state.engine
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
    except SQLAlchemyError:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return Health(status="unavailable")
    return Health(status="ok")
