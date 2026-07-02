"""Phase 1 — Ingest. Goodreads CSV -> books table, idempotent.

Thin Goodreads-specific wrapper over the format-agnostic importer (mylibrary.importers).
Kept as the stable entry point for the CLI `ingest` command, POST /ingest[/upload], and the
existing test-suite. clean_isbn is re-exported so `from mylibrary.ingest import clean_isbn`
keeps working.
"""
from __future__ import annotations

from pathlib import Path

from .config import LOCAL_USER_ID
from .importers.core import clean_isbn, import_rows  # clean_isbn re-exported (back-compat)
from .importers.formats import parse_goodreads

__all__ = ["clean_isbn", "ingest_csv"]


def ingest_csv(csv_path: str | Path, *, user_id: str = LOCAL_USER_ID) -> dict:
    """Parse a Goodreads export and upsert into the books table for user_id.

    Returns {total_rows, inserted, updated, rated, skipped} — unchanged contract.
    """
    csv_path = Path(csv_path)
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Goodreads export not found at {csv_path}. "
            "Export from Goodreads > My Books > Import and export > Export Library, "
            "then drop the CSV into the data/ folder."
        )
    text = csv_path.read_text(encoding="utf-8-sig")
    parsed = parse_goodreads(text)
    counts = import_rows(parsed.rows, user_id=user_id, source="goodreads_import")
    return {
        "total_rows": parsed.total_rows,
        "inserted": counts["inserted"],
        "updated": counts["updated"],
        "rated": counts["rated"],
        "skipped": parsed.skipped,
    }
