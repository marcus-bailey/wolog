# development: docker-compose.yml runs the API with the source mounted and --reload.
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
