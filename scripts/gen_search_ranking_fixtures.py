#!/usr/bin/env python3
"""Additively record real catalog responses for the search-RANKING test queries.

Run from the repo root:  python scripts/gen_search_ranking_fixtures.py

Why this is separate from `gen_catalog_fixtures.py`: that script rewrites all three
catalog fixtures in one pass, including `enrichment-expected.json`, whose seven seeds
were hand-picked by probing the live catalogs to hit five specific match branches. A
re-record can flip one of those branches and turn the enrichment parity test red for
reasons that have nothing to do with search. This script therefore MERGES into
`http.json` and never touches `expected.json` or `enrichment-expected.json`.

It records HTTP only. It deliberately does NOT record Python's ranking output: these
queries exist to pin the *fixed* Node ranking, and Python's `_match_score` is the
buggy original (see todo.md "Add-book search ranking"). Python is invoked purely to
emit the same four URLs `searchBooks` issues.
"""
from __future__ import annotations

import atexit
import json
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DATABASE_URL"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_JWKS_URL"] = ""
os.environ["SUPABASE_JWT_SECRET"] = ""
os.environ["REDIS_URL"] = ""
_TEMP_DATA_DIR = tempfile.TemporaryDirectory(prefix="search-ranking-fixtures-")
atexit.register(_TEMP_DATA_DIR.cleanup)
os.environ["MYLIBRARY_DATA_DIR"] = _TEMP_DATA_DIR.name
# As in gen_catalog_fixtures.py: the real Google Books key is left to load_dotenv so
# the recording is authenticated (anonymous requests 429 off a shared quota), and is
# stripped from every URL before anything touches disk.

import httpx  # noqa: E402

from mylibrary import catalog  # noqa: E402

# Each query pins one defect from todo.md's "Add-book search ranking" item.
QUERIES = [
    "the androids dream",  # defect 1: apostrophe dropped by the user
    "the android's dream",  # defect 1 control: this spelling already worked
    "lock in scalzi",  # defect 2: query spans title AND author
    "scalzi lock in",  # defect 2: author first
]
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
    safe_url = _KEY_PARAM.sub("", str(url))
    recorded[safe_url] = {"status": resp.status_code, "body": body}
    return resp


httpx.get = _spy

for q in QUERIES:
    catalog.search_books(q, max_results=8)

# Refuse to write a fixture in which a whole host silently failed -- the same guard
# gen_claude_fixtures.py uses. A keyless/quota-limited run records 429s that look
# like real data to the replay helper and would prove nothing.
by_host: dict[str, list[int]] = {}
for url, entry in recorded.items():
    host = url.split("/")[2]
    by_host.setdefault(host, []).append(entry["status"])
for host, statuses in sorted(by_host.items()):
    ok = sum(1 for s in statuses if s == 200)
    print(f"  {host}: {ok}/{len(statuses)} returned 200")
    if ok == 0:
        sys.exit(f"ERROR: every request to {host} failed -- refusing to write fixture")

path = OUT / "http.json"
existing = json.loads(path.read_text())
added = [u for u in recorded if u not in existing]
overwritten = [u for u in recorded if u in existing]
merged = {**existing, **recorded}
path.write_text(json.dumps(merged, indent=1))
print(
    f"recorded {len(recorded)} URLs for {len(QUERIES)} queries "
    f"({len(added)} new, {len(overwritten)} refreshed) -> {path}"
)
