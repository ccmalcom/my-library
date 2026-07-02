"""Per-format parsers, format detection, and the import orchestrator.

Each parser turns raw CSV text into a ParsedImport (canonical rows + counts). detect_format
sniffs a header row. import_text ties parse -> import_rows together for the API/CLI.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass

from ..config import LOCAL_USER_ID
from .core import (
    ImportRow,
    clean_isbn,
    import_rows,
    normalize_shelf,
    parse_date,
    parse_int,
    parse_rating,
)

SOURCE_FOR = {
    "goodreads": "goodreads_import",
    "storygraph": "storygraph_import",
    "canonical": "canonical_import",
    "generic": "csv_import",
}

MAPPING_FIELDS = ["title", "author", "isbn13", "rating", "review", "shelf", "date_read"]

CANONICAL_FIELDS = [
    "title", "author", "additional_authors", "isbn13", "shelf", "rating",
    "review", "date_read", "date_added", "page_count", "year_published",
]


@dataclass
class ParsedImport:
    rows: list[ImportRow]
    total_rows: int
    skipped: int
    format: str


def _reader(text: str) -> csv.DictReader:
    # utf-8-sig handling is done by the caller (bytes decoded as utf-8-sig).
    return csv.DictReader(io.StringIO(text))


def csv_headers(text: str) -> list[str]:
    """Public helper: the header row of a CSV, for the import-preview API."""
    return list(_reader(text).fieldnames or [])


def sample_rows(text: str, n: int = 5) -> list[dict[str, str]]:
    """Public helper: the first n data rows of a CSV as plain dicts (empty string for
    missing/None cells), for the import-preview API."""
    out: list[dict[str, str]] = []
    for i, row in enumerate(_reader(text)):
        if i >= n:
            break
        out.append({k: (v or "") for k, v in row.items()})
    return out


def _first_author(raw: str | None) -> tuple[str | None, str | None]:
    """Split a possibly multi-author string -> (primary, additional-joined)."""
    if not raw:
        return None, None
    parts = [p.strip() for p in raw.replace(" and ", ", ").split(",") if p.strip()]
    if not parts:
        return None, None
    return parts[0], (", ".join(parts[1:]) or None)


def parse_goodreads(text: str) -> ParsedImport:
    rows: list[ImportRow] = []
    total = skipped = 0
    for row in _reader(text):
        total += 1
        title = (row.get("Title") or "").strip()
        if not title:
            skipped += 1
            continue
        rating = parse_int(row.get("My Rating")) or 0
        rows.append(
            ImportRow(
                title=title,
                author=(row.get("Author") or "").strip() or None,
                additional_authors=(row.get("Additional Authors") or "").strip() or None,
                isbn13=clean_isbn(row.get("ISBN13")) or clean_isbn(row.get("ISBN")),
                shelf=(row.get("Exclusive Shelf") or "").strip() or None,
                rating=rating or None,
                # Goodreads "My Review" is intentionally NOT seeded here — preserves legacy
                # behavior and existing tests. Non-Goodreads sources seed reviews instead.
                review=None,
                date_read=parse_date(row.get("Date Read")),
                date_added=parse_date(row.get("Date Added")),
                page_count=parse_int(row.get("Number of Pages")),
                year_published=parse_int(row.get("Original Publication Year"))
                or parse_int(row.get("Year Published")),
                external_id=(row.get("Book Id") or "").strip() or None,
            )
        )
    return ParsedImport(rows=rows, total_rows=total, skipped=skipped, format="goodreads")


def _isbn13_only(raw: str | None) -> str | None:
    """StoryGraph's ISBN/UID column may hold an internal UID. Keep only a 13-digit ISBN."""
    s = clean_isbn(raw)
    if s and len(s) == 13 and s.isdigit():
        return s
    return None


def parse_storygraph(text: str) -> ParsedImport:
    rows: list[ImportRow] = []
    total = skipped = 0
    for row in _reader(text):
        total += 1
        title = (row.get("Title") or "").strip()
        if not title:
            skipped += 1
            continue
        primary, extra = _first_author(row.get("Authors"))
        contributors = (row.get("Contributors") or "").strip() or None
        additional = ", ".join(x for x in (extra, contributors) if x) or None
        rows.append(
            ImportRow(
                title=title,
                author=primary,
                additional_authors=additional,
                isbn13=_isbn13_only(row.get("ISBN/UID")),
                shelf=normalize_shelf(row.get("Read Status")),
                rating=parse_rating(row.get("Star Rating")),
                review=(row.get("Review") or "").strip() or None,
                date_read=parse_date(row.get("Last Date Read")),
                date_added=parse_date(row.get("Date Added")),
            )
        )
    return ParsedImport(rows=rows, total_rows=total, skipped=skipped, format="storygraph")


