"""In-app library edits: re-rating and reviewing books, plus profile freshness.

Goodreads is an import-once cold-start seed; MyLibrary owns ratings and feedback going
forward (locked decision #2). This module is the write path for that ownership: it sets
`app_rating` / `app_review` and stamps `feedback_updated_at` so the app can tell when the
taste profile has gone stale.

Re-profiling is deliberately NOT triggered here. The UI surfaces a "re-profile" button
when `profile_status()` reports the profile is dirty; the user chooses when to spend the
Claude call. The efficient re-profile itself lives in `profile.update_taste_profile`.
"""

from __future__ import annotations

from datetime import datetime

from .db import Book, init_db, session_scope
from .profile import books_changed_since, get_profile_meta


class BookNotFoundError(Exception):
    """Raised when a feedback edit targets a book id that doesn't exist."""


def _book_summary(book: Book) -> dict:
    return {
        "id": book.id,
        "title": book.title,
        "author": book.author,
        "app_rating": book.app_rating,
        "goodreads_rating": book.goodreads_rating,
        "effective_rating": book.effective_rating,
        "app_review": book.app_review,
        "feedback_updated_at": book.feedback_updated_at,
    }


def set_book_feedback(
    book_id: int,
    *,
    rating: int | None = None,
    review: str | None = None,
    clear_review: bool = False,
) -> dict:
    """Set the in-app rating and/or review for a book; stamp it as changed.

    - `rating`: 1-5 to set, or 0 to clear the in-app rating (revert to the Goodreads
      seed). `None` leaves the rating untouched.
    - `review`: text to store. `None` leaves the review untouched; pass `clear_review`
      to remove an existing review.

    Touching either field bumps `feedback_updated_at`, which is what later makes the
    taste profile show as dirty. Never re-profiles — that's an explicit user action.
    """
    if rating is not None and rating != 0 and not (1 <= rating <= 5):
        raise ValueError("rating must be between 1 and 5 (or 0 to clear).")
    if rating is None and review is None and not clear_review:
        raise ValueError("Nothing to update: pass a rating and/or a review.")

    init_db()
    with session_scope() as session:
        book = session.get(Book, book_id)
        if book is None:
            raise BookNotFoundError(f"Book {book_id} not found.")

        if rating is not None:
            # 0 clears the in-app rating, falling back to the imported Goodreads value.
            book.app_rating = None if rating == 0 else rating
        if clear_review:
            book.app_review = None
        elif review is not None:
            book.app_review = review.strip() or None

        book.feedback_updated_at = datetime.utcnow()
        return _book_summary(book)


def profile_status() -> dict:
    """Report whether the taste profile is stale relative to in-app edits.

    `dirty` is True when ratings/reviews have changed since the profile was last built
    (or when feedback exists but no profile has ever been built). This backs the UI's
    "re-profile" button — the app shows it only when `dirty` is True.
    """
    init_db()
    with session_scope() as session:
        meta = get_profile_meta(session)
        since = meta.last_profiled_at
        changed = books_changed_since(session, since)
        return {
            "dirty": bool(changed),
            "changed_books": len(changed),
            "changed_book_ids": [b.id for b in changed],
            "last_profiled_at": meta.last_profiled_at,
            "last_profile_kind": meta.last_profile_kind,
        }
