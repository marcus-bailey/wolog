# Wolog

A single-user workout tracker: Routines, an Exercise library, and dated Sessions of Sets. What it does is in [`docs/spec.md`](docs/spec.md); the words it uses are in [`CONTEXT.md`](CONTEXT.md).

It will run at `https://apps.marcusbailey.com/wolog/` on the apps server, behind that server's login (spec §8).

- **SPA:** React + TypeScript, built with Vite (`frontend/`)
- **API:** FastAPI on Python 3.13, SQLAlchemy, Alembic migrations (`backend/`)
- **Database:** PostgreSQL 17

```
Browser ──► /wolog/        ──► SPA
            /wolog/api/    ──► API ──► Postgres
            /wolog/health  ──► API
```

The app lives under `/wolog/`. The API itself answers on `/api/...` and `/health`; in production the apps server's nginx strips the prefix, and in development Vite's dev server does.

## Local development

Requires Docker. One command starts Postgres, the API (migrations first, then Uvicorn with reload) and Vite's dev server, with the source mounted:

```sh
docker compose up -d
```

Then open http://localhost:5173/wolog/. The API's OpenAPI docs are at http://localhost:8000/api/docs. Everything listens on 127.0.0.1 only.

There's no login in development, so the API never answers `401`. On the apps server, a `401` sends the browser to `/oauth2/start` and back to the same page, at most three times in two minutes.

To work outside Docker, you also need [uv](https://docs.astral.sh/uv/) and Node 24 (`.nvmrc`):

```sh
docker compose up -d postgres
cd backend && DATABASE_URL=postgresql+psycopg://wolog:wolog@localhost:5462/wolog \
  sh -c 'uv run alembic upgrade head && uv run uvicorn wolog.main:app --reload'
cd frontend && npm install && npm run dev
```

## Tests

The API tests run against a real Postgres, building a fresh `wolog_test` database from the migrations. Start the compose Postgres first:

```sh
docker compose up -d postgres
(cd backend && uv run pytest)
(cd frontend && npm test)
```

| Where      | Command                                          | What it does                                   |
| ---------- | ------------------------------------------------ | ---------------------------------------------- |
| `backend`  | `uv run pytest`                                  | API tests (set `TEST_DATABASE_URL` to change DB) |
| `backend`  | `uv run ruff check . && uv run ruff format .`    | Lint and format                                |
| `backend`  | `uv run mypy`                                    | Type check (strict)                            |
| `backend`  | `uv run alembic revision -m "…"`                 | New migration in `migrations/versions/`        |
| `frontend` | `npm test`                                       | Unit and component tests (Vitest)              |
| `frontend` | `npm run lint` / `npm run typecheck`             | ESLint / TypeScript (strict, no implicit `any`)|
| `frontend` | `npm run build`                                  | Production build for `/wolog/`                 |

CI (`.github/workflows/ci.yml`) runs all of these on every pull request and on main.

## Dependencies

Only versions at least two weeks old, as for the apps server's images: `backend/pyproject.toml` sets uv's `exclude-newer = "2 weeks"`, and for npm pass `--before=<date two weeks ago>` when adding or upgrading a package. Generate npm lockfile changes in a Linux container too (`docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine npm install --package-lock-only …`), or `npm ci` in Docker misses Linux-only optional packages.