def detect_format(headers: list[str]) -> str:
    hset = {h.strip() for h in headers}
    lower = {h.strip().lower() for h in headers}
    if "Book Id" in hset and "Exclusive Shelf" in hset:
        return "goodreads"
    if "Read Status" in hset and "Star Rating" in hset:
        return "storygraph"
    if {"title", "shelf", "rating"} <= lower:
        return "canonical"
    return "unknown"


def parse_canonical(text: str) -> ParsedImport:
    rows: list[ImportRow] = []
    total = skipped = 0
    for row in _reader(text):
        total += 1
        title = (row.get("title") or "").strip()
        if not title:
            skipped += 1
            continue
        rows.append(
            ImportRow(
                title=title,
                author=(row.get("author") or "").strip() or None,
                additional_authors=(row.get("additional_authors") or "").strip() or None,
                isbn13=clean_isbn(row.get("isbn13")),
                shelf=normalize_shelf(row.get("shelf")),
                rating=parse_rating(row.get("rating")),
                review=(row.get("review") or "").strip() or None,
                date_read=parse_date(row.get("date_read")),
                date_added=parse_date(row.get("date_added")),
                page_count=parse_int(row.get("page_count")),
                year_published=parse_int(row.get("year_published")),
            )
        )
    return ParsedImport(rows=rows, total_rows=total, skipped=skipped, format="canonical")


# Header keywords used to auto-suggest a generic mapping (checked as case-insensitive substrings).
_SUGGEST_HINTS = {
    "title": ("title", "book"),
    "author": ("author", "writer", "by"),
    "isbn13": ("isbn",),
    "rating": ("rating", "stars", "star", "score"),
    "review": ("review", "notes", "comment"),
    "shelf": ("shelf", "status", "read status", "bookshelf"),
    "date_read": ("date read", "read date", "finished"),
}


def suggest_mapping(headers: list[str]) -> dict[str, str | None]:
    out: dict[str, str | None] = {f: None for f in MAPPING_FIELDS}
    for field, hints in _SUGGEST_HINTS.items():
        for h in headers:
            hl = h.strip().lower()
            if any(hint in hl for hint in hints):
                out[field] = h
                break
    return out


def parse_generic(text: str, mapping: dict[str, str]) -> ParsedImport:
    title_col = mapping.get("title")
    if not title_col:
        raise ValueError("A 'title' column mapping is required.")
    rows: list[ImportRow] = []
    total = skipped = 0
    for row in _reader(text):
        total += 1
        title = (row.get(title_col) or "").strip()
        if not title:
            skipped += 1
            continue

        def cell(field: str, row=row) -> str | None:
            col = mapping.get(field)
            return row.get(col) if col else None

        rows.append(
            ImportRow(
                title=title,
                author=(cell("author") or "").strip() or None,
                isbn13=clean_isbn(cell("isbn13")),
                shelf=normalize_shelf(cell("shelf")),
                rating=parse_rating(cell("rating")),
                review=(cell("review") or "").strip() or None,
                date_read=parse_date(cell("date_read")),
            )
        )
    return ParsedImport(rows=rows, total_rows=total, skipped=skipped, format="generic")


_PARSERS = {
    "goodreads": parse_goodreads,
    "storygraph": parse_storygraph,
    "canonical": parse_canonical,
}


def import_text(
    text: str,
    *,
    fmt: str,
    mapping: dict[str, str] | None = None,
    user_id: str = LOCAL_USER_ID,
) -> dict:
    if fmt == "auto":
        fmt = detect_format(_reader(text).fieldnames or [])
        if fmt == "unknown":
            raise ValueError(
                "Could not detect the file format. Provide a column mapping (generic import)."
            )
    if fmt == "generic":
        parsed = parse_generic(text, mapping or {})
    else:
        parser = _PARSERS.get(fmt)
        if parser is None:
            raise ValueError(f"Unknown format: {fmt}")
        parsed = parser(text)
    counts = import_rows(parsed.rows, user_id=user_id, source=SOURCE_FOR[parsed.format])
    return {
        "format": parsed.format,
        "total_rows": parsed.total_rows,
        "skipped": parsed.skipped,
        "inserted": counts["inserted"],
        "updated": counts["updated"],
        "rated": counts["rated"],
    }
