"""Phase 5 — the two-stage recommender.

Locked decision: the LLM is NOT the recommender. Final picks are always real catalog
books that survived retrieval; Claude only reranks and explains them. Concretely:

  Stage 1 — RETRIEVAL (hybrid, deterministic-first):
    a. metadata expansion  — pull the subjects/authors of the reader's loved books and
       query Open Library + Google Books for more books like them.
    b. Claude-seeded queries — Claude reads the taste profile and proposes SEARCH terms
       (not titles); each term is run against the live catalog. This only widens reach:
       every candidate it yields is still a real catalog hit, so nothing Claude "made up"
       can survive. (This is the one place Claude touches stage 1, and it cannot inject
       an unverified title.)
    Both pools are merged, de-duplicated, and filtered against the existing library
    (we never recommend a book you already have on any shelf).

  Stage 2 — RERANK / EXPLAIN:
    Claude scores the real candidate pool for fit against the taste profile, writes a
    grounded rationale per pick, and cites the trait ids + book ids it leaned on. Picks
    are constrained to the provided candidates; ids are validated before persisting.

The served set is persisted (one run_id per call) so the later feedback phase can mine
rejected recs as labeled negatives and a UI can show "why this".
"""

from __future__ import annotations

import json
import uuid
from collections import Counter

from .config import LOCAL_USER_ID, get_settings
from .db import Book, Recommendation, TasteSignal, TasteTrait, init_db, session_scope
from .enrich import _normalize_title, _surname
from .profile import books_changed_since, get_profile_meta
from .user_settings import resolve_anthropic_key

_REJECTED_STATUS = "rejected"

# --- tuning knobs (kept here so CLI/API stay thin) -------------------------
_TOP_SUBJECTS = 8
_TOP_AUTHORS = 6
_PER_QUERY = 8  # catalog hits to pull per subject/author/seed query
_SEED_QUERIES = 8  # how many search terms to ask Claude to propose
_MAX_CANDIDATES = 60  # cap on the pool handed to the reranker (token budget)
_SEED_RESERVE_SHARE = 0.3  # min share of the cap reserved for Claude-seeded-only candidates
_LOVED_MIN = 4  # effective rating at/above which a book counts as "loved"
_LOVED_SAMPLE = 20  # loved books shown to Claude for context
_MAX_PER_AUTHOR = 2  # cap candidates from any single author
_MAX_LIBRARY_AUTHOR_SHARE = 0.4  # cap share of candidates from authors already owned


# --- Claude stage 1b: propose search queries -------------------------------

_SEED_TOOL = {
    "name": "propose_search_queries",
    "description": (
        "Propose catalog SEARCH queries that would surface books this reader is likely "
        "to love next. These are search terms (subjects, micro-genres, comp-author "
        "phrasings) — NOT specific book titles. Each is run against a live book catalog."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "queries": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": (
                                "A catalog search query, e.g. 'literary science fiction "
                                "first contact' or 'inauthor:\"Ursula K. Le Guin\"'. Avoid "
                                "naming books the reader already owns."
                            ),
                        },
                        "reason": {
                            "type": "string",
                            "description": "Which trait/pattern this query chases.",
                        },
                    },
                    "required": ["query", "reason"],
                },
            }
        },
        "required": ["queries"],
    },
}

_SEED_SYSTEM = (
    "You expand a reader's taste profile into catalog search queries for discovery. You "
    "propose search TERMS, never specific titles, and you aim the queries at the reader's "
    "distinguishing traits (what separates their 5-star from 4-star books), not generic "
    "bestsellers."
)


# --- Claude stage 2: rerank + explain --------------------------------------

_RANK_TOOL = {
    "name": "rank_recommendations",
    "description": (
        "Rank the provided real catalog candidates by how well they fit this reader's "
        "taste profile, and explain each pick. Choose ONLY from the given candidates."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "recommendations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "candidate_index": {
                            "type": "integer",
                            "description": "The `idx` of a provided candidate. Must exist.",
                        },
                        "score": {
                            "type": "number",
                            "description": "0..1 fit with the reader's taste profile.",
                        },
                        "rationale": {
                            "type": "string",
                            "description": (
                                "1-2 sentences tying this book to specific traits/books — "
                                "concrete, not 'you'll love this'."
                            ),
                        },
                        "grounded_trait_ids": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "Trait ids (from the profile) this pick leans on.",
                        },
                        "grounded_book_ids": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "Library book ids this candidate is most like.",
                        },
                    },
                    "required": [
                        "candidate_index",
                        "score",
                        "rationale",
                        "grounded_trait_ids",
                        "grounded_book_ids",
                    ],
                },
            }
        },
        "required": ["recommendations"],
    },
}

