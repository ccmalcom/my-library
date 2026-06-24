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
import re
import time
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .config import get_settings

_USER_AGENT = "MyLibrary/0.1 (personal book-analysis project)"
# Fail fast on a dead host (5s connect), but give slow-but-alive Open Library enough
# time to actually answer (15s read) so we don't self-inflict timeouts on valid responses.
_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)
_MAX_RETRIES = 2

_last_call_at = 0.0
# Per-request throttle in seconds. None = derive from settings on first use; can be
# overridden at runtime via set_rate() (e.g. the CLI's --rps flag).
_throttle_seconds: float | None = None


def set_rate(requests_per_second: float) -> None:
    """Override the request rate at runtime. <=0 disables throttling."""
    global _throttle_seconds
    _throttle_seconds = 1.0 / requests_per_second if requests_per_second > 0 else 0.0


def _current_throttle() -> float:
    global _throttle_seconds
    if _throttle_seconds is None:
        rps = get_settings().requests_per_second
        _throttle_seconds = 1.0 / rps if rps > 0 else 0.0
    return _throttle_seconds


# --- request stats (so the caller can see rate-limiting) -------------------

_stats: dict = {}


def reset_stats() -> None:
    global _stats
    _stats = {
        "requests": 0,
        "rate_limited": 0,  # 429s
        "server_errors": 0,  # 5xx
        "network_errors": 0,  # timeouts / connection failures
        "retries": 0,
        "by_host": defaultdict(lambda: {"requests": 0, "rate_limited": 0}),
    }


def get_stats() -> dict:
    """Return a plain (JSON-serializable) snapshot of request stats."""
    snap = {k: v for k, v in _stats.items() if k != "by_host"}
    snap["by_host"] = {h: dict(d) for h, d in _stats.get("by_host", {}).items()}
    return snap


reset_stats()


def _host(url: str) -> str:
    return urlsplit(url).netloc


def _cache_path(url: str) -> Path:
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return get_settings().cache_dir / f"{key}.json"


def _throttle() -> None:
    global _last_call_at
    throttle = _current_throttle()
    elapsed = time.monotonic() - _last_call_at
    if elapsed < throttle:
        time.sleep(throttle - elapsed)
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

    host = _host(url)
    host_stats = _stats["by_host"][host]
    backoff = 1.0
    for attempt in range(1, _MAX_RETRIES + 1):
        _throttle()
        _stats["requests"] += 1
        host_stats["requests"] += 1
        if attempt > 1:
            _stats["retries"] += 1
        try:
            resp = httpx.get(
                url, headers={"User-Agent": _USER_AGENT}, timeout=_TIMEOUT
            )
        except httpx.HTTPError:
            _stats["network_errors"] += 1
            if attempt == _MAX_RETRIES:
                return None
            time.sleep(backoff)
            backoff *= 2
            continue

        if resp.status_code == 404:
            cache_file.write_text("null", encoding="utf-8")
            return None
        if resp.status_code in (429, 500, 502, 503, 504):
            if resp.status_code == 429:
                _stats["rate_limited"] += 1
                host_stats["rate_limited"] += 1
            else:
                _stats["server_errors"] += 1
            if attempt == _MAX_RETRIES:
                return None
            # On a 429, prefer the server's Retry-After hint if present.
            retry_after = resp.headers.get("Retry-After")
            wait = float(retry_after) if (retry_after or "").isdigit() else backoff
            time.sleep(wait)
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


def openlibrary_query(query: str, *, max_results: int = 8) -> list[dict]:
    """Free-text Open Library search (the `q=` param), for user-facing add-a-book search.

    Unlike `openlibrary_search` (which keys on a title field for enrichment), this passes
    the raw query straight through, so "dune herbert" or an ISBN both work. Requests a
    trimmed `fields` set so the payload stays small, and surfaces an ISBN-13 when present.
    """
    query = (query or "").strip()
    if not query:
        return []
    params = httpx.QueryParams(
        {
            "q": query,
            "limit": str(max_results),
            "fields": "key,title,author_name,first_publish_year,cover_i,isbn,subject",
        }
    )
    url = f"https://openlibrary.org/search.json?{params}"
    data = _get_json(url)
    if not data:
        return []
    candidates = []
    for doc in data.get("docs", [])[:max_results]:
        cover_id = doc.get("cover_i")
        isbns = doc.get("isbn") or []
        isbn13 = next((i for i in isbns if len(i) == 13 and i.isdigit()), None)
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
                "isbn13": isbn13,
                "raw": doc,
            }
        )
    return candidates


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


