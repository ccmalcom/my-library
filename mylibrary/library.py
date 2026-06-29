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
from typing import Literal

from .config import LOCAL_USER_ID
from .db import Book, Enrichment, TasteTrait, TasteSignal, init_db, session_scope, utcnow
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
        "exclude_from_profile": book.exclude_from_profile,
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
    user_id: str = LOCAL_USER_ID,
) -> int:
    """Manually add a book to `user_id`'s library; return the new book id.

    The first-class path is the in-app "add a book" flow: the user picks a real catalog
    hit (search-and-pick), so the cover/subjects/year/isbn come from that pick and are
    stored as a stub Enrichment (confidence_label="MANUAL", like the recommendation path).
    No extra network call happens here — the search already resolved the book — so adding
    is fast and works offline.

    Dedup mirrors the recommender: normalized title + author surname. A duplicate raises
    `BookExistsError` rather than silently creating a second row.

    A `rating` (1-5) sets `app_rating` and bumps `feedback_updated_at`, making the taste
    profile show as dirty — the same ownership model as in-app re-rating/reviewing (locked
    decision #2). A `review` is a rated signal: it may only accompany a rating, so adding a
    review without one raises `ValueError` (a written review is an especially strong, direct
    signal, but the model still tiers it by its rating). `shelf` defaults to "read".
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

    # A review is a rated signal — there's no such thing as a review without a rating.
    # Reject a review on an unrated add (rating omitted or 0) rather than storing a
    # dangling review the taste model can't tier.
    if review and rating in (None, 0):
        raise ValueError("A review requires a rating (1-5). Rate the book, or omit the review.")

    init_db()
    with session_scope() as session:
        norm_title = _normalize_title(title)
        norm_surname = _surname(author)
        # Dedup is scoped to this user — one user's add never scans another's books.
        dupe_q = session.query(Book).filter(
            Book.user_id == user_id, Book.title.isnot(None)
        )
        for b in dupe_q.all():
            if _normalize_title(b.title) == norm_title and _surname(b.author) == norm_surname:
                raise BookExistsError(f'"{title}" is already in your library.')

        book = Book(
            user_id=user_id,
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
    exclude_from_profile: bool | None = None,
    is_favorite: bool | None = None,
    user_id: str = LOCAL_USER_ID,
) -> dict:
    """Set the in-app rating, review, date-read, exclude flag, and/or favorite for a book.

    - `rating`: 1-5 to set, or 0 to clear the in-app rating (revert to the Goodreads
      seed). `None` leaves the rating untouched.
    - `review`: text to store. `None` leaves the review untouched; pass `clear_review`
      to remove an existing review. A review requires the book to be rated (set a rating
      in the same call or beforehand) — reviewing an unrated book raises `ValueError`.
    - `date_read`: the date the reader finished the book (optional — "if remembered").
      `None` leaves it untouched. Feeds the profile's temporal weighting (`read_year`).
    - `exclude_from_profile`: when True, the book is tracked but skipped during taste
      profiling and archetype derivation. `None` leaves the flag untouched.
    - `is_favorite`: marks the book as a personal favorite, surfaced as extra-strong
      profiling signal. `None` leaves the flag untouched.

    Touching any field bumps `feedback_updated_at`, which is what later makes the taste
    profile show as dirty. Never re-profiles — that's an explicit user action.
    """
    if rating is not None and rating != 0 and not (1 <= rating <= 5):
        raise ValueError("rating must be between 1 and 5 (or 0 to clear).")
    if (rating is None and review is None and not clear_review
            and date_read is None and exclude_from_profile is None and is_favorite is None):
        raise ValueError("Nothing to update: pass a rating, review, date read, exclude flag, and/or favorite.")

    init_db()
    with session_scope() as session:
        book = session.get(Book, book_id)
        if book is None or book.user_id != user_id:
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
        if exclude_from_profile is not None:
            book.exclude_from_profile = exclude_from_profile
        if is_favorite is not None:
            book.is_favorite = is_favorite

        # A review can't exist without a rating. After applying the rating change above,
        # if the book carries a review but has no effective rating, reject — the rating can
        # be supplied in the same call. Clearing a review or date-only edits are unaffected.
        # Exception: DNF books are exempt — a review on an unfinished book doesn't require a rating.
        if book.app_review and book.effective_rating is None and book.exclusive_shelf != "did-not-finish":
            raise ValueError(
                "A review requires a rating. Rate the book 1-5 (same update is fine) "
                "before saving a review."
            )

        book.feedback_updated_at = utcnow()
        return _book_summary(book)


def set_book_shelf(book_id: int, shelf: str, *, user_id: str = LOCAL_USER_ID) -> dict:
    """Move a book to a different shelf (e.g. to-read -> currently-reading / read).

    A shelf move is not a taste signal on its own, so it does NOT bump
    `feedback_updated_at` or dirty the profile — rating/review the book (separately) does.
    """
    if shelf not in VALID_SHELVES:
        raise ValueError(f"shelf must be one of {sorted(VALID_SHELVES)}.")

    init_db()
    with session_scope() as session:
        book = session.get(Book, book_id)
        if book is None or book.user_id != user_id:
            raise BookNotFoundError(f"Book {book_id} not found.")
        if shelf != "did-not-finish" and book.app_review and book.effective_rating is None:
            raise ValueError(
                "A review requires a rating. Rate the book 1-5 before moving it off did-not-finish."
            )
        book.exclusive_shelf = shelf
        return _book_summary(book)


def remove_book(book_id: int, *, user_id: str = LOCAL_USER_ID) -> dict:
    """Permanently delete a book (and its enrichment) from the library.

    Used to drop a title off the to-read shelf. `books` the *table* is never dropped,
    but individual rows can be removed; the Enrichment relationship cascades.
    """
    init_db()
    with session_scope() as session:
        book = session.get(Book, book_id)
        if book is None or book.user_id != user_id:
            raise BookNotFoundError(f"Book {book_id} not found.")
        title = book.title
        session.delete(book)
        return {"id": book_id, "title": title, "removed": True}


def profile_status(*, user_id: str = LOCAL_USER_ID) -> dict:
    """Report whether `user_id`'s taste profile is stale relative to in-app edits.

    `dirty` is True when ratings/reviews have changed since the profile was last built,
    OR when any trait verdict (status/user_weight) has been updated since last profiling.
    This backs the UI's "re-profile" button — the app shows it only when `dirty` is True.
    """
    init_db()
    with session_scope() as session:
        meta = get_profile_meta(session, user_id)
        since = meta.last_profiled_at
        changed = books_changed_since(session, since, user_id)
        # Also dirty if any trait verdict was updated after the last profile build.
        trait_verdict_dirty = _trait_verdicts_changed_since(session, since, user_id)
        # Also dirty if any rec was rejected with structured reasons after the last build.
        rec_reject_dirty = (
            meta.rec_feedback_updated_at is not None
            and (since is None or meta.rec_feedback_updated_at > since)
        )
        return {
            "dirty": bool(changed) or trait_verdict_dirty or rec_reject_dirty,
            "changed_books": len(changed),
            "changed_book_ids": [b.id for b in changed],
            "last_profiled_at": meta.last_profiled_at,
            "last_profile_kind": meta.last_profile_kind,
        }


def _trait_verdicts_changed_since(session, since, user_id: str) -> bool:
    """Return True if any TasteTrait verdict_updated_at > since (or since is None and any exist)."""
    from sqlalchemy import func

    q = session.query(func.count(TasteTrait.id)).filter(
        TasteTrait.user_id == user_id,
        TasteTrait.verdict_updated_at.isnot(None),
    )
    if since is not None:
        q = q.filter(TasteTrait.verdict_updated_at > since)
    return q.scalar() > 0


class TraitNotFoundError(Exception):
    """Raised when set_trait_verdict targets a trait that doesn't exist or belongs to another user."""


