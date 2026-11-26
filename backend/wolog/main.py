"""Entry point for Uvicorn: `uvicorn wolog.main:app`. Migrations run before this (see README)."""

from wolog.app import create_app

app = create_app()
