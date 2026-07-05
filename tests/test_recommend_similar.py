"""Tests for Wave 3a — per-book 'more books like this' (ephemeral, book-anchored).

No live network (catalog patched) and no real Anthropic calls (the two book-anchored
Claude helpers are patched). Mirrors the patching style of test_recommend.py.
"""

from __future__ import annotations

from mylibrary import catalog, recommend
from mylibrary.config import get_settings
from mylibrary.db import Book, Enrichment, session_scope


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


class _Block:
    type = "tool_use"

    def __init__(self, payload):
        self.input = payload


class _FakeMessages:
    def __init__(self, payload):
        self._payload = payload

    def create(self, **kwargs):
        return type("Msg", (), {"content": [_Block(self._payload)]})()


class _FakeClient:
    def __init__(self, payload):
        self.messages = _FakeMessages(payload)


def _seed_book(title="Dune", author="Frank Herbert", subjects=("Science fiction", "Politics")):
    """Insert one enriched book + a second owned book (exclusion guard). Returns seed id."""
    with session_scope() as session:
        seed = Book(
            title=title,
            author=author,
            goodreads_rating=5,
            enrichment=Enrichment(subjects=list(subjects), language="en", description="A desert epic."),
        )
        session.add(seed)
        session.add(
            Book(
                title="Neuromancer",
                author="William Gibson",
                goodreads_rating=4,
                enrichment=Enrichment(subjects=["Cyberpunk"], language="en"),
            )
        )
        session.flush()
        return seed.id


def test_build_book_signal_seeds_from_one_book():
    seed_id = _seed_book()
    with session_scope() as session:
        book = session.get(Book, seed_id)
        signal = recommend._build_book_signal(session, book, "local")

    # Seeds come from the ONE book, not the library aggregate.
    assert signal["top_subjects"] == ["Science fiction", "Politics"]
    assert signal["top_authors"] == ["Frank Herbert"]
    assert signal["anchor"]["id"] == seed_id
    assert signal["anchor"]["title"] == "Dune"
    assert signal["anchor"]["description"] == "A desert epic."
    # Exclusion sets cover the WHOLE library (both books), so neither is re-recommended.
    assert recommend._dedup_key("Dune", "Frank Herbert") in signal["library_keys"]
    assert recommend._dedup_key("Neuromancer", "William Gibson") in signal["library_keys"]
    assert "en" in signal["library_languages"]
    # Both surnames present in library_authors.
    assert {"herbert", "gibson"} <= signal["library_authors"]


def test_book_facet_queries_returns_query_strings(monkeypatch):
    anchor = {"title": "Dune", "author": "Frank Herbert", "year": 1965,
              "subjects": ["Science fiction"], "description": "Desert epic.", "series": "Dune"}
    payload = {"queries": [
        {"query": "epic ecological science fiction", "reason": "core"},
        {"query": "  ", "reason": "blank -> dropped"},
    ]}
    monkeypatch.setattr(
        recommend, "_client", lambda *a, **k: (_FakeClient(payload), get_settings())
    )
    out = recommend._book_facet_queries(anchor, n_queries=8, user_id="local")
    assert out == ["epic ecological science fiction"]


def test_similar_seed_pool_runs_queries_against_catalog(monkeypatch):
    anchor = {"title": "Dune", "author": "Frank Herbert", "year": 1965,
              "subjects": ["Science fiction"], "description": None, "series": None}
    monkeypatch.setattr(recommend, "_book_facet_queries", lambda a, **k: ["space opera"])
    monkeypatch.setattr(
        catalog, "googlebooks_query", lambda q, **k: [_cand("Hyperion", "Dan Simmons")]
    )
    pool, queries = recommend._similar_seed_pool(anchor, n_queries=8, per_query=8, user_id="local")
    assert queries == ["space opera"]
    assert len(pool) == 1
    cand, reason = pool[0]
    assert cand["title"] == "Hyperion"
    assert reason == "query:space opera"


def test_rerank_similar_drops_bad_indices(monkeypatch):
    candidates = [_cand("Hyperion", "Dan Simmons"), _cand("Anathem", "Neal Stephenson")]
    anchor = {"title": "Dune", "author": "Frank Herbert", "subjects": ["Science fiction"],
              "description": None, "series": None, "year": 1965}
    payload = {"recommendations": [
        {"candidate_index": 1, "score": 0.88, "rationale": "Same cerebral scale."},
        {"candidate_index": 1, "score": 0.5, "rationale": "dup -> dropped"},
        {"candidate_index": 99, "score": 0.9, "rationale": "bad index -> dropped"},
    ]}
    monkeypatch.setattr(
        recommend, "_client", lambda *a, **k: (_FakeClient(payload), get_settings())
    )
    out = recommend._rerank_similar(candidates, anchor, n=10, user_id="local")
    assert len(out) == 1
    assert out[0]["title"] == "Anathem"
    assert out[0]["score"] == 0.88
    assert out[0]["rationale"] == "Same cerebral scale."


def test_recommend_similar_is_ephemeral_and_book_anchored(monkeypatch):
    from mylibrary.db import Recommendation

    seed_id = _seed_book()

    monkeypatch.setattr(
        catalog, "openlibrary_subject",
        lambda subject, **k: [_cand("Hyperion", "Dan Simmons", source="openlibrary")],
    )
    monkeypatch.setattr(
        catalog, "googlebooks_subject",
        lambda subject, **k: [_cand("Dune", "Frank Herbert")],  # seed book -> filtered
    )
    monkeypatch.setattr(catalog, "googlebooks_author", lambda author, **k: [])
    monkeypatch.setattr(
        catalog, "googlebooks_query",
        lambda q, **k: [_cand("Leviathan Wakes", "James S. A. Corey")],
    )
    monkeypatch.setattr(recommend, "_book_facet_queries", lambda a, **k: ["space opera"])

    def fake_rerank(candidates, anchor, *, n, **_kw):
        out = []
        for i, c in enumerate(candidates):
            c = dict(c)
            c["score"] = 1.0 - i * 0.1
            c["rationale"] = f"like {anchor['title']}"
            out.append(c)
        return out[:n]

    monkeypatch.setattr(recommend, "_rerank_similar", fake_rerank)

    result = recommend.recommend_similar(seed_id, n=5)

    assert result["anchor_book_id"] == seed_id
    assert result["anchor_title"] == "Dune"
    assert result["count"] >= 1
    titles = [r["title"] for r in result["recommendations"]]
    assert "Dune" not in titles  # the seed book is never recommended back
    assert "Hyperion" in titles
    assert result["recommendations"][0]["rationale"].startswith("like Dune")
    assert "rank" in result["recommendations"][0]
    # Ephemeral: nothing persisted to the recommendations table.
    with session_scope() as session:
        assert session.query(Recommendation).count() == 0


def test_recommend_similar_missing_book_raises():
    import pytest

    with pytest.raises(RuntimeError):
        recommend.recommend_similar(999999, n=5)
