# Name the SPA, API, and database

Research for [Name the SPA, API, and database](https://github.com/marcus-bailey/wolog/issues/2).

Question: which SPA framework, JSON API host, and relational database should the spec name for a single-user app shipped as Docker images on a home Kubernetes cluster?

Locked constraints: desktop-first responsive web; SPA + JSON API + relational database; one human on a private LAN; no product auth. Prefer boring, well-documented defaults one person can operate.

## Recommendation

**React (TypeScript) + Vite**, **FastAPI**, **PostgreSQL**.

Three images in the cluster: the compiled SPA (static files behind any static web server), the FastAPI process, and the official PostgreSQL image. The database is the only stateful workload and must sit on a PersistentVolume.

This trio matches the already-locked shape (SPA talks JSON to an API that talks SQL) without dragging in a second application server or a document store.

## Why this trio

### SPA: React + Vite

Vite is a build tool whose production command “bundles your code with Rolldown, pre-configured to output highly optimized static assets.” The default output is a `dist` folder you “may deploy … to any of your preferred platforms.” `vite preview` is explicitly “intended for previewing the build locally and not meant as a production server.” ([Vite Getting Started](https://vite.dev/guide/); [Deploying a Static Site](https://vite.dev/guide/static-deploy))

React’s own “start a new project” page recommends full-stack frameworks first, and says those frameworks “do not require a server” because they also support CSR / SPA / SSG. It also documents building from scratch with Vite when existing frameworks are a poor fit. ([Start a New React Project](https://react.dev/learn/start-a-new-react-project); [Build a React App from Scratch](https://react.dev/learn/build-a-react-app-from-scratch), including `npm create vite@latest my-app -- --template react-ts`)

Wolog already chose a **separate** JSON API. A Vite React SPA is that choice in concrete tools: client-rendered UI, static `dist`, API elsewhere. Official React templates include `react-ts`, which keeps the spec aligned with the repo preference against implicit `any`.

Vite also documents pairing the build with a traditional backend via a manifest and injected script tags, so serving the SPA from the API image later is a documented option, not a hack. ([Backend Integration](https://vite.dev/guide/backend-integration))

### API: FastAPI

FastAPI is “a modern, fast (high-performance), web framework for building APIs with Python based on standard Python type hints,” “based on (and fully compatible with) the open standards for APIs: OpenAPI … and JSON Schema.” The homepage example is a JSON route. ([FastAPI](https://fastapi.tiangolo.com/))

Official Docker docs treat Kubernetes as a first-class target: “Using Kubernetes or similar tools”; “you will probably want to handle replication at the cluster level”; “a single (Uvicorn) process per container.” They also show combining “a database, a Python application, a web server with a React frontend application” as separate containers on the cluster network. ([FastAPI in Containers — Docker](https://fastapi.tiangolo.com/deployment/docker/))

SQL is officially supported via SQLModel (SQLAlchemy + Pydantic). The tutorial lists PostgreSQL among SQLAlchemy-supported engines and says “for your production application, you might want to use a database server like PostgreSQL.” ([SQL (Relational) Databases](https://fastapi.tiangolo.com/tutorial/sql-databases/))

If the SPA and API are separate origins in development (Vite on one port, API on another), FastAPI’s CORS middleware is the documented fix. ([CORS](https://fastapi.tiangolo.com/tutorial/cors/))

### Database: PostgreSQL

PostgreSQL is “a powerful, open source object-relational database system,” ACID-compliant since 2001, with WAL for crash recovery and point-in-time recovery. ([About PostgreSQL](https://www.postgresql.org/about/); [Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html))

FastAPI’s own Docker guide points at the official [PostgreSQL image on Docker Hub](https://hub.docker.com/_/postgres). That is the boring image for a home cluster.

## Kubernetes-shaped constraints the spec must mention

1. **Postgres is stateful.** Kubernetes PersistentVolumes have a lifecycle independent of any Pod. A PVC is how the Postgres Pod keeps its data across restarts. `hostPath` “WILL NOT WORK in a multi-node cluster”; prefer a real PV / StorageClass. Use a **Retain** reclaim policy for the home-lab volume so deleting a claim does not wipe training history. ([Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/))
2. **Three processes, not one image.** FastAPI’s Docker guide models database, API, and React frontend as separate containers. The SPA build is static files (`vite build` → `dist`). Postgres is its own official image. Do not put the database in the API container.
3. **One Uvicorn process per API replica.** On Kubernetes, FastAPI recommends cluster-level replication and a single process per container, not `--workers` inside the image. For a single-user home app, one API replica is enough.
4. **Migrations before serve.** FastAPI’s SQL tutorial creates tables on startup for the demo, then says “for production you would probably use a migration script that runs before you start your app” (Alembic). Spec that as an init container or a one-shot Job, not as implicit `create_all` in every replica.
5. **Same-origin in production is simpler.** CORS is required only when the browser origin of the SPA differs from the API. Serving `dist` from the API (FastAPI `StaticFiles`) or from one ingress host with path routing avoids that. Vite’s backend-integration guide covers the production-manifest case.

## Rejected alternatives

### Next.js as the SPA (or as the API)

Next.js is “a React framework for building **full-stack** web applications.” Static export (`output: 'export'`) exists, but official docs list a long set of unsupported features once you turn the Node server off (dynamic route handlers that read the request, cookies, rewrites, Server Actions, default `next/image`, …). ([Next.js Docs](https://nextjs.org/docs); [Static Exports](https://nextjs.org/docs/app/guides/static-exports))

The destination already named a **JSON API plus SPA**. Using Next.js as that SPA means either running a second Node server next to FastAPI, or accepting static-export limits. React+Vite is the smaller SPA.

### FastAPI + SQLite instead of PostgreSQL

SQLite’s own guidance: it “competes with `fopen()`,” not with client/server engines. It works well as an application file or a low-traffic website on one machine. It is a poorer fit when “the data is separated from the application by a network” or when many writers hit one file. FastAPI’s SQL tutorial uses SQLite for the copy-paste demo and points production at PostgreSQL. ([Appropriate Uses For SQLite](https://www.sqlite.org/whentouse.html); [FastAPI SQL databases](https://fastapi.tiangolo.com/tutorial/sql-databases/))

A Kubernetes API replica talking to a SQLite file on a volume is the “data on a separate device from the application” case SQLite warns about. Postgres is the client/server engine that matches “hosted remotely from the user’s computer,” even on a LAN.

### Document store

Already ruled out by the destination (relational). No further research.

### Go / Rails / Django as the API

Any of these can host JSON. They were not chosen because FastAPI is the documented, typed, Docker-and-Kubernetes-documented JSON API that pairs with SQLModel/PostgreSQL without introducing a second language into a one-person home deploy. This is a preference among boring options, not a claim those stacks cannot work.

## Spec one-liner

Name **React + Vite (TypeScript)**, **FastAPI**, and **PostgreSQL**; deploy as three containers; put Postgres on a retained PersistentVolume; run schema migrations before the API serves traffic.
