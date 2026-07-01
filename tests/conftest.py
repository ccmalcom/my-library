"""Test fixtures: isolate each test run to a throwaway data dir + fresh SQLite db."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

SAMPLE_CSV = Path(__file__).parent / "sample_goodreads.csv"


@pytest.fixture(scope="session", autouse=True)
def _disable_dotenv_for_tests():
    # mylibrary.config calls load_dotenv() at import time. Several tests
    # monkeypatch.delenv() a var (e.g. DATABASE_URL, SUPABASE_URL) and then
    # importlib.reload(config) to exercise env-driven branches -- but reload()
    # re-executes config.py's own `from dotenv import load_dotenv` + load_dotenv()
    # call, and python-dotenv repopulates any var that's currently unset from the
    # developer's real .env. That silently undoes the delenv and can point a test
    # at a real Postgres/Supabase project (a "DATABASE_URL" resurrection has been
    # observed to attempt a real INSERT). No-op load_dotenv for the whole session;
    # every test sets the env vars it needs explicitly via monkeypatch.setenv.
    import dotenv

    original = dotenv.load_dotenv
    dotenv.load_dotenv = lambda *a, **k: False
    yield
    dotenv.load_dotenv = original


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    # Point the engine at a temp data dir BEFORE it's created.
    monkeypatch.setenv("MYLIBRARY_DATA_DIR", str(tmp_path))

    # Force LOCAL single-user mode regardless of the developer's .env, so the suite is
    # hermetic: never run against hosted Postgres, never require an auth token. (Without
    # this, a .env with DATABASE_URL would point tests at production, and SUPABASE_URL
    # would make every TestClient request 401.) Tests that need these set them themselves.
    # REDIS_URL is also cleared so the FastAPI lifespan never tries to connect to the
    # production arq pool during tests -- it falls back to the BackgroundTask mode instead.
    for _var in (
        "DATABASE_URL",
        "SUPABASE_URL",
        "SUPABASE_JWKS_URL",
        "SUPABASE_JWT_SECRET",
        "ENCRYPTION_KEY",
        "REDIS_URL",
    ):
        monkeypatch.delenv(_var, raising=False)

    import mylibrary.db as db

    # Dispose before nulling so SQLite releases file handles. Without dispose(),
    # the prior test's TestClient lifespan thread can hold the engine alive long
    # enough that _ensure_engine() returns the stale engine instead of creating a
    # fresh one at the new tmp_path, causing state to leak between tests.
    if db._engine is not None:
        db._engine.dispose()
    db._engine = None
    db._SessionLocal = None
    db.init_db()
    yield
    if db._engine is not None:
        db._engine.dispose()
    db._engine = None
    db._SessionLocal = None
