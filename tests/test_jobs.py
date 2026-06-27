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