_RANK_SYSTEM = (
    "You are a book recommender. You rank a fixed list of real catalog candidates against "
    "a reader's evidence-backed taste profile. You never invent books — you only rank the "
    "candidates given. Every pick cites the trait ids and library book ids it is grounded "
    "in, drawn only from the provided data. You prefer specific fit over popularity, and "
    "you respect aversion traits (penalize candidates that trip them)."
)


def _client(api_key: str | None = None):
    """Anthropic client, with the key checked at point of use (so callers that don't
    reach a Claude stage — or tests that patch these helpers — don't need a key).

    `api_key` is the per-user key resolved by the caller; when None it falls back to the
    env key (local/CLI). Raises if neither is available.
    """
    settings = get_settings()
    if api_key is None:
        api_key = settings.anthropic_api_key
    if not api_key:
        raise RuntimeError(
            "No Anthropic API key configured. Add your key in Settings (or set "
            "ANTHROPIC_API_KEY) before running recommend."
        )
    from anthropic import Anthropic

    return Anthropic(api_key=api_key), settings


# --- library signal --------------------------------------------------------


def _apply_author_caps(candidates: list[dict], signal: dict) -> list[dict]:
    """Cap per-author candidates and the overall share from authors already in the
    library, so small libraries don't return same-author clones. Pure filter."""
    lib_authors = signal.get("library_authors") or set()
    per_author: Counter[str] = Counter()
    kept: list[dict] = []
    for c in candidates:
        a = _surname(c.get("author"))
        if a:
            if per_author[a] >= _MAX_PER_AUTHOR:
                continue
            per_author[a] += 1
        kept.append(c)

    total = len(kept)
    if not total:
        return kept
    lib = [c for c in kept if _surname(c.get("author")) in lib_authors]
    non = [c for c in kept if _surname(c.get("author")) not in lib_authors]
    max_lib = int(total * _MAX_LIBRARY_AUTHOR_SHARE)
    if len(lib) > max_lib:
        kept = non + lib[:max_lib]
    return kept


def _dedup_key(title: str | None, author: str | None) -> tuple[str, str]:
    return (_normalize_title(title), _surname(author))


def _allowed_languages(signal: dict) -> set[str]:
    langs = signal.get("library_languages") or set()
    return set(langs) if langs else {"en"}


def _language_ok(lang: str | None, allowed: set[str]) -> bool:
    """Unknown-language candidates are always allowed (never silently dropped);
    known languages must be in the allowed set."""
    if not lang:
        return True
    return lang in allowed


