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

from anthropic import Anthropic

from .config import LOCAL_USER_ID, get_settings
from .db import (
    Book,
    ProfileMeta,
    Recommendation,
    TasteSignal,
    TasteTrait,
    init_db,
    session_scope,
    utcnow,
)
from .usage import tracked_create
from .user_settings import resolve_anthropic_key

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


def build_tiers(
    session,
    user_id: str = LOCAL_USER_ID,
    less_like_books: list[str] | None = None,
) -> dict[str, list[dict]]:
    """Return `user_id`'s rated books, DNF books, and noted rejected recs grouped into tiers.

    When `less_like_books` is provided (titles the user marked "less like"), they are
    surfaced in a `less_like` bucket so the extractor can sharpen aversion reasoning.
    """
    tiers: dict[str, list[dict]] = {"5": [], "4": [], "3": [], "<=2": [], "dnf": [], "rejected": []}
    for book in session.query(Book).filter(
        Book.user_id == user_id, Book.exclude_from_profile.is_(False)
    ).all():
        if book.exclusive_shelf == "did-not-finish":
            tiers["dnf"].append(_book_payload(book))
            continue
        r = book.effective_rating
        if r is None:
            continue
        tiers[_tier(r)].append(_book_payload(book))
    # Rejected recommendations with a user note are explicit aversion signal.
    for rec in (
        session.query(Recommendation)
        .filter(
            Recommendation.user_id == user_id,
            Recommendation.status == "rejected",
            Recommendation.user_note.isnot(None),
        )
        .all()
    ):
        tiers["rejected"].append(
            {"title": rec.title, "author": rec.author, "note": rec.user_note}
        )
    if less_like_books:
        tiers["less_like"] = [{"title": t} for t in less_like_books]
    return tiers


def get_profile_meta(session, user_id: str = LOCAL_USER_ID) -> ProfileMeta:
    """Return this user's ProfileMeta row, creating it on first use.

    Was a singleton (id=1); now keyed by user_id (one row per user).
    """
    meta = (
        session.query(ProfileMeta).filter(ProfileMeta.user_id == user_id).one_or_none()
    )
    if meta is None:
        meta = ProfileMeta(user_id=user_id)
        session.add(meta)
        session.flush()
    return meta


def mark_profiled(session, kind: str, user_id: str = LOCAL_USER_ID) -> None:
    """Stamp the user's profile as freshly built — clears the 'dirty' state."""
    meta = get_profile_meta(session, user_id)
    meta.last_profiled_at = utcnow()
    meta.last_profile_kind = kind


def books_changed_since(
    session, since: datetime | None, user_id: str = LOCAL_USER_ID
) -> list[Book]:
    """Rated books, DNF books, and favorited books (of `user_id`) whose in-app feedback
    changed after `since`.

    Includes books toggled to/from `exclude_from_profile` so that those changes
    dirty the profile. `since=None` (never profiled) means every book carrying
    feedback is 'changed'. Unrated books are excluded unless they are favorited —
    favorites are sent to Claude as positive signal regardless of rating, so toggling
    a favorite must dirty the profile.
    """
    q = session.query(Book).filter(
        Book.user_id == user_id,
        Book.feedback_updated_at.isnot(None),
    )
    if since is not None:
        q = q.filter(Book.feedback_updated_at > since)
    return [
        b for b in q.all()
        if b.effective_rating is not None
        or b.exclusive_shelf == "did-not-finish"
        or b.is_favorite
    ]


# --- structured feedback (Task 2.1) ----------------------------------------
#
# User verdicts on traits (TasteTrait.status / user_weight) and explicit more/less
# steering (TasteSignal) are durable preferences. The profiler reads them so that a
# rebuild honors what the user has already told us: confirmed traits are preserved,
# rejected traits are never re-derived (even as paraphrases), downweighted traits are
# softened, and more/less-like books are surfaced as strong positive/negative signal.


