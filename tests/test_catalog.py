"""Tests for catalog response parsing (no live network — _get_json is patched)."""

from __future__ import annotations

from mylibrary import catalog

_OL_BOOKS_PAYLOAD = {
    "ISBN:9780441172719": {
        "key": "/books/OL1M",
        "title": "Dune",
        "subjects": [
            {"name": "Science fiction", "url": "x"},
            {"name": "Politics", "url": "x"},
        ],
        "cover": {"small": "s.jpg", "medium": "m.jpg", "large": "l.jpg"},
        "description": "A desert planet and its spice.",
    }
}

_GB_PAYLOAD = {
    "items": [
        {
            "id": "gb123",
            "volumeInfo": {
                "title": "Dune",
                "authors": ["Frank Herbert"],
                "categories": ["Fiction / Science Fiction"],
                "description": "Spice.",
                "imageLinks": {"thumbnail": "t.jpg"},
                "publishedDate": "1965-08-01",
            },
        }
    ]
}


def test_openlibrary_by_isbn_parses_record(monkeypatch):
    monkeypatch.setattr(catalog, "_get_json", lambda url, **k: _OL_BOOKS_PAYLOAD)
    rec = catalog.openlibrary_by_isbn("9780441172719")
    assert rec is not None
    assert rec["title"] == "Dune"
    assert rec["subjects"] == ["Science fiction", "Politics"]
    assert rec["cover_url"] == "m.jpg"
    assert rec["description"] == "A desert planet and its spice."
    assert rec["source"] == "openlibrary"


def test_openlibrary_by_isbn_missing_returns_none(monkeypatch):
    monkeypatch.setattr(catalog, "_get_json", lambda url, **k: None)
    assert catalog.openlibrary_by_isbn("0000000000000") is None


def test_googlebooks_by_isbn_parses_volume(monkeypatch):
    monkeypatch.setattr(catalog, "_get_json", lambda url, **k: _GB_PAYLOAD)
    rec = catalog.googlebooks_by_isbn("9780441172719")
    assert rec is not None
    assert rec["title"] == "Dune"
    assert rec["author"] == "Frank Herbert"
    assert rec["year"] == 1965
    assert rec["subjects"] == ["Fiction / Science Fiction"]
