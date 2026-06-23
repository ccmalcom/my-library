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

from .config import get_settings
from .db import Book, Recommendation, TasteTrait, init_db, session_scope
from .enrich import _normalize_title, _surname

_REJECTED_STATUS = "rejected"

# --- tuning knobs (kept here so CLI/API stay thin) -------------------------
_TOP_SUBJECTS = 8
_TOP_AUTHORS = 6
_PER_QUERY = 8  # catalog hits to pull per subject/author/seed query
_SEED_QUERIES = 8  # how many search terms to ask Claude to propose
_MAX_CANDIDATES = 60  # cap on the pool handed to the reranker (token budget)
_SEED_RESERVE_SHARE = 0.3  # min share of the cap reserved for Claude-seeded-only candidates
_LOVED_MIN = 4  # effective rating at/above which a book counts as "loved"
_LOVED_SAMPLE = 40  # loved books shown to Claude for context


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


def _client():
    """Anthropic client, with the key checked at point of use (so callers that don't
    reach a Claude stage — or tests that patch these helpers — don't need a key)."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Add it to .env before running recommend "
            "(the rerank/explain stage and Claude-seeded discovery both need it)."
        )
    from anthropic import Anthropic

    return Anthropic(api_key=settings.anthropic_api_key), settings


# --- library signal --------------------------------------------------------


def _dedup_key(title: str | None, author: str | None) -> tuple[str, str]:
    return (_normalize_title(title), _surname(author))


def _build_signal(session) -> dict:
    """Summarize the library: loved books, their top subjects/authors, and the dedup
    keys/ISBNs of everything already on a shelf (so we never re-recommend them)."""
    books = session.query(Book).all()
    library_keys: set[tuple[str, str]] = set()
    library_isbns: set[str] = set()
    loved: list[dict] = []
    subject_counts: Counter[str] = Counter()
    author_counts: Counter[str] = Counter()

    for b in books:
        library_keys.add(_dedup_key(b.title, b.author))
        if b.isbn13:
            library_isbns.add(b.isbn13)

    # Also exclude explicitly rejected recommendations so they never resurface.
    rejected = (
        session.query(Recommendation)
        .filter(Recommendation.status == _REJECTED_STATUS)
        .all()
    )
    for r in rejected:
        library_keys.add(_dedup_key(r.title, r.author))
        if r.isbn13:
            library_isbns.add(r.isbn13)
        r = b.effective_rating
        if r is None or r < _LOVED_MIN:
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
                "rating": r,
                "year": b.year_published,
                "subjects": subjects[:8],
                "read_year": read_date.year if read_date else None,
            }
        )

    loved.sort(key=lambda d: (d["rating"], d["read_year"] or 0), reverse=True)
    traits = (
        session.query(TasteTrait)
        .order_by(TasteTrait.inference_confidence.desc())
        .all()
    )
    return {
        "library_keys": library_keys,
        "library_isbns": library_isbns,
        "loved": loved,
        "top_subjects": [s for s, _ in subject_counts.most_common(_TOP_SUBJECTS)],
        "top_authors": [a for a, _ in author_counts.most_common(_TOP_AUTHORS)],
        "traits": [
            {
                "id": t.id,
                "claim": t.claim,
                "polarity": t.polarity,
                "confidence": round(t.inference_confidence, 2),
            }
            for t in traits
        ],
    }


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


def _claude_seed_queries(signal: dict, *, n_queries: int) -> list[str]:
    """Ask Claude for catalog search terms (stage 1b). Returns query strings only."""
    client, settings = _client()
    prompt = (
        "A reader's taste profile and a sample of their loved books are below. Propose "
        f"up to {n_queries} CATALOG SEARCH QUERIES (search terms, not book titles) that "
        "would surface books they are likely to rate highly. Chase their distinguishing "
        "traits, cover their range, and avoid generic bestseller terms.\n\n"
        "TASTE TRAITS (JSON):\n"
        + json.dumps(signal["traits"], ensure_ascii=False)
        + "\n\nLOVED BOOKS (JSON):\n"
        + json.dumps(signal["loved"][:_LOVED_SAMPLE], ensure_ascii=False)
    )
    message = client.messages.create(
        model=settings.model,
        max_tokens=1500,
        system=_SEED_SYSTEM,
        tools=[_SEED_TOOL],
        tool_choice={"type": "tool", "name": "propose_search_queries"},
        messages=[{"role": "user", "content": prompt}],
    )
    for block in message.content:
        if getattr(block, "type", None) == "tool_use":
            items = block.input.get("queries", [])
            return [q["query"].strip() for q in items if q.get("query", "").strip()]
    return []


def _seed_pool(signal: dict, *, n_queries: int, per_query: int) -> tuple[list[tuple[dict, str]], list[str]]:
    from . import catalog

    queries = _claude_seed_queries(signal, n_queries=n_queries)
    pool: list[tuple[dict, str]] = []
    for q in queries:
        for cand in catalog.googlebooks_query(q, max_results=per_query):
            pool.append((cand, f"query:{q}"))
    return pool, queries


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
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = {
                "title": title,
                "author": cand.get("author"),
                "year": cand.get("year"),
                "isbn13": isbn,
                "subjects": (cand.get("subjects") or [])[:8],
                "cover_url": cand.get("cover_url"),
                "catalog_source": cand.get("source"),
                "catalog_id": cand.get("resolved_id"),
                "pools": {pool_name},
                "seed_reason": reason,
            }
        else:
            existing["pools"].add(pool_name)
            if not existing.get("author") and cand.get("author"):
                existing["author"] = cand.get("author")
            if not existing.get("subjects") and cand.get("subjects"):
                existing["subjects"] = (cand.get("subjects") or [])[:8]

    for cand, reason in metadata_pool:
        add(cand, reason, "metadata")
    for cand, reason in seed_pool:
        add(cand, reason, "claude_seed")

    candidates = []
    for c in by_key.values():
        pools = c.pop("pools")
        c["retrieval_pool"] = "both" if len(pools) > 1 else next(iter(pools))
        candidates.append(c)
    return _cap_pool(candidates, cap=cap)


def _cap_pool(candidates: list[dict], *, cap: int) -> list[dict]:
    """Trim the candidate pool to `cap` without letting the (larger) metadata pool starve
    the Claude-seeded one. If we paid for seed queries, their candidates must actually
    reach the reranker — so reserve a share of the cap for seed-only books before metadata
    fills the rest. 'both'-pool candidates are the most grounded and are always kept."""
    if len(candidates) <= cap:
        return candidates

    both = [c for c in candidates if c["retrieval_pool"] == "both"]
    meta = [c for c in candidates if c["retrieval_pool"] == "metadata"]
    seed = [c for c in candidates if c["retrieval_pool"] == "claude_seed"]

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


def _claude_rerank(candidates: list[dict], signal: dict, *, n: int) -> list[dict]:
    client, settings = _client()
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
    prompt = (
        f"Rank the best {n} candidates for this reader and explain each. Choose ONLY from "
        "the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit. Penalize "
        "anything that trips an aversion trait. Ground every pick in specific trait ids "
        "and the library book ids it most resembles — use only ids that appear below.\n\n"
        "TASTE TRAITS (JSON):\n"
        + json.dumps(signal["traits"], ensure_ascii=False)
        + "\n\nLOVED BOOKS (JSON):\n"
        + json.dumps(signal["loved"][:_LOVED_SAMPLE], ensure_ascii=False)
        + "\n\nCANDIDATES (JSON):\n"
        + json.dumps(indexed, ensure_ascii=False)
    )
    message = client.messages.create(
        model=settings.model,
        max_tokens=4000,
        system=_RANK_SYSTEM,
        tools=[_RANK_TOOL],
        tool_choice={"type": "tool", "name": "rank_recommendations"},
        messages=[{"role": "user", "content": prompt}],
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
    return out[:n]


# --- orchestrator ----------------------------------------------------------


def recommend(
    *,
    n: int = 10,
    use_metadata: bool = True,
    use_claude_seeds: bool = True,
    requests_per_second: float | None = None,
) -> dict:
    """Run the two-stage recommender and persist the served set. Returns a summary."""
    init_db()
    if requests_per_second is not None:
        from . import catalog

        catalog.set_rate(requests_per_second)

    with session_scope() as session:
        signal = _build_signal(session)
        if not signal["loved"]:
            raise RuntimeError(
                "No loved books found (need books rated >= 4). Run ingest + enrich "
                "(and ideally profile) first."
            )

        metadata_pool = (
            _metadata_pool(signal, per_query=_PER_QUERY) if use_metadata else []
        )
        seed_queries: list[str] = []
        seed_pool: list[tuple[dict, str]] = []
        if use_claude_seeds:
            seed_pool, seed_queries = _seed_pool(
                signal, n_queries=_SEED_QUERIES, per_query=_PER_QUERY
            )

        candidates = _assemble(metadata_pool, seed_pool, signal, cap=_MAX_CANDIDATES)
        if not candidates:
            return {
                "run_id": None,
                "served": 0,
                "candidates": 0,
                "note": "Retrieval surfaced no new candidates (catalog empty/offline?).",
                "recommendations": [],
            }

        ranked = _claude_rerank(candidates, signal, n=n)

        run_id = uuid.uuid4().hex[:12]
        recs_out = []
        for rank, c in enumerate(ranked, 1):
            session.add(
                Recommendation(
                    run_id=run_id,
                    rank=rank,
                    title=c["title"],
                    author=c.get("author"),
                    year=c.get("year"),
                    isbn13=c.get("isbn13"),
                    cover_url=c.get("cover_url"),
                    subjects=c.get("subjects") or [],
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


def latest_recommendations(session) -> list[Recommendation]:
    """Rows of the most recent run, in rank order (helper for API/CLI readers)."""
    last = (
        session.query(Recommendation)
        .order_by(Recommendation.created_at.desc(), Recommendation.id.desc())
        .first()
    )
    if last is None:
        return []
    return (
        session.query(Recommendation)
        .filter(Recommendation.run_id == last.run_id)
        .order_by(Recommendation.rank)
        .all()
    )
