"""Tests for in-app re-rating/reviewing and the efficient incremental re-profile.

Covers the write path (set_book_feedback), the dirty/profile-status tracking, and that
update_taste_profile only ships the changed + cited books to Claude — not the whole
library (the whole point of the incremental path).
"""

from __future__ import annotations

from datetime import date, datetime

import pytest

from mylibrary.db import Book, Enrichment, TasteTrait, session_scope
from mylibrary.ingest import ingest_csv
from mylibrary.library import (
    BookNotFoundError,
    add_book,
    profile_status,
    remove_book,
    set_book_feedback,
    set_book_shelf,
)
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


def test_set_date_read():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Recursion")
    out = set_book_feedback(bid, rating=4, date_read=date(2024, 5, 1))
    assert out["date_read"] == date(2024, 5, 1)
    with session_scope() as session:
        assert session.get(Book, bid).date_read == date(2024, 5, 1)


def test_date_read_alone_counts_as_an_update():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Recursion")
    out = set_book_feedback(bid, date_read=date(2023, 1, 2))
    assert out["date_read"] == date(2023, 1, 2)
    assert out["feedback_updated_at"] is not None


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


# --- shelf moves / removal --------------------------------------------------


def test_set_shelf_moves_book_without_dirtying_profile():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Project Hail Mary")  # starts on to-read
    out = set_book_shelf(bid, "currently-reading")
    assert out["exclusive_shelf"] == "currently-reading"
    # A shelf move is not a taste signal -> profile stays clean.
    assert out["feedback_updated_at"] is None
    assert profile_status()["dirty"] is False


def test_set_shelf_rejects_unknown_shelf():
    ingest_csv(SAMPLE_CSV)
    with pytest.raises(ValueError):
        set_book_shelf(_book_id("Dune"), "wishlist")


def test_remove_book_deletes_row_and_enrichment():
    ingest_csv(SAMPLE_CSV)
    bid = _book_id("Project Hail Mary")
    with session_scope() as session:
        session.add(Enrichment(book_id=bid, resolution_confidence=1.0))
    out = remove_book(bid)
    assert out["removed"] is True
    with session_scope() as session:
        assert session.get(Book, bid) is None
        assert session.query(Enrichment).filter(Enrichment.book_id == bid).count() == 0


def test_remove_missing_book_raises():
    ingest_csv(SAMPLE_CSV)
    with pytest.raises(BookNotFoundError):
        remove_book(999999)


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
    # Project Hail Mary is unrated (to-read). Touching only its date-read bumps feedback
    # but leaves it unrated, so it must not count as a changed (taste) signal. (A review
    # can't be used here — reviewing an unrated book is rejected; see the test below.)
    set_book_feedback(_book_id("Project Hail Mary"), date_read=date(2024, 1, 1))
    with session_scope() as session:
        changed = books_changed_since(session, None)
    assert all(b.title != "Project Hail Mary" for b in changed)


def test_review_requires_rating():
    ingest_csv(SAMPLE_CSV)
    # Project Hail Mary is unrated — a review alone must be rejected.
    with pytest.raises(ValueError):
        set_book_feedback(_book_id("Project Hail Mary"), review="excited to read")
    # Supplying a rating in the same call is allowed.
    out = set_book_feedback(
        _book_id("Project Hail Mary"), rating=5, review="Loved it."
    )
    assert out["app_rating"] == 5
    assert out["app_review"] == "Loved it."


# --- recommender signal (regression) ---------------------------------------


def test_build_signal_collects_loved_books_without_any_rejections():
    """Regression: loved-book collection must run in the main book loop, not under the
    rejected-recommendations loop. With no rejected recs, loved must still be populated."""
    from mylibrary.recommend import _build_signal

    ingest_csv(SAMPLE_CSV)
    with session_scope() as session:
        signal = _build_signal(session)

    # Sample CSV has three books rated >= 4: Dune (5), Three-Body (4), Name of the Wind (5).
    titles = {b["title"] for b in signal["loved"]}
    assert titles == {"Dune", "The Three-Body Problem", "The Name of the Wind"}
    assert all(b["rating"] >= 4 for b in signal["loved"])


def test_build_signal_respects_app_rating_override():
    """A loved Goodreads book re-rated below 4 in-app drops out of the loved set."""
    from mylibrary.recommend import _build_signal

    ingest_csv(SAMPLE_CSV)
    set_book_feedback(_book_id("Dune"), rating=2)  # was 5★ from Goodreads
    with session_scope() as session:
        signal = _build_signal(session)

    titles = {b["title"] for b in signal["loved"]}
    assert "Dune" not in titles


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


def test_dnf_book_can_be_reviewed_without_rating():
    """DNF books are exempt from the review-requires-rating invariant."""
    book_id = add_book(title="Quit This One", author="Author X", shelf="to-read")
    set_book_shelf(book_id, "did-not-finish")
    # Should not raise — DNF books may carry a review without a rating
    result = set_book_feedback(book_id, review="Couldn't get past chapter 2.")
    assert result["app_review"] == "Couldn't get past chapter 2."
    assert result["effective_rating"] is None


def test_list_books_does_not_n_plus_one_on_enrichment():
    """Eager-loading enrichment keeps SQL execute count flat as rows grow."""
    from sqlalchemy import event
    from mylibrary.db import Book, Enrichment, _ensure_engine, session_scope
    from mylibrary.api import list_books
    from mylibrary.config import LOCAL_USER_ID

    # Seed 20 read books, each with an enrichment row.
    with session_scope() as session:
        for i in range(20):
            b = Book(
                user_id=LOCAL_USER_ID,
                title=f"Book {i}",
                author="A",
                exclusive_shelf="read",
                goodreads_rating=4,
            )
            session.add(b)
            session.flush()
            session.add(Enrichment(book_id=b.id, resolution_confidence=1.0, cover_url=f"http://x/{i}.jpg"))

    engine, _ = _ensure_engine()
    counter = {"n": 0}

    def _count(conn, cursor, statement, params, context, executemany):
        counter["n"] += 1

    event.listen(engine, "after_cursor_execute", _count)
    try:
        out = list_books(user_id=LOCAL_USER_ID, shelf="read", limit=500)
    finally:
        event.remove(engine, "after_cursor_execute", _count)

    assert len(out) == 20
    assert all(b.cover_url is not None for b in out)
    # With a lazy relationship this is ~21 (1 list + 20 per-row). Eager join => a small
    # constant. Allow generous headroom but well under the per-row blowup.
    assert counter["n"] <= 5, f"expected eager load, got {counter['n']} queries"
