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
import re
import uuid
from collections import Counter

from .config import LOCAL_USER_ID, get_settings
from .db import Book, Recommendation, TasteSignal, TasteTrait, init_db, session_scope
from .enrich import _STRONG_SIM, _normalize_title, _surname, _title_sim
from .profile import books_changed_since, get_profile_meta
from .usage import tracked_create
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
_COLD_START_LOVED = 8    # below this many loved books → cold-start strategy
_COLD_START_RATED = 12   # ...or below this many rated books


# --- cold-start detection --------------------------------------------------


def _is_cold_start(signal: dict) -> bool:
    """Thin libraries can't support reliable author/subject inference; switch to a
    broader, diversity-first retrieval strategy below either threshold."""
    return (
        len(signal.get("loved") or []) < _COLD_START_LOVED
        or (signal.get("rated_count") or 0) < _COLD_START_RATED
    )


# --- Claude stage 1b: propose search queries -------------------------------

_SEED_TOOL = {
    "name": "propose_search_queries",
    "description": (
        "Propose catalog SEARCH queries that would surface books this reader is likely "
        "to love next. These are search terms (subjects, micro-genres, comp-author "
        "phrasings), NOT specific book titles. Each is run against a live book catalog."
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
                                "1-2 sentences in the voice of a well-read friend: what the "
                                "book does, anchored to at most two library books by title, "
                                "naming the mechanism of the fit. Honest about stretch picks. "
                                "Plain punctuation, no em dashes. No generic praise, no "
                                "clinical trait-speak."
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
    "a reader's evidence-backed taste profile. You never invent books; you only rank the "
    "candidates given. Every pick cites the trait ids and library book ids it is grounded "
    "in, drawn only from the provided data. You prefer specific fit over popularity, and "
    "you respect aversion traits (penalize candidates that trip them).\n\n"
    "Write each rationale like a well-read friend pressing the book into their hands, in "
    "1-2 sentences: lead with what the book does, then anchor it to at most two of their "
    "library books by title. Name the mechanism of the fit (pace, voice, structure, mood: "
    "whatever the trait actually is), never just shared genre. If the pick is a stretch, "
    "say so honestly and name what still connects. Use plain punctuation only: no em "
    "dashes. Never write \"you'll love this\", generic praise, or clinical trait "
    "language.\n\n"
    "Examples of the target voice:\n"
    "- Technically sci-fi, but it moves like the quiet family novels you rate highest: one "
    "household, twenty years, every chapter a knife slid in slowly.\n"
    "- A reach: you rarely go for war fiction. But it's told in the clipped, unsentimental "
    "voice that carried The Remains of the Day for you, and it's short enough to bail on "
    "cheap.\n"
    "- Romance-adjacent without the love-triangle stall you keep one-starring: the couple "
    "is together by chapter three, and the book is about what happens after."
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
    max_lib = max(1, int(total * _MAX_LIBRARY_AUTHOR_SHARE))
    if len(lib) > max_lib:
        # Reorders: new-author candidates first, then trimmed library authors.
        # _cap_pool re-sorts downstream by retrieval_pool, so this ordering is absorbed.
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


_SERIES_PAREN_RE = re.compile(
    r"\(([^()]+?),\s*(?:#|book\s+|vol\.?\s+|volume\s+)(\d{1,3})\)",
    re.IGNORECASE,
)


def _series_info(title: str | None) -> tuple[str, int] | None:
    """Extract (series_name, position) from a Goodreads/OL-style trailing
    parenthetical like '(Mistborn, #6)' or '(The Stormlight Archive, Book 2)'.
    Returns None when the title carries no such marker -- most books don't, and
    absence just means we can't tell it's a sequel from the title alone."""
    if not title:
        return None
    m = _SERIES_PAREN_RE.search(title)
    if not m:
        return None
    name = re.sub(r"\s+", " ", m.group(1)).strip().lower()
    if not name:
        return None
    return name, int(m.group(2))


def _series_ok(title: str | None, library_series: dict[str, set[int]]) -> bool:
    """Blocks book N (N>1) of a series the reader hasn't started -- i.e. owns no
    earlier volume, on any shelf, under the same series name. Titles without a
    detectable '(Series, #N)' marker always pass: we can't identify them as a
    sequel from text alone, and dropping candidates on a guess would silently
    remove unrelated standalone books too."""
    info = _series_info(title)
    if info is None:
        return True
    name, position = info
    if position <= 1:
        return True
    owned = library_series.get(name)
    return bool(owned and any(p < position for p in owned))


def _fuzzy_duplicate(title: str | None, library_titles: list[str]) -> bool:
    """Catches same-work editions that survive the exact (title, author) dedup key --
    e.g. an abridged/translated/ELT-graded-reader reissue credited to a different
    'author' field (a retelling editor or publisher series name instead of the
    original author). A near-identical normalized title is treated as the same work
    on its own; author agreement is not required."""
    if not title:
        return False
    return any(_title_sim(title, lt) >= _STRONG_SIM for lt in set(library_titles))


_LEARNER_EDITION_MARKERS = (
    "graded reader",
    "for foreign speakers",
    "for esl",
    "for efl",
    "esl reader",
    "efl reader",
    "english language learners",
    "simplified english edition",
    "learner's edition",
    "students of english",
)


def _is_learner_edition(cand: dict) -> bool:
    """Flags graded-reader / ESL / abridged-for-language-learners reissues. These
    carry title or subject phrasing like 'graded reader' or 'for foreign speakers'
    (the latter mirrors real OpenLibrary/Google Books subject-heading text). They
    aren't a genuine discovery for a taste-driven recommender even when the reader
    has never read the original work, so they're dropped outright rather than only
    deduped against an owned copy."""
    haystack = " | ".join([cand.get("title") or "", *(cand.get("subjects") or [])]).lower()
    return any(marker in haystack for marker in _LEARNER_EDITION_MARKERS)


def _build_signal(session, user_id: str = LOCAL_USER_ID) -> dict:
    """Summarize the library: loved books, their top subjects/authors, and the dedup
    keys/ISBNs of everything already on a shelf (so we never re-recommend them)."""
    from sqlalchemy.orm import selectinload
    books = session.query(Book).options(selectinload(Book.enrichment)).filter(Book.user_id == user_id).all()
    library_keys: set[tuple[str, str]] = set()
    library_isbns: set[str] = set()
    library_languages: set[str] = set()
    library_authors: set[str] = set()
    library_titles: list[str] = []
    library_series: dict[str, set[int]] = {}
    loved: list[dict] = []
    subject_counts: Counter[str] = Counter()
    author_counts: Counter[str] = Counter()
    rated_count = 0

    for b in books:
        library_keys.add(_dedup_key(b.title, b.author))
        if b.title:
            library_titles.append(b.title)
        series_info = _series_info(b.title)
        if series_info is not None:
            name, position = series_info
            library_series.setdefault(name, set()).add(position)
        if b.isbn13:
            library_isbns.add(b.isbn13)
        enr_lang = b.enrichment.language if b.enrichment else None
        if enr_lang:
            library_languages.add(enr_lang)
        if b.author:
            library_authors.add(_surname(b.author))
        if b.effective_rating is not None:
            rated_count += 1

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
        if r.title:
            library_titles.append(r.title)
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
        "library_titles": library_titles,
        "library_series": library_series,
        "loved": loved,
        "rated_count": rated_count,
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


def _build_book_signal(session, book: Book, user_id: str = LOCAL_USER_ID) -> dict:
    """A `signal`-shaped dict seeded from ONE book for the 'more like this' path.

    Discovery seeds (`top_subjects`, `top_authors`, `anchor`) come from the single seed
    book. The exclusion/permission sets (`library_keys`, `library_isbns`,
    `library_authors`, `library_languages`) still cover the WHOLE library, so we never
    recommend a book the reader already owns and we respect their reading languages —
    exactly like `_build_signal`, but without the taste-profile/loved aggregation.
    """
    from sqlalchemy.orm import selectinload

    books = (
        session.query(Book)
        .options(selectinload(Book.enrichment))
        .filter(Book.user_id == user_id)
        .all()
    )
    library_keys: set[tuple[str, str]] = set()
    library_isbns: set[str] = set()
    library_languages: set[str] = set()
    library_authors: set[str] = set()
    for b in books:
        library_keys.add(_dedup_key(b.title, b.author))
        if b.isbn13:
            library_isbns.add(b.isbn13)
        enr_lang = b.enrichment.language if b.enrichment else None
        if enr_lang:
            library_languages.add(enr_lang)
        if b.author:
            library_authors.add(_surname(b.author))

    enr = book.enrichment
    subjects = (enr.subjects or []) if enr else []
    anchor = {
        "id": book.id,
        "title": book.title,
        "author": book.author,
        "year": book.year_published,
        "subjects": subjects[:8],
        "description": enr.description if enr else None,
        "series": enr.series if enr else None,
    }
    return {
        "library_keys": library_keys,
        "library_isbns": library_isbns,
        "library_authors": library_authors,
        "library_languages": library_languages,
        "top_subjects": subjects[:_TOP_SUBJECTS],
        "top_authors": [book.author] if book.author else [],
        "anchor": anchor,
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


def _metadata_pool(signal: dict, *, per_query: int, cold_start: bool = False) -> list[tuple[dict, str]]:
    """Deterministic expansion from the reader's loved subjects/authors. In cold-start
    (thin library), author expansion is skipped — it produces same-author clones — and
    discovery leans on subjects + Claude-seeded comp queries that reach beyond the
    library's authors."""
    from . import catalog

    pool: list[tuple[dict, str]] = []
    for subject in signal["top_subjects"]:
        for cand in catalog.openlibrary_subject(subject, max_results=per_query):
            pool.append((cand, f"subject:{subject}"))
        for cand in catalog.googlebooks_subject(subject, max_results=per_query):
            pool.append((cand, f"subject:{subject}"))
    if not cold_start:
        for author in signal["top_authors"]:
            for cand in catalog.googlebooks_author(author, max_results=per_query):
                pool.append((cand, f"author:{author}"))
    return pool


def _claude_seed_queries(
    signal: dict, *, n_queries: int, api_key: str | None = None, user_id: str
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
    message = tracked_create(
        client,
        user_id=user_id,
        operation="recommend_seed",
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
    signal: dict, *, n_queries: int, per_query: int, api_key: str | None = None, user_id: str
) -> tuple[list[tuple[dict, str]], list[str]]:
    from . import catalog

    queries = _claude_seed_queries(signal, n_queries=n_queries, api_key=api_key, user_id=user_id)
    pool: list[tuple[dict, str]] = []
    for q in queries:
        for cand in catalog.googlebooks_query(q, max_results=per_query):
            pool.append((cand, f"query:{q}"))
    return pool, queries


_BOOK_FACET_SYSTEM = (
    "You decompose ONE book into catalog search queries that would surface OTHER books "
    "like it. You propose search TERMS, never specific titles. Chase what makes this "
    "particular book distinctive (its voice, structure, pace, mood, and specific subject "
    "matter), not generic bestsellers in its genre. Do not aim queries at the book's own "
    "author (same-author books are handled separately); reach for comparable books by "
    "other authors."
)


def _book_facet_queries(
    anchor: dict, *, n_queries: int, api_key: str | None = None, user_id: str
) -> list[str]:
    """Stage 1b for the per-book path: ask Claude for catalog search terms that describe
    books like the seed book. Returns query strings only. Reuses `_SEED_TOOL`."""
    client, _settings = _client(api_key)
    book_context = "SEED BOOK (JSON):\n" + json.dumps(
        {
            "title": anchor.get("title"),
            "author": anchor.get("author"),
            "year": anchor.get("year"),
            "subjects": anchor.get("subjects") or [],
            "series": anchor.get("series"),
            "description": anchor.get("description"),
        },
        ensure_ascii=False,
    )
    task_prompt = (
        f"The seed book is above. Propose up to {n_queries} CATALOG SEARCH QUERIES "
        "(search terms, not book titles) that would surface books a reader who loved this "
        "one is likely to enjoy. Chase its distinguishing qualities (voice, structure, "
        "mood, and specific subject matter) and avoid generic bestseller terms and the "
        "book's own author."
    )
    message = tracked_create(
        client,
        user_id=user_id,
        operation="similar_seed",
        model="claude-haiku-4-5-20251001",
        max_tokens=1500,
        system=_BOOK_FACET_SYSTEM,
        tools=[_SEED_TOOL],
        tool_choice={"type": "tool", "name": "propose_search_queries"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": book_context,
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


def _similar_seed_pool(
    anchor: dict, *, n_queries: int, per_query: int, api_key: str | None = None, user_id: str
) -> tuple[list[tuple[dict, str]], list[str]]:
    """Run the per-book facet queries against the live catalog. Mirrors `_seed_pool`."""
    from . import catalog

    queries = _book_facet_queries(anchor, n_queries=n_queries, api_key=api_key, user_id=user_id)
    pool: list[tuple[dict, str]] = []
    for q in queries:
        for cand in catalog.googlebooks_query(q, max_results=per_query):
            pool.append((cand, f"query:{q}"))
    return pool, queries


# --- Wave 3b: natural-language discovery ------------------------------------
#
# Stage A interprets a free-text request into catalog search queries + hard
# constraints (never titles). Stage B (below) reranks the real candidates by fit
# to the request. Results are ephemeral — discover() persists nothing.

_DISCOVER_SYSTEM = (
    "You translate a reader's natural-language book request into catalog search queries and "
    "constraints. You never name specific titles; you produce search TERMS (themes, genres, "
    "styles, comparable-author names when the reader gives one) that a book catalog can "
    "resolve.\n\n"
    "Rules:\n"
    "- The reader's request is the primary signal. Their taste profile is provided as "
    "secondary context: use it to break ties and set tone (e.g. their prose preferences), "
    "never to override what they asked for. If they ask for something their profile dislikes, "
    "honor the request; people read outside their pattern on purpose.\n"
    "- If the request names a book or author (\"like The Fifth Season\"), decompose WHY someone "
    "asks for that book into 3-6 distinct facets (e.g. geological apocalypse setting; "
    "second-person narration; rage as the engine; found family under oppression) and emit one "
    "query per facet. Facets, not synonyms: six rewordings of the same idea retrieve the same "
    "shelf six times.\n"
    "- If the request is a mood or situation (\"something gentle for a bad week\", \"a beach book "
    "that isn't dumb\"), translate the mood into concrete catalog language: pacing, stakes, tone.\n"
    "- Extract hard constraints ONLY when the reader states them: language, publication era "
    "(min_year / max_year), and subjects to avoid (exclude_subjects, e.g. \"nothing violent\" "
    "-> war, violence). These are filters, not queries. Do not invent constraints the reader "
    "didn't state, and do not constrain by length or series; those aren't filterable.\n"
    "- When the request is ambiguous, emit queries covering the 2-3 most likely readings rather "
    "than guessing one.\n\n"
    "Examples (request -> facets; constraints only when stated):\n"
    "- \"Find me a book like Project Hail Mary\" -> facets: lone-problem-solver survival scifi; "
    "competence-porn engineering narration; first-contact friendship; humor inside hard sci-fi; "
    "race-against-extinction stakes. No constraints.\n"
    "- \"Something gentle for a bad week\" -> facets: low-stakes literary comfort; kindness between "
    "strangers; cozy small-community fiction; quiet healing narratives. Constraints: "
    "exclude_subjects: [grief, war, abuse].\n"
    "- \"A thriller my book club won't hate\" -> facets: literary crime; character-driven suspense; "
    "thrillers with prose ambition; discussable moral-dilemma plots. No hard constraints.\n"
    "- \"Nonfiction that reads like a novel\" -> facets: narrative nonfiction; immersive reportage; "
    "true crime with literary structure; biography with scene-level storytelling. No hard "
    "constraints."
)

_DISCOVER_TOOL = {
    "name": "interpret_request",
    "description": (
        "Translate a reader's natural-language book request into catalog SEARCH queries "
        "(search terms: themes, styles, comparable-author names, never specific titles), "
        "the hard constraints they stated, and a one-sentence interpretation of what they want."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "interpretation": {
                "type": "string",
                "description": "One sentence restating what the reader wants, in their own terms.",
            },
            "queries": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "A catalog search query for one facet: search terms, not a title.",
                        },
                        "rationale": {
                            "type": "string",
                            "description": "Which facet of the request this query chases.",
                        },
                    },
                    "required": ["query", "rationale"],
                },
            },
            "constraints": {
                "type": "object",
                "description": "Hard filters the reader stated. Omit any they did not state.",
                "properties": {
                    "languages": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "ISO 639-1 codes, e.g. ['en','fr']. Only when the reader names a language.",
                    },
                    "min_year": {
                        "type": "integer",
                        "description": "Earliest publication year, when the reader states an era.",
                    },
                    "max_year": {
                        "type": "integer",
                        "description": "Latest publication year, when the reader states an era.",
                    },
                    "exclude_subjects": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Subjects/themes to avoid, e.g. ['war','grief'] for 'nothing heavy'.",
                    },
                },
            },
        },
        "required": ["interpretation", "queries"],
    },
}