def _feedback_context(session, user_id: str = LOCAL_USER_ID) -> dict:
    """Collect the user's trait verdicts + more/less book signals for `user_id`.

    Returns the buckets the profiler injects into its prompts. `confirmed` and
    `edited` are user-locked traits (preserved as their own rows, never re-emitted).
    `more_like` /
    `less_like` join TasteSignal -> Book to render "{title} by {author}" strings
    (book-kind signals only; rec-kind snapshots are handled in Phase 2.2).
    """
    traits = session.query(TasteTrait).filter(TasteTrait.user_id == user_id).all()

    confirmed = [t.claim for t in traits if t.status == "confirmed"]
    edited = [t.claim for t in traits if t.status == "edited"]
    rejected = [t.claim for t in traits if t.status == "rejected"]
    downweighted = [
        {"claim": t.claim, "user_weight": t.user_weight}
        for t in traits
        if (t.user_weight is not None and t.user_weight < 1.0 and t.status != "rejected")
    ]

    def _book_label(book_id: int | None) -> str | None:
        if book_id is None:
            return None
        book = session.query(Book).filter(
            Book.id == book_id, Book.user_id == user_id
        ).one_or_none()
        if book is None:
            return None
        if book.author:
            return f"{book.title} by {book.author}"
        return book.title

    more_like: list[str] = []
    less_like: list[str] = []
    signals = (
        session.query(TasteSignal)
        .filter(TasteSignal.user_id == user_id, TasteSignal.target_kind == "book")
        .all()
    )
    for sig in signals:
        label = _book_label(sig.target_book_id)
        if label is None:
            continue
        if sig.direction == "more":
            more_like.append(label)
        elif sig.direction == "less":
            less_like.append(label)

    favorite_books = (
        session.query(Book)
        .filter(Book.user_id == user_id, Book.is_favorite == True)  # noqa: E712
        .all()
    )
    favorites = [
        f"{b.title} by {b.author}" if b.author else b.title
        for b in favorite_books
    ]

    return {
        "confirmed": confirmed,
        "edited": edited,
        "rejected": rejected,
        "downweighted": downweighted,
        "more_like": more_like,
        "less_like": less_like,
        "favorites": favorites,
    }


def _feedback_block(feedback: dict | None) -> str:
    """Render the `## User Feedback` prompt section, or "" when feedback is empty."""
    if not feedback:
        return ""
    lines: list[str] = []
    # Confirmed AND edited traits are user-locked: they are stored separately and
    # survive every rebuild as their own rows. Claude must NOT echo them back into
    # its output — doing so creates duplicate 'proposed' rows alongside the locked
    # ones. So we describe them as fixed context to respect, not to reproduce.
    locked = list(feedback.get("confirmed") or []) + list(feedback.get("edited") or [])
    if locked:
        lines.append(
            "The following traits are already locked in by the user and are stored "
            "separately — do NOT output them (or reworded variants) in your trait "
            "list, and do not contradict them: " + "; ".join(locked)
        )
    if feedback.get("rejected"):
        lines.append(
            "The following traits were rejected by the user — do NOT re-derive or "
            "include variants of these: " + "; ".join(feedback["rejected"])
        )
    if feedback.get("downweighted"):
        rendered = "; ".join(
            f"{d['claim']} (weight {d['user_weight']})"
            for d in feedback["downweighted"]
        )
        lines.append(
            "The following traits should be softened (user finds them less "
            "important): " + rendered
        )
    if feedback.get("more_like"):
        lines.append(
            "The user wants MORE recommendations like: "
            + "; ".join(feedback["more_like"])
            + " — treat these as strong positive signal"
        )
    if feedback.get("less_like"):
        lines.append(
            "The user wants FEWER recommendations like: "
            + "; ".join(feedback["less_like"])
            + " — treat these as strong negative signal (aversion)"
        )
    if feedback.get("favorites"):
        lines.append(
            "The following are the user's all-time favorite books — weight these "
            "as the strongest possible positive signal when deriving taste traits: "
            + "; ".join(feedback["favorites"])
        )
    if not lines:
        return ""
    return "\n\n## User Feedback\n" + "\n".join(f"- {line}" for line in lines) + "\n"


_REJECT_STOPWORDS = frozenset(
    {
        "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
        "above", "all", "over", "under", "this", "that", "these", "those", "its",
        "it", "is", "are", "be", "as", "than", "but", "not", "no",
    }
)


def _claim_tokens(text: str) -> set[str]:
    import re

    return {
        w
        for w in re.findall(r"[a-z0-9]+", (text or "").lower())
        if w not in _REJECT_STOPWORDS
    }


def _remove_rejected_claims(
    new_traits: list[dict], rejected_claims: list[str]
) -> list[dict]:
    """Drop traits whose claim case-insensitively matches a rejected claim.

    Guards against a user-killed trait sneaking back in as a paraphrase. Matching is
    case-insensitive and covers both a substring hit and a high significant-token
    overlap (>= 60% of the rejected claim's content words present in the candidate),
    so a reworded variant of a rejected trait is still filtered.
    """
    if not rejected_claims:
        return new_traits
    rejected = [r for r in rejected_claims if r and r.strip()]
    rej_lower = [r.strip().lower() for r in rejected]
    rej_tokens = [_claim_tokens(r) for r in rejected]

    kept: list[dict] = []
    for t in new_traits:
        claim = (t.get("claim") or "").strip()
        claim_lower = claim.lower()
        claim_tokens = _claim_tokens(claim)
        matched = False
        for r_lower, r_tokens in zip(rej_lower, rej_tokens):
            if claim_lower and (r_lower in claim_lower or claim_lower in r_lower):
                matched = True
                break
            if r_tokens:
                overlap = len(r_tokens & claim_tokens) / len(r_tokens)
                if overlap >= 0.6:
                    matched = True
                    break
        if not matched:
            kept.append(t)
    return kept


