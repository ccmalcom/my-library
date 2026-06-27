# Worker Retirement + Cache Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the dominant Upstash cost and the idle Railway worker by defaulting enrichment to FastAPI BackgroundTasks, hardening it against mid-job restarts, and persisting the catalog cache on a Railway volume.

**Architecture:** The API already enqueues to arq only when `REDIS_URL` is set; unsetting it makes `enrich_start` fall back to a BackgroundTask running `run_enrich_job` in Starlette's threadpool. We add two safety nets (startup recovery + a staleness cap) so a web redeploy can't strand a job in `running` forever, then move the catalog cache onto a persistent Railway volume. arq stays in the tree, dormant behind `REDIS_URL`.

**Tech Stack:** Python 3.12 (Railway) / 3.14 (local), FastAPI, SQLAlchemy 2.0, arq (dormant), pytest, Railway, Supabase Postgres.

## Global Constraints

- Run tests on Windows with `.venv/Scripts/python -m pytest` (bare `python` may lack venv packages like `slowapi`).
- DB access uses `with session_scope() as session:` — never `get_session()`.
- Keep arq dormant; do NOT delete `worker.py` or the `enrich_start` enqueue branch.
- No schema migration: dead-job hardening uses only existing `EnrichJob` columns (`status`, `started_at`, `finished_at`, `error`).
- Staleness cap is exactly `1800` seconds (30 min).
- Startup recovery is gated on `get_settings().redis_url is None` (must be a no-op in arq mode).
- The interrupted-job message string is exactly `"Enrichment was interrupted, please retry."` (reused by both safety nets).
- `books` table is never dropped; this plan touches no book data.
- End any git commit message with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Startup recovery for orphaned jobs

When the web process boots in BackgroundTask mode, any `EnrichJob` left `pending`/`running` by a killed predecessor process is dead — mark it errored so the frontend stops polling. No-op in arq mode.

**Files:**
- Modify: `mylibrary/worker.py` (add `INTERRUPTED_MESSAGE`, `recover_orphaned_jobs`)
- Modify: `mylibrary/api.py` (call it from `lifespan`; extend the `.worker` import)
- Test: `tests/test_jobs.py` (new)

