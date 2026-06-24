"""Tests for the manual add-a-book path: library.add_book + catalog.search_books."""

from __future__ import annotations

import pytest

from mylibrary import catalog
from mylibrary.db import Book, Enrichment, session_scope
from mylibrary.library import BookExistsError, add_book, profile_status


def _get(book_id: int) -> Book:
    with session_scope() as session:
        b = session.get(Book, book_id)
        # touch the relationship so it's loaded before the session closes
        _ = b.enrichment
        return b


def test_add_book_minimal_creates_row():
    book_id = add_book(title="Dune", author="Frank Herbert")
    with session_scope() as session:
        b = session.get(Book, book_id)
        assert b.title == "Dune"
        assert b.author == "Frank Herbert"
        assert b.source == "manual"
        assert b.exclusive_shelf == "read"
        assert b.goodreads_rating == 0
        assert b.effective_rating is None  # unrated by default
        assert b.date_added is not None


def test_add_book_with_rating_sets_app_rating_and_dirties_profile():
    book_id = add_book(title="Dune", author="Frank Herbert", rating=5)
    with session_scope() as session:
        b = session.get(Book, book_id)
        assert b.app_rating == 5
        assert b.effective_rating == 5
        assert b.feedback_updated_at is not None
    # A rated add with no profile yet should report the profile as dirty.
    assert profile_status()["dirty"] is True


def test_add_book_with_review_sets_app_review_and_dirties_profile():
    book_id = add_book(title="Dune", author="Frank Herbert", review="  A desert epic.  ")
    with session_scope() as session:
        b = session.get(Book, book_id)
        assert b.app_review == "A desert epic."  # stripped
        assert b.feedback_updated_at is not None  # a review is a direct taste signal
    # A reviewed (even if unrated) add should report the profile as dirty.
    assert profile_status()["dirty"] is True


def test_add_book_blank_review_is_ignored():
    book_id = add_book(title="Dune", author="Frank Herbert", review="   ")
    with session_scope() as session:
        b = session.get(Book, book_id)
        assert b.app_review is None
        assert b.feedback_updated_at is None


def test_add_book_stores_catalog_pick_as_stub_enrichment():
    book_id = add_book(
        title="Dune",
        author="Frank Herbert",
        year=1965,
        isbn13="9780441172719",
        cover_url="http://example.com/dune.jpg",
        subjects=["Science fiction", "Politics"],
        catalog_source="openlibrary",
        catalog_id="/works/OL1W",
    )
    with session_scope() as session:
        b = session.get(Book, book_id)
        enr = b.enrichment
        assert enr is not None
        assert enr.confidence_label == "MANUAL"
        assert enr.cover_url == "http://example.com/dune.jpg"
        assert enr.subjects == ["Science fiction", "Politics"]
        assert enr.resolved_source == "openlibrary"
        assert enr.resolution_confidence == 1.0


def test_add_book_dedups_on_title_and_surname():
    add_book(title="Dune", author="Frank Herbert")
    # Same work, different casing/subtitle + only-surname author -> treated as duplicate.
    with pytest.raises(BookExistsError):
        add_book(title="DUNE: Special Edition", author="Herbert")


def test_add_book_rejects_bad_shelf_and_rating():
    with pytest.raises(ValueError):
        add_book(title="X", shelf="nonsense")
    with pytest.raises(ValueError):
        add_book(title="X", rating=9)
    with pytest.raises(ValueError):
        add_book(title="   ")  # empty title


def test_add_book_respects_shelf():
    book_id = add_book(title="The Left Hand of Darkness", shelf="to-read")
    assert _get(book_id).exclusive_shelf == "to-read"


# --- catalog.search_books -------------------------------------------------------

_GB_SEARCH = {
    "items": [
        {
            "id": "gb_dune",
            "volumeInfo": {
                "title": "Dune",
                "authors": ["Frank Herbert"],
                "categories": ["Fiction"],
                "imageLinks": {"thumbnail": "gb_dune.jpg"},
                "publishedDate": "1965",
                "industryIdentifiers": [
                    {"type": "ISBN_10", "identifier": "0441172717"},
                    {"type": "ISBN_13", "identifier": "9780441172719"},
                ],
            },
        }
    ]
}

_OL_SEARCH = {
    "docs": [
        {
            "key": "/works/OL1W",
            "title": "Dune",
            "author_name": ["Frank Herbert"],
            "first_publish_year": 1965,
            "cover_i": 111,
            "isbn": ["0441172717", "9780441172719"],
            "subject": ["Science fiction"],
        },
        {
            "key": "/works/OL2W",
            "title": "Dune Messiah",
            "author_name": ["Frank Herbert"],
            "first_publish_year": 1969,
            "cover_i": 222,
            "isbn": ["9780593098233"],
            "subject": ["Science fiction"],
        },
    ]
}


def test_search_books_merges_dedups_and_extracts_isbn13(monkeypatch):
    def fake_get_json(url, **kwargs):
        if "googleapis.com" in url:
            return _GB_SEARCH
        if "openlibrary.org/search.json" in url:
            return _OL_SEARCH
        return None

    monkeypatch.setattr(catalog, "_get_json", fake_get_json)

    results = catalog.search_books("dune")
    titles = [r["title"] for r in results]

    # "Dune" appears in both sources but is de-duplicated; "Dune Messiah" survives.
    assert titles.count("Dune") == 1
    assert "Dune Messiah" in titles

    dune = next(r for r in results if r["title"] == "Dune")
    assert dune["isbn13"] == "9780441172719"
    assert dune["cover_url"]  # has a cover (preferred to the front)


def test_search_books_empty_query_returns_empty():
    assert catalog.search_books("   ") == []
