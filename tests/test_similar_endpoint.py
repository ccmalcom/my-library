"""Contract tests for POST /books/{book_id}/similar (Wave 3a).

The recommender internals are patched so the endpoint is exercised without network/LLM.
Mirrors test_taste_signal_endpoint.py's TestClient harness.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from mylibrary import recommend
from mylibrary.api import app
from mylibrary.db import LOCAL_USER_ID, Book, init_db, session_scope


def _client():
    return TestClient(app)


def _insert_book(user_id: str = LOCAL_USER_ID, title: str = "Dune") -> int:
    init_db()
    with session_scope() as s:
        b = Book(user_id=user_id, title=title, author="Frank Herbert", goodreads_rating=5)
        s.add(b)
        s.flush()
        return b.id


def test_similar_happy_path(monkeypatch):
    book_id = _insert_book()

    def fake(book_id_arg, *, n, user_id):
        return {
            "anchor_book_id": book_id_arg,
            "anchor_title": "Dune",
            "count": 1,
            "model": "claude-sonnet-5",
            "seed_queries": ["space opera"],
            "recommendations": [{
                "rank": 1, "title": "Hyperion", "author": "Dan Simmons", "year": 1989,
                "isbn13": None, "cover_url": None, "subjects": ["Science fiction"],
                "description": "Frame tale.", "catalog_source": "openlibrary",
                "catalog_id": "OL1W", "retrieval_pool": "both", "seed_reason": "query:space opera",
                "score": 0.91, "rationale": "like Dune",
            }],
        }

    monkeypatch.setattr(recommend, "recommend_similar", fake)
    # api.py imports the symbol by name, so patch the reference the endpoint calls:
    import mylibrary.api as api_mod
    monkeypatch.setattr(api_mod, "recommend_similar", fake)

    with _client() as c:
        r = c.post(f"/books/{book_id}/similar", json={"n": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["anchor_book_id"] == book_id
    assert body["recommendations"][0]["title"] == "Hyperion"


def test_similar_unknown_book_404():
    _insert_book()
    with _client() as c:
        r = c.post("/books/999999/similar", json={"n": 5})
    assert r.status_code == 404


def test_similar_insufficient_metadata_400(monkeypatch):
    book_id = _insert_book()

    def boom(*a, **k):
        raise RuntimeError("Not enough metadata on this book to find similar reads.")

    import mylibrary.api as api_mod
    monkeypatch.setattr(api_mod, "recommend_similar", boom)

    with _client() as c:
        r = c.post(f"/books/{book_id}/similar", json={"n": 5})
    assert r.status_code == 400
