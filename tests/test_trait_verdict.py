"""Tests for Task 3.1: PATCH /profile/traits/{trait_id} status + user_weight.

TDD: covers
  1. PATCH with {"status":"confirmed"} sets status + verdict_updated_at
  2. PATCH with {"user_weight":0.5} sets weight + verdict_updated_at
  3. PATCH with {"user_weight":2} returns 422 (out of range)
  4. Profile becomes dirty after a verdict is applied
  5. 404 on unknown trait id
  6. set_trait_verdict core function works directly via session
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from mylibrary.api import app
from mylibrary.db import TasteTrait, session_scope, LOCAL_USER_ID


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _client():
    return TestClient(app)


def _insert_trait(user_id: str = LOCAL_USER_ID, claim: str = "I like sci-fi") -> int:
    """Insert a minimal TasteTrait row and return its id."""
    with session_scope() as s:
        t = TasteTrait(
            user_id=user_id,
            claim=claim,
            polarity="positive",
            inference_confidence=0.8,
            status="proposed",
            exhibits=[],
            contrasts=[],
        )
        s.add(t)
        s.flush()
        return t.id


# ---------------------------------------------------------------------------
# 1. PATCH status=confirmed sets status + verdict_updated_at
# ---------------------------------------------------------------------------

def test_patch_trait_status_confirmed():
    trait_id = _insert_trait()
    with _client() as c:
        resp = c.patch(f"/profile/traits/{trait_id}", json={"status": "confirmed"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "confirmed"
    assert data["verdict_updated_at"] is not None


# ---------------------------------------------------------------------------
# 2. PATCH user_weight=0.5 sets weight + verdict_updated_at
# ---------------------------------------------------------------------------

def test_patch_trait_user_weight():
    trait_id = _insert_trait()
    with _client() as c:
        resp = c.patch(f"/profile/traits/{trait_id}", json={"user_weight": 0.5})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["user_weight"] == pytest.approx(0.5)
    assert data["verdict_updated_at"] is not None


# ---------------------------------------------------------------------------
# 3. PATCH user_weight=2 → 422 (out of 0.0-1.0 range)
# ---------------------------------------------------------------------------

def test_patch_trait_user_weight_out_of_range():
    trait_id = _insert_trait()
    with _client() as c:
        resp = c.patch(f"/profile/traits/{trait_id}", json={"user_weight": 2.0})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 4. Profile becomes dirty after a verdict is applied
# ---------------------------------------------------------------------------

def test_profile_dirty_after_verdict():
    trait_id = _insert_trait()
    with _client() as c:
        # Apply a verdict.
        patch_resp = c.patch(f"/profile/traits/{trait_id}", json={"status": "rejected"})
        assert patch_resp.status_code == 200, patch_resp.text
        # Check profile status.
        status_resp = c.get("/profile/status")
    assert status_resp.status_code == 200, status_resp.text
    assert status_resp.json()["dirty"] is True


# ---------------------------------------------------------------------------
# 5. 404 on unknown trait id
# ---------------------------------------------------------------------------

def test_patch_trait_not_found():
    with _client() as c:
        resp = c.patch("/profile/traits/999999", json={"status": "confirmed"})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 6. set_trait_verdict core function
# ---------------------------------------------------------------------------

def test_set_trait_verdict_core_function():
    from mylibrary.library import set_trait_verdict, TraitNotFoundError

    trait_id = _insert_trait()
    with session_scope() as s:
        updated = set_trait_verdict(s, trait_id, status="confirmed", user_weight=0.3, user_id=LOCAL_USER_ID)
        assert updated.status == "confirmed"
        assert updated.user_weight == pytest.approx(0.3)
        assert updated.verdict_updated_at is not None


def test_set_trait_verdict_not_found_raises():
    from mylibrary.library import set_trait_verdict, TraitNotFoundError

    with session_scope() as s:
        with pytest.raises(TraitNotFoundError):
            set_trait_verdict(s, 999999, status="confirmed", user_id=LOCAL_USER_ID)


# ---------------------------------------------------------------------------
# 7. Wrong-user access returns 404 / TraitNotFoundError
# ---------------------------------------------------------------------------

def test_set_trait_verdict_wrong_user_raises():
    """set_trait_verdict must raise TraitNotFoundError when user_id doesn't own the trait."""
    from mylibrary.library import set_trait_verdict, TraitNotFoundError

    # Insert a trait owned by LOCAL_USER_ID.
    trait_id = _insert_trait(user_id=LOCAL_USER_ID)

    with session_scope() as s:
        with pytest.raises(TraitNotFoundError):
            set_trait_verdict(s, trait_id, status="confirmed", user_id="other-user-id")


def test_patch_trait_wrong_user_returns_404():
    """PATCH /profile/traits/{id} as a different user must return 404, not 200."""
    from unittest.mock import patch as mock_patch
    from mylibrary.auth import resolve_user_id

    trait_id = _insert_trait(user_id=LOCAL_USER_ID)

    # Temporarily resolve all requests as a different user.
    # Patch the name as imported into api.py (not the original module) so the
    # current_user dependency sees the replacement.
    with mock_patch("mylibrary.api.resolve_user_id", return_value="other-user-id"):
        with _client() as c:
            resp = c.patch(f"/profile/traits/{trait_id}", json={"status": "confirmed"})

    assert resp.status_code == 404
