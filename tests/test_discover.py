"""Tests for Wave 3b — natural-language discovery (ephemeral, request-anchored).

No live network (catalog patched) and no real Anthropic calls (the two discovery Claude
helpers are patched). Mirrors the patching style of test_recommend_similar.py.
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
        "language": "en",
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


def test_clean_constraints_keeps_supported_drops_unsupported():
    raw = {
        "languages": ["FR", "en "],
        "min_year": "2000",
        "max_year": 2020,
        "exclude_subjects": ["War", " grief "],
        "max_pages": 300,        # unsupported -> dropped
        "standalone": True,      # unsupported -> dropped
        "series": "completed",   # unsupported -> dropped
    }
    out = recommend._clean_constraints(raw)
    assert out["languages"] == ["fr", "en"]
    assert out["min_year"] == 2000
    assert out["max_year"] == 2020
    assert out["exclude_subjects"] == ["war", "grief"]
    assert "max_pages" not in out
    assert "standalone" not in out
    assert "series" not in out


def test_interpret_query_returns_queries_constraints_and_echo(monkeypatch):
    payload = {
        "interpretation": "gentle, low-stakes comfort reads",
        "queries": [
            {"query": "cozy small-community fiction", "rationale": "mood"},
            {"query": "  ", "rationale": "blank -> dropped"},
        ],
        "constraints": {"exclude_subjects": ["grief"], "max_pages": 350},
    }
    monkeypatch.setattr(
        recommend, "_client", lambda *a, **k: (_FakeClient(payload), get_settings())
    )
    signal = {"traits": [], "loved": []}
    out = recommend._interpret_query("something gentle", signal, user_id="local")
    assert out["interpretation"] == "gentle, low-stakes comfort reads"
    assert out["queries"] == ["cozy small-community fiction"]
    assert out["constraints"]["exclude_subjects"] == ["grief"]
    assert "max_pages" not in out["constraints"]  # cut constraint dropped


def test_discovery_pool_runs_queries_against_both_sources(monkeypatch):
    monkeypatch.setattr(
        catalog, "googlebooks_query", lambda q, **k: [_cand("Hyperion", "Dan Simmons")]
    )
    monkeypatch.setattr(
        catalog, "openlibrary_query",
        lambda q, **k: [_cand("Anathem", "Neal Stephenson", source="openlibrary")],
    )
    pool = recommend._discovery_pool(["space opera"], per_query=8)
    titles = sorted(c["title"] for c, _r in pool)
    assert titles == ["Anathem", "Hyperion"]
    assert all(r == "query:space opera" for _c, r in pool)


def test_apply_discovery_constraints_filters_era_and_subjects():
    pool = [
        (_cand("Old", year=1950, subjects=["Fiction"]), "query:x"),
        (_cand("New", year=2015, subjects=["Fiction"]), "query:x"),
        (_cand("Warlike", year=2015, subjects=["War stories"]), "query:x"),
        (_cand("Unknown", year=None, subjects=None), "query:x"),  # unknown -> passes
    ]
    out = recommend._apply_discovery_constraints(
        pool, {"min_year": 2000, "exclude_subjects": ["war"]}
    )
    titles = sorted(c["title"] for c, _r in out)
    # 'Old' dropped by min_year, 'Warlike' dropped by exclude_subjects, unknowns pass.
    assert titles == ["New", "Unknown"]


def test_apply_discovery_constraints_no_constraints_is_passthrough():
    pool = [(_cand("A", year=1990), "query:x")]
    assert recommend._apply_discovery_constraints(pool, {}) == pool


def test_subject_hits_is_whole_word():
    assert recommend._subject_hits("war", "war stories")
    assert not recommend._subject_hits("war", "warmth and light")


def test_rerank_discovery_drops_bad_indices(monkeypatch):
    candidates = [_cand("Hyperion", "Dan Simmons"), _cand("Anathem", "Neal Stephenson")]
    payload = {"recommendations": [
        {"candidate_index": 1, "score": 0.88, "rationale": "Delivers the cerebral-scale facet."},
        {"candidate_index": 1, "score": 0.5, "rationale": "dup -> dropped"},
        {"candidate_index": 99, "score": 0.9, "rationale": "bad index -> dropped"},
    ]}
    monkeypatch.setattr(
        recommend, "_client", lambda *a, **k: (_FakeClient(payload), get_settings())
    )
    out = recommend._rerank_discovery(
        candidates, "like Anathem", "cerebral idea-driven scifi", {"traits": [], "loved": []},
        n=10, user_id="local",
    )
    assert len(out) == 1
    assert out[0]["title"] == "Anathem"
    assert out[0]["score"] == 0.88
    assert out[0]["rationale"] == "Delivers the cerebral-scale facet."


def _seed_library():
    """One owned book so the exclusion set is non-empty (a would-be dup)."""
    with session_scope() as session:
        session.add(Book(
            title="Anathem", author="Neal Stephenson", goodreads_rating=5,
            enrichment=Enrichment(subjects=["Science fiction"], language="en"),
        ))
        session.flush()


def test_discover_is_ephemeral_and_request_anchored(monkeypatch):
    from mylibrary.db import Recommendation

    _seed_library()

    monkeypatch.setattr(
        recommend, "_interpret_query",
        lambda q, sig, **k: {
            "interpretation": "cerebral idea-driven science fiction",
            "queries": ["cerebral idea-driven science fiction"],
            "constraints": {},
        },
    )
    monkeypatch.setattr(
        catalog, "googlebooks_query",
        lambda q, **k: [_cand("Hyperion", "Dan Simmons")],
    )
    monkeypatch.setattr(
        catalog, "openlibrary_query",
        lambda q, **k: [_cand("Anathem", "Neal Stephenson", source="openlibrary")],  # owned -> excluded
    )

    def fake_rerank(candidates, query, interpretation, signal, *, n, **_kw):
        out = []
        for i, c in enumerate(candidates):
            c = dict(c)
            c["score"] = 1.0 - i * 0.1
            c["rationale"] = f"answers: {query}"
            out.append(c)
        return out[:n]

    monkeypatch.setattr(recommend, "_rerank_discovery", fake_rerank)

    result = recommend.discover("like Anathem", n=5)

    assert result["query"] == "like Anathem"
    assert result["interpretation"] == "cerebral idea-driven science fiction"
    assert result["count"] >= 1
    titles = [r["title"] for r in result["recommendations"]]
    assert "Hyperion" in titles
    assert "Anathem" not in titles  # owned book is excluded from results
    assert result["recommendations"][0]["rationale"].startswith("answers:")
    assert "rank" in result["recommendations"][0]
    # Ephemeral: nothing persisted to the recommendations table.
    with session_scope() as session:
        assert session.query(Recommendation).count() == 0


def test_discover_empty_query_raises():
    import pytest

    with pytest.raises(RuntimeError):
        recommend.discover("   ", n=5)
