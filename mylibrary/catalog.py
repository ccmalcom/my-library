"""Live-catalog clients: Open Library + Google Books.

Responsibilities:
  - Fetch book metadata by ISBN or by title+author search.
  - Cache every raw HTTP response to disk (keyed by URL hash) so re-runs never
    re-hit the network — enrichment is meant to be idempotent and rate-friendly.
  - Throttle and retry with backoff on 429 / 5xx.

This module returns *raw* payloads and small normalized candidate dicts. The
confidence scoring and persistence live in enrich.py.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

import httpx

from .config import get_settings

_USER_AGENT = "MyLibrary/0.1 (personal book-analysis project)"
_TIMEOUT = 20.0
_THROTTLE_SECONDS = 0.34  # be polite to free APIs (~3 req/s)
_MAX_RETRIES = 3

_last_call_at = 0.0


def _cache_path(url: str) -> Path:
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return get_settings().cache_dir / f"{key}.json"


def _throttle() -> None:
    global _last_call_at
    elapsed = time.monotonic() - _last_call_at
    if elapsed < _THROTTLE_SECONDS:
        time.sleep(_THROTTLE_SECONDS - elapsed)
    _last_call_at = time.monotonic()


def _get_json(url: str, *, use_cache: bool = True) -> Any | None:
    """GET a URL returning JSON, with disk cache + retry/backoff.

    Returns parsed JSON, or None on a clean 404 / empty result.
    """
    cache_file = _cache_path(url)
    if use_cache and cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass  # corrupt cache entry; refetch

    backoff = 1.0
    for attempt in range(1, _MAX_RETRIES + 1):
        _throttle()
        try:
            resp = httpx.get(
                url, headers={"User-Agent": _USER_AGENT}, timeout=_TIMEOUT
            )
        except httpx.HTTPError:
            if attempt == _MAX_RETRIES:
                return None
            time.sleep(backoff)
            backoff *= 2
            continue

        if resp.status_code == 404:
            cache_file.write_text("null", encoding="utf-8")
            return None
        if resp.status_code in (429, 500, 502, 503, 504):
            if attempt == _MAX_RETRIES:
                return None
            time.sleep(backoff)
            backoff *= 2
            continue

        try:
            data = resp.json()
        except json.JSONDecodeError:
            return None
        cache_file.write_text(json.dumps(data), encoding="utf-8")
        return data

    return None


# --- Open Library ----------------------------------------------------------


def openlibrary_by_isbn(isbn: str) -> dict | None:
    """Return a normalized record from the OL Books API, or None."""
    url = (
        f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}"
        "&jscmd=data&format=json"
    )
    data = _get_json(url)
    if not data:
        return None
    record = data.get(f"ISBN:{isbn}")
    if not record:
        return None
    return {
        "source": "openlibrary",
        "resolved_id": record.get("key"),
        "title": record.get("title"),
        "subjects": [s.get("name") for s in record.get("subjects", []) if s.get("name")],
        "cover_url": (record.get("cover") or {}).get("medium"),
        "description": _ol_description(record),
        "raw": {"isbn": isbn, "record": record},
    }


def _ol_description(record: dict) -> str | None:
    desc = record.get("description") or record.get("notes")
    if isinstance(desc, dict):
        return desc.get("value")
    return desc if isinstance(desc, str) else None


def openlibrary_search(title: str, author: str | None) -> list[dict]:
    """Return up to 5 candidate docs for a title (+ optional author)."""
    params = httpx.QueryParams({"title": title, "limit": "5"})
    if author:
        params = params.set("author", author)
    url = f"https://openlibrary.org/search.json?{params}"
    data = _get_json(url)
    if not data:
        return []
    candidates = []
    for doc in data.get("docs", [])[:5]:
        cover_id = doc.get("cover_i")
        candidates.append(
            {
                "source": "openlibrary",
                "resolved_id": doc.get("key"),
                "title": doc.get("title"),
                "author": (doc.get("author_name") or [None])[0],
                "subjects": (doc.get("subject") or [])[:25],
                "cover_url": (
                    f"https://covers.openlibrary.org/b/id/{cover_id}-M.jpg"
                    if cover_id
                    else None
                ),
                "year": doc.get("first_publish_year"),
                "raw": doc,
            }
        )
    return candidates


# --- Google Books ----------------------------------------------------------


def _google_books_query(q: str) -> list[dict]:
    settings = get_settings()
    params = httpx.QueryParams({"q": q, "maxResults": "5"})
    if settings.google_books_api_key:
        params = params.set("key", settings.google_books_api_key)
    url = f"https://www.googleapis.com/books/v1/volumes?{params}"
    data = _get_json(url)
    if not data:
        return []
    candidates = []
    for item in data.get("items", [])[:5]:
        info = item.get("volumeInfo", {})
        candidates.append(
            {
                "source": "googlebooks",
                "resolved_id": item.get("id"),
                "title": info.get("title"),
                "author": (info.get("authors") or [None])[0],
                "subjects": info.get("categories") or [],
                "description": info.get("description"),
                "cover_url": (info.get("imageLinks") or {}).get("thumbnail"),
                "year": _year_from_google(info.get("publishedDate")),
                "raw": item,
            }
        )
    return candidates


def _year_from_google(published: str | None) -> int | None:
    if not published:
        return None
    try:
        return int(published[:4])
    except ValueError:
        return None


def googlebooks_by_isbn(isbn: str) -> dict | None:
    candidates = _google_books_query(f"isbn:{isbn}")
    return candidates[0] if candidates else None


def googlebooks_search(title: str, author: str | None) -> list[dict]:
    q = f'intitle:"{title}"'
    if author:
        q += f' inauthor:"{author}"'
    return _google_books_query(q)