def _build_signal(session, user_id: str = LOCAL_USER_ID) -> dict:
    """Summarize the library: loved books, their top subjects/authors, and the dedup
    keys/ISBNs of everything already on a shelf (so we never re-recommend them)."""
    books = session.query(Book).filter(Book.user_id == user_id).all()
    library_keys: set[tuple[str, str]] = set()
    library_isbns: set[str] = set()
    library_languages: set[str] = set()
    library_authors: set[str] = set()
    loved: list[dict] = []
    subject_counts: Counter[str] = Counter()
    author_counts: Counter[str] = Counter()

    for b in books:
        library_keys.add(_dedup_key(b.title, b.author))
        if b.isbn13:
            library_isbns.add(b.isbn13)
        enr_lang = b.enrichment.language if b.enrichment else None
        if enr_lang:
            library_languages.add(enr_lang)
        if b.author:
            library_authors.add(_surname(b.author))

        rating = b.effective_rating
        if rating is None or rating < _LOVED_MIN:
            continue
        enr = b.enrichment
        subjects = (enr.subjects or []) if enr else []
        for s in subjects:
            subject_counts[s] += 1
        if b.author:
            author_counts[b.author] += 1
        read_date = b.date_read or b.date_added
        loved.append(
            {
                "id": b.id,
                "title": b.title,
                "author": b.author,
                "rating": rating,
                "year": b.year_published,
                "subjects": subjects[:8],
                "read_year": read_date.year if read_date else None,
            }
        )

    # Also exclude explicitly rejected recommendations so they never resurface.
    rejected = (
        session.query(Recommendation)
        .filter(
            Recommendation.user_id == user_id,
            Recommendation.status == _REJECTED_STATUS,
        )
        .all()
    )
    rejected_with_notes: list[dict] = []
    for r in rejected:
        library_keys.add(_dedup_key(r.title, r.author))
        if r.isbn13:
            library_isbns.add(r.isbn13)
        if r.user_note:
            rejected_with_notes.append(
                {"title": r.title, "author": r.author, "note": r.user_note}
            )

    loved.sort(key=lambda d: (d["rating"], d["read_year"] or 0), reverse=True)
    traits = (
        session.query(TasteTrait)
        .filter(TasteTrait.user_id == user_id)
        .order_by(TasteTrait.inference_confidence.desc())
        .all()
    )

    # --- structured feedback (Task 2.2) -----------------------------------
    # more/less-like book signals, rendered "{title} by {author}" (book-kind only).
    more_like, less_like = _feedback_book_signals(session, user_id)
    # aggregate reject reasons across the user's rejected recs.
    reject_reason_counts = _reject_reason_counts(session, user_id)

    return {
        "library_keys": library_keys,
        "library_isbns": library_isbns,
        "library_languages": library_languages,
        "library_authors": library_authors,
        "loved": loved,
        "top_subjects": [s for s, _ in subject_counts.most_common(_TOP_SUBJECTS)],
        "top_authors": [a for a, _ in author_counts.most_common(_TOP_AUTHORS)],
        # Rejected traits are dead to the reranker — excluded entirely. Each surviving
        # trait carries its user_weight + status so stage-2 can weight its influence.
        "traits": [
            {
                "id": t.id,
                "claim": t.claim,
                "polarity": t.polarity,
                "confidence": round(t.inference_confidence, 2),
                "user_weight": t.user_weight if t.user_weight is not None else 1.0,
                "status": t.status or "proposed",
            }
            for t in traits
            if (t.status or "proposed") != "rejected"
        ],
        "more_like": more_like,
        "less_like": less_like,
        "reject_reason_counts": reject_reason_counts,
        "rejected_with_notes": rejected_with_notes,
    }


def _feedback_book_signals(
    session, user_id: str = LOCAL_USER_ID
) -> tuple[list[str], list[str]]:
    """more/less-like book labels from TasteSignal (book-kind), same join as
    profile._feedback_context — "{title} by {author}" (title-only if no author)."""
    more_like: list[str] = []
    less_like: list[str] = []
    signals = (
        session.query(TasteSignal)
        .filter(TasteSignal.user_id == user_id, TasteSignal.target_kind == "book")
        .all()
    )
    for sig in signals:
        if sig.target_book_id is None:
            continue
        book = (
            session.query(Book)
            .filter(Book.id == sig.target_book_id, Book.user_id == user_id)
            .one_or_none()
        )
        if book is None:
            continue
        label = f"{book.title} by {book.author}" if book.author else book.title
        if sig.direction == "more":
            more_like.append(label)
        elif sig.direction == "less":
            less_like.append(label)
    return more_like, less_like


def _reject_reason_counts(session, user_id: str = LOCAL_USER_ID) -> dict[str, int]:
    """Flatten + count reject_reasons across the user's rejected recommendations."""
    rows = (
        session.query(Recommendation)
        .filter(
            Recommendation.user_id == user_id,
            Recommendation.status == _REJECTED_STATUS,
            Recommendation.reject_reasons.isnot(None),
        )
        .all()
    )
    counts: Counter[str] = Counter()
    for r in rows:
        for reason in r.reject_reasons or []:
            counts[reason] += 1
    return dict(counts)


# --- stage 1: retrieval ----------------------------------------------------


