"""Supabase GoTrue admin client — invite and delete users (server-only).

Uses the SERVICE-ROLE key, which must never reach the browser. Only the admin API
routes call this module. Network failures and non-2xx responses raise SupabaseAdminError;
the secret is never included in the error text.
"""

from __future__ import annotations

import httpx

from .config import get_settings

_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)


class SupabaseAdminError(Exception):
    """Misconfiguration, network failure, or non-2xx GoTrue admin response."""


def _base_and_headers() -> tuple[str, dict]:
    s = get_settings()
    if not s.supabase_url or not s.supabase_service_role_key:
        raise SupabaseAdminError(
            "Supabase admin not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)."
        )
    base = s.supabase_url.rstrip("/") + "/auth/v1"
    key = s.supabase_service_role_key
    return base, {"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"}


def _request(method: str, path: str, *, json: dict | None, client: httpx.Client | None) -> httpx.Response:
    base, headers = _base_and_headers()
    url = base + path
    owns = client is None
    client = client or httpx.Client(timeout=_TIMEOUT)
    try:
        resp = client.request(method, url, json=json, headers=headers)
    except httpx.HTTPError as exc:
        raise SupabaseAdminError(f"Supabase admin request failed: {type(exc).__name__}") from exc
    finally:
        if owns:
            client.close()
    if resp.status_code >= 300:
        # Surface GoTrue's message but never the key.
        raise SupabaseAdminError(f"Supabase admin {method} {path} -> {resp.status_code}: {resp.text}")
    return resp


def invite_user(email: str, *, client: httpx.Client | None = None) -> dict:
    """Send a Supabase invite email; returns {'id', 'email'} of the created/known user."""
    resp = _request("POST", "/invite", json={"email": email}, client=client)
    data = resp.json()
    return {"id": data.get("id"), "email": data.get("email", email)}


def delete_user(supabase_user_id: str, *, client: httpx.Client | None = None) -> None:
    """Permanently delete a Supabase auth user (GoTrue admin)."""
    _request("DELETE", f"/admin/users/{supabase_user_id}", json=None, client=client)