def _clean_constraints(raw: dict) -> dict:
    """Keep only the supported, catalog-filterable constraints; normalize their types.

    Supported: languages (list[str], 2-letter lowercased), min_year/max_year (int),
    exclude_subjects (list[str], lowercased). Page-count and standalone/series constraints
    are intentionally unsupported — catalog candidates don't reliably carry that data — so
    they are dropped here even if the model emits them."""
    out: dict = {}
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
    return out


def _interpret_query(
    query: str, signal: dict, *, api_key: str | None = None, user_id: str
) -> dict:
    """Stage A: interpret an NL request into search queries + constraints + an echo string.

    Returns {"interpretation": str, "queries": list[str], "constraints": dict}. The taste
    profile (traits + loved) is passed as secondary context for tie-breaking; the request
    rules. Tracks spend under operation 'discover_interpret'."""
    client, _settings = _client(api_key)
    profile_context = (
        "READER TASTE PROFILE (secondary context; the request rules):\n"
        "TASTE TRAITS (JSON):\n"
        + json.dumps(signal.get("traits") or [], ensure_ascii=False)
        + "\n\nLOVED BOOKS (JSON):\n"
        + json.dumps((signal.get("loved") or [])[:_LOVED_SAMPLE], ensure_ascii=False)
    )
    task_prompt = (
        f'The reader asked: "{query}"\n\n'
        "Interpret this request. Emit search QUERIES (facets, not titles), any hard "
        "CONSTRAINTS they stated (language, era, subjects to avoid; omit if unstated), and "
        "a one-sentence INTERPRETATION of what they want."
    )
    message = tracked_create(
        client,
        user_id=user_id,
        operation="discover_interpret",
        model="claude-haiku-4-5-20251001",
        max_tokens=1500,
        system=_DISCOVER_SYSTEM,
        tools=[_DISCOVER_TOOL],
        tool_choice={"type": "tool", "name": "interpret_request"},
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
            data = block.input
            queries = [
                q["query"].strip()
                for q in data.get("queries", [])
                if q.get("query", "").strip()
            ]
            return {
                "interpretation": (data.get("interpretation") or "").strip(),
                "queries": queries,
                "constraints": _clean_constraints(data.get("constraints") or {}),
            }
    return {"interpretation": "", "queries": [], "constraints": {}}


def _discovery_pool(queries: list[str], *, per_query: int) -> list[tuple[dict, str]]:
    """Run interpreted NL-discovery queries against the live catalog (Google + OL free-text).

    Discovery has no library-metadata backstop — recall rests entirely on these queries — so
    each runs against BOTH sources. Mirrors `_seed_pool`'s (candidate, reason) tuple shape."""
    from . import catalog

    pool: list[tuple[dict, str]] = []
    for q in queries:
        for cand in catalog.googlebooks_query(q, max_results=per_query):
            pool.append((cand, f"query:{q}"))
        for cand in catalog.openlibrary_query(q, max_results=per_query):
            pool.append((cand, f"query:{q}"))
    return pool


def _subject_hits(term: str, subject: str) -> bool:
    """True when `term` appears as a whole word inside `subject` (both already lowercased).

    Whole-word so an exclude of 'war' doesn't trip 'warmth' or 'steward'."""
    return re.search(rf"\b{re.escape(term)}\b", subject) is not None


def _apply_discovery_constraints(
    pool: list[tuple[dict, str]], constraints: dict
) -> list[tuple[dict, str]]:
    """Filter the candidate pool by the reader's stated era + exclude_subjects constraints.

    Applied to the RAW pool before assembly's cap, so the cap never keeps a constraint-
    violating book over a valid one. Unknown/missing fields always PASS (never drop a
    candidate for lacking metadata — same philosophy as `_language_ok`). Language is handled
    separately, via the signal's allowed-language set in `discover`."""
    if not constraints:
        return pool
    min_year = constraints.get("min_year")
    max_year = constraints.get("max_year")
    exclude = [s.lower() for s in (constraints.get("exclude_subjects") or [])]

    def ok(cand: dict) -> bool:
        year = cand.get("year")
        if isinstance(year, int):
            if min_year is not None and year < min_year:
                return False
            if max_year is not None and year > max_year:
                return False
        if exclude:
            subjects = [str(s).lower() for s in (cand.get("subjects") or [])]
            for term in exclude:
                if any(_subject_hits(term, s) for s in subjects):
                    return False
        return True

    return [(c, r) for (c, r) in pool if ok(c)]


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
    library_series = signal.get("library_series") or {}
    library_titles = signal.get("library_titles") or []
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
        if not _series_ok(title, library_series):
            return
        if _fuzzy_duplicate(title, library_titles):
            return
        if _is_learner_edition(cand):
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
        "reasons; weight trait influence by each trait's `user_weight`: traits with a "
        "lower weight should influence the score less (0.0 = ignore, 1.0 = normal)."
    )
    return "\n\n".join(lines)