def _metadata_pool(signal: dict, *, per_query: int) -> list[tuple[dict, str]]:
    """Deterministic expansion from the reader's loved subjects/authors."""
    from . import catalog

    pool: list[tuple[dict, str]] = []
    for subject in signal["top_subjects"]:
        for cand in catalog.openlibrary_subject(subject, max_results=per_query):
            pool.append((cand, f"subject:{subject}"))
        for cand in catalog.googlebooks_subject(subject, max_results=per_query):
            pool.append((cand, f"subject:{subject}"))
    for author in signal["top_authors"]:
        for cand in catalog.googlebooks_author(author, max_results=per_query):
            pool.append((cand, f"author:{author}"))
    return pool


def _claude_seed_queries(
    signal: dict, *, n_queries: int, api_key: str | None = None
) -> list[str]:
    """Ask Claude for catalog search terms (stage 1b). Returns query strings only."""
    client, _settings = _client(api_key)
    profile_context = (
        "TASTE TRAITS (JSON):\n"
        + json.dumps(signal["traits"], ensure_ascii=False)
        + "\n\nLOVED BOOKS (JSON):\n"
        + json.dumps(signal["loved"][:_LOVED_SAMPLE], ensure_ascii=False)
    )
    more_like = signal.get("more_like") or []
    less_like = signal.get("less_like") or []
    steering = ""
    if more_like:
        steering += (
            " Bias the queries toward the qualities of these books the reader wants "
            "more of: " + json.dumps(more_like, ensure_ascii=False) + "."
        )
    if less_like:
        steering += (
            " Avoid the qualities of these books the reader wants less of: "
            + json.dumps(less_like, ensure_ascii=False) + "."
        )
    task_prompt = (
        "A reader's taste profile and a sample of their loved books are above. Propose "
        f"up to {n_queries} CATALOG SEARCH QUERIES (search terms, not book titles) that "
        "would surface books they are likely to rate highly. Chase their distinguishing "
        "traits, cover their range, and avoid generic bestseller terms." + steering
    )
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1500,
        system=_SEED_SYSTEM,
        tools=[_SEED_TOOL],
        tool_choice={"type": "tool", "name": "propose_search_queries"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": profile_context,
                 "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": task_prompt},
            ],
        }],
    )
    for block in message.content:
        if getattr(block, "type", None) == "tool_use":
            items = block.input.get("queries", [])
            return [q["query"].strip() for q in items if q.get("query", "").strip()]
    return []


def _seed_pool(
    signal: dict, *, n_queries: int, per_query: int, api_key: str | None = None
) -> tuple[list[tuple[dict, str]], list[str]]:
    from . import catalog

    queries = _claude_seed_queries(signal, n_queries=n_queries, api_key=api_key)
    pool: list[tuple[dict, str]] = []
    for q in queries:
        for cand in catalog.googlebooks_query(q, max_results=per_query):
            pool.append((cand, f"query:{q}"))
    return pool, queries


def _fill_ol_descriptions(candidates: list[dict]) -> None:
    """Fetch Work descriptions for OL candidates that didn't get one from the pool query.

    The OL subjects endpoint returns works but no descriptions. We have the work key
    already in `catalog_source`/`catalog_id`, so one extra cached GET per OL candidate
    fills the gap. Disk-cached — repeat runs cost nothing.
    """
    from . import catalog as _catalog

    for c in candidates:
        if c.get("description") or c.get("catalog_source") != "openlibrary":
            continue
        work_key = c.get("catalog_id")
        if work_key:
            c["description"] = _catalog.openlibrary_work_description(work_key)


