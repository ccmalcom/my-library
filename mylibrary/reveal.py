"""Lazy second-person "reveal line" generation for the Wrapped reveal.

Each TasteTrait.claim is analytic ("Rewards dense, stylized prose..."). The reveal shows
a presentation rewrite in second person ("You notice sentences. Plain prose has to work
twice as hard."). We generate these on demand with one cheap Haiku pass the first time a
user views (or replays) the reveal, persist them per-trait, and never regenerate a line
that already exists. The analytic claim stays the recommender's source of truth.

Constraints enforced via prompt + few-shots (Set 1 of calibration-examples.md):
  - <= 14 words, second person, concrete nouns, no hedging words in the line itself
  - derivable from the claim; no new assertions
"""

from __future__ import annotations

import json

from anthropic import Anthropic

from .config import LOCAL_USER_ID
from .db import TasteTrait, init_db, session_scope
from .usage import tracked_create
from .user_settings import resolve_anthropic_key

_MODEL = "claude-haiku-4-5-20251001"

_SYSTEM = (
    "You rewrite a reader's analytic taste traits as short, second-person reveal lines "
    "for a personal reading app. Each line addresses the reader directly ('You...'), "
    "uses concrete nouns over abstractions, contains no hedging words, and asserts "
    "nothing the source claim doesn't already say. Never gush; the delight is in the "
    "specificity. Return one line per trait id via the record_reveal_lines tool."
)

# 3-5 few-shots (calibration Set 1) baked into the prompt as anchors.
_FEWSHOTS = [
    ("Rewards dense, stylized prose; rates workmanlike prose lower",
     "You notice sentences. Plain prose has to work twice as hard."),
    ("Reader consistently rewards character interiority over plot momentum",
     "You'll forgive a slow plot if the people feel real."),
    ("Rewards completed series over standalones",
     "When you commit, you commit. Standalones envy your series."),
    ("Penalizes romance subplots that interrupt the main narrative",
     "Love stories that stall the plot lose you fast."),
    ("Possible preference for translated fiction; sample is small",
     "You keep drifting toward books written in other languages first."),
]

_REVEAL_TOOL = {
    "name": "record_reveal_lines",
    "description": "Record one second-person reveal line per trait id.",
    "input_schema": {
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer", "description": "The trait id being rewritten."},
                        "reveal_line": {
                            "type": "string",
                            "description": "<=14 words, second person, concrete, no hedging, "
                            "derivable from the claim.",
                        },
                    },
                    "required": ["id", "reveal_line"],
                },
            }
        },
        "required": ["lines"],
    },
}


def _build_reveal_prompt(traits: list[dict]) -> str:
    """`traits` is a list of {id, claim, polarity}. Pure — no I/O."""
    examples = "\n".join(
        f'  claim: "{claim}"\n  line:  "{line}"' for claim, line in _FEWSHOTS
    )
    return (
        "Rewrite each analytic taste claim below as a second-person reveal line.\n\n"
        "Rules for every line:\n"
        "  - 14 words or fewer.\n"
        "  - Address the reader as 'You'. Present tense.\n"
        "  - Concrete nouns over abstractions ('slow first chapters', not 'gradual pacing').\n"
        "  - No hedging words inside the line (no 'maybe', 'probably', 'we think').\n"
        "  - Assert nothing the claim doesn't already say. No new facts.\n"
        "  - For an aversion, keep a knowing tone — 'not for you', never 'you failed to appreciate'.\n\n"
        "Examples:\n"
        + examples
        + "\n\nReturn exactly one line per id via record_reveal_lines.\n\n"
        "TRAITS (JSON):\n"
        + json.dumps(traits, ensure_ascii=False)
    )


def generate_reveal_lines(*, user_id: str = LOCAL_USER_ID, max_tokens: int = 1200) -> dict:
    """Generate + persist reveal lines for any of `user_id`'s traits missing one.

    Idempotent: traits that already have a reveal_line are skipped, and if none are
    missing (or the user has no traits) no Claude call is made. Requires an API key
    only when there is work to do.
    """
    init_db()

    with session_scope() as session:
        pending = (
            session.query(TasteTrait)
            .filter(TasteTrait.user_id == user_id, TasteTrait.reveal_line.is_(None))
            .all()
        )
        if not pending:
            return {"generated": 0, "traits": 0, "model": _MODEL}
        payload = [
            {"id": t.id, "claim": t.claim, "polarity": t.polarity} for t in pending
        ]

    api_key = resolve_anthropic_key(user_id)
    if not api_key:
        raise RuntimeError(
            "No Anthropic API key configured. Add your key in Settings (or set "
            "ANTHROPIC_API_KEY) before viewing the reveal."
        )

    client = Anthropic(api_key=api_key)
    message = tracked_create(
        client,
        user_id=user_id,
        operation="reveal_lines",
        model=_MODEL,
        max_tokens=max_tokens,
        system=_SYSTEM,
        tools=[_REVEAL_TOOL],
        tool_choice={"type": "tool", "name": "record_reveal_lines"},
        messages=[{"role": "user", "content": _build_reveal_prompt(payload)}],
    )

    lines: list[dict] = []
    for block in message.content:
        if getattr(block, "type", None) == "tool_use":
            lines = block.input.get("lines", [])
            break

    by_id = {
        int(item["id"]): str(item["reveal_line"]).strip()
        for item in lines
        if item.get("id") is not None and str(item.get("reveal_line") or "").strip()
    }

    generated = 0
    valid_ids = {p["id"] for p in payload}
    with session_scope() as session:
        for tid, line in by_id.items():
            if tid not in valid_ids:
                continue
            trait = session.get(TasteTrait, tid)
            if trait is None or trait.user_id != user_id:
                continue
            if trait.reveal_line:  # a concurrent generation may have filled it
                continue
            trait.reveal_line = line
            generated += 1

    return {"generated": generated, "traits": len(payload), "model": _MODEL}
