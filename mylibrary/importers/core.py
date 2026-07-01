"""Format-agnostic import core: the canonical ImportRow and the shared upsert.

Every import source (Goodreads, StoryGraph, canonical, generic CSV) parses to a list of
ImportRow, then import_rows() upserts them. The locked invariants live here:
  - app_rating / app_review are NEVER clobbered on re-import (locked decision #2).
  - Imported ratings seed goodreads_rating (the source-agnostic "imported rating" slot).
  - Imported reviews seed app_review ONLY when inserting a new book AND a rating is present
    (a review requires a rating).
  - No network calls — enrichment runs later.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

from ..config import LOCAL_USER_ID
from ..db import Book, init_db, session_scope, utcnow
from ..enrich import _normalize_title, _surname
from ..library import VALID_SHELVES


def clean_isbn(raw: str | None) -> str | None:
    """Strip Goodreads' Excel-escaped `="..."` wrapper; empty -> None."""
    if raw is None:
        return None
    s = raw.strip()
    if s.startswith("="):
        s = s[1:]
    s = s.strip().strip('"').strip()
    return s or None


def parse_int(raw: str | None) -> int | None:
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def parse_date(raw: str | None) -> date | None:
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def parse_rating(raw) -> int | None:
    """A star rating string (may be a half-star float like '4.5') -> int 1..5.

    Rounds half-up, clamps to 1..5. Empty / 0 / non-numeric -> None (unrated).
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        val = float(s)
    except ValueError:
        return None
    rounded = int(val + 0.5)  # half-up for non-negative
    if rounded <= 0:
        return None
    return min(rounded, 5)


# Common shelf/status spellings across managers -> our canonical VALID_SHELVES.
_SHELF_SYNONYMS = {
    "read": "read",
    "currently-reading": "currently-reading",
    "currently reading": "currently-reading",
    "reading": "currently-reading",
    "to-read": "to-read",
    "to read": "to-read",
    "want to read": "to-read",
    "tbr": "to-read",
    "did-not-finish": "did-not-finish",
    "did not finish": "did-not-finish",
    "dnf": "did-not-finish",
    "abandoned": "did-not-finish",
}


def normalize_shelf(raw: str | None) -> str | None:
    if not raw:
        return None
    key = raw.strip().lower()
    if key in VALID_SHELVES:
        return key
    return _SHELF_SYNONYMS.get(key)


@dataclass
class ImportRow:
    title: str
    author: str | None = None
    additional_authors: str | None = None
    isbn13: str | None = None
    shelf: str | None = None
    rating: int | None = None
    review: str | None = None
    date_read: date | None = None
    date_added: date | None = None
    page_count: int | None = None
    year_published: int | None = None
    external_id: str | None = None  # source-native id (Goodreads Book Id); None otherwise


# Import-owned fields updated on re-import (never app_rating / app_review).
_UPDATE_FIELDS = (
    "author",
    "additional_authors",
    "isbn13",
    "exclusive_shelf",
    "date_read",
    "date_added",
    "page_count",
    "year_published",
    "goodreads_rating",
)


def import_rows(rows: list[ImportRow], *, user_id: str = LOCAL_USER_ID, source: str) -> dict:
    """Upsert canonical rows for user_id. Returns {inserted, updated, rated}.

    Dedup precedence:
      - external_id present (Goodreads): match on (user_id, goodreads_book_id) only.
      - else ISBN13 match, else normalized-title + author-surname match.
    Sparse imports never null existing data: on update, only non-None incoming fields win.
    """
    init_db()
    inserted = updated = rated = 0

    with session_scope() as session:
        existing = session.query(Book).filter(Book.user_id == user_id).all()
        by_grid = {b.goodreads_book_id: b for b in existing if b.goodreads_book_id}
        by_isbn = {b.isbn13: b for b in existing if b.isbn13}
        by_titlekey: dict[tuple[str, str], Book] = {}
        for b in existing:
            by_titlekey.setdefault((_normalize_title(b.title or ""), _surname(b.author)), b)

        for row in rows:
            if row.rating:
                rated += 1

            match: Book | None = None
            if row.external_id is not None:
                match = by_grid.get(row.external_id)
            else:
                if row.isbn13:
                    match = by_isbn.get(row.isbn13)
                if match is None:
                    match = by_titlekey.get(
                        (_normalize_title(row.title), _surname(row.author))
                    )

            incoming = {
                "author": row.author,
                "additional_authors": row.additional_authors,
                "isbn13": row.isbn13,
                "exclusive_shelf": row.shelf,
                "date_read": row.date_read,
                "date_added": row.date_added,
                "page_count": row.page_count,
                "year_published": row.year_published,
                "goodreads_rating": row.rating,  # seed slot; None skipped on update
            }

            if match is None:
                book = Book(
                    user_id=user_id,
                    goodreads_book_id=row.external_id,
                    title=row.title,
                    author=row.author,
                    additional_authors=row.additional_authors,
                    isbn13=row.isbn13,
                    exclusive_shelf=row.shelf,
                    goodreads_rating=row.rating or 0,
                    date_read=row.date_read,
                    date_added=row.date_added,
                    page_count=row.page_count,
                    year_published=row.year_published,
                    source=source,
                )
                # Seed the imported review ONLY on a fresh insert and only with a rating
                # (review-requires-rating). Never seed onto a book that may already own one.
                if row.review and row.rating:
                    book.app_review = row.review
                    book.app_rating = None  # keep app_rating unset; goodreads_rating is the seed
                    book.feedback_updated_at = utcnow()
                session.add(book)
                # index the new book so a later row in the same file dedups against it
                if row.isbn13:
                    by_isbn.setdefault(row.isbn13, book)
                by_titlekey.setdefault(
                    (_normalize_title(row.title), _surname(row.author)), book
                )
                inserted += 1
            else:
                for field in _UPDATE_FIELDS:
                    val = incoming.get(field)
                    if val is not None:
                        setattr(match, field, val)
                updated += 1

    return {"inserted": inserted, "updated": updated, "rated": rated}
