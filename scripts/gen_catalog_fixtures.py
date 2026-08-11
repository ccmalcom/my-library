#!/usr/bin/env python3
"""Record real Open Library + Google Books responses for the Node catalog tests.

Run from the repo root:  python scripts/gen_catalog_fixtures.py

Isolation: uses a throwaway MYLIBRARY_DATA_DIR so the real disk cache is never
read or written. Records the URLs `search_books` issues for a fixed query set,
writing {url: {status, body}} for the Node httpReplay helper.
"""
from __future__ import annotations

import atexit
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DATABASE_URL"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_JWKS_URL"] = ""
os.environ["SUPABASE_JWT_SECRET"] = ""
os.environ["REDIS_URL"] = ""
_TEMP_DATA_DIR = tempfile.TemporaryDirectory(prefix="catalog-fixtures-")
atexit.register(_TEMP_DATA_DIR.cleanup)
os.environ["MYLIBRARY_DATA_DIR"] = _TEMP_DATA_DIR.name
# Deliberately NOT stubbing GOOGLE_BOOKS_API_KEY: leave it to load_dotenv()
# below picking up the real key from the repo-root .env, so this recording
# run authenticates and gets real Google Books data (unauthenticated requests
# hit a shared daily quota in this environment and 429). The key is stripped
# from the recorded URL before anything touches disk -- see _spy below -- so
# the real value is never persisted into a git-committed fixture, and the
# fixture's URL matches what Node builds in the test env (which has no
# GOOGLE_BOOKS_API_KEY configured, since vitest doesn't load the repo's .env).

import httpx  # noqa: E402

from mylibrary import catalog  # noqa: E402
from mylibrary.db import Book, Enrichment, init_db, session_scope  # noqa: E402
from mylibrary.enrich import enrich_library  # noqa: E402

QUERIES = ["dune", "ancillary justice", "9780316246620"]
OUT = Path("frontend/lib/server/__tests__/fixtures/catalog")

recorded: dict[str, dict] = {}
emitted_urls: list[str] = []
_orig_get = httpx.get
_KEY_PARAM = re.compile(r"&key=[^&]*")


def _spy(url, **kw):
    resp = _orig_get(url, **kw)
    try:
        body = resp.json()
    except Exception:
        body = None
    # Strip the API key param before recording -- never persist the secret,
    # and match the keyless URL Node builds without GOOGLE_BOOKS_API_KEY set.
    safe_url = _KEY_PARAM.sub("", str(url))
    emitted_urls.append(safe_url)
    recorded[safe_url] = {"status": resp.status_code, "body": body}
    return resp

httpx.get = _spy

results = {}
for q in QUERIES:
    results[q] = catalog.search_books(q, max_results=8)

