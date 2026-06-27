"""Tests for Phase 5 — the two-stage recommender.

No live network (catalog functions patched) and no real Anthropic calls (the two Claude
helpers / the client are patched). Covers: the new catalog retrieval parser, the
dedupe/merge assembly, the rerank id-validation, and end-to-end persistence.
"""

from __future__ import annotations

from mylibrary import catalog, recommend
from mylibrary.config import get_settings
from mylibrary.db import Book, Enrichment, ProfileMeta, Recommendation, TasteTrait, session_scope
from mylibrary.db import utcnow


# --- helpers ---------------------------------------------------------------


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


def _seed_library():
    """Two loved books (Dune, Neuromancer) + one trait. Dune doubles as the dedupe guard."""
    with session_scope() as session:
        session.add(
            Book(
                title="Dune",
                author="Frank Herbert",
                goodreads_rating=5,
                enrichment=Enrichment(subjects=["Science fiction", "Politics"]),
            )
        )
        session.add(
            Book(
                title="Neuromancer",
                author="William Gibson",
                goodreads_rating=4,
                enrichment=Enrichment(subjects=["Science fiction", "Cyberpunk"]),
            )
        )
        session.add(
            TasteTrait(
                claim="Rewards dense SF world-building.",
                polarity="reward",
                exhibits=[1],
                contrasts=[],
                inference_confidence=0.8,
            )
        )
        session.add(
            ProfileMeta(
                last_profiled_at=utcnow(),
                last_profile_kind="full",
            )
        )


# --- catalog retrieval parser ----------------------------------------------

_OL_SUBJECT_PAYLOAD = {
    "works": [
        {
            "key": "/works/OL1W",
            "title": "Hyperion",
            "authors": [{"name": "Dan Simmons"}],
            "cover_id": 42,
            "first_publish_year": 1989,
        }
    ]
}


def test_openlibrary_subject_parses_works(monkeypatch):
    monkeypatch.setattr(catalog, "_get_json", lambda url, **k: _OL_SUBJECT_PAYLOAD)
    cands = catalog.openlibrary_subject("Science Fiction")
    assert len(cands) == 1
    c = cands[0]
    assert c["title"] == "Hyperion"
    assert c["author"] == "Dan Simmons"
    assert c["year"] == 1989
    assert c["source"] == "openlibrary"
    assert c["cover_url"].endswith("42-M.jpg")


def test_ol_subject_slug():
    assert catalog._ol_subject_slug("Science Fiction") == "science_fiction"
    assert catalog._ol_subject_slug("LGBTQ+ Fiction") == "lgbtq_fiction"


# --- assembly: dedupe + provenance ----------------------------------------


def test_assemble_filters_library_and_tags_both():
    signal = {
        "library_keys": {recommend._dedup_key("Dune", "Frank Herbert")},
        "library_isbns": set(),
    }
    metadata = [
        (_cand("Dune", "Frank Herbert"), "subject:Science fiction"),  # in library -> drop
        (_cand("Hyperion", "Dan Simmons"), "subject:Science fiction"),
    ]
    seed = [
        (_cand("Hyperion", "Dan Simmons"), "query:space opera"),  # dup -> both
        (_cand("Leviathan Wakes", "James S. A. Corey"), "query:space opera"),
    ]
    out = recommend._assemble(metadata, seed, signal, cap=50)
    titles = {c["title"]: c for c in out}
    assert "Dune" not in titles
    assert set(titles) == {"Hyperion", "Leviathan Wakes"}
    assert titles["Hyperion"]["retrieval_pool"] == "both"
    assert titles["Leviathan Wakes"]["retrieval_pool"] == "claude_seed"
    # "both" candidates are surfaced first.
    assert out[0]["title"] == "Hyperion"


def test_cap_pool_reserves_seed_slots():
    # Metadata vastly outnumbers seed; without a reserve, seed-only would be truncated.
    pool = (
        [{"title": "both", "retrieval_pool": "both"}]
        + [{"title": f"m{i}", "retrieval_pool": "metadata"} for i in range(30)]
        + [{"title": f"s{i}", "retrieval_pool": "claude_seed"} for i in range(6)]
    )
    out = recommend._cap_pool(pool, cap=10)
    assert len(out) == 10
    pools = [c["retrieval_pool"] for c in out]
    assert pools.count("both") == 1
    assert pools.count("claude_seed") == 3  # round(10 * 0.3)
    assert pools.count("metadata") == 6


