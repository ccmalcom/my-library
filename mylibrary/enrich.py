"""Phase 2 — Enrichment (the foundation).

Resolve each book to real catalog metadata and emit a resolution-confidence score.
Because the source library has no review text, this enriched metadata is the PRIMARY
signal for the taste profile — so the confidence score matters as much as the data:
low-confidence matches are exactly what a later feedback phase will ask the user to fix.

Resolution order:
  1. ISBN13 -> Open Library  (exact)      -> HIGH
  2. ISBN13 -> Google Books  (exact)      -> HIGH
  3. title+author -> Open Library search  -> MEDIUM / LOW by match quality
  4. title+author -> Google Books search  -> MEDIUM / LOW by match quality
  5. nothing resolved                     -> LOW (unresolved)

Idempotent: books already enriched are skipped unless force=True, and catalog.py
caches every raw response to disk, so re-runs hit cache, not the network.
"""

from __future__ import annotations

import re
from datetime import datetime
from difflib import SequenceMatcher

from . import catalog
from .db import Book, Enrichment, init_db, session_scope

# Confidence bands
_CONF = {"HIGH": 0.95, "MEDIUM": 0.70, "LOW": 0.30, "NONE": 0.0}
_STRONG_SIM = 0.85
_WEAK_SIM = 0.60


def _normalize_title(t: str | None) -> str:
    if not t:
        return ""
    t = t.lower()
    t = t.split(":")[0]  # drop subtitle
    t = re.sub(r"\(.*?\)", "", t)  # drop parenthetical (editions, etc.)
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _surname(author: str | None) -> str:
    if not author:
        return ""
    return _normalize_title(author).split(" ")[-1]


def _title_sim(a: str | None, b: str | None) -> float:
    return SequenceMatcher(None, _normalize_title(a), _normalize_title(b)).ratio()


def _score_candidates(book: Book, candidates: list[dict]) -> tuple[dict | None, str]:
    """Pick the best candidate and a confidence label.

    Guards the documented mis-resolution traps: a common title that matches two
    different works near-equally is treated as ambiguous and scored LOW so the
    feedback loop surfaces it, rather than silently trusting the top hit.
    """
    if not candidates:
        return None, "NONE"

    scored = sorted(
        candidates,
        key=lambda c: _title_sim(book.title, c.get("title")),
        reverse=True,
    )
    best = scored[0]
    best_sim = _title_sim(book.title, best.get("title"))
    second_sim = _title_sim(book.title, scored[1].get("title")) if len(scored) > 1 else 0.0
    author_ok = (
        not book.author
        or not best.get("author")
        or _surname(book.author) == _surname(best.get("author"))
        or _surname(book.author) in _normalize_title(best.get("author"))
    )

    ambiguous = best_sim >= _STRONG_SIM and second_sim >= _STRONG_SIM
    if best_sim >= _STRONG_SIM and author_ok and not ambiguous:
        return best, "MEDIUM"
    if best_sim >= _WEAK_SIM:
        return best, "LOW"
    return best, "LOW"


def _apply(enr: Enrichment, cand: dict, label: str, method: str) -> None:
    enr.resolved_source = cand.get("source")
    enr.resolved_id = cand.get("resolved_id")
    enr.subjects = cand.get("subjects") or []
    enr.series = cand.get("series")
    enr.series_position = cand.get("series_position")
    enr.description = cand.get("description")
    enr.cover_url = cand.get("cover_url")
    enr.confidence_label = label
    enr.resolution_confidence = _CONF[label]
    enr.match_method = method
    enr.raw_response = cand.get("raw")
    enr.resolved_at = datetime.utcnow()


def _resolve_one(book: Book) -> tuple[dict | None, str, str]:
    """Return (candidate, confidence_label, match_method) for one book."""
    if book.isbn13:
        rec = catalog.openlibrary_by_isbn(book.isbn13)
        if rec:
            return rec, "HIGH", "isbn:openlibrary"
        rec = catalog.googlebooks_by_isbn(book.isbn13)
        if rec:
            return rec, "HIGH", "isbn:googlebooks"

    ol = catalog.openlibrary_search(book.title, book.author)
    cand, label = _score_candidates(book, ol)
    if cand is not None and label == "MEDIUM":
        return cand, label, "search:openlibrary"

    gb = catalog.googlebooks_search(book.title, book.author)
    gcand, glabel = _score_candidates(book, gb)
    if gcand is not None and glabel == "MEDIUM":
        return gcand, glabel, "search:googlebooks"

    # No strong match anywhere — keep the best low-confidence guess if any.
    if cand is not None:
        return cand, "LOW", "search:openlibrary"
    if gcand is not None:
        return gcand, "LOW", "search:googlebooks"
    return None, "NONE", "unresolved"


def enrich_library(
    *, force: bool = False, limit: int | None = None, include_unrated: bool = False
) -> dict:
    """Enrich rated books (or all, if include_unrated). Returns a summary dict."""
    init_db()
    summary = {
        "processed": 0,
        "HIGH": 0,
        "MEDIUM": 0,
        "LOW": 0,
        "unresolved": 0,
        "skipped_existing": 0,
    }

    with session_scope() as session:
        q = session.query(Book)
        books = q.all()
        for book in books:
            if not include_unrated and book.effective_rating is None:
                continue
            if limit is not None and summary["processed"] >= limit:
                break

            enr = book.enrichment
            if enr is not None and not force:
                summary["skipped_existing"] += 1
                continue

            cand, label, method = _resolve_one(book)
            if enr is None:
                enr = Enrichment(book_id=book.id)
                session.add(enr)

            if cand is None:
                enr.confidence_label = "LOW"
                enr.resolution_confidence = _CONF["NONE"]
                enr.match_method = method
                enr.resolved_at = datetime.utcnow()
                summary["unresolved"] += 1
            else:
                _apply(enr, cand, label, method)
                summary[label] += 1

            summary["processed"] += 1

    return summary
