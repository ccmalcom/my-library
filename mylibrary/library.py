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

from datetime import date

from .db import Book, Enrichment, init_db, session_scope, utcnow
from .enrich import _normalize_title, _surname
from .profile import books_changed_since, get_profile_meta


class BookNotFoundError(Exception):
    """Raised when an edit targets a book id that doesn't exist."""


class BookExistsError(Exception):
    """Raised when a manual add would duplicate a book already in the library."""


# The shelves a book can live on (mirrors Goodreads' Exclusive Shelf values).
VALID_SHELVES = {"to-read", "currently-reading", "read", "did-not-finish"}


def _book_summary(book: Book) -> dict:
    return {
        "id": book.id,
        "title": book.title,
        "author": book.author,
        "exclusive_shelf": book.exclusive_shelf,
        "app_rating": book.app_rating,
        "goodreads_rating": book.goodreads_rating,
        "effective_rating": book.effective_rating,
        "app_review": book.app_review,
        "date_read": book.date_read,
        "feedback_updated_at": book.feedback_updated_at,
    }


def add_book(
    *,
    title: str,
    author: str | None = None,
    year: int | None = None,
    isbn13: str | None = None,
    shelf: str = "read",
    rating: int | None = None,
    review: str | None = None,
    cover_url: str | None = None,
    subjects: list[str] | None = None,
    catalog_source: str | None = None,
    catalog_id: str | None = None,
) -> int:
    """Manually add a book to the library; return the new book id.

    The first-class path is the in-app "add a book" flow: the user picks a real catalog
    hit (search-and-pick), so the cover/subjects/year/isbn come from that pick and are
    stored as a stub Enrichment (confidence_label="MANUAL", like the recommendation path).
    No extra network call happens here — the search already resolved the book — so adding
    is fast and works offline.

    Dedup mirrors the recommender: normalized title + author surname. A duplicate raises
    `BookExistsError` rather than silently creating a second row.

    A `rating` (1-5) and/or a `review` set `app_rating` / `app_review` and bump
    `feedback_updated_at`, so a rated or reviewed manual add immediately makes the taste
    profile show as dirty — the same ownership model as in-app re-rating/reviewing (locked
    decision #2; a written review is an especially strong, direct signal). `shelf` defaults
    to "read".
    """
    title = (title or "").strip()
    if not title:
        raise ValueError("title is required.")
    if shelf not in VALID_SHELVES:
        raise ValueError(f"shelf must be one of {sorted(VALID_SHELVES)}.")
    if rating is not None and rating != 0 and not (1 <= rating <= 5):
        raise ValueError("rating must be between 1 and 5 (or omitted/0 for unrated).")

    author = (author or "").strip() or None
    isbn13 = (isbn13 or "").strip() or None
    review = (review or "").strip() or None

    init_db()
    with session_scope() as session:
        norm_title = _normalize_title(title)
        norm_surname = _surname(author)
        for b in session.query(Book).filter(Book.title.isnot(None)).all():
            if _normalize_title(b.title) == norm_title and _surname(b.author) == norm_surname:
                raise BookExistsError(f'"{title}" is already in your library.')

        book = Book(
            title=title,
            author=author,
            isbn13=isbn13,
            year_published=year,
            exclusive_shelf=shelf,
            source="manual",
            goodreads_rating=0,
            date_added=date.today(),
        )
        if rating not in (None, 0):
            book.app_rating = rating
        if review:
            book.app_review = review
        # Any direct taste signal (rating or review) dirties the profile.
        if rating not in (None, 0) or review:
            book.feedback_updated_at = utcnow()
        session.add(book)
        session.flush()  # assign book.id

        # Stub enrichment from the catalog pick so the cover/subjects render immediately
        # and the recommender treats the book as already enriched (won't re-resolve it).
        if cover_url or subjects or catalog_source or catalog_id:
            session.add(
                Enrichment(
                    book_id=book.id,
                    resolved_source=catalog_source,
                    resolved_id=catalog_id,
                    subjects=subjects or [],
                    cover_url=cover_url,
                    resolution_confidence=1.0,
                    confidence_label="MANUAL",
                    match_method="manual_add",
                )
            )
        return book.id


def set_book_feedback(
    book_id: int,
    *,
    rating: int | None = None,
    review: str | None = None,
    clear_review: bool = False,
    date_read: date | None = None,
) -> dict:
    """Set the in-app rating, review, and/or date-read for a book; stamp it as changed.

    - `rating`: 1-5 to set, or 0 to clear the in-app rating (revert to the Goodreads
      seed). `None` leaves the rating untouched.
    - `review`: text to store. `None` leaves the review untouched; pass `clear_review`
      to remove an existing review.
    - `date_read`: the date the reader finished the book (optional — "if remembered").
      `None` leaves it untouched. Feeds the profile's temporal weighting (`read_year`).

    Touching any field bumps `feedback_updated_at`, which is what later makes the taste
    profile show as dirty. Never re-profiles — that's an explicit user action.
    """
    if rating is not None and rating != 0 and not (1 <= rating <= 5):
        raise ValueError("rating must be between 1 and 5 (or 0 to clear).")
    if rating is None and review is None and not clear_review and date_read is None:
        raise ValueError("Nothing to update: pass a rating, review, and/or date read.")

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
        if date_read is not None:
            book.date_read = date_read

        book.feedback_updated_at = utcnow()
        return _book_summary(book)


def set_book_shelf(book_id: int, shelf: str) -> dict:
    """Move a book to a different shelf (e.g. to-read -> currently-reading / read).

    A shelf move is not a taste signal on its own, so it does NOT bump
    `feedback_updated_at` or dirty the profile — rating/review the book (separately) does.
    """
    if shelf not in VALID_SHELVES:
        raise ValueError(f"shelf must be one of {sorted(VALID_SHELVES)}.")

    init_db()
    with session_scope() as session:
        book = session.get(Book, book_id)
        if book is None:
            raise BookNotFoundError(f"Book {book_id} not found.")
        book.exclusive_shelf = shelf
        return _book_summary(book)


def remove_book(book_id: int) -> dict:
    """Permanently delete a book (and its enrichment) from the library.

    Used to drop a title off the to-read shelf. `books` the *table* is never dropped,
    but individual rows can be removed; the Enrichment relationship cascades.
    """
    init_db()
    with session_scope() as session:
        book = session.get(Book, book_id)
        if book is None:
            raise BookNotFoundError(f"Book {book_id} not found.")
        title = book.title
        session.delete(book)
        return {"id": book_id, "title": title, "removed": True}


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
