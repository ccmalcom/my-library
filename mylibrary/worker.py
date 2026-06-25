"""arq worker — background job definitions for MyLibrary.

Processes long-running tasks (currently enrichment) outside the HTTP request
cycle so cloud deployments with 30-60s timeout limits don't choke.

Run the worker alongside the API:
    python -m arq mylibrary.worker.WorkerSettings

The API enqueues jobs via `arq.create_pool`; the worker picks them up,
runs the core function, and writes progress + final status to `EnrichJob`.

Local / no-Redis mode: the API falls back to FastAPI BackgroundTasks and
calls `run_enrich_job` directly (same function, no arq involved).
"""

from __future__ import annotations

import asyncio
import uuid

from .config import get_settings
from .db import EnrichJob, session_scope, utcnow
from .enrich import enrich_library


# --------------------------------------------------------------------------- #
#  Core job function — used by BOTH the arq worker and the BackgroundTask     #
#  fallback so the logic lives in one place.                                  #
# --------------------------------------------------------------------------- #


def run_enrich_job(
    job_id: str,
    user_id: str,
    force: bool = False,
    limit: int | None = None,
) -> None:
    """Run enrich_library for a single user and track progress in EnrichJob.

    Designed to be called from a thread (via run_in_executor in async contexts)
    since enrich_library is synchronous.  Progress is written to the DB in
    batches of 5 books so the status endpoint sees near-real-time updates
    without hammering the DB on every single resolution.
    """
    # Mark as running
    with session_scope() as session:
        job = session.query(EnrichJob).filter(EnrichJob.job_id == job_id).first()
        if job is None:
            return  # race — job was deleted before we started
        job.status = "running"
        job.started_at = utcnow()

    last_flush = [0]

    def on_progress(done: int, total: int, title: str, label: str) -> None:
        # Flush at start (done==0 to seed total), end, or every 5 books.
        if done == 0 or done == total or (done - last_flush[0]) >= 5:
            last_flush[0] = done
            with session_scope() as s:
                j = s.query(EnrichJob).filter(EnrichJob.job_id == job_id).first()
                if j is not None:
                    j.progress = done
                    j.total = total

    try:
        summary = enrich_library(
            force=force,
            limit=limit,
            progress=on_progress,
            user_id=user_id,
        )
        with session_scope() as session:
            job = session.query(EnrichJob).filter(EnrichJob.job_id == job_id).first()
            if job is not None:
                job.status = "done"
                job.finished_at = utcnow()
                job.progress = summary["processed"]
                job.total = summary["total"] + summary.get("skipped_existing", 0)
    except Exception as exc:
        with session_scope() as session:
            job = session.query(EnrichJob).filter(EnrichJob.job_id == job_id).first()
            if job is not None:
                job.status = "error"
                job.finished_at = utcnow()
                job.error = str(exc)[:2000]  # cap at 2 KB
        raise


# --------------------------------------------------------------------------- #
#  arq task — thin async wrapper around the blocking run_enrich_job           #
# --------------------------------------------------------------------------- #


async def enrich_books(
    ctx: dict,
    *,
    job_id: str,
    user_id: str,
    force: bool = False,
    limit: int | None = None,
) -> None:
    """arq task: enrich a user's library in a thread pool and track progress."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        None,
        lambda: run_enrich_job(job_id=job_id, user_id=user_id, force=force, limit=limit),
    )


# --------------------------------------------------------------------------- #
#  Helpers for the API layer                                                   #
# --------------------------------------------------------------------------- #


def make_job_id() -> str:
    """Generate a stable, opaque job identifier."""
    return str(uuid.uuid4())


def create_enrich_job(user_id: str) -> str:
    """Insert a pending EnrichJob row and return its job_id."""
    job_id = make_job_id()
    with session_scope() as session:
        session.add(EnrichJob(job_id=job_id, user_id=user_id, status="pending"))
    return job_id


# --------------------------------------------------------------------------- #
#  arq WorkerSettings                                                          #
# --------------------------------------------------------------------------- #


def _build_redis_settings():
    """Build arq RedisSettings from REDIS_URL env var (evaluated at import time)."""
    from arq.connections import RedisSettings as ArqRedisSettings

    url = get_settings().redis_url
    if url:
        return ArqRedisSettings.from_dsn(url)
    return ArqRedisSettings()  # default: redis://localhost:6379


class WorkerSettings:
    """arq worker configuration.

    Start with:
        python -m arq mylibrary.worker.WorkerSettings

    Reads REDIS_URL from the environment (via get_settings()); defaults to
    localhost:6379 if unset (useful for local arq development with a local
    Redis instance).
    """

    functions = [enrich_books]
    redis_settings = _build_redis_settings()
