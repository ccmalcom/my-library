"""Wave 2 — multi-format import core + parsers."""
from __future__ import annotations

import os

from mylibrary.db import Book, session_scope
from mylibrary.importers.core import (
    ImportRow,
    clean_isbn,
    import_rows,
    normalize_shelf,
    parse_rating,
)
from mylibrary.importers.formats import (
    SOURCE_FOR,
    detect_format,
    import_text,
    parse_canonical,
    parse_generic,
    parse_goodreads,
    parse_storygraph,
    suggest_mapping,
)

from .conftest import SAMPLE_CSV

STORYGRAPH_CSV = os.path.join(os.path.dirname(__file__), "sample_storygraph.csv")
CANONICAL_CSV = os.path.join(os.path.dirname(__file__), "sample_canonical.csv")
GENERIC_CSV = os.path.join(os.path.dirname(__file__), "sample_generic.csv")


def test_parse_goodreads_matches_legacy_counts():
    text = open(SAMPLE_CSV, encoding="utf-8-sig").read()
    parsed = parse_goodreads(text)
    assert parsed.format == "goodreads"
    assert parsed.total_rows == 6
    assert parsed.skipped == 0
    assert len(parsed.rows) == 6
    dune = next(r for r in parsed.rows if r.title == "Dune")
    assert dune.isbn13 == "9780441172719"
    assert dune.external_id  # Goodreads Book Id preserved
    assert SOURCE_FOR["goodreads"] == "goodreads_import"


def test_parse_rating_rounds_half_up_and_clamps():
    assert parse_rating("4.5") == 5
    assert parse_rating("4.4") == 4
    assert parse_rating("3") == 3
    assert parse_rating("") is None
    assert parse_rating("0") is None
    assert parse_rating("not a number") is None
    assert parse_rating("9") == 5  # clamp high
    assert parse_rating("0.4") is None  # rounds to 0 -> unrated


def test_normalize_shelf_maps_synonyms():
    assert normalize_shelf("read") == "read"
    assert normalize_shelf("to-read") == "to-read"
    assert normalize_shelf("want to read") == "to-read"
    assert normalize_shelf("currently reading") == "currently-reading"
    assert normalize_shelf("DNF") == "did-not-finish"
    assert normalize_shelf("did not finish") == "did-not-finish"
    assert normalize_shelf("") is None
    assert normalize_shelf("some nonsense") is None


def test_clean_isbn_reused():
    assert clean_isbn('="9780441172719"') == "9780441172719"
    assert clean_isbn("") is None


def test_import_rows_inserts_and_seeds_review_with_rating():
    rows = [
        ImportRow(title="Dune", author="Frank Herbert", rating=5,
                  review="A masterpiece.", shelf="read", isbn13="9780441172719"),
        ImportRow(title="Unrated Book", author="Jane Doe", review="ignored no rating"),
    ]
    out = import_rows(rows, source="storygraph_import")
    assert out["inserted"] == 2
    assert out["rated"] == 1
    with session_scope() as session:
        dune = session.query(Book).filter(Book.title == "Dune").one()
        assert dune.goodreads_rating == 5        # imported rating seeds goodreads_rating
        assert dune.app_rating is None
        assert dune.app_review == "A masterpiece."
        assert dune.source == "storygraph_import"
        ub = session.query(Book).filter(Book.title == "Unrated Book").one()
        assert ub.app_review is None              # review dropped: no rating


def test_import_rows_dedups_by_title_surname_and_preserves_app_rating():
    import_rows([ImportRow(title="Dune", author="Frank Herbert", rating=5)],
                source="goodreads_import")
    with session_scope() as session:
        session.query(Book).filter(Book.title == "Dune").one().app_rating = 2
    out = import_rows([ImportRow(title="dune", author="Herbert", rating=4, shelf="read")],
                      source="storygraph_import")
    assert out["inserted"] == 0 and out["updated"] == 1
    with session_scope() as session:
        dune = session.query(Book).filter(Book.title == "Dune").one()
        assert dune.app_rating == 2               # never clobbered
        assert dune.effective_rating == 2
        assert dune.exclusive_shelf == "read"     # import-owned field updated


