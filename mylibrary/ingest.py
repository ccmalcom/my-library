"""Phase 1 — Ingest. Goodreads CSV -> books table, idempotent.

Handles the three documented Goodreads quirks:
  1. ISBN / ISBN13 are Excel-escaped as `="..."` — stripped before use.
  2. `My Rating == 0` means *unrated*, not zero stars.
  3. `Exclusive Shelf` carries the read/to-read/etc. status.

Upsert is keyed on `Book Id` (the stable Goodreads key) so re-importing the same
export updates rows in place instead of duplicating them. The in-app `app_rating`
is never touched by import — Goodreads is an import-once seed, not the source of truth.
"""

from __future__ import annotations

import csv
from datetime import date, datetime
from pathlib import Path

from .config import LOCAL_USER_ID
from .db import Book, init_db, session_scope


def clean_isbn(raw: str | None) -> str | None:
    """Strip Goodreads' Excel-escaped `="..."` wrapper. Empty -> None."""
    if raw is None:
        return None
    s = raw.strip()
    if s.startswith("="):
        s = s[1:]
    s = s.strip().strip('"').strip()
    return s or None


def _parse_int(raw: str | None) -> int | None:
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _parse_date(raw: str | None) -> date | None:
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


def ingest_csv(csv_path: str | Path, *, user_id: str = LOCAL_USER_ID) -> dict:
    """Parse a Goodreads export and upsert into the books table for `user_id`.

    Returns a summary dict: {total_rows, inserted, updated, rated, skipped}.
    """
    csv_path = Path(csv_path)
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Goodreads export not found at {csv_path}. "
            "Export from Goodreads > My Books > Import and export > Export Library, "
            "then drop the CSV into the data/ folder."
        )

    init_db()
    total = inserted = updated = rated = skipped = 0

    with session_scope() as session, csv_path.open(
        newline="", encoding="utf-8-sig"
    ) as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            total += 1
            gr_id = (row.get("Book Id") or "").strip() or None
            title = (row.get("Title") or "").strip()
            if not title:
                skipped += 1
                continue

            my_rating = _parse_int(row.get("My Rating")) or 0  # 0 == unrated
            if my_rating > 0:
                rated += 1

            values = dict(
                title=title,
                author=(row.get("Author") or "").strip() or None,
                additional_authors=(row.get("Additional Authors") or "").strip() or None,
                isbn13=clean_isbn(row.get("ISBN13")) or clean_isbn(row.get("ISBN")),
                exclusive_shelf=(row.get("Exclusive Shelf") or "").strip() or None,
                goodreads_rating=my_rating,
                date_read=_parse_date(row.get("Date Read")),
                date_added=_parse_date(row.get("Date Added")),
                page_count=_parse_int(row.get("Number of Pages")),
                year_published=_parse_int(row.get("Original Publication Year"))
                or _parse_int(row.get("Year Published")),
                source="goodreads_import",
            )

            existing = None
            if gr_id is not None:
                existing = (
                    session.query(Book)
                    .filter(Book.user_id == user_id, Book.goodreads_book_id == gr_id)
                    .one_or_none()
                )

            if existing is None:
                session.add(Book(user_id=user_id, goodreads_book_id=gr_id, **values))
                inserted += 1
            else:
                # Update import-owned fields only; never clobber app_rating.
                for key, val in values.items():
                    setattr(existing, key, val)
                updated += 1

    return {
        "total_rows": total,
        "inserted": inserted,
        "updated": updated,
        "rated": rated,
        "skipped": skipped,
    }
