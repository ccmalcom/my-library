"""Configuration and shared paths.

Everything that touches the filesystem or environment funnels through here so the
CLI, the API, and the tests all agree on where data lives.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the project root (one level above this package) if present.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_PROJECT_ROOT / ".env")

# Owner id for all data in local single-user mode (no Supabase auth configured). In hosted
# multi-tenant mode this is replaced per-request by the JWT `sub`. Canonical definition lives
# here (the root of the import graph) so db.py and auth.py share it without an import cycle.
LOCAL_USER_ID = "local"

DEFAULT_MODEL = "claude-sonnet-4-6"
# Default catalog request rate. ~3/s was very gentle; 8/s is faster and, in practice,
# does not provoke 429s from Open Library / Google Books. Tune via MYLIBRARY_REQ_PER_SEC
# or `enrich --rps`; the enrich summary's http block flags any rate-limiting.
DEFAULT_REQ_PER_SEC = 8.0


@dataclass(frozen=True)
class Settings:
    project_root: Path
    data_dir: Path
    cache_dir: Path
    db_path: Path
    csv_path: Path
    anthropic_api_key: str | None
    google_books_api_key: str | None
    model: str
    requests_per_second: float

    # --- web distribution (multi-tenant hosting) ---------------------------
    # All optional: unset == local single-user SQLite mode, exactly as before.
    # Set in the deployment environment (Supabase/Railway), never committed.
    database_url: str | None  # full Postgres URL; when set, overrides the SQLite default
    # Supabase auth. New projects sign access tokens with ES256 (asymmetric) and publish the
    # PUBLIC key at a JWKS endpoint — the backend verifies against that, no shared secret.
    # `supabase_url` is the project URL (JWKS URL derived from it); `supabase_jwks_url`
    # overrides; `supabase_jwt_secret` is the legacy HS256 fallback.
    supabase_url: str | None
    supabase_jwks_url: str | None
    supabase_jwt_secret: str | None  # legacy HS256 fallback (older Supabase projects)
    encryption_key: str | None  # base64 32-byte key for AES-256-GCM of per-user API keys

    @property
    def db_url(self) -> str:
        # Hosted Postgres when DATABASE_URL is provided; otherwise the local SQLite file.
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.db_path}"

    @property
    def is_multi_tenant(self) -> bool:
        """True when running against a hosted Postgres DB (web-distribution mode)."""
        return bool(self.database_url)

    @property
    def jwks_url(self) -> str | None:
        """JWKS endpoint for verifying ES256 access tokens (derived from supabase_url)."""
        if self.supabase_jwks_url:
            return self.supabase_jwks_url
        if self.supabase_url:
            return self.supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"
        return None

    @property
    def auth_enabled(self) -> bool:
        """True when any Supabase auth verification is configured (JWKS or HS256 secret)."""
        return bool(self.jwks_url or self.supabase_jwt_secret)


def _resolve_data_dir() -> Path:
    raw = os.getenv("MYLIBRARY_DATA_DIR")
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (_PROJECT_ROOT / p)
    return _PROJECT_ROOT / "data"


def get_settings() -> Settings:
    data_dir = _resolve_data_dir()
    cache_dir = data_dir / "cache"
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        project_root=_PROJECT_ROOT,
        data_dir=data_dir,
        cache_dir=cache_dir,
        db_path=data_dir / "mylibrary.db",
        csv_path=data_dir / "goodreads_library_export.csv",
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY"),
        google_books_api_key=os.getenv("GOOGLE_BOOKS_API_KEY"),
        model=os.getenv("MYLIBRARY_MODEL", DEFAULT_MODEL),
        requests_per_second=float(
            os.getenv("MYLIBRARY_REQ_PER_SEC", DEFAULT_REQ_PER_SEC)
        ),
        database_url=os.getenv("DATABASE_URL"),
        supabase_url=os.getenv("SUPABASE_URL"),
        supabase_jwks_url=os.getenv("SUPABASE_JWKS_URL"),
        supabase_jwt_secret=os.getenv("SUPABASE_JWT_SECRET"),
        encryption_key=os.getenv("ENCRYPTION_KEY"),
    )