def _claude_rerank(
    candidates: list[dict], signal: dict, *, n: int, api_key: str | None = None, user_id: str
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
            "each note as direct testimony about what to avoid; heavily penalize "
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
    message = tracked_create(
        client,
        user_id=user_id,
        operation="recommend_rerank",
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


_SIMILAR_RANK_TOOL = {
    "name": "rank_similar_books",
    "description": (
        "Rank the provided real catalog candidates by how similar they are to the seed "
        "book, and explain each pick. Choose ONLY from the given candidates."
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
                            "description": "0..1 similarity to the seed book.",
                        },
                        "rationale": {
                            "type": "string",
                            "description": (
                                "1-2 sentences in the voice of a well-read friend: what the "
                                "book does and how it echoes the seed book, naming the "
                                "mechanism of the resemblance (pace, voice, structure, mood, "
                                "subject), never just shared genre. Honest about stretch "
                                "picks. Plain punctuation, no em dashes."
                            ),
                        },
                    },
                    "required": ["candidate_index", "score", "rationale"],
                },
            }
        },
        "required": ["recommendations"],
    },
}

_SIMILAR_RANK_SYSTEM = (
    "You recommend books similar to ONE specific book the reader already knows. You rank a "
    "fixed list of real catalog candidates by how much they resemble that seed book, and you "
    "never invent books; you only rank the candidates given. You prefer specific resemblance "
    "(voice, structure, pace, mood, subject) over shared genre or popularity.\n\n"
    "Write each rationale like a well-read friend pressing the book into their hands, in 1-2 "
    "sentences: lead with what the book does, then name exactly how it echoes the seed book. "
    "If a pick is a stretch, say so honestly and name what still connects. Use plain "
    "punctuation only: no em dashes. Never write \"you'll love this\", generic praise, or "
    "clinical genre-speak."
)


