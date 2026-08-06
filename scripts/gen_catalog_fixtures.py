#!/usr/bin/env python3
"""Record real Open Library + Google Books responses for the Node catalog tests.

Run from the repo root:  python scripts/gen_catalog_fixtures.py

Isolation: uses a throwaway MYLIBRARY_DATA_DIR so the real disk cache is never
read or written. Records the URLs `search_books` issues for a fixed query set,
writing {url: {status, body}} for the Node httpReplay helper.
"""
from __future__ import annotations
import json, os, re, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DATABASE_URL"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_JWKS_URL"] = ""
os.environ["SUPABASE_JWT_SECRET"] = ""
os.environ["REDIS_URL"] = ""
os.environ["MYLIBRARY_DATA_DIR"] = tempfile.mkdtemp(prefix="catalog-fixtures-")
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

QUERIES = ["dune", "ancillary justice", "9780316246620"]
OUT = Path("frontend/lib/server/__tests__/fixtures/catalog")

recorded: dict[str, dict] = {}
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
    recorded[safe_url] = {"status": resp.status_code, "body": body}
    return resp

httpx.get = _spy

results = {}
for q in QUERIES:
    results[q] = catalog.search_books(q, max_results=8)

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "http.json").write_text(json.dumps(recorded, indent=1))
(OUT / "expected.json").write_text(json.dumps(results, indent=1))
print(f"recorded {len(recorded)} URLs for {len(QUERIES)} queries -> {OUT}")