def _assemble(
    metadata_pool: list[tuple[dict, str]],
    seed_pool: list[tuple[dict, str]],
    signal: dict,
    *,
    cap: int,
) -> list[dict]:
    """Merge both pools, drop library books + duplicates, tag provenance, cap size."""
    library_keys = signal["library_keys"]
    library_isbns = signal["library_isbns"]
    allowed_langs = _allowed_languages(signal)
    by_key: dict[tuple[str, str], dict] = {}

    def add(cand: dict, reason: str, pool_name: str) -> None:
        title = cand.get("title")
        if not title:
            return
        key = _dedup_key(title, cand.get("author"))
        if key in library_keys or key == ("", ""):
            return
        isbn = cand.get("isbn13")
        if isbn and isbn in library_isbns:
            return
        if not _language_ok(cand.get("language"), allowed_langs):
            return
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = {
                "title": title,
                "author": cand.get("author"),
                "year": cand.get("year"),
                "isbn13": isbn,
                "subjects": (cand.get("subjects") or [])[:8],
                "description": cand.get("description"),
                "cover_url": cand.get("cover_url"),
                "catalog_source": cand.get("source"),
                "catalog_id": cand.get("resolved_id"),
                "language": cand.get("language"),
                "pools": {pool_name},
                "seed_reason": reason,
            }
        else:
            existing["pools"].add(pool_name)
            if not existing.get("author") and cand.get("author"):
                existing["author"] = cand.get("author")
            if not existing.get("subjects") and cand.get("subjects"):
                existing["subjects"] = (cand.get("subjects") or [])[:8]
            if not existing.get("description") and cand.get("description"):
                existing["description"] = cand.get("description")
            if not existing.get("language") and cand.get("language"):
                existing["language"] = cand.get("language")

    for cand, reason in metadata_pool:
        add(cand, reason, "metadata")
    for cand, reason in seed_pool:
        add(cand, reason, "claude_seed")

    candidates = []
    for c in by_key.values():
        pools = c.pop("pools")
        c["retrieval_pool"] = "both" if len(pools) > 1 else next(iter(pools))
        candidates.append(c)
    candidates = _apply_author_caps(candidates, signal)
    return _cap_pool(candidates, cap=cap)


def _cap_pool(candidates: list[dict], *, cap: int) -> list[dict]:
    """Trim the candidate pool to `cap` without letting the (larger) metadata pool starve
    the Claude-seeded one. If we paid for seed queries, their candidates must actually
    reach the reranker — so reserve a share of the cap for seed-only books before metadata
    fills the rest. 'both'-pool candidates are the most grounded and are always kept.
    Within each bucket, candidates with a description are sorted first."""
    if len(candidates) <= cap:
        return candidates

    def _desc_first(lst: list[dict]) -> list[dict]:
        return sorted(lst, key=lambda c: 0 if c.get("description") else 1)

    both = _desc_first([c for c in candidates if c["retrieval_pool"] == "both"])
    meta = _desc_first([c for c in candidates if c["retrieval_pool"] == "metadata"])
    seed = _desc_first([c for c in candidates if c["retrieval_pool"] == "claude_seed"])

    chosen = both[:cap]
    remaining = cap - len(chosen)
    if remaining <= 0:
        return chosen

    # Guarantee seed-only candidates a minimum slice of what's left (if any exist).
    seed_quota = min(len(seed), round(cap * _SEED_RESERVE_SHARE), remaining)
    chosen += seed[:seed_quota]
    chosen += meta[: cap - len(chosen)]
    # Backfill any slack (e.g. too few metadata hits) with leftover seed candidates.
    if len(chosen) < cap:
        chosen += seed[seed_quota : seed_quota + (cap - len(chosen))]
    return chosen[:cap]


# --- stage 2: rerank -------------------------------------------------------


def _user_steering_block(signal: dict) -> str:
    """Render the `## User Steering` section appended to the cached profile prefix.

    Carries the user's more/less-like books and frequent reject reasons, plus the
    instruction that trait influence is weighted by each trait's `user_weight`. Returns
    "" only when there is no steering signal at all (the user_weight instruction is
    always emitted so the reranker knows traits carry weights)."""
    more_like = signal.get("more_like") or []
    less_like = signal.get("less_like") or []
    reject_counts = signal.get("reject_reason_counts") or {}

    lines = ["\n\n## User Steering"]
    if more_like:
        lines.append(
            "MORE LIKE (books the reader explicitly wants more of):\n"
            + json.dumps(more_like, ensure_ascii=False)
        )
    if less_like:
        lines.append(
            "LESS LIKE (books the reader explicitly wants less of):\n"
            + json.dumps(less_like, ensure_ascii=False)
        )
    if reject_counts:
        reasons = ", ".join(f"{r}: {c} times" for r, c in reject_counts.items())
        lines.append("FREQUENT REJECT REASONS: " + reasons)
    lines.append(
        "Favor candidates resembling the more-like books; penalize candidates "
        "resembling the less-like books; penalize candidates matching frequent reject "
        "reasons; weight trait influence by each trait's `user_weight` — traits with a "
        "lower weight should influence the score less (0.0 = ignore, 1.0 = normal)."
    )
    return "\n\n".join(lines)


