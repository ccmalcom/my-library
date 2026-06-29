"""Tests for Task 3.2: reject_reasons on PATCH /recommendations/{rec_id}/feedback.

TDD: covers
  1. PATCH {"status":"rejected","reject_reasons":["too_dark"]} persists reasons
  2. Unknown reason code -> 422
  3. reject_reasons with non-rejected status -> 422
  4. Profile becomes dirty when rejected with reasons
  5. Rejecting without reasons (plain reject) still works
"""

from __future__ import annotations

import uuid
import pytest
from fastapi.testclient import TestClient

from mylibrary.api import app
from mylibrary.db import Recommendation, session_scope, LOCAL_USER_ID, init_db


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _client():
    return TestClient(app)


def _insert_rec(user_id: str = LOCAL_USER_ID, title: str = "Test Book") -> int:
    """Insert a minimal Recommendation row and return its id."""
    init_db()
    with session_scope() as s:
        rec = Recommendation(
            user_id=user_id,
            run_id=str(uuid.uuid4()),
            rank=1,
            title=title,
            score=0.8,
            status="served",
        )
        s.add(rec)
        s.flush()
        return rec.id


# ---------------------------------------------------------------------------
# 1. Valid reject with reasons persists
# ---------------------------------------------------------------------------

def test_reject_with_reasons_persists():
    rec_id = _insert_rec()
    with _client() as c:
        resp = c.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"status": "rejected", "reject_reasons": ["too_dark", "wrong_genre"]},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"

    # Verify persisted in DB
    with session_scope() as s:
        rec = s.get(Recommendation, rec_id)
        assert rec.reject_reasons == ["too_dark", "wrong_genre"]


# ---------------------------------------------------------------------------
# 2. Unknown reason code -> 422
# ---------------------------------------------------------------------------

def test_unknown_reject_reason_returns_422():
    rec_id = _insert_rec()
    with _client() as c:
        resp = c.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"status": "rejected", "reject_reasons": ["not_a_real_reason"]},
        )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# 3. reject_reasons with non-rejected status -> 422
# ---------------------------------------------------------------------------

def test_reject_reasons_with_accepted_status_returns_422():
    rec_id = _insert_rec()
    with _client() as c:
        resp = c.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"status": "accepted", "reject_reasons": ["too_dark"]},
        )
    assert resp.status_code == 422, resp.text


def test_reject_reasons_with_no_status_returns_422():
    """reject_reasons without any status should 422 (no status = can't be rejected)."""
    rec_id = _insert_rec()
    with _client() as c:
        resp = c.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"reject_reasons": ["too_dark"]},
        )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# 4. Profile becomes dirty after reject with reasons
# ---------------------------------------------------------------------------

def test_profile_dirty_after_reject_with_reasons():
    rec_id = _insert_rec()
    with _client() as c:
        patch_resp = c.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"status": "rejected", "reject_reasons": ["overhyped"]},
        )
        assert patch_resp.status_code == 200, patch_resp.text
        status_resp = c.get("/profile/status")
    assert status_resp.status_code == 200, status_resp.text
    assert status_resp.json()["dirty"] is True


# ---------------------------------------------------------------------------
# 5. Plain reject (no reasons) still works
# ---------------------------------------------------------------------------

def test_plain_reject_without_reasons_still_works():
    rec_id = _insert_rec()
    with _client() as c:
        resp = c.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"status": "rejected"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"

    with session_scope() as s:
        rec = s.get(Recommendation, rec_id)
        assert rec.reject_reasons is None
