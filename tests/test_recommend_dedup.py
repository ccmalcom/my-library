"""Tests for the edition/duplicate gate (Bug: recommender suggesting a
graded-reader/ESL edition of a book the reader already rated 5 stars, with
Claude's own rationale admitting "this is a reread" -- but nothing upstream
of Claude ever excluded it). Pure-function tests plus `_assemble`-level
integration tests -- no live network, no Claude calls.
"""

from mylibrary import recommend


def _cand(title, author=None, source="googlebooks", subjects=None, year=None):
    return {
        "source": source,
        "resolved_id": f"id-{title}",
        "title": title,
        "author": author,
        "subjects": subjects or [],
        "cover_url": None,
        "year": year,
        "raw": {},
    }


def test_fuzzy_duplicate_matches_same_title_different_author_field():
    # The graded-reader edition is credited to an ELT adapter, not Mary Shelley --
    # the exact (title, author-surname) key would miss this, so title alone must catch it.
    assert recommend._fuzzy_duplicate(
        "Frankenstein: A Graded Reader for Russian Students of English",
        ["Frankenstein"],
    ) is True


def test_fuzzy_duplicate_false_for_unrelated_titles():
    assert recommend._fuzzy_duplicate("Anathem", ["Frankenstein"]) is False


def test_fuzzy_duplicate_false_for_empty_title_or_library():
    assert recommend._fuzzy_duplicate(None, ["Frankenstein"]) is False
    assert recommend._fuzzy_duplicate("Frankenstein", []) is False


def test_is_learner_edition_flags_graded_reader_by_title():
    cand = _cand("Frankenstein: A Graded Reader for Russian Students of English", "ELT Adapter")
    assert recommend._is_learner_edition(cand) is True


def test_is_learner_edition_flags_by_subject_heading():
    cand = _cand(
        "Great Expectations",
        "Charles Dickens",
        subjects=["English language--Textbooks for foreign speakers"],
    )
    assert recommend._is_learner_edition(cand) is True


def test_is_learner_edition_false_for_ordinary_book():
    cand = _cand("Frankenstein", "Mary Shelley", subjects=["Gothic fiction"])
    assert recommend._is_learner_edition(cand) is False


def test_assemble_drops_learner_edition_even_when_never_owned():
    # Not a dedup case at all (title never appeared in the library) -- still
    # not a genuine discovery, so it's dropped outright.
    signal = {"library_keys": set(), "library_isbns": set(), "library_titles": [], "library_series": {}}
    metadata = [
        (
            _cand("Oliver Twist: A Graded Reader for Russian Students of English", "ELT Adapter"),
            "subject:Classics",
        ),
    ]
    out = recommend._assemble(metadata, [], signal, cap=50)
    assert out == []


def test_assemble_drops_fuzzy_duplicate_of_owned_book():
    signal = {
        "library_keys": set(),  # exact (title, author) key deliberately empty/mismatched
        "library_isbns": set(),
        "library_titles": ["Frankenstein"],
        "library_series": {},
    }
    metadata = [
        (_cand("Frankenstein: A Norton Critical Edition", "Someone Else"), "subject:Classics"),
    ]
    out = recommend._assemble(metadata, [], signal, cap=50)
    assert out == []
