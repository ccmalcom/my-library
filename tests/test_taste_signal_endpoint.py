"""Tests for Task 3.3: POST /taste-signal (more/less like this).

Covers:
1. book/more with a real book id persists and dirties the profile
2. book kind with a foreign (other user's) book id -> 404
3. rec/less with a snapshot persists
4. Bad direction value -> 422
5. book kind without target_book_id -> 422
6. rec kind without snapshot -> 422
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from mylibrary.api import app
from mylibrary.db import Book, TasteSignal, session_scope, LOCAL_USER_ID, init_db
from mylibrary.profile import get_profile_meta


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _client():
    return TestClient(app)


def _insert_book(user_id: str = LOCAL_USER_ID, title: str = "Test Book") -> int:
    """Insert a minimal Book row and return its id."""
    init_db()
    with session_scope() as s:
        book = Book(
            user_id=user_id,
            title=title,
            goodreads_rating=4,
        )
        s.add(book)
        s.flush()
        return book.id


# ---------------------------------------------------------------------------
# 1. book/more persists and dirties profile
# ---------------------------------------------------------------------------

def test_book_more_persists_and_dirties_profile():
    book_id = _insert_book()
    with _client() as c:
        resp = c.post(
            "/taste-signal",
            json={"direction": "more", "target_kind": "book", "target_book_id": book_id},
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["direction"] == "more"
    assert body["target_kind"] == "book"
    assert body["target_book_id"] == book_id

    # Verify persisted in DB
    with session_scope() as s:
        signal = s.get(TasteSignal, body["id"])
        assert signal is not None
        assert signal.direction == "more"
        assert signal.target_book_id == book_id

    # Verify profile is dirty
    with session_scope() as s:
        meta = get_profile_meta(s, LOCAL_USER_ID)
        assert meta.rec_feedback_updated_at is not None


# ---------------------------------------------------------------------------
# 2. book kind with foreign book id -> 404
# ---------------------------------------------------------------------------

def test_book_foreign_id_returns_404():
    # Insert a book for a different user
    other_book_id = _insert_book(user_id="other-user", title="Other Book")
    with _client() as c:
        resp = c.post(
            "/taste-signal",
            json={"direction": "more", "target_kind": "book", "target_book_id": other_book_id},
        )
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# 3. rec/less with snapshot persists
# ---------------------------------------------------------------------------

def test_rec_less_with_snapshot_persists():
    snapshot = {"title": "Dune", "author": "Frank Herbert", "subjects": ["sci-fi"]}
    with _client() as c:
        resp = c.post(
            "/taste-signal",
            json={"direction": "less", "target_kind": "rec", "snapshot": snapshot},
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["direction"] == "less"
    assert body["target_kind"] == "rec"
    assert body["snapshot"] == snapshot
    assert body["target_book_id"] is None

    # Verify persisted
    with session_scope() as s:
        signal = s.get(TasteSignal, body["id"])
        assert signal is not None
        assert signal.snapshot["title"] == "Dune"


# ---------------------------------------------------------------------------
# 4. Bad direction -> 422
# ---------------------------------------------------------------------------

def test_bad_direction_returns_422():
    with _client() as c:
        resp = c.post(
            "/taste-signal",
            json={"direction": "meh", "target_kind": "book", "target_book_id": 1},
        )
    # Pydantic validation catches the bad literal before we even hit the endpoint
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# 5. book kind without target_book_id -> 422
# ---------------------------------------------------------------------------

def test_book_kind_without_id_returns_422():
    with _client() as c:
        resp = c.post(
            "/taste-signal",
            json={"direction": "more", "target_kind": "book"},
        )
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# 6. rec kind without snapshot -> 422
# ---------------------------------------------------------------------------

def test_rec_kind_without_snapshot_returns_422():
    with _client() as c:
        resp = c.post(
            "/taste-signal",
            json={"direction": "less", "target_kind": "rec"},
        )
    assert resp.status_code == 422, resp.text
