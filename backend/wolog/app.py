"""The Wolog API. It answers on /api/... and /health; in production the apps server's nginx
strips the /wolog/ prefix before requests arrive here (spec §8)."""

from fastapi import FastAPI
from sqlalchemy import Engine

from wolog import days, exercises, health, history, last_time, refusals, rotation, routines, sessions, today
from wolog.db import database_url, make_engine


def create_app(engine: Engine | None = None) -> FastAPI:
    app = FastAPI(title="Wolog", openapi_url="/api/openapi.json", docs_url="/api/docs", redoc_url=None)
    app.state.engine = engine if engine is not None else make_engine(database_url())
    refusals.install(app)
    app.include_router(health.router)
    app.include_router(exercises.router)
    app.include_router(routines.router)
    app.include_router(days.router)
    app.include_router(rotation.router)
    app.include_router(today.router)
    app.include_router(sessions.router)
    app.include_router(last_time.router)
    app.include_router(history.router)
    return app