def _google_books_query(q: str, *, max_results: int = 5) -> list[dict]:
    settings = get_settings()
    max_results = max(1, min(max_results, 40))  # Google Books caps maxResults at 40
    params = httpx.QueryParams({"q": q, "maxResults": str(max_results)})
    if settings.google_books_api_key:
        params = params.set("key", settings.google_books_api_key)
    url = f"https://www.googleapis.com/books/v1/volumes?{params}"
    data = _get_json(url)
    if not data:
        return []
    candidates = []
    for item in data.get("items", [])[:max_results]:
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


def _isbn13_from_google_item(item: dict) -> str | None:
    """Pull the ISBN-13 out of a Google Books volume's industryIdentifiers, if any."""
    info = (item or {}).get("volumeInfo", {})
    for ident in info.get("industryIdentifiers", []) or []:
        if ident.get("type") == "ISBN_13" and ident.get("identifier"):
            return ident["identifier"]
    return None


def googlebooks_by_isbn(isbn: str) -> dict | None:
    candidates = _google_books_query(f"isbn:{isbn}")
    return candidates[0] if candidates else None


def googlebooks_search(title: str, author: str | None) -> list[dict]:
    q = f'intitle:"{title}"'
    if author:
        q += f' inauthor:"{author}"'
    return _google_books_query(q)


# --- Discovery retrieval (Phase 5 recommender) -----------------------------
#
# Unlike the enrichment helpers above (which resolve a KNOWN book), these surface
# *new* candidates for the two-stage recommender. They return the same normalized
# candidate shape, so recommend.py can treat every source uniformly.


def googlebooks_query(q: str, *, max_results: int = 10) -> list[dict]:
    """Run an arbitrary Google Books query (used for Claude-seeded discovery)."""
    return _google_books_query(q, max_results=max_results)


def googlebooks_subject(subject: str, *, max_results: int = 10) -> list[dict]:
    return _google_books_query(f'subject:"{subject}"', max_results=max_results)


def googlebooks_author(author: str, *, max_results: int = 10) -> list[dict]:
    return _google_books_query(f'inauthor:"{author}"', max_results=max_results)


def _ol_subject_slug(subject: str) -> str:
    """Open Library's subjects API keys on lowercase, underscore-joined slugs."""
    slug = re.sub(r"[^a-z0-9]+", "_", subject.lower()).strip("_")
    return slug


def _dedup_key(title: str | None, author: str | None) -> tuple[str, str]:
    """Light normalize for de-duplicating search hits across sources.

    Kept inline (rather than importing enrich._normalize_title) to avoid a circular
    import — enrich imports catalog. Good enough for collapsing "Dune" from Google and
    Open Library into one row.
    """
    def norm(s: str | None) -> str:
        return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).strip()

    surname = norm(author).split(" ")[-1] if author else ""
    return norm(title).split(":")[0].strip(), surname


def search_books(query: str, *, max_results: int = 8) -> list[dict]:
    """User-facing book search for the manual add-a-book flow.

    Queries Google Books and Open Library with the same free-text string, normalizes both
    to the shared candidate shape (with an `isbn13`), de-duplicates across sources, and
    prefers hits that have a cover so the picker looks right. Network responses are cached
    by `_get_json`, so repeat searches are cheap.
    """
    query = (query or "").strip()
    if not query:
        return []

    results: list[dict] = []
    for cand in _google_books_query(query, max_results=max_results):
        cand["isbn13"] = _isbn13_from_google_item(cand.get("raw") or {})
        results.append(cand)
    results.extend(openlibrary_query(query, max_results=max_results))

    seen: set[tuple[str, str]] = set()
    deduped: list[dict] = []
    for cand in results:
        if not cand.get("title"):
            continue
        key = _dedup_key(cand.get("title"), cand.get("author"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(cand)

    # Stable-sort cover-bearing hits to the front without otherwise reordering.
    deduped.sort(key=lambda c: c.get("cover_url") is None)
    return deduped[:max_results]


def openlibrary_subject(subject: str, *, max_results: int = 10) -> list[dict]:
    """Return works filed under a subject via Open Library's subjects API."""
    slug = _ol_subject_slug(subject)
    if not slug:
        return []
    url = f"https://openlibrary.org/subjects/{slug}.json?limit={max_results}"
    data = _get_json(url)
    if not data:
        return []
    candidates = []
    for work in data.get("works", [])[:max_results]:
        cover_id = work.get("cover_id")
        candidates.append(
            {
                "source": "openlibrary",
                "resolved_id": work.get("key"),
                "title": work.get("title"),
                "author": (
                    (work.get("authors") or [{}])[0].get("name")
                    if work.get("authors")
                    else None
                ),
                "subjects": [subject],
                "cover_url": (
                    f"https://covers.openlibrary.org/b/id/{cover_id}-M.jpg"
                    if cover_id
                    else None
                ),
                "year": work.get("first_publish_year"),
                "raw": work,
            }
        )
    return candidates
