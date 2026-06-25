"""Config tests — DATABASE_URL driver normalisation for the Postgres cutover.

The hosted DB is reached via ``DATABASE_URL``. Supabase hands out a bare ``postgresql://``
(or legacy ``postgres://``) string, but this project installs psycopg v3 only — so the URL
must be pinned to the ``+psycopg`` driver or the app fails at connect time with a missing
psycopg2. These tests lock that normalisation in.
"""

from __future__ import annotations

from mylibrary.config import get_settings


def _db_url_for(monkeypatch, url: str) -> str:
    monkeypatch.setenv("DATABASE_URL", url)
    return get_settings().db_url


def test_bare_postgresql_url_pinned_to_psycopg(monkeypatch):
    out = _db_url_for(monkeypatch, "postgresql://user:pw@host:5432/postgres")
    assert out == "postgresql+psycopg://user:pw@host:5432/postgres"


def test_legacy_postgres_scheme_normalised(monkeypatch):
    out = _db_url_for(monkeypatch, "postgres://user:pw@host:5432/postgres")
    assert out == "postgresql+psycopg://user:pw@host:5432/postgres"


def test_explicit_driver_left_untouched(monkeypatch):
    url = "postgresql+psycopg://user:pw@host:5432/postgres"
    assert _db_url_for(monkeypatch, url) == url


def test_query_params_preserved(monkeypatch):
    out = _db_url_for(monkeypatch, "postgresql://u:p@host:5432/postgres?sslmode=require")
    assert out == "postgresql+psycopg://u:p@host:5432/postgres?sslmode=require"


def test_local_mode_falls_back_to_sqlite(monkeypatch):
    # conftest deletes DATABASE_URL; with it unset, db_url is the local SQLite file.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert get_settings().db_url.startswith("sqlite:///")
