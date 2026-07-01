"""Auth — verify Supabase-issued JWTs and extract the per-request user_id.

Supabase (this project) signs access tokens with **ES256** (ECDSA P-256, asymmetric): a
private key signs, and the matching PUBLIC key — published at the project's JWKS endpoint —
verifies. The backend therefore holds no shared secret; it fetches the public key from JWKS
(cached, auto-refreshed when Supabase rotates keys) and verifies the signature.

Modes:
- **Local single-user** (no Supabase auth configured) → auth is disabled and `resolve_user_id`
  returns `LOCAL_USER_ID`, so the CLI, tests, and an unconfigured API keep working unchanged.
- **Hosted** (SUPABASE_URL / SUPABASE_JWKS_URL set) → every request must carry a valid
  `Authorization: Bearer <access token>`; the verified `sub` claim becomes `user_id`.

A legacy **HS256** path (shared `SUPABASE_JWT_SECRET`) is kept as a fallback for older
projects, used only when no JWKS URL is configured.
"""

from __future__ import annotations

from typing import Annotated

from .config import LOCAL_USER_ID, get_settings

# Re-exported from config (canonical definition there) so existing `from .auth import
# LOCAL_USER_ID` imports keep working. Sentinel owner for all rows in local (no-auth) mode.
__all__ = ["LOCAL_USER_ID", "AuthError", "resolve_user_id", "resolve_claims", "current_user_id"]

_SUPABASE_AUDIENCE = "authenticated"

# One PyJWKClient per JWKS URL (it caches the fetched keys + refreshes on rotation).
_jwks_clients: dict = {}


class AuthError(Exception):
    """Raised when a token is missing or fails verification (hosted mode)."""


def _jwks_client(jwks_url: str):
    client = _jwks_clients.get(jwks_url)
    if client is None:
        from jwt import PyJWKClient  # pyjwt[crypto]; imported lazily for local mode

        client = PyJWKClient(jwks_url)
        _jwks_clients[jwks_url] = client
    return client


def _verify_es256(token: str, jwks_url: str) -> dict:
    """Verify an ES256 Supabase token against the project JWKS; return its claims."""
    import jwt

    try:
        signing_key = _jwks_client(jwks_url).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience=_SUPABASE_AUDIENCE,
            leeway=10,  # small clock-skew tolerance
        )
    except jwt.PyJWTError as exc:  # expired, bad signature, wrong audience, no matching kid…
        raise AuthError(f"invalid token: {exc}") from exc
    return claims


def _verify_hs256(token: str, secret: str) -> dict:
    """Legacy fallback: verify an HS256 Supabase token with the shared secret; return claims."""
    import jwt

    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=_SUPABASE_AUDIENCE,
            leeway=10,
        )
    except jwt.PyJWTError as exc:
        raise AuthError(f"invalid token: {exc}") from exc
    return claims


def _require_sub(claims: dict) -> str:
    sub = claims.get("sub")
    if not sub:
        raise AuthError("token has no sub claim")
    return str(sub)


def resolve_claims(authorization_header: str | None) -> dict:
    """Verified JWT claims for the request. Framework-agnostic (unit-testable).

    Local mode (no Supabase auth configured): returns the local sentinel claims,
    ignoring the header. Hosted mode: verifies the bearer token (ES256 via JWKS, else
    HS256) and returns the decoded claims (includes `sub` and, for Supabase, `email`).
    """
    settings = get_settings()
    if not settings.auth_enabled:
        return {"sub": LOCAL_USER_ID, "email": None}

    if not authorization_header or not authorization_header.lower().startswith("bearer "):
        raise AuthError("missing bearer token")
    token = authorization_header.split(" ", 1)[1].strip()

    jwks_url = settings.jwks_url
    claims = _verify_es256(token, jwks_url) if jwks_url else _verify_hs256(token, settings.supabase_jwt_secret)
    _require_sub(claims)  # raise if no sub
    return claims


def resolve_user_id(authorization_header: str | None) -> str:
    """The user_id (`sub`) for the request. Behavior unchanged from before."""
    return _require_sub(resolve_claims(authorization_header))


# --- FastAPI dependency ----------------------------------------------------
# `api.py` defines its own `current_user` dependency (using Header) wired onto every route;
# this convenience mirror is kept for non-route callers and tests.


def current_user_id(authorization: Annotated[str | None, "Authorization header"] = None) -> str:
    """Resolve the user_id from an Authorization header, raising HTTP 401 on failure."""
    from fastapi import HTTPException

    try:
        return resolve_user_id(authorization)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
