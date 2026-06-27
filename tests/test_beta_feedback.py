"""Tests for the beta-feedback feature: POST/GET /feedback, POST /feedback/dismiss.

TDD: this file is written BEFORE the implementation. Tests cover:
  1. POST /feedback validation
  2. One-time trigger submit upserts state row
  3. post-recs submit does NOT write a state row
  4. GET /feedback/prompt -- prompts disabled
  5. GET /feedback/prompt -- one-time trigger, no state row -> show=true
  6. GET /feedback/prompt -- one-time trigger, terminal states -> show=false
  7. GET /feedback/prompt -- ask_later, active snooze -> show=false
  8. GET /feedback/prompt -- ask_later, expired snooze -> show=true
  9. GET /feedback/prompt -- post-recs eligible
 10. GET /feedback/prompt -- post-recs global dont_ask -> show=false
 11. GET /feedback/prompt -- post-recs already submitted -> show=false
 12. POST /feedback/dismiss dont_ask
 13. POST /feedback/dismiss ask_later
 14. User scoping
 15. Unique constraint -- second dismiss upserts (no duplicate row)
 16. Migration idempotency
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from mylibrary.api import app
from mylibrary.db import Feedback, FeedbackPromptState, session_scope


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _client():
    return TestClient(app)


def _insert_state(user_id: str, trigger: str, run_id: str, status: str, snooze_until=None):
    """Directly insert a FeedbackPromptState row for test setup."""
    with session_scope() as s:
        row = FeedbackPromptState(
            user_id=user_id,
            trigger=trigger,
            run_id=run_id,
            status=status,
            snooze_until=snooze_until,
        )
        s.add(row)


# ---------------------------------------------------------------------------
# 1. POST /feedback validation
# ---------------------------------------------------------------------------

def test_post_feedback_bad_category_422():
    with _client() as c:
        resp = c.post("/feedback", json={"category": "unknown", "body": "hello"})
    assert resp.status_code == 422


def test_post_feedback_empty_body_422():
    with _client() as c:
        resp = c.post("/feedback", json={"category": "bug", "body": ""})
    assert resp.status_code == 422


def test_post_feedback_happy_path_inserts_row():
    with _client() as c:
        resp = c.post("/feedback", json={"category": "idea", "body": "Add dark mode"})
    assert resp.status_code == 201
    with session_scope() as s:
        row = s.query(Feedback).filter(Feedback.body == "Add dark mode").one()
        assert row.category == "idea"
        assert row.trigger is None


# ---------------------------------------------------------------------------
# 2. One-time trigger submit -> upserts submitted state row
# ---------------------------------------------------------------------------

def test_post_feedback_post_setup_upserts_submitted_state():
    with _client() as c:
        resp = c.post(
            "/feedback",
            json={"category": "praise", "body": "Setup was smooth", "trigger": "post-setup"},
        )
    assert resp.status_code == 201
    with session_scope() as s:
        state = (
            s.query(FeedbackPromptState)
            .filter(
                FeedbackPromptState.user_id == "local",
                FeedbackPromptState.trigger == "post-setup",
                FeedbackPromptState.run_id == "",
            )
            .one()
        )
        assert state.status == "submitted"


def test_post_feedback_post_first_profile_upserts_submitted_state():
    with _client() as c:
        resp = c.post(
            "/feedback",
            json={"category": "bug", "body": "Profile took too long", "trigger": "post-first-profile"},
        )
    assert resp.status_code == 201
    with session_scope() as s:
        state = (
            s.query(FeedbackPromptState)
            .filter(
                FeedbackPromptState.user_id == "local",
                FeedbackPromptState.trigger == "post-first-profile",
                FeedbackPromptState.run_id == "",
            )
            .one()
        )
        assert state.status == "submitted"


# ---------------------------------------------------------------------------
# 3. post-recs submit does NOT write a state row
# ---------------------------------------------------------------------------

def test_post_feedback_post_recs_no_state_row():
    with _client() as c:
        resp = c.post(
            "/feedback",
            json={
                "category": "idea",
                "body": "More fantasy please",
                "trigger": "post-recs",
                "run_id": "run-abc",
            },
        )
    assert resp.status_code == 201
    with session_scope() as s:
        count = (
            s.query(FeedbackPromptState)
            .filter(FeedbackPromptState.trigger == "post-recs")
            .count()
        )
        assert count == 0
        fb = s.query(Feedback).filter(Feedback.trigger == "post-recs").one()
        assert fb.run_id == "run-abc"


# ---------------------------------------------------------------------------
# 4. GET /feedback/prompt -- prompts disabled
# ---------------------------------------------------------------------------

def test_get_prompt_disabled_always_returns_false(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "false")
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-setup"})
    assert resp.status_code == 200
    assert resp.json() == {"show": False}


# ---------------------------------------------------------------------------
# 5. GET /feedback/prompt -- one-time trigger, no state row -> show=true
# ---------------------------------------------------------------------------

def test_get_prompt_one_time_no_row_show_true(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-setup"})
    assert resp.status_code == 200
    assert resp.json() == {"show": True}


# ---------------------------------------------------------------------------
# 6. GET /feedback/prompt -- one-time trigger, terminal states -> show=false
# ---------------------------------------------------------------------------

def test_get_prompt_one_time_submitted_show_false(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    _insert_state("local", "post-setup", "", "submitted")
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-setup"})
    assert resp.json() == {"show": False}


def test_get_prompt_one_time_dont_ask_show_false(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    _insert_state("local", "post-first-profile", "", "dont_ask")
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-first-profile"})
    assert resp.json() == {"show": False}


# ---------------------------------------------------------------------------
# 7. GET /feedback/prompt -- ask_later, active snooze -> show=false
# ---------------------------------------------------------------------------

def test_get_prompt_one_time_ask_later_active_snooze_show_false(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    future = datetime.utcnow() + timedelta(hours=48)
    _insert_state("local", "post-setup", "", "ask_later", snooze_until=future)
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-setup"})
    assert resp.json() == {"show": False}


# ---------------------------------------------------------------------------
# 8. GET /feedback/prompt -- ask_later, expired snooze -> show=true
# ---------------------------------------------------------------------------

def test_get_prompt_one_time_ask_later_expired_snooze_show_true(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    past = datetime.utcnow() - timedelta(hours=1)
    _insert_state("local", "post-setup", "", "ask_later", snooze_until=past)
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-setup"})
    assert resp.json() == {"show": True}


# ---------------------------------------------------------------------------
# 9. GET /feedback/prompt -- post-recs eligible (all three conditions pass)
# ---------------------------------------------------------------------------

def test_get_prompt_post_recs_eligible(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-recs", "run_id": "run-xyz"})
    assert resp.json() == {"show": True}


# ---------------------------------------------------------------------------
# 10. GET /feedback/prompt -- post-recs global dont_ask -> show=false
# ---------------------------------------------------------------------------

def test_get_prompt_post_recs_global_dont_ask_show_false(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    _insert_state("local", "post-recs", "", "dont_ask")
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-recs", "run_id": "run-xyz"})
    assert resp.json() == {"show": False}


# ---------------------------------------------------------------------------
# 11. GET /feedback/prompt -- post-recs already submitted (feedback row exists)
# ---------------------------------------------------------------------------

def test_get_prompt_post_recs_already_submitted_show_false(monkeypatch):
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    with session_scope() as s:
        s.add(Feedback(
            user_id="local",
            category="idea",
            body="great recs",
            trigger="post-recs",
            run_id="run-xyz",
        ))
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-recs", "run_id": "run-xyz"})
    assert resp.json() == {"show": False}


# ---------------------------------------------------------------------------
# 12. POST /feedback/dismiss dont_ask
# ---------------------------------------------------------------------------

def test_post_dismiss_dont_ask_upserts_terminal_state():
    with _client() as c:
        resp = c.post(
            "/feedback/dismiss",
            json={"trigger": "post-recs", "mode": "dont_ask"},
        )
    assert resp.status_code == 204
    with session_scope() as s:
        row = (
            s.query(FeedbackPromptState)
            .filter(
                FeedbackPromptState.user_id == "local",
                FeedbackPromptState.trigger == "post-recs",
                FeedbackPromptState.run_id == "",
            )
            .one()
        )
        assert row.status == "dont_ask"


# ---------------------------------------------------------------------------
# 13. POST /feedback/dismiss ask_later
# ---------------------------------------------------------------------------

def test_post_dismiss_ask_later_upserts_snooze(monkeypatch):
    monkeypatch.setenv("FEEDBACK_SNOOZE_HOURS", "72")
    with _client() as c:
        resp = c.post(
            "/feedback/dismiss",
            json={"trigger": "post-setup", "mode": "ask_later"},
        )
    assert resp.status_code == 204
    with session_scope() as s:
        row = (
            s.query(FeedbackPromptState)
            .filter(
                FeedbackPromptState.user_id == "local",
                FeedbackPromptState.trigger == "post-setup",
                FeedbackPromptState.run_id == "",
            )
            .one()
        )
        assert row.status == "ask_later"
        assert row.snooze_until is not None
        expected = datetime.utcnow() + timedelta(hours=72)
        diff = abs((row.snooze_until - expected).total_seconds())
        assert diff < 60, f"snooze_until off by {diff}s"


def test_post_dismiss_ask_later_post_recs_uses_run_id(monkeypatch):
    monkeypatch.setenv("FEEDBACK_SNOOZE_HOURS", "24")
    with _client() as c:
        resp = c.post(
            "/feedback/dismiss",
            json={"trigger": "post-recs", "run_id": "run-abc", "mode": "ask_later"},
        )
    assert resp.status_code == 204
    with session_scope() as s:
        row = (
            s.query(FeedbackPromptState)
            .filter(
                FeedbackPromptState.user_id == "local",
                FeedbackPromptState.trigger == "post-recs",
                FeedbackPromptState.run_id == "run-abc",
            )
            .one()
        )
        assert row.status == "ask_later"


# ---------------------------------------------------------------------------
# 14. User scoping
# ---------------------------------------------------------------------------

def test_user_scoping_state_isolated(monkeypatch):
    """User A's dismissed state must not affect user B's prompt eligibility."""
    monkeypatch.setenv("FEEDBACK_PROMPTS_ENABLED", "true")
    _insert_state("user-a", "post-setup", "", "dont_ask")
    with _client() as c:
        resp = c.get("/feedback/prompt", params={"trigger": "post-setup"})
    assert resp.json() == {"show": True}


# ---------------------------------------------------------------------------
# 15. Unique constraint -- second dismiss upserts (no duplicate row)
# ---------------------------------------------------------------------------

def test_dismiss_upsert_no_duplicate():
    with _client() as c:
        c.post("/feedback/dismiss", json={"trigger": "post-setup", "mode": "ask_later"})
        resp = c.post("/feedback/dismiss", json={"trigger": "post-setup", "mode": "dont_ask"})
    assert resp.status_code == 204
    with session_scope() as s:
        count = (
            s.query(FeedbackPromptState)
            .filter(
                FeedbackPromptState.user_id == "local",
                FeedbackPromptState.trigger == "post-setup",
                FeedbackPromptState.run_id == "",
            )
            .count()
        )
        assert count == 1
        row = (
            s.query(FeedbackPromptState)
            .filter(
                FeedbackPromptState.user_id == "local",
                FeedbackPromptState.trigger == "post-setup",
                FeedbackPromptState.run_id == "",
            )
            .one()
        )
        assert row.status == "dont_ask"


# ---------------------------------------------------------------------------
# 16. Migration idempotency -- upgrade head twice should not raise
# ---------------------------------------------------------------------------

def test_migration_idempotency(tmp_path, monkeypatch):
    """Running alembic upgrade head twice must not error.

    Uses a fresh SQLite DB (DATABASE_URL unset) so this test works without
    a network connection to the production Postgres instance.
    """
    import subprocess, sys, os

    db_path = tmp_path / "migration_test.db"
    sqlite_url = f"sqlite:///{db_path}"

    # Build an isolated env: clear production credentials, point at SQLite.
    env = os.environ.copy()
    for _var in ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_JWKS_URL",
                 "SUPABASE_JWT_SECRET", "ENCRYPTION_KEY", "REDIS_URL"):
        env.pop(_var, None)
    env["DATABASE_URL"] = sqlite_url
    env["MYLIBRARY_DATA_DIR"] = str(tmp_path)

    # Find the repo root (where alembic.ini lives).
    import mylibrary
    repo_root = str(
        __import__("pathlib").Path(mylibrary.__file__).parent.parent
    )

    run_kwargs = dict(
        args=[sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        env=env,
    )

    result1 = subprocess.run(**run_kwargs)
    assert result1.returncode == 0, f"First upgrade failed:\n{result1.stderr}"

    result2 = subprocess.run(**run_kwargs)
    assert result2.returncode == 0, f"Second upgrade (idempotency) failed:\n{result2.stderr}"