def test_import_rows_dedups_by_isbn():
    import_rows([ImportRow(title="Old Title", isbn13="9780441172719", rating=3)],
                source="canonical_import")
    out = import_rows([ImportRow(title="Different Title", isbn13="9780441172719", rating=4)],
                      source="canonical_import")
    assert out["updated"] == 1 and out["inserted"] == 0


def test_import_rows_dedups_duplicate_external_id_within_batch():
    out = import_rows(
        [
            ImportRow(title="Dune", author="Frank Herbert", rating=5, external_id="42"),
            ImportRow(title="Dune (reshelved)", author="Frank Herbert", shelf="read",
                      external_id="42"),
        ],
        source="goodreads_import",
    )
    assert out["inserted"] == 1 and out["updated"] == 1
    with session_scope() as session:
        book = session.query(Book).filter(Book.goodreads_book_id == "42").one()
        assert book.exclusive_shelf == "read"  # second row's import-owned field applied


def test_parse_storygraph_maps_fields():
    text = open(STORYGRAPH_CSV, encoding="utf-8-sig").read()
    parsed = parse_storygraph(text)
    assert parsed.format == "storygraph"
    assert parsed.total_rows == 4 and parsed.skipped == 0
    dune = next(r for r in parsed.rows if r.title == "Dune")
    assert dune.rating == 5              # 4.5 rounds half-up
    assert dune.review == "Sweeping and strange."
    assert dune.shelf == "read"
    assert dune.isbn13 == "9780441172719"
    assert dune.external_id is None
    fifth = next(r for r in parsed.rows if r.title == "The Fifth Season")
    assert fifth.rating is None          # empty Star Rating
    assert fifth.shelf == "to-read"
    assert fifth.isbn13 is None          # non-ISBN UID dropped


def test_detect_format_sniffs_headers():
    assert detect_format(["Book Id", "Title", "Exclusive Shelf", "My Rating"]) == "goodreads"
    assert detect_format(["Title", "Authors", "Read Status", "Star Rating"]) == "storygraph"
    assert detect_format(["title", "author", "shelf", "rating", "review"]) == "canonical"
    assert detect_format(["Book Title", "My Stars", "Notes"]) == "unknown"


def test_parse_canonical_roundtrip_fields():
    parsed = parse_canonical(open(CANONICAL_CSV, encoding="utf-8-sig").read())
    assert parsed.format == "canonical" and parsed.total_rows == 2
    dune = next(r for r in parsed.rows if r.title == "Dune")
    assert dune.rating == 5 and dune.review == "Sweeping."
    assert dune.page_count == 412 and dune.year_published == 1965


def test_suggest_mapping_guesses_headers():
    m = suggest_mapping(["Book Title", "Writer", "My Stars", "Notes", "Status"])
    assert m["title"] == "Book Title"
    assert m["rating"] == "My Stars"
    assert m["review"] == "Notes"
    assert m["shelf"] == "Status"


def test_parse_generic_with_mapping():
    text = open(GENERIC_CSV, encoding="utf-8-sig").read()
    mapping = {"title": "Book Title", "author": "Writer", "rating": "My Stars",
               "review": "Notes", "shelf": "Status"}
    parsed = parse_generic(text, mapping)
    assert parsed.format == "generic" and parsed.total_rows == 2
    dune = next(r for r in parsed.rows if r.title == "Dune")
    assert dune.rating == 5 and dune.shelf == "read"
    fifth = next(r for r in parsed.rows if r.title == "The Fifth Season")
    assert fifth.shelf == "to-read"      # 'Want to read' normalized


def test_import_text_auto_detects_and_imports():
    out = import_text(open(STORYGRAPH_CSV, encoding="utf-8-sig").read(), fmt="auto")
    assert out["format"] == "storygraph"
    assert out["inserted"] == 4


def test_import_text_unknown_without_mapping_raises():
    import pytest
    with pytest.raises(ValueError):
        import_text(open(GENERIC_CSV, encoding="utf-8-sig").read(), fmt="auto")