def _rerank_similar(
    candidates: list[dict], anchor: dict, *, n: int, api_key: str | None = None, user_id: str
) -> list[dict]:
    """Stage 2 for the per-book path: rank candidates by similarity to the seed book.

    Mirrors `_claude_rerank`'s id-validation and description-priority, but grounds in a
    single anchor book rather than the taste profile (no trait/book id grounding)."""
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
    seed_context = "SEED BOOK (JSON):\n" + json.dumps(
        {
            "title": anchor.get("title"),
            "author": anchor.get("author"),
            "year": anchor.get("year"),
            "subjects": anchor.get("subjects") or [],
            "series": anchor.get("series"),
            "description": anchor.get("description"),
        },
        ensure_ascii=False,
    )
    task_prompt = (
        f"Rank the best {n} candidates by similarity to the SEED BOOK and explain each. "
        "Choose ONLY from the CANDIDATES list (cite each by its `idx`). Score 0..1 for "
        "resemblance to the seed book. Name the mechanism of the resemblance in each "
        "rationale.\n\nCANDIDATES (JSON):\n" + json.dumps(indexed, ensure_ascii=False)
    )
    message = tracked_create(
        client,
        user_id=user_id,
        operation="similar_rerank",
        model=settings.model,
        max_tokens=4000,
        system=_SIMILAR_RANK_SYSTEM,
        tools=[_SIMILAR_RANK_TOOL],
        tool_choice={"type": "tool", "name": "rank_similar_books"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": seed_context,
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
        out.append(cand)

    out.sort(key=lambda c: c["score"], reverse=True)
    with_desc = [c for c in out if c.get("description")]
    without_desc = [c for c in out if not c.get("description")]
    return (with_desc + without_desc)[:n]


_DISCOVER_RANK_TOOL = {
    "name": "rank_discovery",
    "description": (
        "Rank the provided real catalog candidates by how well they answer the reader's "
        "request, and explain each pick. Choose ONLY from the given candidates."
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
                            "description": "0..1 fit with the reader's REQUEST.",
                        },
                        "rationale": {
                            "type": "string",
                            "description": (
                                "1-2 sentences answering the request in its own terms: what the "
                                "book does and which facet of the request it delivers. Name the "
                                "mechanism (pace, voice, structure, mood, subject), not just "
                                "shared genre. Honest about stretch picks. Plain punctuation, "
                                "no em dashes."
                            ),
                        },
                    },
                    "required": ["candidate_index", "score", "rationale"],
                },
            }
        },
        "required": ["recommendations"],
    },
}

