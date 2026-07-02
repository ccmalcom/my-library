import importlib

import pytest

import mylibrary.config as config
import mylibrary.auth as auth
import mylibrary.admin as admin


def _reload(monkeypatch, **env):
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    importlib.reload(config)
    importlib.reload(auth)
    importlib.reload(admin)


def test_local_mode_is_admin(monkeypatch):
    # No Supabase auth configured -> unauthenticated local user is admin (dev box).
    _reload(monkeypatch, SUPABASE_URL=None, SUPABASE_JWT_SECRET=None, ADMIN_EMAILS=None)
    assert auth.resolve_claims(None) == {"sub": "local", "email": None}
    assert admin.is_admin(None) is True


def test_hs256_admin_by_email(monkeypatch):
    import jwt
    _reload(
        monkeypatch,
        SUPABASE_URL=None,
        SUPABASE_JWKS_URL=None,
        SUPABASE_JWT_SECRET="testsecret",
        ADMIN_EMAILS="boss@x.io",
    )
    token = jwt.encode(
        {"sub": "u-1", "email": "boss@x.io", "aud": "authenticated"},
        "testsecret",
        algorithm="HS256",
    )
    hdr = f"Bearer {token}"
    assert auth.resolve_claims(hdr)["email"] == "boss@x.io"
    assert admin.is_admin(hdr) is True


def test_hs256_non_admin_email(monkeypatch):
    import jwt
    _reload(
        monkeypatch,
        SUPABASE_URL=None,
        SUPABASE_JWKS_URL=None,
        SUPABASE_JWT_SECRET="testsecret",
        ADMIN_EMAILS="boss@x.io",
    )
    token = jwt.encode(
        {"sub": "u-2", "email": "rando@x.io", "aud": "authenticated"},
        "testsecret",
        algorithm="HS256",
    )
    assert admin.is_admin(f"Bearer {token}") is False
