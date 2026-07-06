"""Per-user custom instructions (natural-language taste directive) + derived constraints.

`nl_text` is the durable, user-editable source of truth. `constraints` is the derived
structured filter set the recommender applies deterministically. One row per user; survives
clear_library / clear_profile, dropped only by delete_account (see purge.py).

Page-count and series/standalone wishes are intentionally NOT stored as constraints (catalog
candidates lack reliable data for them); they live in nl_text as soft Stage-2 steering.
"""

from __future__ import annotations

import json

from anthropic import Anthropic

from .config import LOCAL_USER_ID
from .db import Book, TasteSignal, TasteTrait, UserDirective, init_db, session_scope, utcnow
from .usage import tracked_create
from .user_settings import resolve_anthropic_key


def _clean_directive_constraints(raw: dict | None) -> dict:
    """Keep only supported, catalog-filterable constraints; normalize types.

    Supported: languages (list[str], 2-letter lowercased), min_year/max_year (int),
    exclude_subjects (list[str], lowercased), exclude_authors (list[str] surnames, lowercased).
    Everything else (e.g. page counts, series flags) is dropped.
    """
    out: dict = {}
    if not raw:
        return out
    langs = [
        str(x).strip().lower()[:2]
        for x in (raw.get("languages") or [])
        if str(x).strip()
    ]
    if langs:
        out["languages"] = langs
    for key in ("min_year", "max_year"):
        val = raw.get(key)
        if isinstance(val, bool):
            continue
        if isinstance(val, int):
            out[key] = val
        elif isinstance(val, str) and val.strip().isdigit():
            out[key] = int(val.strip())
    excl = [
        str(x).strip().lower()
        for x in (raw.get("exclude_subjects") or [])
        if str(x).strip()
    ]
    if excl:
        out["exclude_subjects"] = excl
    authors = [
        str(x).strip().lower()
        for x in (raw.get("exclude_authors") or [])
        if str(x).strip()
    ]
    if authors:
        out["exclude_authors"] = authors
    return out


def get_directive(*, user_id: str = LOCAL_USER_ID) -> dict | None:
    """Return this user's directive, or None when there is no meaningful record."""
    init_db()
    with session_scope() as s:
        row = (
            s.query(UserDirective)
            .filter(UserDirective.user_id == user_id)
            .one_or_none()
        )
        if row is None or not (row.nl_text or row.constraints):
            return None
        return {
            "nl_text": row.nl_text,
            "constraints": row.constraints or {},
            "updated_at": row.updated_at,
        }


def set_directive(
    nl_text: str | None,
    constraints: dict | None = None,
    *,
    user_id: str = LOCAL_USER_ID,
) -> dict:
    """Upsert this user's directive. Empty text AND empty constraints is rejected."""
    init_db()
    text = (nl_text or "").strip()
    cleaned = _clean_directive_constraints(constraints)
    if not text and not cleaned:
        raise ValueError("Custom instructions must not be empty.")
    with session_scope() as s:
        row = (
            s.query(UserDirective)
            .filter(UserDirective.user_id == user_id)
            .one_or_none()
        )
        if row is None:
            row = UserDirective(
                user_id=user_id, nl_text=text or None, constraints=cleaned or None
            )
            s.add(row)
        else:
            row.nl_text = text or None
            row.constraints = cleaned or None
            row.updated_at = utcnow()
    return {"nl_text": text or None, "constraints": cleaned}


def clear_directive(*, user_id: str = LOCAL_USER_ID) -> None:
    """Delete this user's directive row (reverts to no custom instructions)."""
    init_db()
    with session_scope() as s:
        s.query(UserDirective).filter(
            UserDirective.user_id == user_id
        ).delete(synchronize_session=False)


_DISTILL_MODEL = "claude-haiku-4-5-20251001"

_DISTILL_SYSTEM = (
    "You are an authoring aid for a personal reading app. Your job is to turn a reader's "
    "messy, natural-language message about what they want to read into a clean, durable "
    "'custom instructions' record that steers their book recommendations. You do NOT "
    "recommend books and you do NOT chat for its own sake; you distill.\n\n"
    "Return, via the record_directive tool:\n"
    "- proposed_text: a tightened rewrite of the reader's standing preferences in their own "
    "voice, second person, a few plain sentences. Fold in anything still true from their "
    "CURRENT instructions; drop anything they just contradicted. This is the durable record, "
    "so write it to stand on its own without the chat.\n"
    "- constraints: ONLY hard, catalog-filterable filters the reader actually stated: "
    "languages (ISO 639-1), min_year / max_year, exclude_subjects, exclude_authors "
    "(surnames). Do NOT invent filters. Do NOT emit page-count or series filters; those are "
    "not filterable, so leave length or series wishes in proposed_text as soft guidance.\n"
    "- conflicts: short plain-language notes when the new request contradicts something in "
    "the reader's EXISTING SIGNALS (a rejected taste trait, or a book they marked "
    "less-like-this). One sentence each; empty list when there is no clash. Never resolve a "
    "conflict yourself; just surface it.\n"
    "- assistant_message: one short, friendly line to the reader: confirm what you captured "
    "and, only if useful, ask one clarifying question.\n\n"
    "Use plain punctuation only. No em dashes."
)

