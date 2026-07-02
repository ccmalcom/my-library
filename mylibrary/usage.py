"""Per-user Anthropic spend tracking (soft-warn only).

`tracked_create` wraps `client.messages.create`, recording token usage + computed cost
after each call. Recording is best-effort: any failure here is swallowed so it can never
break a profile/recommend/archetype call. `cap_status` reports month-to-date spend and a
soft-warn flag; nothing in this module ever blocks a call.
"""

from __future__ import annotations

import datetime as dt
import logging
from datetime import datetime, timezone

from sqlalchemy import func

from .config import get_settings
from .db import UsageEvent, session_scope

logger = logging.getLogger(__name__)

# USD per 1,000,000 tokens: (input, output, cache_write, cache_read).
# List prices — verify against the current Anthropic pricing page when they change.
MODEL_PRICING: dict[str, tuple[float, float, float, float]] = {
    "claude-sonnet-4-6": (3.00, 15.00, 3.75, 0.30),
    "claude-haiku-4-5-20251001": (1.00, 5.00, 1.25, 0.10),
}
# Fallback for any model not listed (use the most expensive tier so we never under-warn).
DEFAULT_PRICING: tuple[float, float, float, float] = (3.00, 15.00, 3.75, 0.30)

# Claude Sonnet 5 launched 2026-06-30 at a time-boxed promo rate, reverting to list price
# (identical to Sonnet 4.6's rate) on 2026-09-01. Kept out of the static MODEL_PRICING dict
# because it's the one rate that changes on a known calendar date rather than by code edit.
# Cache write/read multipliers (1.25x / 0.1x of input) mirror Anthropic's standard prompt-
# caching ratio used elsewhere in this table — re-verify against the pricing page if Anthropic
# ever prices Sonnet 5 caching differently.
_SONNET_5_PROMO_END = dt.date(2026, 8, 31)
_SONNET_5_PROMO_RATE: tuple[float, float, float, float] = (2.00, 10.00, 2.50, 0.20)
_SONNET_5_LIST_RATE: tuple[float, float, float, float] = (3.00, 15.00, 3.75, 0.30)


def _today() -> dt.date:
    """Seam for tests — monkeypatch this instead of freezing real time."""
    return dt.date.today()


def _sonnet_5_pricing() -> tuple[float, float, float, float]:
    return _SONNET_5_PROMO_RATE if _today() <= _SONNET_5_PROMO_END else _SONNET_5_LIST_RATE


def _pricing(model: str) -> tuple[float, float, float, float]:
    if model == "claude-sonnet-5":
        return _sonnet_5_pricing()
    return MODEL_PRICING.get(model, DEFAULT_PRICING)


def _tok(usage, name: str) -> int:
    try:
        return int(getattr(usage, name, 0) or 0)
    except (TypeError, ValueError):
        return 0


def cost_usd(model: str, usage) -> float:
    """Dollar cost of one call from its token usage. Missing token fields count as 0."""
    in_rate, out_rate, cw_rate, cr_rate = _pricing(model)
    cost = (
        _tok(usage, "input_tokens") * in_rate
        + _tok(usage, "output_tokens") * out_rate
        + _tok(usage, "cache_creation_input_tokens") * cw_rate
        + _tok(usage, "cache_read_input_tokens") * cr_rate
    ) / 1_000_000
    return cost


def record_usage(*, user_id: str, model: str, operation: str, usage) -> None:
    """Insert one UsageEvent. Best-effort: logs and returns on any error, never raises."""
    try:
        row = UsageEvent(
            user_id=user_id,
            model=model,
            operation=operation,
            input_tokens=_tok(usage, "input_tokens"),
            output_tokens=_tok(usage, "output_tokens"),
            cache_creation_input_tokens=_tok(usage, "cache_creation_input_tokens"),
            cache_read_input_tokens=_tok(usage, "cache_read_input_tokens"),
            cost_usd=cost_usd(model, usage),
        )
        with session_scope() as session:
            session.add(row)
    except Exception:  # noqa: BLE001 — recording must never break the calling operation
        logger.warning("usage recording failed for user=%s op=%s", user_id, operation, exc_info=True)


def tracked_create(client, *, user_id: str, operation: str, **create_kwargs):
    """Call `client.messages.create(**create_kwargs)` and record its usage. Returns the message."""
    message = client.messages.create(**create_kwargs)
    record_usage(
        user_id=user_id,
        model=create_kwargs.get("model", "unknown"),
        operation=operation,
        usage=getattr(message, "usage", None),
    )
    return message


def _month_start() -> datetime:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def cap_status(user_id: str) -> dict:
    """Month-to-date spend + soft-warn flag for `user_id` (current UTC month)."""
    settings = get_settings()
    cap = settings.monthly_soft_cap_usd
    since = _month_start()
    with session_scope() as session:
        spent = (
            session.query(func.coalesce(func.sum(UsageEvent.cost_usd), 0.0))
            .filter(UsageEvent.user_id == user_id, UsageEvent.created_at >= since)
            .scalar()
        ) or 0.0
        by_op_rows = (
            session.query(UsageEvent.operation, func.coalesce(func.sum(UsageEvent.cost_usd), 0.0))
            .filter(UsageEvent.user_id == user_id, UsageEvent.created_at >= since)
            .group_by(UsageEvent.operation)
            .all()
        )
    pct = (spent / cap) if cap > 0 else 0.0
    return {
        "spent_usd": round(float(spent), 4),
        "cap_usd": cap,
        "pct": round(pct, 4),
        "warn": pct >= settings.usage_warn_threshold,
        "by_operation": {op: round(float(c), 4) for op, c in by_op_rows},
    }
