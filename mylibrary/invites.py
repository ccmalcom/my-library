"""Invite lifecycle — the core the /admin API calls.

create_invite -> Supabase invite email + an `invites` row (status active).
revoke_user   -> delete the Supabase user + purge their app data + mark the row revoked.
list_roster   -> every invite, newest first, with a book_count for quick health-at-a-glance.
"""

from __future__ import annotations

from sqlalchemy import func

from .db import Book, Invite, session_scope, utcnow
from .purge import delete_account
from .supabase_admin import delete_user, invite_user


class InviteError(Exception):
    """A revoke target was not found, or another invite-flow precondition failed."""


def _invite_dict(row: Invite, *, book_count: int | None = None) -> dict:
    d = {
        "id": row.id,
        "email": row.email,
        "status": row.status,
        "supabase_user_id": row.supabase_user_id,
        "invited_by": row.invited_by,
        "created_at": row.created_at,
        "revoked_at": row.revoked_at,
    }
    if book_count is not None:
        d["book_count"] = book_count
    return d


def create_invite(email: str, *, invited_by: str) -> dict:
    """Invite *email* via Supabase and record an active invite row (idempotent on email)."""
    email = (email or "").strip().lower()
    if not email:
        raise InviteError("email must not be empty")

    result = invite_user(email)  # may raise SupabaseAdminError
    sb_id = result.get("id")

    with session_scope() as session:
        row = session.query(Invite).filter(Invite.email == email).one_or_none()
        if row is None:
            row = Invite(email=email, invited_by=invited_by)
            session.add(row)
        row.invited_by = invited_by
        row.supabase_user_id = sb_id
        row.status = "active"
        row.revoked_at = None
        session.flush()
        return _invite_dict(row)


def list_roster() -> list[dict]:
    """All invites, newest first, each annotated with the user's current book_count."""
    with session_scope() as session:
        rows = session.query(Invite).order_by(Invite.created_at.desc(), Invite.id.desc()).all()
        counts = dict(
            session.query(Book.user_id, func.count(Book.id)).group_by(Book.user_id).all()
        )
        return [
            _invite_dict(row, book_count=counts.get(row.supabase_user_id, 0))
            for row in rows
        ]


def revoke_user(*, supabase_user_id: str) -> dict:
    """Delete the Supabase user, purge their app data, and mark the invite revoked.

    Idempotent / retry-safe: if the row is already "revoked" (e.g. a previous
    call succeeded at delete_user but then delete_account raised), this skips
    delete_user entirely and goes straight to the purge, since the Supabase
    account is already confirmed gone and calling delete_user again would 404.
    """
    if not supabase_user_id:
        raise InviteError("supabase_user_id is required")

    with session_scope() as session:
        row = (
            session.query(Invite)
            .filter(Invite.supabase_user_id == supabase_user_id)
            .one_or_none()
        )
        if row is None:
            raise InviteError("invite not found for supabase_user_id")
        already_revoked = row.status == "revoked"

    if not already_revoked:
        delete_user(supabase_user_id)  # may raise SupabaseAdminError

        # Mark the row revoked now, before purging app data: the Supabase account is
        # already gone at this point, so a retry must never call delete_user again.
        # If delete_account below raises, the row must still read "revoked".
        with session_scope() as session:
            row = (
                session.query(Invite)
                .filter(Invite.supabase_user_id == supabase_user_id)
                .one_or_none()
            )
            if row is not None:
                row.status = "revoked"
                row.revoked_at = utcnow()

    delete_account(user_id=supabase_user_id)  # purge.delete_account: books, profile, key, etc.

    return {"supabase_user_id": supabase_user_id, "status": "revoked"}
