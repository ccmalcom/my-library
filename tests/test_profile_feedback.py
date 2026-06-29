"""Task 2.1 — feed trait verdicts + weights + more/less signal into the profiler.

Covers `_feedback_context`, the feedback block injected into `_build_prompt`,
`_remove_rejected_claims`, and the rejected-claim filter inside
`extract_taste_profile` (with the Anthropic client mocked).
"""
from __future__ import annotations

import pytest

from mylibrary import profile
from mylibrary.db import (
    Book,
    ProfileMeta,
    TasteSignal,
    TasteTrait,
    session_scope,
    utcnow,
)


# --- Anthropic mock (mirrors tests/test_recommend.py) -----------------------
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


def _seed_feedback():
    """One confirmed trait, one rejected trait, one downweighted (0.5), two signals."""
    with session_scope() as session:
        liked = Book(title="Dune", author="Frank Herbert", goodreads_rating=5)
        disliked = Book(title="Twilight", author="Stephenie Meyer", goodreads_rating=2)
        session.add_all([liked, disliked])
        session.flush()

        session.add_all(
            [
                TasteTrait(
                    claim="Rewards dense political world-building.",
                    polarity="reward",
                    exhibits=[liked.id],
                    contrasts=[],
                    inference_confidence=0.8,
                    status="confirmed",
                ),
                TasteTrait(
                    claim="Enjoys sparkly vampire romance.",
                    polarity="reward",
                    exhibits=[],
                    contrasts=[],
                    inference_confidence=0.5,
                    status="rejected",
                ),
                TasteTrait(
                    claim="Prefers very long books.",
                    polarity="reward",
                    exhibits=[],
                    contrasts=[],
                    inference_confidence=0.6,
                    status="proposed",
                    user_weight=0.5,
                ),
            ]
        )
        session.add_all(
            [
                TasteSignal(
                    direction="more",
                    target_kind="book",
                    target_book_id=liked.id,
                ),
                TasteSignal(
                    direction="less",
                    target_kind="book",
                    target_book_id=disliked.id,
                ),
            ]
        )


def test_feedback_context_buckets():
    _seed_feedback()
    with session_scope() as session:
        ctx = profile._feedback_context(session, profile.LOCAL_USER_ID)

    assert ctx["confirmed"] == ["Rewards dense political world-building."]
    assert ctx["rejected"] == ["Enjoys sparkly vampire romance."]
    assert ctx["downweighted"] == [
        {"claim": "Prefers very long books.", "user_weight": 0.5}
    ]
    assert ctx["more_like"] == ["Dune by Frank Herbert"]
    assert ctx["less_like"] == ["Twilight by Stephenie Meyer"]


def test_build_prompt_includes_feedback_section():
    _seed_feedback()
    with session_scope() as session:
        ctx = profile._feedback_context(session, profile.LOCAL_USER_ID)

    tiers = {"5": [], "4": [], "3": [], "<=2": [], "dnf": [], "rejected": []}
    prompt = profile._build_prompt(tiers, feedback=ctx)

    assert "Rewards dense political world-building." in prompt
    assert "do NOT re-derive" in prompt
    assert "Dune by Frank Herbert" in prompt
    assert "Twilight by Stephenie Meyer" in prompt


def test_build_prompt_no_feedback_section_when_empty():
    tiers = {"5": [], "4": [], "3": [], "<=2": [], "dnf": [], "rejected": []}
    empty = {
        "confirmed": [],
        "rejected": [],
        "downweighted": [],
        "more_like": [],
        "less_like": [],
    }
    prompt = profile._build_prompt(tiers, feedback=empty)
    assert "User Feedback" not in prompt


def test_remove_rejected_claims_filters_substring_case_insensitive():
    new_traits = [
        {"claim": "Enjoys SPARKLY vampire romance and brooding leads."},
        {"claim": "Rewards dense political world-building."},
    ]
    rejected = ["Enjoys sparkly vampire romance."]
    kept = profile._remove_rejected_claims(new_traits, rejected)
    claims = [t["claim"] for t in kept]
    assert "Rewards dense political world-building." in claims
    assert all("vampire" not in c.lower() for c in claims)


def test_extract_taste_profile_excludes_rejected_paraphrase(monkeypatch):
    # Seed a rated book + a rejected trait the profile must never re-derive.
    with session_scope() as session:
        book = Book(title="Dune", author="Frank Herbert", goodreads_rating=5)
        session.add(book)
        session.flush()
        bid = book.id
        session.add(
            TasteTrait(
                claim="Enjoys sparkly vampire romance.",
                polarity="reward",
                exhibits=[],
                contrasts=[],
                inference_confidence=0.5,
                status="rejected",
            )
        )

    # Claude returns one good trait + a paraphrase of the rejected one.
    payload = {
        "traits": [
            {
                "claim": "Rewards dense political world-building.",
                "polarity": "reward",
                "exhibits": [bid],
                "contrasts": [],
                "inference_confidence": 0.9,
            },
            {
                "claim": "Loves SPARKLY VAMPIRE romance above all.",
                "polarity": "reward",
                "exhibits": [bid],
                "contrasts": [],
                "inference_confidence": 0.7,
            },
        ]
    }

    monkeypatch.setattr(profile, "resolve_anthropic_key", lambda uid: "test-key")
    import anthropic

    monkeypatch.setattr(anthropic, "Anthropic", lambda **kw: _FakeClient(payload))

    profile.extract_taste_profile()

    with session_scope() as session:
        proposed = (
            session.query(TasteTrait)
            .filter(TasteTrait.status == "proposed")
            .all()
        )
    claims = [t.claim for t in proposed]
    assert "Rewards dense political world-building." in claims
    assert all("vampire" not in c.lower() for c in claims)
