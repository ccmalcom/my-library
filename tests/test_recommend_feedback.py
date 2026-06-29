"""Task 2.2 — structured feedback wired into the two-stage recommender.

Verifies `_build_signal` carries per-trait user_weight/status (excluding rejected
traits) plus more_like/less_like book labels and reject_reason_counts, and that the
new signal keys reach Claude in `_claude_rerank` and `_claude_seed_queries`.

No live network / no real Anthropic calls — the client + helpers are patched as in
test_recommend.py.
"""

from __future__ import annotations

from mylibrary import recommend
from mylibrary.config import get_settings
from mylibrary.db import (
    Book,
    Recommendation,
    TasteSignal,
    TasteTrait,
    session_scope,
)


class _Block:
    type = "tool_use"

    def __init__(self, payload):
        self.input = payload


class _CapturingMessages:
    """Records the kwargs of the last create() call so tests can inspect the prompt."""

    def __init__(self, payload, sink):
        self._payload = payload
        self._sink = sink

    def create(self, **kwargs):
        self._sink.update(kwargs)
        return type("Msg", (), {"content": [_Block(self._payload)]})()


class _CapturingClient:
    def __init__(self, payload, sink):
        self.messages = _CapturingMessages(payload, sink)


def _seed_feedback_db():
    """One rejected trait, one confirmed trait (weight 0.5), a more/less book signal,
    and a rejected recommendation carrying a reject reason."""
    with session_scope() as session:
        session.add(
            Book(id=1, title="Dune", author="Frank Herbert", goodreads_rating=5)
        )
        session.add(
            Book(id=2, title="Neuromancer", author="William Gibson", goodreads_rating=4)
        )
        session.add(
            TasteTrait(
                claim="Rewards dense SF world-building.",
                polarity="reward",
                inference_confidence=0.8,
                status="confirmed",
                user_weight=0.5,
            )
        )
        session.add(
            TasteTrait(
                claim="Dislikes grimdark.",
                polarity="aversion",
                inference_confidence=0.7,
                status="rejected",
                user_weight=1.0,
            )
        )
        session.add(
            TasteSignal(
                direction="more", target_kind="book", target_book_id=1
            )
        )
        session.add(
            TasteSignal(
                direction="less", target_kind="book", target_book_id=2
            )
        )
        session.add(
            Recommendation(
                run_id="r1",
                rank=1,
                title="Blood Meridian",
                author="Cormac McCarthy",
                status="rejected",
                reject_reasons=["too_dark"],
            )
        )


def test_build_signal_carries_feedback():
    _seed_feedback_db()
    with session_scope() as session:
        signal = recommend._build_signal(session)

    claims = {t["claim"]: t for t in signal["traits"]}
    # Rejected trait is dead to the reranker.
    assert "Dislikes grimdark." not in claims
    # Confirmed trait present with its weight + status.
    confirmed = claims["Rewards dense SF world-building."]
    assert confirmed["user_weight"] == 0.5
    assert confirmed["status"] == "confirmed"

    assert any("Dune" in s for s in signal["more_like"])
    assert any("Neuromancer" in s for s in signal["less_like"])
    assert signal["reject_reason_counts"] == {"too_dark": 1}


def test_build_signal_defaults_when_no_feedback():
    with session_scope() as session:
        session.add(TasteTrait(claim="Likes SF.", polarity="reward",
                               inference_confidence=0.5))
    with session_scope() as session:
        signal = recommend._build_signal(session)
    t = signal["traits"][0]
    assert t["user_weight"] == 1.0
    assert t["status"] == "proposed"
    assert signal["more_like"] == []
    assert signal["less_like"] == []
    assert signal["reject_reason_counts"] == {}


def test_rerank_context_includes_steering(monkeypatch):
    sink: dict = {}
    payload = {"recommendations": []}
    monkeypatch.setattr(
        recommend, "_client",
        lambda *a, **k: (_CapturingClient(payload, sink), get_settings()),
    )
    candidates = [{"title": "Hyperion", "author": "Dan Simmons", "subjects": []}]
    signal = {
        "traits": [{"id": 1, "claim": "x", "polarity": "reward",
                    "confidence": 0.8, "user_weight": 0.5, "status": "confirmed"}],
        "loved": [{"id": 1, "title": "Dune", "author": "Frank Herbert"}],
        "more_like": ["Dune by Frank Herbert"],
        "less_like": ["Neuromancer by William Gibson"],
        "reject_reason_counts": {"too_dark": 3},
    }
    recommend._claude_rerank(candidates, signal, n=5)

    # The cached prefix (first content block) carries the steering.
    blocks = sink["messages"][0]["content"]
    prefix = blocks[0]["text"]
    assert "Dune by Frank Herbert" in prefix
    assert "user_weight" in prefix
    assert "too_dark" in prefix


def test_seed_queries_prompt_includes_more_like(monkeypatch):
    sink: dict = {}
    payload = {"queries": []}
    monkeypatch.setattr(
        recommend, "_client",
        lambda *a, **k: (_CapturingClient(payload, sink), get_settings()),
    )
    signal = {
        "traits": [],
        "loved": [],
        "more_like": ["Dune by Frank Herbert"],
        "less_like": ["Neuromancer by William Gibson"],
        "reject_reason_counts": {},
    }
    recommend._claude_seed_queries(signal, n_queries=5)

    blocks = sink["messages"][0]["content"]
    joined = " ".join(b["text"] for b in blocks)
    assert "Dune by Frank Herbert" in joined
