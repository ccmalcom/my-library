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
from datetime import datetime

from .config import get_settings
from .db import Book, ProfileMeta, TasteTrait, init_db, session_scope

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
                        "exhibits": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": (
                                "Book ids that EXHIBIT the trait: for a 'reward', the "
                                "high-rated books showing it; for an 'aversion', the "
                                "low-rated books showing it. These must be consistent "
                                "with the polarity — do NOT put high-rated books here "
                                "for an aversion."
                            ),
                        },
                        "contrasts": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": (
                                "Book ids that anchor the CONTRAST — the counter-examples "
                                "that make the distinction sharp (e.g. for an aversion to "
                                "X, similar books WITHOUT X that scored higher). May be "
                                "empty if the trait stands on its exhibits alone."
                            ),
                        },
                        "inference_confidence": {
                            "type": "number",
                            "description": "0..1 — how strongly the evidence supports the claim.",
                        },
                    },
                    "required": [
                        "claim",
                        "polarity",
                        "exhibits",
                        "contrasts",
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
    # Prefer the actual read date; fall back to when it was added to the shelf.
    read_date = book.date_read or book.date_added
    payload = {
        "id": book.id,
        "title": book.title,
        "author": book.author,
        "year": book.year_published,
        "pages": book.page_count,
        "subjects": subjects,
        "series": enr.series if enr else None,
        "read_year": read_date.year if read_date else None,
    }
    # Reviews are the rare direct signal — include verbatim (capped) when present.
    if book.app_review:
        payload["review"] = book.app_review.strip()[:1000]
    return payload


def build_tiers(session) -> dict[str, list[dict]]:
    """Return rated books grouped into rating tiers, with enriched metadata."""
    tiers: dict[str, list[dict]] = {"5": [], "4": [], "3": [], "<=2": []}
    for book in session.query(Book).all():
        r = book.effective_rating
        if r is None:
            continue
        tiers[_tier(r)].append(_book_payload(book))
    return tiers


def get_profile_meta(session) -> ProfileMeta:
    """Return the single ProfileMeta row, creating it (id=1) on first use."""
    meta = session.get(ProfileMeta, 1)
    if meta is None:
        meta = ProfileMeta(id=1)
        session.add(meta)
        session.flush()
    return meta


def mark_profiled(session, kind: str) -> None:
    """Stamp the profile as freshly built — clears the 'dirty' state."""
    meta = get_profile_meta(session)
    meta.last_profiled_at = datetime.utcnow()
    meta.last_profile_kind = kind


def books_changed_since(session, since: datetime | None) -> list[Book]:
    """Rated books whose in-app rating/review changed after `since`.

    `since=None` (never profiled) means every book carrying feedback is 'changed'.
    Unrated books are excluded — they don't participate in taste analysis.
    """
    q = session.query(Book).filter(Book.feedback_updated_at.isnot(None))
    if since is not None:
        q = q.filter(Book.feedback_updated_at > since)
    return [b for b in q.all() if b.effective_rating is not None]


def _build_prompt(tiers: dict[str, list[dict]]) -> str:
    counts = {k: len(v) for k, v in tiers.items()}
    return (
        "Below is a reader's rated library, grouped by star rating. Each book has "
        "enriched metadata (subjects, year, length, series). Most books have no review "
        "text, so reason mainly from metadata + the rating tiers — but where a book "
        "carries a `review` field, those are the reader's own words: treat them as the "
        "strongest, most direct signal, above any metadata inference.\n\n"
        f"Tier sizes: {counts}. Note the heavy positive skew — 'loved it' has low "
        "discriminative power, so focus on what is genuinely distinguishing.\n\n"
        "Infer the reader's taste traits. Prioritize, in order:\n"
        "  1. What separates the 5-star books from the 4-star books?\n"
        "  2. What do the lowest-rated books (<=2 and 3) share? (these are 'aversion' traits)\n"
        "  3. Cross-cutting rewards visible across the high tiers.\n\n"
        "For EACH trait, split the evidence into two fields:\n"
        "  - `exhibits`: the books that SHOW the trait. These MUST match the polarity — "
        "an aversion's exhibits are LOW-rated books, a reward's exhibits are HIGH-rated. "
        "Never put high-rated books in an aversion's exhibits.\n"
        "  - `contrasts`: the counter-examples that sharpen the distinction (e.g. for an "
        "aversion to X, similar books WITHOUT X that scored higher). May be empty.\n\n"
        "Temporal context: The `read_year` field shows when each book was read (or "
        "added to the shelf). Tastes evolve, so weight this accordingly:\n"
        "  - Recent reads (2020+) are the strongest signal of current preferences.\n"
        "  - Mid-era reads (2015-2019) are relevant but may reflect a transitional period.\n"
        "  - Older reads (pre-2015) may reflect a different life stage entirely — for "
        "example, a heavy YA phase in one's teens is not necessarily a current preference.\n"
        "  - Lower `inference_confidence` for traits supported only by older reads unless "
        "those same traits are echoed in more recent ones. If a trait is consistent across "
        "all eras, call it an enduring preference (and note that in the claim).\n"
        "  IMPORTANT EXCEPTION — do NOT apply temporal discounting to traits rooted in "
        "values or representation (e.g. LGBTQ+ themes, feminist perspectives, racial or "
        "political identity in fiction). A reader's core values rarely regress with age: "
        "the absence of such themes in recent reads more likely reflects the books "
        "available than a shift in the reader's preferences. If a value-based trait is "
        "consistent across any era of the library, treat it as enduring regardless of "
        "when those books were read. Only downweight it if recent reads actively "
        "contradict it (e.g. the reader started rating books with that theme *lower*).\n\n"
        "Quality rules:\n"
        "  - Use ONLY book ids from the data below.\n"
        "  - Make claims specific and falsifiable, not generic genre labels.\n"
        "  - Do NOT force a book into a trait it doesn't fit just to pad the evidence.\n"
        "  - Keep traits DISTINCT — don't emit two traits describing the same pattern.\n"
        "  - Distinguish genuine taste from mechanical rating drift (e.g. later books in "
        "a long series slipping a star is series fatigue, not a standalone taste trait).\n"
        "  - Lower your inference_confidence when a trait rests on very few books.\n"
        "  - Aim for 6-12 traits. Record them with the record_taste_traits tool.\n\n"
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
            exhibits = [i for i in t.get("exhibits", []) if i in valid_ids]
            contrasts = [i for i in t.get("contrasts", []) if i in valid_ids]
            session.add(
                TasteTrait(
                    claim=t.get("claim", "").strip(),
                    polarity=t.get("polarity", "reward"),
                    exhibits=exhibits,
                    contrasts=contrasts,
                    inference_confidence=float(t.get("inference_confidence", 0.0)),
                    status="proposed",
                )
            )
            saved += 1

        mark_profiled(session, "full")

    return {
        "mode": "full",
        "rated_books": total_rated,
        "tiers": {k: len(v) for k, v in tiers.items()},
        "traits_saved": saved,
        "model": settings.model,
    }


# --- incremental re-profile -------------------------------------------------
#
# The full extractor ships the entire rated library to Claude. After the cold start,
# most re-profiles follow a handful of edits (a re-rate, a new review). Resending the
# whole library each time is wasteful, so `update_taste_profile` sends only:
#   - the CURRENT trait set (claims + cited evidence), and
#   - the books that CHANGED since the last profile + the books those traits already cite
# and asks Claude to REVISE the trait set in light of the new evidence. The payload scales
# with the size of the edit, not the size of the library.

_REVISE_TOOL = {
    "name": "revise_taste_traits",
    "description": (
        "Return the REVISED full taste-trait set after accounting for the reader's "
        "latest rating/review changes. Keep traits that still hold (adjusting confidence "
        "or evidence as warranted), drop traits the new evidence contradicts, and add new "
        "traits the changes reveal. Cite only book ids present in the provided data."
    ),
    # Same per-trait shape as the cold-start tool, so persistence is identical.
    "input_schema": _TOOL["input_schema"],
}

_REVISE_SYSTEM = (
    "You are a literary taste analyst maintaining a reader's evolving taste profile. "
    "You are given the profile you previously inferred plus the reader's most recent "
    "rating and review changes. You make the SMALLEST revision that honors the new "
    "evidence: keep what still holds, adjust confidence where the new data strengthens "
    "or weakens a claim, retire claims the new evidence contradicts, and add genuinely "
    "new traits. Review text is the reader's own words — weight it above metadata "
    "inference. Cite only book ids that appear in the provided data."
)


def _build_update_prompt(
    current_traits: list[dict],
    books_meta: dict[int, dict],
    changed_ids: list[int],
) -> str:
    return (
        "The reader has updated some ratings and/or written new reviews since this "
        "profile was last built. Revise the profile accordingly — do NOT re-derive it "
        "from scratch.\n\n"
        "You are NOT given the whole library, only the books needed to reason about the "
        "change: the books that changed, plus the books the current traits already cite. "
        "Cite book ids only from the BOOKS map below.\n\n"
        "How to revise:\n"
        "  - Keep traits that still hold. Raise/lower `inference_confidence` if the new "
        "evidence strengthens or weakens them, and add/remove cited book ids as fitting.\n"
        "  - Drop a trait whose evidence the changes now contradict (e.g. the reader "
        "re-rated its key exhibit, or a new review states the opposite).\n"
        "  - Add new traits the changes reveal — especially anything stated outright in a "
        "review.\n"
        "  - A new/edited `review` is direct testimony; prefer it over metadata guesses.\n"
        "  - Return the COMPLETE revised trait set (the unchanged traits too), 6-12 traits, "
        "via the revise_taste_traits tool.\n\n"
        f"CHANGED BOOK IDS (the edits driving this update): {changed_ids}\n\n"
        "CURRENT TRAITS (JSON):\n"
        + json.dumps(current_traits, ensure_ascii=False)
        + "\n\nBOOKS (id -> metadata; the only books you may cite) (JSON):\n"
        + json.dumps({str(k): v for k, v in books_meta.items()}, ensure_ascii=False)
    )


def update_taste_profile(*, max_tokens: int = 3000) -> dict:
    """Incrementally revise the taste profile from recent edits only.

    Sends just the changed books + the books the current traits cite (not the whole
    library) and asks Claude to revise the trait set. Falls back to a full
    `extract_taste_profile` when there is no prior profile to build on. Marks the profile
    fresh on success (clearing the 'dirty' state). Returns a summary dict.
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key "
            "(https://console.anthropic.com/) before running the taste-profile step."
        )

    init_db()
    with session_scope() as session:
        existing = (
            session.query(TasteTrait)
            .filter(TasteTrait.status == "proposed")
            .all()
        )
        meta = get_profile_meta(session)
        since = meta.last_profiled_at

    # No prior profile to revise -> a full build is both correct and necessary.
    if not existing or since is None:
        return extract_taste_profile(max_tokens=max_tokens)

    with session_scope() as session:
        changed = books_changed_since(session, since)
        if not changed:
            return {
                "mode": "update",
                "changed_books": 0,
                "traits_before": len(existing),
                "traits_after": len(existing),
                "note": "Profile already up to date — no rating/review changes since last build.",
                "model": settings.model,
            }

        # Serialize the current traits and gather the books they cite.
        current_rows = (
            session.query(TasteTrait)
            .filter(TasteTrait.status == "proposed")
            .all()
        )
        current_traits = [
            {
                "id": t.id,
                "claim": t.claim,
                "polarity": t.polarity,
                "inference_confidence": t.inference_confidence,
                "exhibits": t.exhibits or [],
                "contrasts": t.contrasts or [],
            }
            for t in current_rows
        ]
        cited_ids: set[int] = set()
        for t in current_rows:
            cited_ids.update(t.exhibits or [])
            cited_ids.update(t.contrasts or [])

        changed_ids = [b.id for b in changed]
        wanted_ids = cited_ids.union(changed_ids)

        books = {
            b.id: b
            for b in session.query(Book).filter(Book.id.in_(wanted_ids)).all()
        }
        books_meta: dict[int, dict] = {}
        for bid, b in books.items():
            payload = _book_payload(b)
            payload["rating"] = b.effective_rating
            books_meta[bid] = payload

        prompt = _build_update_prompt(current_traits, books_meta, changed_ids)

        from anthropic import Anthropic

        client = Anthropic(api_key=settings.anthropic_api_key)
        message = client.messages.create(
            model=settings.model,
            max_tokens=max_tokens,
            system=_REVISE_SYSTEM,
            tools=[_REVISE_TOOL],
            tool_choice={"type": "tool", "name": "revise_taste_traits"},
            messages=[{"role": "user", "content": prompt}],
        )

        traits = []
        for block in message.content:
            if getattr(block, "type", None) == "tool_use":
                traits = block.input.get("traits", [])
                break

        valid_ids = set(books_meta.keys())

        session.query(TasteTrait).filter(TasteTrait.status == "proposed").delete()

        saved = 0
        for t in traits:
            exhibits = [i for i in t.get("exhibits", []) if i in valid_ids]
            contrasts = [i for i in t.get("contrasts", []) if i in valid_ids]
            session.add(
                TasteTrait(
                    claim=t.get("claim", "").strip(),
                    polarity=t.get("polarity", "reward"),
                    exhibits=exhibits,
                    contrasts=contrasts,
                    inference_confidence=float(t.get("inference_confidence", 0.0)),
                    status="proposed",
                )
            )
            saved += 1

        mark_profiled(session, "update")

    return {
        "mode": "update",
        "changed_books": len(changed_ids),
        "books_sent": len(books_meta),
        "traits_before": len(existing),
        "traits_after": saved,
        "model": settings.model,
    }