def _claude_rerank(
    candidates: list[dict], signal: dict, *, n: int, api_key: str | None = None
) -> list[dict]:
    client, settings = _client(api_key)
    indexed = [
        {
            "idx": i,
            "title": c["title"],
            "author": c.get("author"),
            "year": c.get("year"),
            "subjects": c.get("subjects") or [],
        }
        for i, c in enumerate(candidates)
    ]
    valid_trait_ids = {t["id"] for t in signal["traits"]}
    valid_book_ids = {b["id"] for b in signal["loved"]}
    rejected_with_notes = signal.get("rejected_with_notes") or []
    profile_context = (
        "TASTE TRAITS (JSON):\n"
        + json.dumps(signal["traits"], ensure_ascii=False)
        + "\n\nLOVED BOOKS (JSON):\n"
        + json.dumps(signal["loved"][:_LOVED_SAMPLE], ensure_ascii=False)
        + (
            "\n\nREJECTED RECOMMENDATIONS WITH NOTES (JSON):\n"
            "These are books the reader explicitly skipped with an explanation. Treat "
            "each note as direct testimony about what to avoid — heavily penalize "
            "candidates that share the same qualities.\n"
            + json.dumps(rejected_with_notes, ensure_ascii=False)
            if rejected_with_notes else ""
        )
        + _user_steering_block(signal)
    )
    task_prompt = (
        f"Rank the best {n} candidates for this reader and explain each. Choose ONLY from "
        "the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit. Penalize "
        "anything that trips an aversion trait or resembles a rejected book's noted reason. "
        "Ground every pick in specific trait ids "
        "and the library book ids it most resembles — use only ids that appear above.\n\n"
        "CANDIDATES (JSON):\n"
        + json.dumps(indexed, ensure_ascii=False)
    )
    message = client.messages.create(
        model=settings.model,
        max_tokens=4000,
        system=_RANK_SYSTEM,
        tools=[_RANK_TOOL],
        tool_choice={"type": "tool", "name": "rank_recommendations"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": profile_context,
                 "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": task_prompt},
            ],
        }],
    )
    ranked = []
    for block in message.content:
        if getattr(block, "type", None) == "tool_use":
            ranked = block.input.get("recommendations", [])
            break

    out = []
    seen_idx: set[int] = set()
    for r in ranked:
        idx = r.get("candidate_index")
        if not isinstance(idx, int) or idx < 0 or idx >= len(candidates) or idx in seen_idx:
            continue  # drop hallucinated / duplicate indices
        seen_idx.add(idx)
        cand = dict(candidates[idx])
        cand["score"] = float(r.get("score", 0.0))
        cand["rationale"] = (r.get("rationale") or "").strip()
        cand["grounded_trait_ids"] = [
            i for i in r.get("grounded_trait_ids", []) if i in valid_trait_ids
        ]
        cand["grounded_book_ids"] = [
            i for i in r.get("grounded_book_ids", []) if i in valid_book_ids
        ]
        out.append(cand)

    out.sort(key=lambda c: c["score"], reverse=True)
    # Prefer candidates with descriptions (better UX), but never drop below n if
    # description-having candidates are scarce.
    with_desc = [c for c in out if c.get("description")]
    without_desc = [c for c in out if not c.get("description")]
    prioritised = with_desc + without_desc
    return prioritised[:n]


# --- orchestrator ----------------------------------------------------------


