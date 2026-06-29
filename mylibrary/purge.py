"""Destructive data-removal operations: clear a library, reset a profile, delete an account.

Granular single-book removal lives in `library.remove_book`; this module owns the *bulk*
drops. Everything is **user-scoped** — a purge for one user never touches another tenant's
rows (the queries all filter by `user_id`). These back both the CLI (`clear-library` /
`clear-profile` / `delete-account`) and the API `DELETE /library` / `/profile` / `/account`
routes, and are the supported way to reset a user to first-setup state (e.g. to re-test
onboarding without minting a new account).

Cascade model (locked with the user):
- **clear_profile** — drops the derived taste data (taste_traits + recommendations) and the
  profile bookkeeping (profile_meta), but KEEPS the books. The library stays; the profile can
  be rebuilt from it.
- **clear_library** — drops the books (+ their enrichments) AND cascades to clear_profile,
  because a taste profile with no library is meaningless/orphaned. Net result: stats.total == 0
  and no stale profile, i.e. a clean first-setup state.
- **delete_account** — clear_library PLUS user_settings (the encrypted Anthropic key): every
  row this user owns, in every table. App-data only — it does NOT delete the Supabase auth
  user (that would need the Supabase admin API); re-logging in starts fresh.

Why explicit ordered deletes (not ORM cascade): `Enrichment` has a FK to `books.id`, so on
Postgres the enrichments must go before the books or the delete violates the constraint. The
bulk `Query.delete()` path is Core-level and does NOT fire the ORM relationship cascade, so we
delete enrichments explicitly first. `recommendations` reference books only by JSON id lists
(no FK), so they're dropped by `user_id` directly.
"""

from __future__ import annotations

from .config import LOCAL_USER_ID
from .db import (
    Book,
    EnrichJob,
    Enrichment,
    ProfileMeta,
    ReaderArchetype,
    Recommendation,
    TasteSignal,
    TasteTrait,
    UserSettings,
    init_db,
    session_scope,
)


def _delete_profile_rows(session, user_id: str) -> dict:
    """Delete a user's derived taste data (traits + recs) and profile bookkeeping.

    Internal helper operating within an open session so callers can compose it into a
    larger transaction (clear_library / delete_account). Returns per-table counts.
    """
    traits = (
        session.query(TasteTrait)
        .filter(TasteTrait.user_id == user_id)
        .delete(synchronize_session=False)
    )
    recs = (
        session.query(Recommendation)
        .filter(Recommendation.user_id == user_id)
        .delete(synchronize_session=False)
    )
    # Drop the profile_meta row so the user reads as never-profiled; get_profile_meta
    # upserts a fresh one on next access (next build is a full rebuild).
    session.query(ProfileMeta).filter(ProfileMeta.user_id == user_id).delete(
        synchronize_session=False
    )
    # Drop the archetype row (no FK) -- all three purge paths call this helper so the
    # archetype is removed on profile-reset, library-clear, and account-delete.
    session.query(ReaderArchetype).filter(
        ReaderArchetype.user_id == user_id
    ).delete(synchronize_session=False)
    return {"traits_removed": traits, "recommendations_removed": recs}


def _delete_library_rows(session, user_id: str) -> int:
    """Delete a user's books and their enrichments (enrichments first — FK safety)."""
    book_ids = [
        bid for (bid,) in session.query(Book.id).filter(Book.user_id == user_id).all()
    ]
    if book_ids:
        session.query(Enrichment).filter(Enrichment.book_id.in_(book_ids)).delete(
            synchronize_session=False
        )
    return (
        session.query(Book)
        .filter(Book.user_id == user_id)
        .delete(synchronize_session=False)
    )


def clear_profile(*, user_id: str = LOCAL_USER_ID) -> dict:
    """Drop `user_id`'s taste profile (traits + recommendations + profile_meta); keep books."""
    init_db()
    with session_scope() as session:
        result = _delete_profile_rows(session, user_id)
        return {**result, "profile_reset": True}


def clear_library(*, user_id: str = LOCAL_USER_ID) -> dict:
    """Drop `user_id`'s entire library (books + enrichments) and cascade to the profile.

    Leaves the user in a clean first-setup state: stats.total == 0, no orphaned taste data.
    """
    init_db()
    with session_scope() as session:
        profile = _delete_profile_rows(session, user_id)
        books = _delete_library_rows(session, user_id)
        return {
            "books_removed": books,
            **profile,
            "profile_reset": True,
        }


def delete_account(*, user_id: str = LOCAL_USER_ID) -> dict:
    """Delete ALL of `user_id`'s app data: library, enrichments, profile, recs, and settings.

    App-data only — does not remove the Supabase auth user. After this the user_id owns no rows
    anywhere; logging back in is indistinguishable from a brand-new account.
    """
    init_db()
    with session_scope() as session:
        profile = _delete_profile_rows(session, user_id)
        books = _delete_library_rows(session, user_id)
        settings_removed = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user_id)
            .delete(synchronize_session=False)
        )
        signals_removed = (
            session.query(TasteSignal)
            .filter(TasteSignal.user_id == user_id)
            .delete(synchronize_session=False)
        )
        jobs_removed = (
            session.query(EnrichJob)
            .filter(EnrichJob.user_id == user_id)
            .delete(synchronize_session=False)
        )
        return {
            "books_removed": books,
            **profile,
            "settings_removed": settings_removed,
            "signals_removed": signals_removed,
            "jobs_removed": jobs_removed,
            "account_deleted": True,
        }