def test_cap_pool_noop_under_cap():
    pool = [{"title": "a", "retrieval_pool": "metadata"}]
    assert recommend._cap_pool(pool, cap=10) == pool


# --- rerank: id validation -------------------------------------------------


def test_rerank_drops_bad_indices_and_ungrounded_ids(monkeypatch):
    candidates = [_cand("Hyperion", "Dan Simmons"), _cand("Anathem", "Neal Stephenson")]
    signal = {
        "traits": [{"id": 1, "claim": "x", "polarity": "reward", "confidence": 0.8}],
        "loved": [{"id": 1, "title": "Dune", "author": "Frank Herbert"}],
    }
    payload = {
        "recommendations": [
            {
                "candidate_index": 0,
                "score": 0.91,
                "rationale": "Dense SF.",
                "grounded_trait_ids": [1, 999],  # 999 is not a real trait
                "grounded_book_ids": [1, 888],  # 888 is not a real book
            },
            {"candidate_index": 99, "score": 0.5, "rationale": "x",
             "grounded_trait_ids": [], "grounded_book_ids": []},  # bad index -> dropped
        ]
    }
    monkeypatch.setattr(
        recommend, "_client", lambda *a, **k: (_FakeClient(payload), get_settings())
    )
    out = recommend._claude_rerank(candidates, signal, n=10)
    assert len(out) == 1
    assert out[0]["title"] == "Hyperion"
    assert out[0]["grounded_trait_ids"] == [1]
    assert out[0]["grounded_book_ids"] == [1]


# --- end-to-end orchestration + persistence --------------------------------


def test_recommend_persists_ranked_run(monkeypatch):
    _seed_library()

    monkeypatch.setattr(
        catalog, "openlibrary_subject",
        lambda subject, **k: [_cand("Hyperion", "Dan Simmons", source="openlibrary")],
    )
    monkeypatch.setattr(
        catalog, "googlebooks_subject",
        lambda subject, **k: [_cand("Dune", "Frank Herbert")],  # already in library
    )
    monkeypatch.setattr(catalog, "googlebooks_author", lambda author, **k: [])
    monkeypatch.setattr(
        catalog, "googlebooks_query",
        lambda q, **k: [_cand("Hyperion", "Dan Simmons"),  # dup of metadata -> both
                        _cand("Leviathan Wakes", "James S. A. Corey")],
    )
    monkeypatch.setattr(
        recommend, "_claude_seed_queries", lambda signal, **k: ["space opera"]
    )

    def fake_rerank(candidates, signal, *, n, **_kw):
        out = []
        for i, c in enumerate(candidates):
            c = dict(c)
            c["score"] = 1.0 - i * 0.1
            c["rationale"] = "because"
            c["grounded_trait_ids"] = [t["id"] for t in signal["traits"]]
            c["grounded_book_ids"] = [signal["loved"][0]["id"]]
            out.append(c)
        return out[:n]

    monkeypatch.setattr(recommend, "_claude_rerank", fake_rerank)

    result = recommend.recommend(n=5)

    assert result["served"] >= 2
    assert result["run_id"]
    with session_scope() as session:
        rows = session.query(Recommendation).order_by(Recommendation.rank).all()
        titles = [r.title for r in rows]
        assert "Dune" not in titles  # library book filtered before rerank
        assert "Hyperion" in titles
        # all rows share one run_id; ranks are contiguous from 1.
        assert len({r.run_id for r in rows}) == 1
        assert [r.rank for r in rows] == list(range(1, len(rows) + 1))
        hyperion = next(r for r in rows if r.title == "Hyperion")
        assert hyperion.retrieval_pool == "both"
        assert hyperion.grounded_trait_ids == [1]


def test_recommend_requires_loved_books():
    import pytest

    with pytest.raises(RuntimeError):
        recommend.recommend(n=5)
