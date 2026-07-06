"""Tests for the series-position gate (Bug: recommender surfacing book N of a
series the reader hasn't started, e.g. book 7 with none of books 1-6 owned).
Pure-function tests plus an `_assemble`-level integration test -- no live
network, no Claude calls, matching test_recommend_author_cap.py /
test_recommend_language.py.
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


def test_series_info_parses_hash_and_book_markers():
    assert recommend._series_info("The Bands of Mourning (Mistborn, #6)") == ("mistborn", 6)
    assert recommend._series_info(
        "Words of Radiance (The Stormlight Archive, Book 2)"
    ) == ("the stormlight archive", 2)


def test_series_info_none_when_no_marker():
    assert recommend._series_info("Dune") is None
    assert recommend._series_info("1984 (Signet Classics)") is None
    assert recommend._series_info(None) is None


def test_series_ok_allows_book_one_and_unmarked_titles():
    assert recommend._series_ok("Dune", {}) is True
    assert recommend._series_ok("The Way of Kings (The Stormlight Archive, #1)", {}) is True


def test_series_ok_blocks_unowned_continuation():
    # Reader owns nothing tagged "mistborn" -> book 6 is blocked.
    assert recommend._series_ok("The Bands of Mourning (Mistborn, #6)", {}) is False


def test_series_ok_allows_continuation_when_earlier_volume_owned():
    library_series = {"mistborn": {1, 2}}
    assert recommend._series_ok("The Bands of Mourning (Mistborn, #6)", library_series) is True


def test_assemble_drops_unread_series_continuation():
    signal = {
        "library_keys": set(),
        "library_isbns": set(),
        "library_titles": [],
        "library_series": {},
    }
    metadata = [
        (_cand("The Bands of Mourning (Mistborn, #6)", "Brandon Sanderson"), "subject:Fantasy"),
    ]
    out = recommend._assemble(metadata, [], signal, cap=50)
    assert out == []


def test_assemble_keeps_series_continuation_when_earlier_volume_owned():
    signal = {
        "library_keys": set(),
        "library_isbns": set(),
        "library_titles": [],
        "library_series": {"mistborn": {1}},
    }
    metadata = [
        (_cand("The Bands of Mourning (Mistborn, #6)", "Brandon Sanderson"), "subject:Fantasy"),
    ]
    out = recommend._assemble(metadata, [], signal, cap=50)
    assert len(out) == 1
    assert out[0]["title"] == "The Bands of Mourning (Mistborn, #6)"
