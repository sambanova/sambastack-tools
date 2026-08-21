# SambaEval backend image — runs BOTH the api (`sambaeval-server`) and the
# worker (`sambaeval-worker`); the command is overridden per deployment.
#
# IMPORTANT build context: this Dockerfile must be built from the *product root*
# (`sambaeval/`), NOT from `backend/`, because the app resolves the generator
# scripts (`scripts/generators/`), the pricing defaults (`data/pricing_defaults.json`)
# and `VERSION` by walking up from the installed package source
# (`generators.py` / `paths.py` use `Path(__file__).parents[2]`). Keeping the
# on-disk layout `/app/backend/sambaeval` + `/app/scripts` + `/app/data` intact
# is what makes those lookups work, so we install the package **editable**.
#
#   docker build -f backend/Dockerfile -t sambaeval-backend:local .
#
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Build toolchain for any sdist-only wheels (scipy/h5py/psycopg build fallbacks).
# Kept in the single stage for a correct-by-default internal PoV image; slim it
# with a multi-stage build later if size matters.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the pieces the app needs at their expected repo-relative locations.
COPY backend/ /app/backend/
COPY scripts/ /app/scripts/
COPY data/pricing_defaults.json /app/data/pricing_defaults.json
COPY VERSION /app/VERSION

# Editable install keeps `sambaeval` at /app/backend/sambaeval so parents[2]
# resolution finds /app/scripts and /app/data (see header). `[server]` adds the
# FastAPI/uvicorn/authlib stack for both the api and the worker.
RUN pip install --upgrade pip \
    && pip install -e "./backend[server]"

# Entrypoint: optionally run migrations (api sets RUN_MIGRATIONS=1), then exec
# the requested command. In Helm, migrations run as a dedicated pre-upgrade Job
# instead, so the api Deployment leaves RUN_MIGRATIONS unset.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then' \
    '  echo "[entrypoint] alembic upgrade head"' \
    '  (cd /app/backend && alembic upgrade head)' \
    'fi' \
    'exec "$@"' \
    > /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Non-root runtime user.
RUN useradd --create-home --uid 1000 appuser \
    && chown -R appuser:appuser /app
USER appuser

WORKDIR /app/backend
EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["sambaeval-server", "--host", "0.0.0.0", "--port", "8000"]
