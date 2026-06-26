#!/usr/bin/env bash
# Web process entrypoint for the MyLibrary API.
#
# Runs DB migrations to head, then starts uvicorn bound to Railway's $PORT.
# ONLY the web service runs this -- the worker service must NOT run migrations
# (a single migrator avoids two processes racing `alembic upgrade head`).
set -euo pipefail

echo "[start] applying database migrations (alembic upgrade head)..."
python -m alembic upgrade head

echo "[start] launching uvicorn on 0.0.0.0:${PORT:-8000}..."
exec python -m uvicorn mylibrary.api:app --host 0.0.0.0 --port "${PORT:-8000}"