seed = [
    # Intended branch: Open Library ISBN success, including Edition -> Work description.
    {
        "id": 1,
        "user_id": "fixture-user",
        "goodreads_book_id": "fixture-ol-isbn",
        "title": "Dune",
        "author": "Frank Herbert",
        "isbn13": "9780441172719",
        "goodreads_rating": 5,
    },
    # Intended branch: Open Library ISBN miss, then Google Books ISBN success.
    # Seed chosen by probing the live catalogs: Open Library's Books API has no
    # record for this ISBN while Google Books does. Popular titles almost always
    # resolve on Open Library first, which never exercises isbn:googlebooks.
    {
        "id": 2,
        "user_id": "fixture-user",
        "goodreads_book_id": "fixture-google-isbn",
        "title": "The Anxious Generation",
        "author": "Jonathan Haidt",
        "isbn13": "9780593655036",
        "goodreads_rating": 4,
    },
    # Intended branch: no ISBN, Open Library search MEDIUM.
    {
        "id": 3,
        "user_id": "fixture-user",
        "goodreads_book_id": "fixture-ol-search",
        "title": "Ancillary Justice",
        "author": "Ann Leckie",
        "isbn13": None,
        "goodreads_rating": 5,
    },
    # Intended branch: Open Library search LOW wins outright. Google still runs and
    # returns strong hits, but its many near-duplicate editions trip the ambiguity
    # rule (two candidates >= 0.85), so it stays LOW and Open Library's LOW is kept.
    {
        "id": 4,
        "user_id": "fixture-user",
        "goodreads_book_id": "fixture-ol-search-low",
        "title": "Harry Potter and the Sorcerer's Stone",
        "author": "J. K. Rowling",
        "isbn13": None,
        "goodreads_rating": 4,
    },
    # Intended branch: both title searches miss, producing unresolved persistence.
    {
        "id": 5,
        "user_id": "fixture-user",
        "goodreads_book_id": "fixture-unresolved",
        "title": "Zqxjv Nonexistent Catalog Fixture Book 847291",
        "author": "Q. X. Fixture",
        "isbn13": None,
        "goodreads_rating": 3,
    },
    # Intended branch: Open Library search LOW, then Google Books search MEDIUM.
    # Seed chosen by probing the live catalogs: Google's top hit scores 1.0 and its
    # runner-up only 0.5, so the ambiguity rule does not fire and MEDIUM survives.
    {
        "id": 7,
        "user_id": "fixture-user",
        "goodreads_book_id": "fixture-google-search",
        "title": "The Wager",
        "author": "David Grann",
        "isbn13": None,
        "goodreads_rating": 5,
    },
    # Intended branch: existing enrichment is skipped without making catalog requests.
    {
        "id": 6,
        "user_id": "fixture-user",
        "goodreads_book_id": "fixture-pre-enriched",
        "title": "Pride and Prejudice",
        "author": "Jane Austen",
        "isbn13": "9780141439518",
        "goodreads_rating": 5,
    },
]

# enrich_library() calls init_db() itself, but the seed below runs first.
init_db()

# The pre-existing enrichment row that makes book 6 a skip. Emitted as
# `seed_enrichment` so the Node parity test can reproduce the PRE-run state
# directly instead of inferring it from the post-run rows.
seed_enrichment = [
    {
        "book_id": 6,
        "resolved_source": "openlibrary",
        "resolved_id": "/works/OL66554W",
        "subjects": ["Fiction"],
        "series": None,
        "series_position": None,
        "language": "en",
        "description": "Pre-enriched skip sentinel",
        "cover_url": None,
        "resolution_confidence": 0.95,
        "confidence_label": "HIGH",
        "match_method": "isbn:openlibrary",
        "raw_response": {"fixture": "pre-enriched"},
    }
]

with session_scope() as session:
    session.add_all(Book(**row) for row in seed)
    session.add_all(Enrichment(**row) for row in seed_enrichment)

enrichment_url_start = len(emitted_urls)
summary = enrich_library(user_id='fixture-user')

with session_scope() as session:
    persisted = []
    for enrichment in session.query(Enrichment).order_by(Enrichment.book_id).all():
        row = {
            column.name: getattr(enrichment, column.name)
            for column in Enrichment.__table__.columns
            if column.name != "id"
        }
        assert isinstance(row["resolved_at"], datetime)
        row["resolved_at"] = "<TIMESTAMP>"
        persisted.append(row)

enrichment_expected = {
    "seed": seed,
    "seed_enrichment": seed_enrichment,
    "summary": summary,
    "rows": persisted,
    "urls": emitted_urls[enrichment_url_start:],
}

OUT.mkdir(parents=True, exist_ok=True)
# These two keep their original insertion-order serialization on purpose. Sorting
# them would rewrite thousands of untouched lines on the next re-record and bury
# the real change in a hand review. Only the new enrichment fixture is sorted.
(OUT / "http.json").write_text(json.dumps(recorded, indent=1))
(OUT / "expected.json").write_text(json.dumps(results, indent=1))
(OUT / "enrichment-expected.json").write_text(
    json.dumps(enrichment_expected, indent=1, sort_keys=True)
)
print(f"recorded {len(recorded)} URLs for {len(QUERIES)} queries -> {OUT}")
