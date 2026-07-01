"""Wave 2 — multi-format import core + parsers."""
from __future__ import annotations

from mylibrary.db import Book, session_scope
from mylibrary.importers.core import (
    ImportRow,
    clean_isbn,
    import_rows,
    normalize_shelf,
    parse_rating,
)


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
