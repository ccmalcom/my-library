"""Tests for PATCH /recommendations/{id}/feedback (Phase 6).

Covers:
  - accept: Book + stub Enrichment created, status updated
  - accept is idempotent (second PATCH doesn't create a duplicate Book)
  - reject: status updated, no Book created
  - user_note is persisted
  - 404 on unknown id
  - 422 on invalid status value
  - rejected recs are excluded from future recommend dedup
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from mylibrary.api import app
from mylibrary.db import Book, Enrichment, Recommendation, session_scope


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_rec(**overrides) -> int:
    """Insert a minimal Recommendation row and return its id."""
    defaults = dict(
        run_id="testrun",
        rank=1,
        title="The Left Hand of Darkness",
        author="Ursula K. Le Guin",
        year=1969,
        isbn13="9780441478125",
        cover_url="https://example.com/cover.jpg",
        subjects=["Science Fiction", "Gender"],
        catalog_source="googlebooks",
        catalog_id="gb_lhd",
        retrieval_pool="metadata",
        seed_reason="subject:science fiction",
        score=0.92,
        rationale="Matches your love of literary SF.",
        grounded_trait_ids=[1],
        grounded_book_ids=[2],
        status="served",
    )
    defaults.update(overrides)
    with session_scope() as session:
        rec = Recommendation(**defaults)
        session.add(rec)
        session.flush()
        return rec.id


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

def test_accept_creates_book_and_enrichment():
    rec_id = _make_rec()
    with TestClient(app) as client:
        resp = client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "accepted"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "accepted"

    with session_scope() as session:
        book = session.query(Book).filter(Book.title == "The Left Hand of Darkness").one()
        assert book.exclusive_shelf == "to-read"
        assert book.source == "recommendation"
        assert book.goodreads_rating == 0
        assert book.author == "Ursula K. Le Guin"
        assert book.isbn13 == "9780441478125"
        assert book.year_published == 1969

        enr = session.query(Enrichment).filter(Enrichment.book_id == book.id).one()
        assert enr.confidence_label == "RECOMMENDATION"
        assert enr.cover_url == "https://example.com/cover.jpg"
        assert enr.subjects == ["Science Fiction", "Gender"]
        assert enr.resolved_source == "googlebooks"


def test_accept_is_idempotent():
    """Second accept on the same rec must not create a duplicate Book."""
    rec_id = _make_rec()
    with TestClient(app) as client:
        client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "accepted"})
        resp = client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "accepted"})
    assert resp.status_code == 200

    with session_scope() as session:
        count = (
            session.query(Book)
            .filter(Book.title == "The Left Hand of Darkness")
            .count()
        )
        assert count == 1


def test_already_read_creates_read_book_and_returns_it():
    """'already read' must land the book on the read shelf (so it's never recommended
    again) and return it so the UI can prompt a review."""
    rec_id = _make_rec()
    with TestClient(app) as client:
        resp = client.patch(
            f"/recommendations/{rec_id}/feedback", json={"status": "already_read"}
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "already_read"
    assert data["book"] is not None
    assert data["book"]["exclusive_shelf"] == "read"
    assert data["book"]["app_rating"] is None  # unrated until the user reviews it

    with session_scope() as session:
        book = session.query(Book).filter(Book.title == "The Left Hand of Darkness").one()
        assert book.exclusive_shelf == "read"
        assert book.source == "recommendation"


def test_already_read_excludes_book_from_future_recommend_dedup():
    from mylibrary.recommend import _build_signal, _dedup_key

    rec_id = _make_rec()
    with TestClient(app) as client:
        client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "already_read"})

    with session_scope() as session:
        signal = _build_signal(session)

    key = _dedup_key("The Left Hand of Darkness", "Ursula K. Le Guin")
    assert key in signal["library_keys"]


def test_already_read_is_idempotent():
    rec_id = _make_rec()
    with TestClient(app) as client:
        client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "already_read"})
        resp = client.patch(
            f"/recommendations/{rec_id}/feedback", json={"status": "already_read"}
        )
    assert resp.status_code == 200
    with session_scope() as session:
        count = (
            session.query(Book)
            .filter(Book.title == "The Left Hand of Darkness")
            .count()
        )
        assert count == 1


def test_reject_updates_status_no_book_created():
    rec_id = _make_rec()
    with TestClient(app) as client:
        resp = client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "rejected"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"

    with session_scope() as session:
        assert session.query(Book).count() == 0


def test_user_note_is_persisted():
    rec_id = _make_rec()
    with TestClient(app) as client:
        resp = client.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"status": "rejected", "user_note": "Already read this one."},
        )
    assert resp.status_code == 200
    assert resp.json()["user_note"] == "Already read this one."

    with session_scope() as session:
        rec = session.get(Recommendation, rec_id)
        assert rec.user_note == "Already read this one."


def test_user_note_can_be_cleared_with_null():
    rec_id = _make_rec(user_note="Already read this one.")
    with TestClient(app) as client:
        resp = client.patch(
            f"/recommendations/{rec_id}/feedback",
            json={"user_note": None},
        )
    assert resp.status_code == 200
    assert resp.json()["user_note"] is None

    with session_scope() as session:
        rec = session.get(Recommendation, rec_id)
        assert rec.user_note is None


def test_404_on_unknown_id():
    with TestClient(app) as client:
        resp = client.patch("/recommendations/99999/feedback", json={"status": "rejected"})
    assert resp.status_code == 404


def test_422_on_invalid_status():
    rec_id = _make_rec()
    with TestClient(app) as client:
        resp = client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "maybe"})
    assert resp.status_code == 422


def test_rejected_rec_excluded_from_dedup():
    """After rejecting a rec, its dedup key must appear in _build_signal's library_keys."""
    from mylibrary.recommend import _build_signal, _dedup_key

    rec_id = _make_rec()
    with TestClient(app) as client:
        client.patch(f"/recommendations/{rec_id}/feedback", json={"status": "rejected"})

    with session_scope() as session:
        signal = _build_signal(session)

    key = _dedup_key("The Left Hand of Darkness", "Ursula K. Le Guin")
    assert key in signal["library_keys"]