def recommend(
    *,
    n: int = 10,
    use_metadata: bool = True,
    use_claude_seeds: bool = True,
    requests_per_second: float | None = None,
    user_id: str = LOCAL_USER_ID,
) -> dict:
    """Run the two-stage recommender for `user_id` and persist the served set."""
    init_db()
    if requests_per_second is not None:
        from . import catalog

        catalog.set_rate(requests_per_second)

    # Resolve the per-user Anthropic key once; the Claude stages receive it. Not raised
    # here — the key is checked at point of use (so patched tests need no key).
    api_key = resolve_anthropic_key(user_id)

    with session_scope() as session:
        signal = _build_signal(session, user_id)
        if not signal["loved"]:
            raise RuntimeError(
                "No loved books found (need books rated >= 4). Run ingest + enrich "
                "(and ideally profile) first."
            )

        # Block recommendations when the taste profile is missing or stale.
        # A profile is missing when last_profiled_at is None; it's stale (dirty)
        # when rated/reviewed books have changed since the last build.
        meta = get_profile_meta(session, user_id)
        changed = books_changed_since(session, meta.last_profiled_at, user_id)
        if meta.last_profiled_at is None:
            raise RuntimeError(
                "No taste profile found. Run 'profile' (or POST /profile) before "
                "generating recommendations."
            )
        if changed:
            raise RuntimeError(
                f"{len(changed)} book(s) have been rated/reviewed since the last profile "
                "build. Re-profile first (POST /profile/update) so recommendations "
                "reflect your current taste."
            )

        metadata_pool = (
            _metadata_pool(signal, per_query=_PER_QUERY) if use_metadata else []
        )
        seed_queries: list[str] = []
        seed_pool: list[tuple[dict, str]] = []
        if use_claude_seeds:
            seed_pool, seed_queries = _seed_pool(
                signal, n_queries=_SEED_QUERIES, per_query=_PER_QUERY, api_key=api_key
            )

        candidates = _assemble(metadata_pool, seed_pool, signal, cap=_MAX_CANDIDATES)
        _fill_ol_descriptions(candidates)
        if not candidates:
            return {
                "run_id": None,
                "served": 0,
                "candidates": 0,
                "note": "Retrieval surfaced no new candidates (catalog empty/offline?).",
                "recommendations": [],
            }

        ranked = _claude_rerank(candidates, signal, n=n, api_key=api_key)

        run_id = uuid.uuid4().hex[:12]
        recs_out = []
        for rank, c in enumerate(ranked, 1):
            session.add(
                Recommendation(
                    user_id=user_id,
                    run_id=run_id,
                    rank=rank,
                    title=c["title"],
                    author=c.get("author"),
                    year=c.get("year"),
                    isbn13=c.get("isbn13"),
                    cover_url=c.get("cover_url"),
                    subjects=c.get("subjects") or [],
                    description=c.get("description"),
                    catalog_source=c.get("catalog_source"),
                    catalog_id=c.get("catalog_id"),
                    retrieval_pool=c.get("retrieval_pool"),
                    seed_reason=c.get("seed_reason"),
                    score=c["score"],
                    rationale=c.get("rationale"),
                    grounded_trait_ids=c.get("grounded_trait_ids") or [],
                    grounded_book_ids=c.get("grounded_book_ids") or [],
                    status="served",
                )
            )
            recs_out.append(
                {
                    "rank": rank,
                    "title": c["title"],
                    "author": c.get("author"),
                    "year": c.get("year"),
                    "score": round(c["score"], 2),
                    "rationale": c.get("rationale"),
                    "retrieval_pool": c.get("retrieval_pool"),
                    "seed_reason": c.get("seed_reason"),
                    "grounded_trait_ids": c.get("grounded_trait_ids") or [],
                    "grounded_book_ids": c.get("grounded_book_ids") or [],
                }
            )

    return {
        "run_id": run_id,
        "served": len(recs_out),
        "candidates": len(candidates),
        "pool_metadata": len(metadata_pool),
        "pool_seed": len(seed_pool),
        "seed_queries": seed_queries,
        "model": get_settings().model,
        "recommendations": recs_out,
    }


def latest_recommendations(
    session, user_id: str = LOCAL_USER_ID
) -> list[Recommendation]:
    """Rows of `user_id`'s most recent run, in rank order (helper for API/CLI readers)."""
    last = (
        session.query(Recommendation)
        .filter(Recommendation.user_id == user_id)
        .order_by(Recommendation.created_at.desc(), Recommendation.id.desc())
        .first()
    )
    if last is None:
        return []
    return (
        session.query(Recommendation)
        .filter(
            Recommendation.user_id == user_id,
            Recommendation.run_id == last.run_id,
        )
        .order_by(Recommendation.rank)
        .all()
    )