**Interfaces:**
- Produces: `mylibrary.worker.INTERRUPTED_MESSAGE: str`, `mylibrary.worker.recover_orphaned_jobs() -> int` (returns count recovered; reads `get_settings().redis_url`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_jobs.py`:

```python
"""Tests for background-job recovery + staleness (BackgroundTask robustness)."""
from __future__ import annotations

from mylibrary.db import EnrichJob, session_scope, utcnow
from mylibrary.worker import INTERRUPTED_MESSAGE, recover_orphaned_jobs


def _add_job(job_id, status, started_at=None):
    with session_scope() as s:
        s.add(EnrichJob(job_id=job_id, user_id="local", status=status, started_at=started_at))


def test_recover_marks_running_and_pending_as_error(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)  # ensure BackgroundTask mode
    _add_job("j-run", "running", started_at=utcnow())
    _add_job("j-pend", "pending")
    _add_job("j-done", "done")

    n = recover_orphaned_jobs()
    assert n == 2

    with session_scope() as s:
        by_id = {j.job_id: j for j in s.query(EnrichJob).all()}
        assert by_id["j-run"].status == "error"
        assert by_id["j-run"].error == INTERRUPTED_MESSAGE
        assert by_id["j-run"].finished_at is not None
        assert by_id["j-pend"].status == "error"
        assert by_id["j-done"].status == "done"  # untouched


def test_recover_is_noop_when_redis_configured(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    _add_job("j-run", "running", started_at=utcnow())

    n = recover_orphaned_jobs()
    assert n == 0

    with session_scope() as s:
        job = s.query(EnrichJob).filter(EnrichJob.job_id == "j-run").one()
        assert job.status == "running"  # left for the separate worker process
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_jobs.py -v`
Expected: FAIL with `ImportError: cannot import name 'recover_orphaned_jobs' from 'mylibrary.worker'`

- [ ] **Step 3: Implement `recover_orphaned_jobs`**

In `mylibrary/worker.py`, add after the imports (the module already imports `get_settings`, `EnrichJob`, `session_scope`, `utcnow`):

```python
INTERRUPTED_MESSAGE = "Enrichment was interrupted, please retry."


def recover_orphaned_jobs() -> int:
    """Fail jobs left running/pending by a previous web process (called at startup).

    In BackgroundTask mode (REDIS_URL unset) a redeploy/restart kills any in-flight
    enrich, leaving an EnrichJob stuck 'running'/'pending' that the frontend polls
    forever. A fresh boot means no in-process task survived, so we error them.

    No-op when REDIS_URL is set: in arq mode the worker is a SEPARATE process and a
    web restart must not touch jobs it is still running. Returns the count recovered.
    """
    if get_settings().redis_url is not None:
        return 0
    recovered = 0
    with session_scope() as session:
        jobs = (
            session.query(EnrichJob)
            .filter(EnrichJob.status.in_(("pending", "running")))
            .all()
        )
        for job in jobs:
            job.status = "error"
            job.error = INTERRUPTED_MESSAGE
            job.finished_at = utcnow()
            recovered += 1
    return recovered
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_jobs.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Wire recovery into `lifespan`**

In `mylibrary/api.py`, extend the existing worker import (currently `from .worker import create_enrich_job, run_enrich_job`):

```python
from .worker import create_enrich_job, recover_orphaned_jobs, run_enrich_job
```

Then in `lifespan`, call it right after `init_db()`:

```python
    init_db()
    recover_orphaned_jobs()
```

- [ ] **Step 6: Verify the full suite still passes**

Run: `.venv/Scripts/python -m pytest -q`
Expected: PASS (no regressions; the `with TestClient(app) as client:` tests trigger `lifespan`, which now calls `recover_orphaned_jobs()` as a no-op on an empty job table).

- [ ] **Step 7: Commit**

```bash
git add mylibrary/worker.py mylibrary/api.py tests/test_jobs.py
git commit -m "feat: recover orphaned enrich jobs on web startup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Staleness cap on enrich status

Defense-in-depth for an in-process hang no restart cleared: a `running` job older than 30 min is reported as errored on read.

**Files:**
- Modify: `mylibrary/worker.py` (add `STALE_JOB_SECONDS`, `fail_if_stale`)
- Modify: `mylibrary/api.py` (`enrich_status` calls it; extend the `.worker` import)
- Test: `tests/test_jobs.py` (extend)

**Interfaces:**
- Consumes: `mylibrary.worker.INTERRUPTED_MESSAGE` (from Task 1).
- Produces: `mylibrary.worker.STALE_JOB_SECONDS: int` (= 1800), `mylibrary.worker.fail_if_stale(session, job: EnrichJob, *, now: datetime | None = None) -> EnrichJob` (mutates + returns the job; caller's `session_scope` commits).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_jobs.py`:

```python
from datetime import timedelta

from mylibrary.worker import STALE_JOB_SECONDS, fail_if_stale


def test_fail_if_stale_errors_an_old_running_job():
    old = utcnow() - timedelta(seconds=STALE_JOB_SECONDS + 60)
    _add_job("j-old", "running", started_at=old)
    with session_scope() as s:
        job = s.query(EnrichJob).filter(EnrichJob.job_id == "j-old").one()
        fail_if_stale(s, job)
        assert job.status == "error"
        assert job.error == INTERRUPTED_MESSAGE
        assert job.finished_at is not None


def test_fail_if_stale_leaves_a_fresh_running_job():
    _add_job("j-fresh", "running", started_at=utcnow())
    with session_scope() as s:
        job = s.query(EnrichJob).filter(EnrichJob.job_id == "j-fresh").one()
        fail_if_stale(s, job)
        assert job.status == "running"


def test_fail_if_stale_ignores_non_running_jobs():
    old = utcnow() - timedelta(seconds=STALE_JOB_SECONDS + 60)
    _add_job("j-done", "done", started_at=old)
    with session_scope() as s:
        job = s.query(EnrichJob).filter(EnrichJob.job_id == "j-done").one()
        fail_if_stale(s, job)
        assert job.status == "done"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/Scripts/python -m pytest tests/test_jobs.py -v`
Expected: FAIL with `ImportError: cannot import name 'STALE_JOB_SECONDS'`

- [ ] **Step 3: Implement `fail_if_stale`**

In `mylibrary/worker.py`, add `from datetime import datetime, timezone` to the imports, then add below `recover_orphaned_jobs`:

```python
STALE_JOB_SECONDS = 1800  # 30 min: a 'running' job older than this is treated as dead


def fail_if_stale(session, job: EnrichJob, *, now: datetime | None = None) -> EnrichJob:
    """Mark a long-stuck 'running' job as errored. Idempotent; mutates + returns job.

    Defense-in-depth for an in-process hang no restart cleared. No-op for non-running
    jobs or jobs without a started_at. The caller's session_scope() commits the change.
    """
    if job.status != "running" or job.started_at is None:
        return job
    now = now or utcnow()
    started = job.started_at
    if started.tzinfo is None:  # SQLite reads back naive datetimes; assume UTC
        started = started.replace(tzinfo=timezone.utc)
    if (now - started).total_seconds() > STALE_JOB_SECONDS:
        job.status = "error"
        job.error = INTERRUPTED_MESSAGE
        job.finished_at = now
    return job
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_jobs.py -v`
Expected: PASS (5 passed total)

- [ ] **Step 5: Call `fail_if_stale` from the status endpoint**

In `mylibrary/api.py`, extend the worker import to include `fail_if_stale`:

```python
from .worker import create_enrich_job, fail_if_stale, recover_orphaned_jobs, run_enrich_job
```

Then in `enrich_status`, call it after the 404 check and before returning (the surrounding `session_scope()` commits the mutation):

```python
        if job is None:
            raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")
        fail_if_stale(session, job)
        return EnrichJobOut.model_validate(job)
```

- [ ] **Step 6: Verify the full suite still passes**

Run: `.venv/Scripts/python -m pytest -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add mylibrary/worker.py mylibrary/api.py tests/test_jobs.py
git commit -m "feat: error out stale running enrich jobs on status read

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Reword BackgroundTasks as the production default

Documentation-in-code only: the comments currently call BackgroundTasks a "local dev fallback." With the worker retired it is the supported production path. No test (comment-only); verify the frontend already surfaces the error path.

**Files:**
- Modify: `mylibrary/worker.py` (module docstring)
- Modify: `mylibrary/api.py` (`enrich_start` docstring + the fallback comment)

- [ ] **Step 1: Reword the worker module docstring**

In `mylibrary/worker.py`, replace the trailing paragraph of the module docstring:

```
Local / no-Redis mode: the API falls back to FastAPI BackgroundTasks and
calls `run_enrich_job` directly (same function, no arq involved).
```

with:

```
Default (no-Redis) mode: the API runs enrichment as a FastAPI BackgroundTask
calling `run_enrich_job` directly (same function, no arq involved). This is the
SUPPORTED PRODUCTION path for the invite-only deployment. arq is opt-in: set
REDIS_URL (and run this worker) only when you need a dedicated worker process.
```

- [ ] **Step 2: Reword the `enrich_start` docstring + fallback comment**

In `mylibrary/api.py` `enrich_start`, replace:

```
    When REDIS_URL is configured the job runs in the arq worker process. Otherwise it
    runs in a FastAPI BackgroundTask (fine for local single-user dev without Redis).
    Poll GET /enrich/status/{job_id} until status is 'done' or 'error'.
```

with:

```
    By default (REDIS_URL unset) the job runs as a FastAPI BackgroundTask in this web
    process -- the supported production mode. When REDIS_URL is configured it is handed
    off to the arq worker instead. Poll GET /enrich/status/{job_id} until 'done'/'error'.
```

And replace the comment:

```
        # Local dev fallback: run in a BackgroundTask (same blocking function, no Redis)
```

with:

```
        # Default mode: run in a BackgroundTask (same blocking function, no Redis).
        # On a mid-job web restart, recover_orphaned_jobs() fails the stranded row at boot.
```

- [ ] **Step 3: Verify the frontend error path needs no change**

Read `frontend/components/SetupWizard.tsx` around lines 516-517 and 591-607. Confirm:
- `pollStatus` sets `error` from `job.error` when `status === 'error'`.
- A "Retry Enrichment" button renders when `error && jobId`.

Expected: both already present — no frontend edit required. The backend now sets `job.error = "Enrichment was interrupted, please retry."`, which flows straight through.

- [ ] **Step 4: Verify nothing broke**

Run: `.venv/Scripts/python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mylibrary/worker.py mylibrary/api.py
git commit -m "docs: mark BackgroundTasks as the production enrich path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Update project docs

Reflect the new architecture in the long-lived docs so future work doesn't reintroduce the worker assumption.

**Files:**
- Modify: `CLAUDE.md` (Phase 4 + Phase 5 notes)
- Modify: `mylibrary-phase5-deploy-runbook.md`

- [ ] **Step 1: Update CLAUDE.md Phase 4 note**

In `CLAUDE.md`, find the Phase 4 bullet describing `POST /enrich/start` ("enqueues via arq when `REDIS_URL` is set, falls back to FastAPI `BackgroundTasks` otherwise (local dev needs no Redis)"). Append a sentence:

```
As of the efficiency pass, BackgroundTasks is the **intended production mode**
(invite-only scale): the Railway worker service + Upstash are retired and REDIS_URL
is unset. arq stays in the tree, dormant, for future horizontal scale. A web restart
mid-job is recovered by `worker.recover_orphaned_jobs()` at startup (gated on REDIS_URL
unset), and `worker.fail_if_stale` errors a job stuck 'running' past 30 min.
```

- [ ] **Step 2: Update CLAUDE.md Phase 5 note**

In `CLAUDE.md`, find the Phase 5 architecture line ("API + worker -> Railway (two services...)"). Add:

```
**Efficiency pass (2026-06-26):** the worker service + Upstash Redis are retired for the
invite-only launch — a single Railway web service runs enrichment as a BackgroundTask. The
catalog cache lives on a Railway volume mounted at `/data` (`MYLIBRARY_DATA_DIR=/data`) so
it survives redeploys and is shared by enrich + recommend in the one process.
```

- [ ] **Step 3: Update the deploy runbook**

In `mylibrary-phase5-deploy-runbook.md`:
- Mark the worker service and Upstash Redis steps as **OPTIONAL (scale-only)**; the default deploy is web-only with `REDIS_URL` unset.
- Add a "Persistent volume" step: in the Railway web service, create a volume mounted at `/data`, then set env `MYLIBRARY_DATA_DIR=/data`. Note it holds the catalog cache + uploaded CSVs (the DB is Postgres/Supabase, unaffected).
- Add a verification note: after deploy, the Upstash command graph should flatline near zero.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md mylibrary-phase5-deploy-runbook.md
git commit -m "docs: record worker retirement + cache volume in project docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Railway operational cutover (manual)

Console actions on Railway — no code. Do this last, after Tasks 1-4 are deployed, so the recovery safety nets are live before BackgroundTasks becomes the only path.

**Files:** none (Railway dashboard).

- [ ] **Step 1: Add the persistent volume**

In the Railway **web** service: create a Volume, mount path `/data`. Add a service variable `MYLIBRARY_DATA_DIR=/data`. Redeploy.

- [ ] **Step 2: Verify the volume + app health**

After redeploy, `GET https://<railway-domain>/healthz` returns `{"status":"ok"}`. In the web service shell (or logs), confirm `/data/cache/` is created on first catalog hit.

- [ ] **Step 3: Switch enrichment to BackgroundTasks**

In the web service, **delete** the `REDIS_URL` variable. Redeploy. (`lifespan` now sets `arq_pool = None`; `enrich_start` takes the BackgroundTask branch.)

- [ ] **Step 4: Decommission the worker + queue**

Delete the Railway **worker** service. Delete (or let lapse) the Upstash Redis instance.

- [ ] **Step 5: End-to-end smoke test (live)**

- Trigger an enrich from the UI; confirm progress advances and reaches `done`.
- Start another enrich, then redeploy the web service mid-run; confirm the job flips to `error` showing "Enrichment was interrupted, please retry." with a Retry button, and retry completes.
- Confirm the catalog cache persisted: after the redeploy, a repeated catalog search / re-enrich does not re-hit the network (check the enrich summary `http` block or response latency).
- Check the Upstash dashboard (before deletion) / Railway metrics: command rate has dropped to ~0 and only one service runs.

- [ ] **Step 6: Record completion**

Note the cutover date in `mylibrary-phase5-deploy-runbook.md` (mirroring the existing "LIVE (deployed ...)" convention).

---

## Self-Review

**Spec coverage:**
- Phase 1 (retire worker + Upstash) -> Task 3 (code/comments) + Task 5 (ops cutover). ✓
- Phase 2 (dead-job hardening: startup recovery + staleness cap) -> Task 1 + Task 2; frontend already handles error/retry (Task 3 Step 3 verifies). ✓
- Phase 3 (persist catalog cache) -> Task 5 Steps 1-2 (volume + `MYLIBRARY_DATA_DIR`), no code change (config already honors the env var). ✓
- Docs/ops -> Task 4. ✓
- Testing section of spec -> Task 1/2 unit tests + Task 5 manual smoke. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command shows expected output. ✓

**Type consistency:** `INTERRUPTED_MESSAGE` (Task 1) reused in Task 2 and asserted in tests; `recover_orphaned_jobs() -> int`, `fail_if_stale(session, job, *, now=None) -> EnrichJob`, `STALE_JOB_SECONDS = 1800` consistent across worker.py, api.py imports, and tests. The `.worker` import in api.py is extended additively across Tasks 1 and 2 (final form: `create_enrich_job, fail_if_stale, recover_orphaned_jobs, run_enrich_job`). ✓
