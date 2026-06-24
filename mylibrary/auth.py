"""Auth — verify Supabase-issued JWTs and extract the per-request user_id.

Web-distribution scaffold (Phase 1). This is the seam every protected route will
depend on once multi-tenancy lands. It is intentionally self-contained:

- **Local single-user mode** (no `SUPABASE_JWT_SECRET` configured) → auth is disabled and
  `current_user_id` returns the synthetic `LOCAL_USER_ID`. This keeps the existing CLI/API
  and the test suite working unchanged while the rest of the migration is built out.
- **Hosted mode** (secret configured) → every request must carry a valid
  `Authorization: Bearer <supabase access token>`; the `sub` claim becomes `user_id`.

NOT YET WIRED: routes in `api.py` don't depend on this yet, and the DB tables don't have a
`user_id` column yet (Phase 2). Wiring is the next step — see mylibrary-web-distribution-plan.md.
"""

from __future__ import annotations

from typing import Annotated

from .config import LOCAL_USER_ID, get_settings

# Re-exported from config (canonical definition there) so existing `from .auth import
# LOCAL_USER_ID` imports keep working. Sentinel owner for all rows in local (no-auth) mode.
__all__ = ["LOCAL_USER_ID", "AuthError", "resolve_user_id", "current_user_id"]


class AuthError(Exception):
    """Raised when a token is missing or fails verification (hosted mode)."""


def _verify_supabase_jwt(token: str, secret: str) -> str:
    """Verify a Supabase access token (HS256) and return its `sub` (the user_id).

    Supabase signs access tokens with the project JWT secret using HS256 and sets
    `aud="authenticated"`. Raises AuthError on any problem.
    """
    import jwt  # pyjwt — imported lazily so local mode needs no crypto deps installed

    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.PyJWTError as exc:  # expired, bad signature, wrong audience, etc.
        raise AuthError(f"invalid token: {exc}") from exc

    sub = claims.get("sub")
    if not sub:
        raise AuthError("token has no sub claim")
    return str(sub)


def resolve_user_id(authorization_header: str | None) -> str:
    """Core resolver, framework-agnostic so it's unit-testable without a request.

    Returns the user_id. In local mode (no secret configured) this is always
    LOCAL_USER_ID and the header is ignored.
    """
    settings = get_settings()
    secret = settings.supabase_jwt_secret
    if not secret:
        return LOCAL_USER_ID

    if not authorization_header or not authorization_header.lower().startswith("bearer "):
        raise AuthError("missing bearer token")
    token = authorization_header.split(" ", 1)[1].strip()
    return _verify_supabase_jwt(token, secret)


# --- FastAPI dependency ----------------------------------------------------
# Kept import-light: FastAPI is only imported here, so non-web callers (CLI, tests)
# can import resolve_user_id without pulling in the web stack.


def current_user_id(authorization: Annotated[str | None, "Authorization header"] = None) -> str:
    """FastAPI dependency. Use as: `user_id: str = Depends(current_user_id)`.

    TODO(phase-1): replace the bare annotation with `fastapi.Header(None)` and map
    AuthError → HTTPException(401) once routes start depending on this.
    """
    from fastapi import Header, HTTPException  # local import keeps module web-optional

    # NOTE: when wired, the signature becomes
    #   authorization: str | None = Header(default=None)
    # This stub keeps the logic; the Depends wiring is added during route protection.
    _ = Header  # referenced to document intended usage
    try:
        return resolve_user_id(authorization)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