def set_trait_verdict(
    session,
    trait_id: int,
    *,
    status: Literal["confirmed", "rejected"] | None = None,
    user_weight: float | None = None,
    user_id: str,
) -> TasteTrait:
    """Set the user's verdict on a taste trait: confirm/reject it and/or adjust its weight.

    Applies only the fields that are not None. Stamps `verdict_updated_at` so the
    profile-status check can detect the change. Raises TraitNotFoundError (mapped to 404
    by the API layer) if the trait doesn't exist or belongs to another user.
    """
    trait = session.get(TasteTrait, trait_id)
    if trait is None or trait.user_id != user_id:
        raise TraitNotFoundError(f"Trait {trait_id} not found")
    if status is not None:
        trait.status = status
    if user_weight is not None:
        if not (0.0 <= user_weight <= 1.0):
            raise ValueError("user_weight must be between 0.0 and 1.0.")
        trait.user_weight = user_weight
    trait.verdict_updated_at = utcnow()
    session.flush()
    return trait


class TasteSignalError(ValueError):
    """Raised when a taste signal request is invalid (bad direction/kind, missing book, etc.)."""


def record_taste_signal(
    session,
    *,
    direction: str,
    target_kind: str,
    target_book_id: int | None = None,
    snapshot: dict | None = None,
    user_id: str,
) -> TasteSignal:
    """Persist a more/less-like-this steering signal and dirty the profile.

    Validation:
    - direction must be "more" or "less".
    - target_kind must be "book" or "rec".
    - For book kind, target_book_id is required and must refer to a book owned by user_id.
    - For rec kind, snapshot is required.

    Dirties the profile by bumping ProfileMeta.rec_feedback_updated_at so the next
    profile build sees the signal. Raises TasteSignalError (mapped to 422/404 by the
    API layer).
    """
    if direction not in {"more", "less"}:
        raise TasteSignalError(f"direction must be 'more' or 'less', got {direction!r}")
    if target_kind not in {"book", "rec"}:
        raise TasteSignalError(f"target_kind must be 'book' or 'rec', got {target_kind!r}")

    if target_kind == "book":
        if target_book_id is None:
            raise TasteSignalError("target_book_id is required for book-kind signals")
        book = session.get(Book, target_book_id)
        if book is None or book.user_id != user_id:
            raise BookNotFoundError(f"Book {target_book_id} not found")
    elif target_kind == "rec":
        if not snapshot:
            raise TasteSignalError("snapshot is required for rec-kind signals")

    signal = TasteSignal(
        user_id=user_id,
        direction=direction,
        target_kind=target_kind,
        target_book_id=target_book_id,
        snapshot=snapshot,
    )
    session.add(signal)

    # Dirty the profile so the next build incorporates this signal.
    meta = get_profile_meta(session, user_id)
    meta.rec_feedback_updated_at = utcnow()

    session.flush()
    return signal
