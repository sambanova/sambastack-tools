# SambaEval deploy contract (frozen interface for the Helm/deploy stream)

This is the env/port/service contract the app is built against. Do not change
app code; build the packaging around these facts.

## Services & commands
- **api** — FastAPI. Command: `sambaeval-server --host 0.0.0.0 --port 8000`. Port **8000**.
  Console script defined in `backend/pyproject.toml` (`sambaeval-server = "sambaeval.api:serve"`).
  Runs `alembic upgrade head` on boot in prod (or via a migration Job — see §6).
- **worker** — decoupled run executor. Command: `sambaeval-worker` (console script
  `sambaeval-worker = "sambaeval.worker:main"`, added by the backend stream). No port.
- **frontend** — Next.js. Dev command: `npm run dev` (port **3001**). Prod: `npm run build && npm start`.
  Reads `NEXT_PUBLIC_API_BASE_URL` (e.g. `http://localhost:8000`, or same-origin `/api` behind ingress).
- **postgres** — Postgres 16. **minio** — S3 object store (bucket `sambaeval`).

## Environment variables (read by `backend/sambaeval/config.py`)
```
SAMBAEVAL_ENV=local|prod
SAMBAEVAL_STORAGE_BACKEND=db          # default db
DATABASE_URL=postgresql+psycopg://user:pass@host:port/db
AUTH_BACKEND=dev|google               # local uses dev
DEV_USER_EMAIL, DEV_USER_NAME
ALLOWED_DOMAINS=sambanovasystems.com,sambanova.ai
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URL
SESSION_SECRET                        # session cookie signing
CREDS_KEY                             # Fernet key for provider-key encryption
ADMIN_EMAILS=comma,list
S3_ENDPOINT_URL, S3_BUCKET=sambaeval, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION
FRONTEND_ORIGIN=http://localhost:3001
MAX_CONCURRENT_RUNS_PER_USER=4
MAX_UPLOAD_BYTES=52428800
FIXTURE_CACHE_DIR=/var/cache/sambaeval/fixtures   # local cache for s3 fixtures/
                                      # (worker only; mounted volume in-cluster)
SANDBOX_ENABLED=0                     # deferred for PoV (no gVisor on RKE2)
                                      # gates generators with requires_sandbox;
                                      # enforced by the API at run-enqueue
SANDBOX_BACKEND=podman|subprocess|k8s_job   # read by the generator scripts;
                                      # k8s_job is reserved, not implemented
```

## Local port map (Mode A, already used by deploy/local/docker-compose.infra.yml)
- postgres host **5433** -> container 5432
- minio S3 host **9100** -> container 9000; console host **9101** -> 9001
- api **8000**, frontend **3001**

## Repo layout
- backend at `sambaeval/backend` (installable: `pip install -e .[server]`).
- frontend (Next.js) at `sambaeval/` root (`package.json`, `app/`).
- alembic at `sambaeval/backend/alembic` (`alembic.ini` beside it); migrate with
  `cd backend && alembic upgrade head` (reads DATABASE_URL from env).
- generator scripts baked from `sambaeval/scripts/generators`.
