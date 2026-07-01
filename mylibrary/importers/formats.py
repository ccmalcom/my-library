"""Per-format parsers, format detection, and the import orchestrator.

Each parser turns raw CSV text into a ParsedImport (canonical rows + counts). detect_format
sniffs a header row. import_text ties parse -> import_rows together for the API/CLI.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass

from .core import (
    ImportRow,
    clean_isbn,
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


# parse_canonical / parse_generic / suggest_mapping / import_text are added in Task A4.