_DISCOVER_RANK_SYSTEM = (
    "You are a book recommender answering a reader's specific request. You rank a fixed list "
    "of real catalog candidates by how well they answer THAT REQUEST, and you never invent "
    "books; you only rank the candidates given. Rank fit against the request first and the "
    "reader's taste profile second (use the profile only to break ties). You prefer specific "
    "fit (voice, structure, pace, mood, subject) over popularity.\n\n"
    "Write each rationale like a well-read friend pressing the book into their hands, in 1-2 "
    "sentences: lead with what the book does, then answer the request in its own terms: if "
    "they asked for \"like The Fifth Season\", say which facet of it this book delivers. Name "
    "the mechanism of the fit, never just shared genre. If a pick is a stretch, say so honestly "
    "and name what still connects. Use plain punctuation only: no em dashes. Never write "
    "\"you'll love this\", generic praise, or clinical trait language."
)


def _rerank_discovery(
    candidates: list[dict],
    query: str,
    interpretation: str,
    signal: dict,
    *,
    n: int,
    api_key: str | None = None,
    user_id: str,
) -> list[dict]:
    """Stage B for discovery: rank candidates by fit to the reader's request (profile secondary).

    Mirrors `_rerank_similar`'s id-validation + description-priority, but grounds in the
    request text + interpretation rather than a single anchor book. Tracks spend under
    operation 'discover_rerank'."""
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
    profile_context = (
        "READER TASTE PROFILE (secondary — the request rules):\n"
        "TASTE TRAITS (JSON):\n"
        + json.dumps(signal.get("traits") or [], ensure_ascii=False)
        + "\n\nLOVED BOOKS (JSON):\n"
        + json.dumps((signal.get("loved") or [])[:_LOVED_SAMPLE], ensure_ascii=False)
    )
    task_prompt = (
        f'The reader asked: "{query}"\n'
        f"Interpreted as: {interpretation}\n\n"
        f"Rank the best {n} candidates against THIS REQUEST and explain each. Choose ONLY from "
        "the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit to the request. In "
        "each rationale, answer the request in its own terms.\n\n"
        "CANDIDATES (JSON):\n" + json.dumps(indexed, ensure_ascii=False)
    )
    message = tracked_create(
        client,
        user_id=user_id,
        operation="discover_rerank",
        model=settings.model,
        max_tokens=4000,
        system=_DISCOVER_RANK_SYSTEM,
        tools=[_DISCOVER_RANK_TOOL],
        tool_choice={"type": "tool", "name": "rank_discovery"},
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
        out.append(cand)

    out.sort(key=lambda c: c["score"], reverse=True)
    with_desc = [c for c in out if c.get("description")]
    without_desc = [c for c in out if not c.get("description")]
    return (with_desc + without_desc)[:n]


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

        cold_start = _is_cold_start(signal)
        metadata_pool = (
            _metadata_pool(signal, per_query=_PER_QUERY, cold_start=cold_start)
            if use_metadata else []
        )
        seed_queries: list[str] = []
        seed_pool: list[tuple[dict, str]] = []
        if use_claude_seeds:
            seed_pool, seed_queries = _seed_pool(
                signal, n_queries=_SEED_QUERIES, per_query=_PER_QUERY, api_key=api_key,
                user_id=user_id,
            )

        candidates = _assemble(metadata_pool, seed_pool, signal, cap=_MAX_CANDIDATES)
        _fill_ol_descriptions(candidates)
        if not candidates:
            return {
                "run_id": None,
                "served": 0,
                "candidates": 0,
                "cold_start": cold_start,
                "note": "Retrieval surfaced no new candidates (catalog empty/offline?).",
                "recommendations": [],
            }

        ranked = _claude_rerank(candidates, signal, n=n, api_key=api_key, user_id=user_id)

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
        "cold_start": cold_start,
        "pool_metadata": len(metadata_pool),
        "pool_seed": len(seed_pool),
        "seed_queries": seed_queries,
        "model": get_settings().model,
        "recommendations": recs_out,
    }


