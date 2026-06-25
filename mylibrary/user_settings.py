"""Per-user settings — the bring-your-own Anthropic key write/read path (Phase 3).

The key is encrypted at rest (`crypto.encrypt`) and only ever decrypted server-side here at
call time; it is never returned to the client. `resolve_anthropic_key` is the single place
profile/recommend ask "what key do I use for this user?":

- hosted multi-tenant mode → the user's stored, decrypted key;
- local single-user mode (or any user with no stored key) → the `ANTHROPIC_API_KEY` env var,
  so the CLI and existing local flow keep working unchanged.
"""

from __future__ import annotations

from . import crypto
from .config import LOCAL_USER_ID, get_settings
from .db import UserSettings, init_db, session_scope, utcnow


def set_anthropic_key(raw_key: str, *, user_id: str = LOCAL_USER_ID) -> None:
    """Encrypt and upsert `user_id`'s Anthropic key. Empty/blank input is rejected."""
    raw_key = (raw_key or "").strip()
    if not raw_key:
        raise ValueError("API key must not be empty.")

    init_db()
    encrypted = crypto.encrypt(raw_key)
    with session_scope() as session:
        row = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user_id)
            .one_or_none()
        )
        if row is None:
            session.add(
                UserSettings(user_id=user_id, anthropic_api_key_encrypted=encrypted)
            )
        else:
            row.anthropic_api_key_encrypted = encrypted
            row.updated_at = utcnow()


def clear_anthropic_key(*, user_id: str = LOCAL_USER_ID) -> None:
    """Remove `user_id`'s stored key (reverts to env fallback / unconfigured)."""
    init_db()
    with session_scope() as session:
        row = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user_id)
            .one_or_none()
        )
        if row is not None:
            row.anthropic_api_key_encrypted = None
            row.updated_at = utcnow()


def anthropic_key_status(*, user_id: str = LOCAL_USER_ID) -> dict:
    """Whether a key is available for this user (stored key OR env fallback). Never the key."""
    return {"configured": resolve_anthropic_key(user_id) is not None}


def get_display_name(*, user_id: str = LOCAL_USER_ID) -> str | None:
    """Return the display name stored for this user, or None if unset."""
    init_db()
    with session_scope() as session:
        row = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user_id)
            .one_or_none()
        )
        return row.display_name if row is not None else None


def set_display_name(name: str, *, user_id: str = LOCAL_USER_ID) -> None:
    """Upsert the display name for this user. Empty/blank input is rejected."""
    name = (name or "").strip()
    if not name:
        raise ValueError("Display name must not be empty.")

    init_db()
    with session_scope() as session:
        row = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user_id)
            .one_or_none()
        )
        if row is None:
            session.add(UserSettings(user_id=user_id, display_name=name))
        else:
            row.display_name = name
            row.updated_at = utcnow()


def resolve_anthropic_key(user_id: str = LOCAL_USER_ID) -> str | None:
    """The Anthropic key to use for `user_id`: their stored key, else the env fallback.

    Returns None when neither is set (callers raise a configure-your-key error).
    """
    init_db()
    with session_scope() as session:
        row = (
            session.query(UserSettings)
            .filter(UserSettings.user_id == user_id)
            .one_or_none()
        )
        if row is not None and row.anthropic_api_key_encrypted:
            return crypto.decrypt(row.anthropic_api_key_encrypted)
    # Local/dev fallback: the process-wide env key (also what the CLI uses).
    return get_settings().anthropic_api_key
