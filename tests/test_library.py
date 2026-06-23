"""Tests for in-app re-rating/reviewing and the efficient incremental re-profile.

Covers the write path (set_book_feedback), the dirty/profile-status tracking, and that
update_taste_profile only ships the changed + cited books to Claude — not the whole
library (the whole point of the incremental path).
"""

from __future__ import annotations

from datetime import datetime

import pytest

from mylibrary.db import Book, TasteTrait, session_scope
from mylibrary.ingest import ingest_csv
from mylibrary.library import BookNotFoundError, profile_status, set_book_feedback
from mylibrary.profile import books_changed_since, get_profile_meta, mark_profiled

from .conftest import SAMPLE_CSV


def _book_id(title: str) -> int:
    with session_scope() as session:
        return session.query(Book).filter(Book.title == title).one().id


# --- set_book_feedback ------------------------------------------------------


def test_rerate_overrides_goodreads_and_marks_changed():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Dune")  # imported as 5★
    out = set_book_feedback(bid, rating=3)
    assert out["app_rating"] == 3
    assert out["effective_rating"] == 3  # app_rating wins
    assert out["feedback_updated_at"] is not None


def test_rating_zero_clears_app_rating():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Dune")
    set_book_feedback(bid, rating=2)
    out = set_book_feedback(bid, rating=0)  # clear -> fall back to Goodreads 5
    assert out["app_rating"] is None
    assert out["effective_rating"] == 5


def test_review_set_and_clear():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Recursion")
    out = set_book_feedback(bid, review="  Loved the pacing.  ")
    assert out["app_review"] == "Loved the pacing."
    out = set_book_feedback(bid, clear_review=True)
    assert out["app_review"] is None


def test_invalid_rating_and_empty_update_raise():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Dune")
    with pytest.raises(ValueError):
        set_book_feedback(bid, rating=9)
    with pytest.raises(ValueError):
        set_book_feedback(bid)  # nothing to update


def test_missing_book_raises():
    ingest_csv(SAMPLE_CSV)
    with pytest.raises(BookNotFoundError):
        set_book_feedback(999999, rating=4)


def test_review_never_touched_by_reimport():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Dune")
    set_book_feedback(bid, rating=3, review="A desert classic.")
    ingest_csv(SAMPLE_CSV)  # re-import the Goodreads seed
    with session_scope() as session:
        dune = session.get(Book, bid)
        assert dune.app_rating == 3
        assert dune.app_review == "A desert classic."


# --- profile status / dirty tracking ---------------------------------------


def test_status_dirty_when_feedback_predates_any_profile():
    ingest_csv(SAMPLE_CSV)
    set_book_feedback(_book_id("Dune"), rating=3)
    status = profile_status()
    assert status["dirty"] is True
    assert status["changed_books"] == 1
    assert status["last_profiled_at"] is None


def test_status_clean_after_profiling_then_dirty_again_on_edit():
    ingest_csv(SAMPLE_CSV)
    set_book_feedback(_book_id("Dune"), rating=3)
    # Simulate a profile build completing now.
    with session_scope() as session:
        mark_profiled(session, "full")
    assert profile_status()["dirty"] is False

    # A later edit re-dirties the profile.
    set_book_feedback(_book_id("Recursion"), review="changed my mind")
    status = profile_status()
    assert status["dirty"] is True
    assert _book_id("Recursion") in status["changed_book_ids"]


def test_books_changed_since_excludes_unrated():
    ingest_csv(SAMPLE_CSV)
    # Project Hail Mary is unrated (to-read); a review alone shouldn't make it count.
    set_book_feedback(_book_id("Project Hail Mary"), review="excited to read")
    with session_scope() as session:
        changed = books_changed_since(session, None)
    assert all(b.title != "Project Hail Mary" for b in changed)


# --- incremental re-profile -------------------------------------------------


class _FakeBlock:
    type = "tool_use"

    def __init__(self, payload):
        self.input = payload


class _FakeMessage:
    def __init__(self, blocks):
        self.content = blocks


def _install_fake_anthropic(monkeypatch, captured, traits):
    class _FakeMessages:
        def create(self, **kwargs):
            captured["prompt"] = kwargs["messages"][0]["content"]
            captured["system"] = kwargs["system"]
            return _FakeMessage([_FakeBlock({"traits": traits})])

    class _FakeAnthropic:
        def __init__(self, api_key=None):
            self.messages = _FakeMessages()

    monkeypatch.setattr("anthropic.Anthropic", _FakeAnthropic)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")


def test_update_no_changes_short_circuits(monkeypatch):
    ingest_csv(SAMPLE_CSV)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    # An existing profile, freshly built, with no edits since.
    with session_scope() as session:
        session.add(TasteTrait(claim="x", polarity="reward", exhibits=[], contrasts=[],
                               inference_confidence=0.5, status="proposed"))
        mark_profiled(session, "full")

    from mylibrary.profile import update_taste_profile

    result = update_taste_profile()
    assert result["mode"] == "update"
    assert result["changed_books"] == 0


def test_update_only_sends_changed_and_cited_books(monkeypatch):
    ingest_csv(SAMPLE_CSV)
    dune = _book_id("Dune")
    cited = _book_id("The Three-Body Problem")
    uninvolved = "A Little Life"  # neither changed nor cited -> must NOT be sent

    # Seed an existing profile that cites the "cited" book, built in the past.
    with session_scope() as session:
        session.add(TasteTrait(
            claim="Rewards hard SF", polarity="reward",
            exhibits=[cited], contrasts=[], inference_confidence=0.6, status="proposed",
        ))
        meta = get_profile_meta(session)
        meta.last_profiled_at = datetime(2000, 1, 1)
        meta.last_profile_kind = "full"

    # One edit after the (ancient) profile timestamp.
    set_book_feedback(dune, rating=4, review="Reread holds up.")

    captured = {}
    revised = [{
        "claim": "Rewards hard SF", "polarity": "reward",
        "exhibits": [dune, cited], "contrasts": [], "inference_confidence": 0.8,
    }]
    _install_fake_anthropic(monkeypatch, captured, revised)

    from mylibrary.profile import update_taste_profile

    result = update_taste_profile()
    assert result["mode"] == "update"
    assert result["changed_books"] == 1
    assert result["books_sent"] == 2  # changed (Dune) + cited (Three-Body)

    # Scoping: the changed and cited books are in the prompt; the uninvolved one isn't.
    assert "Dune" in captured["prompt"]
    assert "Three-Body Problem" in captured["prompt"]
    assert uninvolved not in captured["prompt"]

    # The revised trait set replaced the old one and is freshly stamped.
    with session_scope() as session:
        traits = session.query(TasteTrait).filter(TasteTrait.status == "proposed").all()
        assert len(traits) == 1
        assert sorted(traits[0].exhibits) == sorted([dune, cited])
        assert get_profile_meta(session).last_profile_kind == "update"
    assert profile_status()["dirty"] is False
