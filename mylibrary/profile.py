"""Phase 3 — Taste-profile extractor (the course-concept showcase).

Groups rated books by rating tier, hands Claude each tier *with enriched metadata*,
and asks it to infer what DISTINGUISHES the tiers — not "what genres does this person
like." The output is captured via tool use / structured output as a list of evidence-
backed traits, each citing the specific book ids that support it.

Design notes that match the locked decisions:
  - Metadata-driven, not review-text-driven (the library has ~no written reviews).
  - The interesting signal is contrast: what separates 5* from 4*, and what the rare
    low-rated books share. The prompt asks for exactly that.
  - Nothing is asserted without evidence: every trait must cite supporting_book_ids,
    drawn only from the ids we provide.
"""

from __future__ import annotations

import json

from .config import get_settings
from .db import Book, TasteTrait, init_db, session_scope

_TOOL = {
    "name": "record_taste_traits",
    "description": (
        "Record the taste traits inferred from the reader's rated library. "
        "Each trait must distinguish rating tiers and cite the book ids that support it."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "traits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim": {
                            "type": "string",
                            "description": (
                                "A specific, falsifiable claim about what drives this "
                                "reader's ratings, e.g. 'Rewards dense political "
                                "world-building over fast plotting.' Avoid generic "
                                "genre statements."
                            ),
                        },
                        "polarity": {
                            "type": "string",
                            "enum": ["reward", "aversion"],
                            "description": (
                                "'reward' = trait associated with higher ratings; "
                                "'aversion' = trait shared by lower-rated books."
                            ),
                        },
                        "supporting_book_ids": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "Book ids (from the provided data) that evidence this trait.",
                        },
                        "inference_confidence": {
                            "type": "number",
                            "description": "0..1 — how strongly the evidence supports the claim.",
                        },
                    },
                    "required": [
                        "claim",
                        "polarity",
                        "supporting_book_ids",
                        "inference_confidence",
                    ],
                },
            }
        },
        "required": ["traits"],
    },
}

_SYSTEM = (
    "You are a literary taste analyst. You infer what drives a specific reader's "
    "ratings from their library metadata. You reason about CONTRAST between rating "
    "tiers, never asserting a trait without citing the books that evidence it. You "
    "only cite book ids that appear in the provided data."
)


def _tier(rating: int) -> str:
    if rating >= 5:
        return "5"
    if rating == 4:
        return "4"
    if rating == 3:
        return "3"
    return "<=2"


def _book_payload(book: Book) -> dict:
    enr = book.enrichment
    subjects = (enr.subjects or [])[:8] if enr else []
    return {
        "id": book.id,
        "title": book.title,
        "author": book.author,
        "year": book.year_published,
        "pages": book.page_count,
        "subjects": subjects,
        "series": enr.series if enr else None,
    }


def build_tiers(session) -> dict[str, list[dict]]:
    """Return rated books grouped into rating tiers, with enriched metadata."""
    tiers: dict[str, list[dict]] = {"5": [], "4": [], "3": [], "<=2": []}
    for book in session.query(Book).all():
        r = book.effective_rating
        if r is None:
            continue
        tiers[_tier(r)].append(_book_payload(book))
    return tiers


def _build_prompt(tiers: dict[str, list[dict]]) -> str:
    counts = {k: len(v) for k, v in tiers.items()}
    return (
        "Below is a reader's rated library, grouped by star rating. Each book has "
        "enriched metadata (subjects, year, length, series). There is essentially no "
        "review text, so reason from metadata + the rating tiers only.\n\n"
        f"Tier sizes: {counts}. Note the heavy positive skew — 'loved it' has low "
        "discriminative power, so focus on what is genuinely distinguishing.\n\n"
        "Infer the reader's taste traits. Prioritize, in order:\n"
        "  1. What separates the 5-star books from the 4-star books?\n"
        "  2. What do the lowest-rated books (<=2 and 3) share? (these are 'aversion' traits)\n"
        "  3. Cross-cutting rewards visible across the high tiers.\n\n"
        "Rules: every trait must cite supporting_book_ids drawn ONLY from the ids "
        "below. Make claims specific and falsifiable, not generic genre labels. "
        "Aim for 6-12 traits. Record them with the record_taste_traits tool.\n\n"
        "LIBRARY DATA (JSON):\n"
        + json.dumps(tiers, ensure_ascii=False)
    )


def extract_taste_profile(*, max_tokens: int = 3000) -> dict:
    """Run the extractor and persist proposed traits. Returns a summary dict.

    Replaces any existing 'proposed' traits (a fresh run supersedes the last);
    user-confirmed/edited traits would be preserved in a later phase.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key "
            "(https://console.anthropic.com/) before running the taste-profile step."
        )

    init_db()
    with session_scope() as session:
        tiers = build_tiers(session)
        total_rated = sum(len(v) for v in tiers.values())
        if total_rated == 0:
            raise RuntimeError(
                "No rated books found. Run ingest (and enrich) first."
            )

        prompt = _build_prompt(tiers)

        # Imported lazily so ingest/enrich work without the anthropic package present.
        from anthropic import Anthropic

        client = Anthropic(api_key=settings.anthropic_api_key)
        message = client.messages.create(
            model=settings.model,
            max_tokens=max_tokens,
            system=_SYSTEM,
            tools=[_TOOL],
            tool_choice={"type": "tool", "name": "record_taste_traits"},
            messages=[{"role": "user", "content": prompt}],
        )

        traits = []
        for block in message.content:
            if getattr(block, "type", None) == "tool_use":
                traits = block.input.get("traits", [])
                break

        valid_ids = {b["id"] for tier in tiers.values() for b in tier}

        # Replace prior proposed traits.
        session.query(TasteTrait).filter(TasteTrait.status == "proposed").delete()

        saved = 0
        for t in traits:
            supporting = [i for i in t.get("supporting_book_ids", []) if i in valid_ids]
            session.add(
                TasteTrait(
                    claim=t.get("claim", "").strip(),
                    polarity=t.get("polarity", "reward"),
                    supporting_book_ids=supporting,
                    inference_confidence=float(t.get("inference_confidence", 0.0)),
                    status="proposed",
                )
            )
            saved += 1

    return {
        "rated_books": total_rated,
        "tiers": {k: len(v) for k, v in tiers.items()},
        "traits_saved": saved,
        "model": settings.model,
    }