def _build_prompt(tiers: dict[str, list[dict]], feedback: dict | None = None) -> str:
    counts = {k: len(v) for k, v in tiers.items()}
    return (
        "Below is a reader's library, grouped by star rating and status. Each book has "
        "enriched metadata (subjects, year, length, series). Most books have no review "
        "text, so reason mainly from metadata + the rating tiers — but where a book "
        "carries a `review` field, those are the reader's own words: treat them as the "
        "strongest, most direct signal, above any metadata inference.\n\n"
        f"Tier sizes: {counts}. Note the heavy positive skew — 'loved it' has low "
        "discriminative power, so focus on what is genuinely distinguishing.\n\n"
        "The `dnf` tier contains books the reader abandoned before finishing. Treat "
        "these as the strongest possible aversion signal, even stronger than 1-2 star "
        "ratings, since the reader could not complete them. Any `review` field on a "
        "DNF book is direct first-person evidence explaining why they quit.\n\n"
        "The `rejected` tier contains books the reader explicitly skipped when "
        "recommended, with a note explaining why. These are direct first-person "
        "statements of aversion — treat each `note` as reliable testimony about what "
        "this reader does NOT want, and use them to sharpen aversion traits.\n\n"
        "Infer the reader's taste traits. Prioritize, in order:\n"
        "  1. What separates the 5-star books from the 4-star books?\n"
        "  2. What do the lowest-rated books (<=2 and 3), DNF books, and rejected recommendations share? (these are 'aversion' traits)\n"
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
        + _feedback_block(feedback)
    )


def extract_taste_profile(*, max_tokens: int = 3000, user_id: str = LOCAL_USER_ID) -> dict:
    """Run the extractor and persist proposed traits for `user_id`. Returns a summary dict.

    Replaces any existing 'proposed' traits (a fresh run supersedes the last);
    user-confirmed/edited traits would be preserved in a later phase.
    """
    init_db()
    settings = get_settings()
    api_key = resolve_anthropic_key(user_id)
    if not api_key:
        raise RuntimeError(
            "No Anthropic API key configured. Add your key in Settings (or set "
            "ANTHROPIC_API_KEY) before running the taste-profile step."
        )
    with session_scope() as session:
        tiers = build_tiers(session, user_id)
        total_rated = sum(len(v) for k, v in tiers.items() if k != "rejected")
        if total_rated == 0:
            raise RuntimeError(
                "No rated books found. Run ingest (and enrich) first."
            )

        feedback = _feedback_context(session, user_id)
        prompt = _build_prompt(tiers, feedback=feedback)

        client = Anthropic(api_key=api_key)
        message = tracked_create(
            client,
            user_id=user_id,
            operation="profile_full",
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

        # Never let a user-rejected trait return (even reworded).
        traits = _remove_rejected_claims(traits, feedback["rejected"])
        # User-locked (confirmed/edited) traits persist as their own rows; drop any
        # echo so the rebuild can't create duplicate 'proposed' copies of them.
        traits = _remove_rejected_claims(
            traits, feedback["confirmed"] + feedback["edited"]
        )

        valid_ids = {b["id"] for tier in tiers.values() for b in tier}

        # Replace prior proposed traits (this user's only).
        session.query(TasteTrait).filter(
            TasteTrait.user_id == user_id, TasteTrait.status == "proposed"
        ).delete()

        saved = 0
        for t in traits:
            exhibits = [i for i in t.get("exhibits", []) if i in valid_ids]
            contrasts = [i for i in t.get("contrasts", []) if i in valid_ids]
            session.add(
                TasteTrait(
                    user_id=user_id,
                    claim=t.get("claim", "").strip(),
                    polarity=t.get("polarity", "reward"),
                    exhibits=exhibits,
                    contrasts=contrasts,
                    inference_confidence=float(t.get("inference_confidence", 0.0)),
                    status="proposed",
                )
            )
            saved += 1

        mark_profiled(session, "full", user_id)

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
    feedback: dict | None = None,
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
        + _feedback_block(feedback)
    )


