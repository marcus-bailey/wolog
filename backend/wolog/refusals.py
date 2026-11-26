"""Refusals: every refused action answers with a plain message saying why (spec §7)."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class RefusalBody(BaseModel):
    """What the API answers when it refuses an action."""

    code: str
    message: str


class Refusal(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def install(app: FastAPI) -> None:
    async def handle(_: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, Refusal)
        body = RefusalBody(code=exc.code, message=exc.message)
        return JSONResponse(status_code=exc.status, content=body.model_dump())

    app.add_exception_handler(Refusal, handle)
