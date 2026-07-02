"""Admin gating — who may call the /admin endpoints.

An admin is any caller whose verified JWT `email` is in the `ADMIN_EMAILS` allowlist.
In local single-user mode (no Supabase auth configured) the unauthenticated local user
is treated as admin so the dev box and tests can reach the admin surface.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException

from .auth import AuthError, resolve_claims
from .config import LOCAL_USER_ID, get_settings


def is_admin(authorization_header: str | None) -> bool:
    """True when the request comes from an admin (local dev user, or allowlisted email)."""
    settings = get_settings()
    if not settings.auth_enabled:
        return True  # local single-user dev box
    try:
        claims = resolve_claims(authorization_header)
    except AuthError:
        return False
    return settings.is_admin_email(claims.get("email"))


def require_admin(authorization: Annotated[str | None, Header()] = None) -> str:
    """FastAPI dependency: allow only admins. Returns the admin's user_id (sub)."""
    settings = get_settings()
    if not settings.auth_enabled:
        return LOCAL_USER_ID
    try:
        claims = resolve_claims(authorization)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if not settings.is_admin_email(claims.get("email")):
        raise HTTPException(status_code=403, detail="Admin access required")
    return str(claims["sub"])


AdminId = Annotated[str, Depends(require_admin)]