def update_taste_profile(*, max_tokens: int = 3000, user_id: str = LOCAL_USER_ID) -> dict:
    """Incrementally revise `user_id`'s taste profile from recent edits only.

    Sends just the changed books + the books the current traits cite (not the whole
    library) and asks Claude to revise the trait set. Falls back to a full
    `extract_taste_profile` when there is no prior profile to build on. Marks the profile
    fresh on success (clearing the 'dirty' state). Returns a summary dict.
    """
    init_db()
    settings = get_settings()
    api_key = resolve_anthropic_key(user_id)
    if not api_key:
        raise RuntimeError(
            "No Anthropic API key configured. Add your key in Settings (or set "
            "ANTHROPIC_API_KEY) before running the taste-profile step."
        )
    with session_scope() as session:
        existing = (
            session.query(TasteTrait)
            .filter(TasteTrait.user_id == user_id, TasteTrait.status == "proposed")
            .all()
        )
        meta = get_profile_meta(session, user_id)
        since = meta.last_profiled_at

    # No prior profile to revise -> a full build is both correct and necessary.
    if not existing or since is None:
        return extract_taste_profile(max_tokens=max_tokens, user_id=user_id)

    with session_scope() as session:
        changed = books_changed_since(session, since, user_id)
        # Excluded books must not be sent to Claude for profiling — only include
        # non-excluded books as the "changed" signal for the incremental update.
        # Keeping excluded books in `books_changed_since` (above) is intentional:
        # it ensures toggling a book's exclude flag dirties the profile.
        # If the only changes are exclusion toggles, a full rebuild is required to
        # properly drop their signal from the existing traits.
        changed_ids = [b.id for b in changed if not b.exclude_from_profile]

        # Check whether trait verdicts, taste signals, or rec rejection reasons were
        # recorded after the last profile build.
        meta_for_check = get_profile_meta(session, user_id)
        has_feedback_since = (
            since is not None
            and (
                session.query(TasteTrait)
                .filter(
                    TasteTrait.user_id == user_id,
                    TasteTrait.verdict_updated_at > since,
                )
                .first()
                is not None
                or session.query(TasteSignal)
                .filter(
                    TasteSignal.user_id == user_id,
                    TasteSignal.created_at > since,
                )
                .first()
                is not None
                or (
                    meta_for_check.rec_feedback_updated_at is not None
                    and meta_for_check.rec_feedback_updated_at > since
                )
            )
        )

        if not changed_ids:
            if not changed and not has_feedback_since:
                return {
                    "mode": "update",
                    "changed_books": 0,
                    "traits_before": len(existing),
                    "traits_after": len(existing),
                    "note": "Profile already up to date — no rating/review changes since last build.",
                    "model": settings.model,
                }
            if not has_feedback_since:
                # Only exclusion toggles changed; incremental update cannot remove their
                # signal, so fall back to a full rebuild.
                return extract_taste_profile(max_tokens=max_tokens, user_id=user_id)
            # Feedback-only update: no changed books, but verdicts/signals need incorporation.
            # Fall through with empty changed_ids so the prompt carries current traits +
            # feedback context; Claude revises based on the feedback block alone.

        # Serialize the current traits and gather the books they cite.
        current_rows = (
            session.query(TasteTrait)
            .filter(TasteTrait.user_id == user_id, TasteTrait.status == "proposed")
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
        wanted_ids = cited_ids.union(changed_ids)

        books = {
            b.id: b
            for b in session.query(Book)
            .filter(Book.user_id == user_id, Book.id.in_(wanted_ids))
            .all()
        }
        books_meta: dict[int, dict] = {}
        for bid, b in books.items():
            payload = _book_payload(b)
            payload["rating"] = b.effective_rating
            books_meta[bid] = payload

        feedback = _feedback_context(session, user_id)
        prompt = _build_update_prompt(
            current_traits, books_meta, changed_ids, feedback=feedback
        )

        client = Anthropic(api_key=api_key)
        message = tracked_create(
            client,
            user_id=user_id,
            operation="profile_update",
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

        traits = _remove_rejected_claims(traits, feedback["rejected"])
        # User-locked (confirmed/edited) traits persist as their own rows; drop any
        # echo so the rebuild can't create duplicate 'proposed' copies of them.
        traits = _remove_rejected_claims(
            traits, feedback["confirmed"] + feedback["edited"]
        )

        valid_ids = set(books_meta.keys())

        session.query(TasteTrait).filter(
            TasteTrait.user_id == user_id, TasteTrait.status == "proposed"
        ).delete()

        saved = 0
        for t in traits:
            exhibits = [i for i in t.get("exhibits", []) if i in valid_ids]
            contrasts = [i for i in t.get("contrasts", []) if i in valid_ids]
            session.add(
                TasteTrait(
                    user_id=user_id,
                    claim=t.get("claim", "").strip(),
                    polarity=t.get("polarity", "reward"),
                    exhibits=exhibits,
                    contrasts=contrasts,
                    inference_confidence=float(t.get("inference_confidence", 0.0)),
                    status="proposed",
                )
            )
            saved += 1

        mark_profiled(session, "update", user_id)

    return {
        "mode": "update",
        "changed_books": len(changed_ids),
        "books_sent": len(books_meta),
        "traits_before": len(existing),
        "traits_after": saved,
        "model": settings.model,
    }
