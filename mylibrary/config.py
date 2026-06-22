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

DEFAULT_MODEL = "claude-sonnet-4-6"
# Default catalog request rate. ~3/s was very gentle; 6/s is a bit faster but still
# polite to the free APIs. Tune via MYLIBRARY_REQ_PER_SEC or `enrich --rps`.
DEFAULT_REQ_PER_SEC = 6.0


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

    @property
    def db_url(self) -> str:
        return f"sqlite:///{self.db_path}"


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
    )