def recommend_similar(
    book_id: int, *, n: int = 8, user_id: str = LOCAL_USER_ID
) -> dict:
    """Ephemeral 'more books like this' for one library book.

    Book-anchored: seeds retrieval from the single book's facets (not the taste profile),
    skips the profile-missing/stale gate and library-thinness cold-start gating, and
    returns results WITHOUT persisting any `recommendations` rows. Same-author caps and
    language filtering still apply (reused from the main retrieval path)."""
    from sqlalchemy.orm import selectinload

    init_db()
    api_key = resolve_anthropic_key(user_id)

    with session_scope() as session:
        book = (
            session.query(Book)
            .options(selectinload(Book.enrichment))
            .filter(Book.id == book_id, Book.user_id == user_id)
            .one_or_none()
        )
        if book is None:
            raise RuntimeError(f"Book {book_id} not found.")

        signal = _build_book_signal(session, book, user_id)
        anchor = signal["anchor"]
        if not signal["top_subjects"] and not anchor.get("description") and not anchor.get("author"):
            raise RuntimeError(
                "Not enough metadata on this book to find similar reads. Enrich it first."
            )

        # cold_start is always False here: library thinness is irrelevant to a single seed.
        metadata_pool = _metadata_pool(signal, per_query=_PER_QUERY, cold_start=False)
        seed_pool, seed_queries = _similar_seed_pool(
            anchor, n_queries=_SEED_QUERIES, per_query=_PER_QUERY, api_key=api_key, user_id=user_id
        )

        candidates = _assemble(metadata_pool, seed_pool, signal, cap=_MAX_CANDIDATES)
        _fill_ol_descriptions(candidates)
        model = get_settings().model
        if not candidates:
            return {
                "anchor_book_id": book.id,
                "anchor_title": book.title,
                "count": 0,
                "model": model,
                "seed_queries": seed_queries,
                "recommendations": [],
            }

        ranked = _rerank_similar(candidates, anchor, n=n, api_key=api_key, user_id=user_id)

        recs_out = []
        for rank, c in enumerate(ranked, 1):
            recs_out.append(
                {
                    "rank": rank,
                    "title": c["title"],
                    "author": c.get("author"),
                    "year": c.get("year"),
                    "isbn13": c.get("isbn13"),
                    "cover_url": c.get("cover_url"),
                    "subjects": c.get("subjects") or [],
                    "description": c.get("description"),
                    "catalog_source": c.get("catalog_source"),
                    "catalog_id": c.get("catalog_id"),
                    "retrieval_pool": c.get("retrieval_pool"),
                    "seed_reason": c.get("seed_reason"),
                    "score": round(c["score"], 2),
                    "rationale": c.get("rationale"),
                }
            )

        return {
            "anchor_book_id": book.id,
            "anchor_title": book.title,
            "count": len(recs_out),
            "model": model,
            "seed_queries": seed_queries,
            "recommendations": recs_out,
        }


