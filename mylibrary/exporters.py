"""Backup / export of a user's library.

CSV = the canonical, re-importable shape (rating/review use effective values so a backup
captures what the user actually rated). JSON = a fuller backup: every book field plus the
durable taste signals (which survive library resets and are otherwise irreplaceable).
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

from .config import LOCAL_USER_ID
from .db import Book, TasteSignal, init_db, session_scope
from .importers.formats import CANONICAL_FIELDS


def _iso(d) -> str | None:
    return d.isoformat() if d is not None else None


def export_csv(user_id: str = LOCAL_USER_ID) -> str:
    init_db()
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CANONICAL_FIELDS)
    writer.writeheader()
    with session_scope() as session:
        books = (
            session.query(Book)
            .filter(Book.user_id == user_id)
            .order_by(Book.id)
            .all()
        )
        for b in books:
            writer.writerow(
                {
                    "title": b.title,
                    "author": b.author or "",
                    "additional_authors": b.additional_authors or "",
                    "isbn13": b.isbn13 or "",
                    "shelf": b.exclusive_shelf or "",
                    "rating": b.effective_rating or "",
                    "review": b.app_review or "",
                    "date_read": _iso(b.date_read) or "",
                    "date_added": _iso(b.date_added) or "",
                    "page_count": b.page_count if b.page_count is not None else "",
                    "year_published": b.year_published if b.year_published is not None else "",
                }
            )
    return buf.getvalue()


def export_json(user_id: str = LOCAL_USER_ID) -> dict:
    init_db()
    with session_scope() as session:
        books = (
            session.query(Book).filter(Book.user_id == user_id).order_by(Book.id).all()
        )
        signals = (
            session.query(TasteSignal)
            .filter(TasteSignal.user_id == user_id)
            .order_by(TasteSignal.id)
            .all()
        )
        return {
            "version": 1,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "books": [
                {
                    "title": b.title,
                    "author": b.author,
                    "additional_authors": b.additional_authors,
                    "isbn13": b.isbn13,
                    "shelf": b.exclusive_shelf,
                    "goodreads_rating": b.goodreads_rating,
                    "app_rating": b.app_rating,
                    "app_review": b.app_review,
                    "effective_rating": b.effective_rating,
                    "is_favorite": b.is_favorite,
                    "exclude_from_profile": b.exclude_from_profile,
                    "date_read": _iso(b.date_read),
                    "date_added": _iso(b.date_added),
                    "page_count": b.page_count,
                    "year_published": b.year_published,
                    "source": b.source,
                }
                for b in books
            ],
            "taste_signals": [
                {
                    "direction": s.direction,
                    "target_kind": s.target_kind,
                    "target_book_id": s.target_book_id,
                    "snapshot": s.snapshot,
                    "created_at": _iso(s.created_at),
                }
                for s in signals
            ],
        }
