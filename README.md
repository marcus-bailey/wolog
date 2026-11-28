# Wolog

A single-user workout tracker: Routines, an Exercise library, and dated Sessions of Sets. What it does is in [`docs/spec.md`](docs/spec.md); the words it uses are in [`CONTEXT.md`](CONTEXT.md).

It runs at `https://apps.marcusbailey.com/wolog/` on the apps server ([`marcus-bailey/apps-server`](https://github.com/marcus-bailey/apps-server)), behind that server's login (spec §8).

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

## Deploying to AWS

CI builds both production images for every commit on main and pushes them to GitHub's container
registry as `ghcr.io/marcus-bailey/wolog-{frontend,backend}:sha-<commit>`, keeping the newest 20
(pull requests build them too, without pushing).
The server pulls them; it never builds. On the server they run as the compose project `wolog`
(`docker-compose.aws.yml`, copied to `/srv/wolog/compose.yml`): `wolog-frontend` (nginx, read-only)
and `wolog-backend` (migrations, then one Uvicorn process), on the server's `apps-edge` network
(and `apps-db` for the API), publishing no port. The nginx routes live in apps-server
(`server/nginx/locations/wolog.inc`); Postgres and its backups are the server's too.

### Updates and rollback

After merging, once CI has passed on main, from the Mac:

```sh
deploy/aws/deploy.sh             # main's latest commit
deploy/aws/deploy.sh 1a2b3c4     # a particular commit, e.g. to roll back
```

It copies the compose file to the server, pulls that commit's images, starts them, waits for both
containers to be healthy and prints their status. Only a healthy release is recorded in
`/srv/wolog/.env` (`WOLOG_TAG`); if it isn't healthy, the script says so and names the release to
roll back to. Migrations run when the API starts and don't
undo: rolling back past a migration needs a restore (below) or a hand-written fix.

### First time

One-off setup on the server (`ssh admin@apps.marcusbailey.com`):

```sh
# The database and its user, in the shared Postgres. Hex, because the password goes into a URL.
PW=$(openssl rand -hex 24)
docker exec -i apps-postgres psql -U postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE wolog LOGIN PASSWORD '$PW'" -c "CREATE DATABASE wolog OWNER wolog"
sudo install -d -o admin -g admin /srv/wolog
(umask 077; echo "POSTGRES_PASSWORD=$PW" > /srv/wolog/.env); unset PW
```

The server is already logged in to GitHub's registry for the other apps; if a pull is refused,
make a classic token with only `read:packages` and run `docker login ghcr.io -u marcus-bailey`.

Then `deploy/aws/deploy.sh` from the Mac, and open https://apps.marcusbailey.com/wolog/.
`.env.example` lists what `/srv/wolog/.env` holds.

### Handy commands (on the server)

```sh
cd /srv/wolog && docker compose ps                         # status
docker logs -f wolog-backend                               # API logs (migrations first)
docker exec -it apps-postgres psql -U postgres -d wolog    # SQL shell
```

### Restore drill

Backups belong to the apps server: its nightly job dumps every database, `wolog` included, to S3
(spec §9). Run this drill at first deploy and **after every Postgres major-version upgrade** of
`apps-postgres`: it proves a dump made by that Postgres restores.

```sh
# 1. A backup now (on the server); note the stamp it prints
ssh admin@apps.marcusbailey.com docker exec apps-backup backup.sh now

# 2. Its wolog dump (on the Mac, after `aws login`)
aws s3 ls s3://apps-server-backups-709987962479/<stamp>/          # wolog.dump is listed
aws s3 cp s3://apps-server-backups-709987962479/<stamp>/wolog.dump .

# 3. Restore it into a scratch database owned by wolog (as a real swap needs), and check the
#    latest Session is there
ssh admin@apps.marcusbailey.com 'docker exec apps-postgres createdb -U postgres -O wolog wolog_restored'
ssh admin@apps.marcusbailey.com 'docker exec -i apps-postgres pg_restore -U postgres -d wolog_restored --no-owner --role=wolog' < wolog.dump
ssh admin@apps.marcusbailey.com "docker exec apps-postgres psql -U postgres -d wolog_restored \
  -c 'select id, date, routine_id, day_id from session order by date desc limit 1'"
ssh admin@apps.marcusbailey.com "docker exec apps-postgres psql -U postgres -d wolog \
  -c 'select id, date, routine_id, day_id from session order by date desc limit 1'"   # the same row

# 4. Clean up, so the scratch copy isn't backed up too
ssh admin@apps.marcusbailey.com 'docker exec apps-postgres dropdb -U postgres wolog_restored'
rm wolog.dump
```

To restore for real, follow apps-server's README ("Restoring a backup"), restoring as in step 3
so the tables belong to `wolog` (with only `--no-owner` they'd belong to `postgres`, and the API
couldn't read them). Check it, then swap it in with the API stopped:

```sh
cd /srv/wolog && docker compose stop wolog-backend
docker exec apps-postgres psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER DATABASE wolog RENAME TO wolog_old' -c 'ALTER DATABASE wolog_restored RENAME TO wolog'
docker compose start wolog-backend      # drop wolog_old once all is well
```

Drills passed:

| Date | Postgres | Backup stamp | Latest Session |
| ---- | -------- | ------------ | -------------- |
| 2026-11-28 | 17.12 | `2026-11-28T0610` | id 1, 2026-11-28 |

## Dependencies

Only versions at least two weeks old, as for the apps server's images: `backend/pyproject.toml` sets uv's `exclude-newer = "2 weeks"`, and for npm pass `--before=<date two weeks ago>` when adding or upgrading a package. Generate npm lockfile changes in a Linux container too (`docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine npm install --package-lock-only …`), or `npm ci` in Docker misses Linux-only optional packages.
