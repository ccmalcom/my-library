"""Contract tests for PATCH /books/{book_id}/enrichment (Wave 3c fix-match queue).

Mirrors test_similar_endpoint.py's TestClient harness.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from mylibrary import catalog
from mylibrary.api import app
from mylibrary.db import LOCAL_USER_ID, Book, Enrichment, init_db, session_scope


def _client():
    return TestClient(app)


def _insert_book(user_id: str = LOCAL_USER_ID, title: str = "Dune") -> int:
    init_db()
    with session_scope() as s:
        b = Book(user_id=user_id, title=title, author="Frank Herbert", goodreads_rating=5)
        s.add(b)
        s.flush()
        s.add(Enrichment(
            book_id=b.id, subjects=["Wrong genre"], description="Wrong synopsis.",
            resolution_confidence=0.30, confidence_label="LOW",
        ))
        return b.id


def test_correct_enrichment_happy_path():
    book_id = _insert_book()
    with _client() as c:
        r = c.patch(
            f"/books/{book_id}/enrichment",
            json={
                "catalog_source": "openlibrary",
                "catalog_id": "/works/OL1W",
                "cover_url": "http://correct/cover.jpg",
                "subjects": ["Science fiction"],
                "description": "The real synopsis.",
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["confidence_label"] == "CORRECTED"
    assert body["resolution_confidence"] == 1.0
    assert body["cover_url"] == "http://correct/cover.jpg"
    assert body["description"] == "The real synopsis."
    assert body["title"] == "Dune"  # book's own title untouched


def test_correct_enrichment_unknown_book_404():
    with _client() as c:
        r = c.patch(
            "/books/999999/enrichment",
            json={"catalog_source": "openlibrary", "catalog_id": "/works/OL1W"},
        )
    assert r.status_code == 404


def test_correct_enrichment_requires_catalog_source_and_id():
    book_id = _insert_book()
    with _client() as c:
        r = c.patch(f"/books/{book_id}/enrichment", json={})
    assert r.status_code == 422  # pydantic: catalog_source/catalog_id are required fields


def test_correct_enrichment_blank_catalog_id_422():
    book_id = _insert_book()
    with _client() as c:
        r = c.patch(
            f"/books/{book_id}/enrichment",
            json={"catalog_source": "openlibrary", "catalog_id": "   "},
        )
    assert r.status_code == 422


def test_catalog_search_passes_through_description(monkeypatch):
    def fake_search(q, *, max_results=8):
        return [{
            "source": "googlebooks", "resolved_id": "gb1", "title": "Dune",
            "author": "Frank Herbert", "cover_url": "c.jpg",
            "subjects": ["Science fiction"], "description": "A desert planet epic.",
            "year": 1965, "isbn13": "9780441172719",
        }]

    monkeypatch.setattr(catalog, "search_books", fake_search)
    with _client() as c:
        r = c.get("/catalog/search?q=dune")
    assert r.status_code == 200, r.text
    hits = r.json()
    assert hits[0]["description"] == "A desert planet epic."
