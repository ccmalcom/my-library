"""Shared vocabulary for structured recommendation feedback."""
from __future__ import annotations

REJECT_REASONS: tuple[str, ...] = (
    "wrong_genre",
    "too_dark",
    "tried_author",
    "too_long",
    "not_now",
    "overhyped",
    "wrong_vibe",
)

_REJECT_REASONS_SET: frozenset[str] = frozenset(REJECT_REASONS)


def is_valid_reasons(reasons: list[str]) -> bool:
    return bool(reasons) and all(r in _REJECT_REASONS_SET for r in reasons)
