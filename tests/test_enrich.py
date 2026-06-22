"""Tests for enrichment matching/confidence logic (no network calls)."""

from __future__ import annotations

from mylibrary.db import Book
from mylibrary.enrich import _normalize_title, _score_candidates, _title_sim


def _book(title, author=None, isbn13=None):
    return Book(title=title, author=author, isbn13=isbn13, goodreads_rating=5)


def test_normalize_title_drops_subtitle_and_punctuation():
    assert _normalize_title("The Lord of the Rings: The Fellowship") == "the lord of the rings"
    assert _normalize_title("Dune (Special Edition)") == "dune"
    assert _normalize_title("The Three-Body Problem") == "the three body problem"


def test_title_sim_is_high_for_near_match():
    assert _title_sim("The Name of the Wind", "Name of the Wind, The") > 0.6


def test_strong_unique_match_scores_medium():
    book = _book("The Name of the Wind", "Patrick Rothfuss")
    candidates = [
        {"title": "The Name of the Wind", "author": "Patrick Rothfuss", "source": "openlibrary"},
        {"title": "Wise Man's Fear", "author": "Patrick Rothfuss", "source": "openlibrary"},
    ]
    cand, label = _score_candidates(book, candidates)
    assert label == "MEDIUM"
    assert cand["title"] == "The Name of the Wind"


def test_ambiguous_common_title_scores_low():
    book = _book("Recursion", "Blake Crouch")
    candidates = [
        {"title": "Recursion", "author": "Tony Ballantyne", "source": "openlibrary"},
        {"title": "Recursion", "author": "Blake Crouch", "source": "openlibrary"},
    ]
    cand, label = _score_candidates(book, candidates)
    assert label == "LOW"


def test_weak_match_scores_low():
    book = _book("A Little Life", "Hanya Yanagihara")
    candidates = [{"title": "Life After Life", "author": "Kate Atkinson", "source": "openlibrary"}]
    cand, label = _score_candidates(book, candidates)
    assert label == "LOW"


def test_no_candidates_scores_none():
    book = _book("Some Obscure Title")
    cand, label = _score_candidates(book, [])
    assert cand is None
    assert label == "NONE"