def discover(query: str, *, n: int = 10, user_id: str = LOCAL_USER_ID) -> dict:
    """Ephemeral natural-language discovery: 'find me a book like X'.

    Two-stage and request-anchored: Stage A (Claude Haiku) interprets the NL request into
    catalog search queries + hard constraints; retrieval resolves them against the live
    catalog; Stage B (rerank model) ranks the real candidates by fit to the request (the
    taste profile is only secondary tie-break context). Results are NOT persisted — no
    `recommendations` rows — so the main recs feed / swipe deck are untouched, and discovery
    works without a taste profile (no profile-missing/stale gate)."""
    query = (query or "").strip()
    if not query:
        raise RuntimeError("Enter something to search for.")

    init_db()
    api_key = resolve_anthropic_key(user_id)

    with session_scope() as session:
        # Full signal: library exclusion sets (keys/isbns/authors/languages) + traits/loved
        # as secondary context. _build_signal never raises on a thin/profile-less library.
        signal = _build_signal(session, user_id)
        interp = _interpret_query(query, signal, api_key=api_key, user_id=user_id)
        queries = interp["queries"]
        constraints = interp["constraints"]
        model = get_settings().model

        if not queries:
            return {
                "query": query,
                "interpretation": interp["interpretation"],
                "count": 0,
                "model": model,
                "queries": [],
                "recommendations": [],
            }

        # A stated language constraint overrides the reader's library languages for this run
        # (people ask for other-language books on purpose). _assemble reads library_languages
        # via _allowed_languages, so overriding it here is enough.
        if constraints.get("languages"):
            signal = {**signal, "library_languages": set(constraints["languages"])}

        pool = _discovery_pool(queries, per_query=_PER_QUERY)
        pool = _apply_discovery_constraints(pool, constraints)
        # Discovery is purely query-driven: no metadata_pool. The interpreted queries ARE the
        # seed pool; _assemble dedups, drops owned/rejected books, language-filters, caps authors.
        candidates = _assemble([], pool, signal, cap=_MAX_CANDIDATES)
        _fill_ol_descriptions(candidates)

        if not candidates:
            return {
                "query": query,
                "interpretation": interp["interpretation"],
                "count": 0,
                "model": model,
                "queries": queries,
                "recommendations": [],
            }

        ranked = _rerank_discovery(
            candidates, query, interp["interpretation"], signal,
            n=n, api_key=api_key, user_id=user_id,
        )

        recs_out = []
        for rank, c in enumerate(ranked, 1):
            recs_out.append({
                "rank": rank,
                "title": c["title"],
                "author": c.get("author"),
                "year": c.get("year"),
                "isbn13": c.get("isbn13"),
                "cover_url": c.get("cover_url"),
                "subjects": c.get("subjects") or [],
                "description": c.get("description"),
                "catalog_source": c.get("catalog_source"),
                "catalog_id": c.get("catalog_id"),
                "retrieval_pool": c.get("retrieval_pool"),
                "seed_reason": c.get("seed_reason"),
                "score": round(c["score"], 2),
                "rationale": c.get("rationale"),
            })

        return {
            "query": query,
            "interpretation": interp["interpretation"],
            "count": len(recs_out),
            "model": model,
            "queries": queries,
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
