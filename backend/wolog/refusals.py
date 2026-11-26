"""Refusals: every refused action answers with a plain message saying why (spec §7)."""

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class RefusalBody(BaseModel):
    """What the API answers when it refuses an action."""

    code: str
    message: str


def documented(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """The refusals a route can answer with, for the OpenAPI schema. Every one has the RefusalBody shape."""
    return {s: {"model": RefusalBody} for s in statuses}


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

    async def handle_invalid(_: Request, exc: Exception) -> JSONResponse:
        """A request the API can't read (a malformed id or body) is refused in the same shape."""
        assert isinstance(exc, RequestValidationError)
        errors = exc.errors()
        detail = ""
        if errors:
            first = errors[0]
            # Name the field (body.name -> "name"); skip list indexes, which mean nothing to a reader.
            where = ".".join(part for part in first["loc"][1:] if isinstance(part, str))
            detail = f" {where}: {first['msg']}." if where else f" {first['msg']}."
        body = RefusalBody(code="invalid_request", message=f"That request isn’t valid.{detail}")
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content=body.model_dump())

    app.add_exception_handler(Refusal, handle)
    app.add_exception_handler(RequestValidationError, handle_invalid)
