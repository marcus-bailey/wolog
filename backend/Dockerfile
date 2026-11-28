# development: docker-compose.yml runs the API with the source mounted and --reload.
# production: the image CI pushes for the apps server (docker-compose.aws.yml).
FROM python:3.13-slim AS development
COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /bin/uv
ENV UV_PROJECT_ENVIRONMENT=/venv UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project
COPY . .
RUN uv sync --frozen
EXPOSE 8000
# Migrations first, then serve (spec §8).
CMD ["sh", "-c", "uv run --frozen alembic upgrade head && uv run --frozen uvicorn wolog.main:app --host 0.0.0.0 --port 8000 --reload"]

# The API and its dependencies, installed (not editable) into /venv; no dev tools.
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /bin/uv
ENV UV_PROJECT_ENVIRONMENT=/venv UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY wolog ./wolog
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim AS production
ENV PATH=/venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN useradd --system --no-create-home --uid 10001 wolog
COPY --from=build /venv /venv
WORKDIR /app
COPY alembic.ini ./
COPY migrations ./migrations
USER wolog
EXPOSE 8000
# Healthy only when the database answers (wolog/health.py).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
# Migrations first, then one Uvicorn process (spec §8). exec: Uvicorn gets Docker's stop signal.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn wolog.main:app --host 0.0.0.0 --port 8000"]
