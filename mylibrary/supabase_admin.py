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
        # Surface a short GoTrue message but never echo arbitrary response bodies
        # (which could contain PII) or the key.
        msg = None
        try:
            data = resp.json()
            msg = data.get("msg") or data.get("message")
        except Exception:
            msg = None
        detail = f": {msg}" if msg else ""
        raise SupabaseAdminError(f"Supabase admin {method} {path} -> {resp.status_code}{detail}")
    return resp


def invite_user(email: str, *, client: httpx.Client | None = None) -> dict:
    """Send a Supabase invite email; returns {'id', 'email'} of the created/known user."""
    resp = _request("POST", "/invite", json={"email": email}, client=client)
    data = resp.json()
    return {"id": data.get("id"), "email": data.get("email", email)}


def delete_user(supabase_user_id: str, *, client: httpx.Client | None = None) -> None:
    """Permanently delete a Supabase auth user (GoTrue admin)."""
    _request("DELETE", f"/admin/users/{supabase_user_id}", json=None, client=client)


def list_users(*, client: httpx.Client | None = None) -> list[dict]:
    """All Supabase auth users (GoTrue admin), paginated. Returns [{'id', 'email'}, ...].

    Used to reconcile users created outside the app's invite flow (e.g. added directly
    in the Supabase dashboard) with the local `invites` roster.
    """
    owns = client is None
    client = client or httpx.Client(timeout=_TIMEOUT)
    try:
        users: list[dict] = []
        page = 1
        per_page = 200
        while True:
            resp = _request(
                "GET", f"/admin/users?page={page}&per_page={per_page}", json=None, client=client
            )
            data = resp.json()
            batch = data.get("users", [])
            users.extend({"id": u.get("id"), "email": u.get("email")} for u in batch)
            if len(batch) < per_page:
                break
            page += 1
        return users
    finally:
        if owns:
            client.close()