_DISTILL_TOOL = {
    "name": "record_directive",
    "description": "Record the distilled custom-instructions text, derived hard constraints, "
    "any conflicts with existing signals, and one short message back to the reader.",
    "input_schema": {
        "type": "object",
        "properties": {
            "proposed_text": {
                "type": "string",
                "description": "The durable custom-instructions record, second person, plain "
                "sentences. Stands on its own without the chat.",
            },
            "constraints": {
                "type": "object",
                "description": "Hard filters the reader stated. Omit any not stated.",
                "properties": {
                    "languages": {"type": "array", "items": {"type": "string"},
                                  "description": "ISO 639-1 codes, only when a language is named."},
                    "min_year": {"type": "integer"},
                    "max_year": {"type": "integer"},
                    "exclude_subjects": {"type": "array", "items": {"type": "string"}},
                    "exclude_authors": {"type": "array", "items": {"type": "string"},
                                        "description": "Author surnames to avoid."},
                },
            },
            "conflicts": {
                "type": "array",
                "items": {"type": "string"},
                "description": "One-sentence notes where the request clashes with existing signals.",
            },
            "assistant_message": {
                "type": "string",
                "description": "One short line back to the reader.",
            },
        },
        "required": ["proposed_text"],
    },
}


def _existing_signals(session, user_id: str) -> dict:
    """The rejected traits + more/less-like books used as conflict-detection context."""
    rejected_traits = [
        t.claim
        for t in session.query(TasteTrait).filter(
            TasteTrait.user_id == user_id, TasteTrait.status == "rejected"
        )
    ]

    def _label(book_id):
        if book_id is None:
            return None
        b = session.query(Book).filter(
            Book.id == book_id, Book.user_id == user_id
        ).one_or_none()
        if b is None:
            return None
        return f"{b.title} by {b.author}" if b.author else b.title

    more_like, less_like = [], []
    for sig in session.query(TasteSignal).filter(
        TasteSignal.user_id == user_id, TasteSignal.target_kind == "book"
    ):
        label = _label(sig.target_book_id)
        if label is None:
            continue
        (more_like if sig.direction == "more" else less_like).append(label)
    return {"rejected_traits": rejected_traits, "more_like": more_like, "less_like": less_like}


def distill_directive(
    message: str, *, current_text: str | None = None, user_id: str = LOCAL_USER_ID
) -> dict:
    """Authoring aid: distill a reader's prose into a proposed directive record.

    Ephemeral: this NEVER writes the directive. The caller shows the proposal (and any
    conflicts) and only `set_directive` persists once the reader accepts. Tracks spend under
    operation 'directive_distill'.
    """
    init_db()
    api_key = resolve_anthropic_key(user_id)
    if not api_key:
        raise RuntimeError(
            "No Anthropic API key configured. Add your key in Settings (or set "
            "ANTHROPIC_API_KEY) before using the custom-instructions assistant."
        )

    with session_scope() as session:
        signals = _existing_signals(session, user_id)

    client = Anthropic(api_key=api_key)
    prompt = (
        "CURRENT INSTRUCTIONS (may be empty):\n"
        + (current_text or "(none yet)")
        + "\n\nEXISTING SIGNALS (JSON - for conflict detection only):\n"
        + json.dumps(signals, ensure_ascii=False)
        + '\n\nREADER MESSAGE:\n"'
        + (message or "").strip()
        + '"'
    )
    msg = tracked_create(
        client,
        user_id=user_id,
        operation="directive_distill",
        model=_DISTILL_MODEL,
        max_tokens=1200,
        system=_DISTILL_SYSTEM,
        tools=[_DISTILL_TOOL],
        tool_choice={"type": "tool", "name": "record_directive"},
        messages=[{"role": "user", "content": prompt}],
    )
    for block in msg.content:
        if getattr(block, "type", None) == "tool_use":
            data = block.input
            return {
                "proposed_text": (data.get("proposed_text") or "").strip(),
                "constraints": _clean_directive_constraints(data.get("constraints") or {}),
                "conflicts": [
                    str(c).strip() for c in (data.get("conflicts") or []) if str(c).strip()
                ],
                "assistant_message": (data.get("assistant_message") or "").strip(),
            }
    return {
        "proposed_text": current_text or "",
        "constraints": {},
        "conflicts": [],
        "assistant_message": "",
    }
