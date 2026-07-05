"""Contract tests for POST /discover (Wave 3b).

The recommender internals are patched so the endpoint is exercised without network/LLM.
Mirrors test_similar_endpoint.py's TestClient harness.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from mylibrary.api import app


def _client():
    return TestClient(app)


def test_discover_happy_path(monkeypatch):
    def fake(query, *, n, user_id):
        return {
            "query": query,
            "interpretation": "cerebral idea-driven scifi",
            "count": 1,
            "model": "claude-sonnet-5",
            "queries": ["cerebral idea-driven science fiction"],
            "recommendations": [{
                "rank": 1, "title": "Hyperion", "author": "Dan Simmons", "year": 1989,
                "isbn13": None, "cover_url": None, "subjects": ["Science fiction"],
                "description": "Frame tale.", "catalog_source": "openlibrary",
                "catalog_id": "OL1W", "retrieval_pool": "claude_seed",
                "seed_reason": "query:cerebral idea-driven science fiction",
                "score": 0.91, "rationale": "Delivers the idea-driven facet.",
            }],
        }

    import mylibrary.api as api_mod
    monkeypatch.setattr(api_mod, "discover", fake)

    with _client() as c:
        r = c.post("/discover", json={"query": "like Anathem", "n": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["query"] == "like Anathem"
    assert body["interpretation"] == "cerebral idea-driven scifi"
    assert body["recommendations"][0]["title"] == "Hyperion"


def test_discover_empty_query_422():
    with _client() as c:
        r = c.post("/discover", json={"query": "", "n": 5})
    assert r.status_code == 422


def test_discover_runtime_error_400(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("No Anthropic API key configured.")

    import mylibrary.api as api_mod
    monkeypatch.setattr(api_mod, "discover", boom)

    with _client() as c:
        r = c.post("/discover", json={"query": "like Anathem", "n": 5})
    assert r.status_code == 400
