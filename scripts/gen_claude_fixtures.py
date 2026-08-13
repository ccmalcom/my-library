#!/usr/bin/env python3
"""Record Python's exact Claude create() kwargs (+ responses) for Node prompt parity.

Run from the repo root:
    python scripts/gen_claude_fixtures.py            # captured prompts, canned responses
    python scripts/gen_claude_fixtures.py --live     # also record REAL Claude responses (costs money)

Isolation identical to gen_parity_fixtures.py: empty-string env overrides set
BEFORE importing mylibrary, throwaway SQLite, fixed ENCRYPTION_KEY.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # for gen_parity_fixtures import

FIXED_TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
os.environ["DATABASE_URL"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_JWKS_URL"] = ""
os.environ["SUPABASE_JWT_SECRET"] = ""
os.environ["REDIS_URL"] = ""
os.environ["ENCRYPTION_KEY"] = FIXED_TEST_KEY
# NOTE: GOOGLE_BOOKS_API_KEY is deliberately NOT forced empty here. An earlier
# revision did that to keep a real credential out of the committed
# recommend-http.json, but catalog._google_books_query simply omits the `key` param
# when it is empty, and Google Books answers KEYLESS requests with 429 "Quota
# exceeded" off a shared anonymous pool. The result was a fixture in which all 16
# Google Books URLs recorded as failures, so the parity test silently proved only
# the Open Library half of retrieval. The key is needed for a real recording and is
# stripped from each URL by _scrub_url below instead.
os.environ["MYLIBRARY_DATA_DIR"] = tempfile.mkdtemp(prefix="claude-fixtures-")
# Pin to config.DEFAULT_MODEL regardless of a developer's local .env override (e.g. a
# temporary cost/availability substitution). Without this, profile_full/profile_update's
# captured `model` leaks whatever MYLIBRARY_MODEL happens to be set to on the machine that
# ran this script, making the checked-in prompts.json fixture non-reproducible — Node's
# profileModel() falls back to the same 'claude-sonnet-5' default when its own env doesn't
# set MYLIBRARY_MODEL, so pinning here is what keeps profile-prompt parity deterministic.
os.environ["MYLIBRARY_MODEL"] = "claude-sonnet-5"
LIVE = "--live" in sys.argv
if not LIVE:
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-fixture-not-used"

from mylibrary import config as _config  # noqa: E402

settings = _config.get_settings()
assert settings.db_url.startswith("sqlite"), f"NOT ISOLATED: {settings.db_url}"

from gen_parity_fixtures import load_seed  # noqa: E402

from mylibrary import archetype as archetype_mod  # noqa: E402
from mylibrary import catalog as catalog_mod  # noqa: E402
from mylibrary import directive as directive_mod  # noqa: E402
from mylibrary import profile as profile_mod  # noqa: E402
from mylibrary import recommend as recommend_mod  # noqa: E402
from mylibrary import reveal as reveal_mod  # noqa: E402
from mylibrary import usage as usage_mod  # noqa: E402
from mylibrary.db import init_db  # noqa: E402

# gen_parity_fixtures has its own import-time isolation preamble: it sets a
# placeholder ANTHROPIC_API_KEY then pops it (so ITS "empty stage" fixture records
# configured=false), and repoints MYLIBRARY_DATA_DIR at its own throwaway tempdir.
# Importing it above just re-ran that module-level code, so re-assert what this
# script needs afterward: a non-empty key in offline mode so resolve_anthropic_key()
# falls through to the env var (get_settings() re-reads os.environ on every call, no
# caching, so this is safe to set post-import). Do not edit gen_parity_fixtures.py to
# "fix" this — its own pop is correct for its own fixtures.
if not LIVE:
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-fixture-not-used"

# --- catalog recorder --------------------------------------------------------
# recommend()'s rerank prompt embeds a candidate list built from live Open Library
# and Google Books responses, so the Node parity test can only rebuild that prompt
# if it sees the same HTTP payloads. Wrap (don't replace) _get_json so the disk
# cache still works and a second scenario run records the same values.
_real_get_json = catalog_mod._get_json
catalog_http: dict[str, dict] = {}


def _scrub_url(url: str) -> str:
    """Strip the Google Books API key from a URL before it is recorded.

    Two reasons this must happen. It keeps a live credential out of the committed
    fixture, and it makes the recorded key match what NODE requests: the Vitest
    env sets no GOOGLE_BOOKS_API_KEY, so catalog.ts builds the keyless URL. The
    `key` param is always appended last (QueryParams.set), so removing it leaves
    the exact keyless form byte-for-byte.
    """
    return re.sub(r"&key=[^&]*", "", url)


def _recording_get_json(url, *, use_cache=True):
    data = _real_get_json(url, use_cache=use_cache)
    # _get_json collapses 404, network failure and non-JSON all to None. Replaying
    # any of them as a 404 reproduces the same None on the Node side.
    catalog_http[_scrub_url(url)] = (
        {"status": 200, "body": data} if data is not None else {"status": 404}
    )
    return data


catalog_mod._get_json = _recording_get_json


def _assert_catalog_recording_is_usable() -> None:
    """Abort rather than commit a fixture whose retrieval half silently failed.

    `_get_json` swallows every failure into None, so a rate-limited or offline run
    still produces a complete-looking recommend-http.json -- one where a whole
    catalog source contributed zero candidates and the parity test proves much less
    than it appears to. Requiring at least one success per host makes that loud.
    """
    from urllib.parse import urlparse

    by_host: dict[str, list[int]] = {}
    for url, entry in catalog_http.items():
        by_host.setdefault(urlparse(url).netloc, []).append(entry["status"])
    if not by_host:
        raise SystemExit("no catalog traffic recorded -- did the recommend scenarios run?")

    for host, statuses in sorted(by_host.items()):
        ok = statuses.count(200)
        print(f"  {host}: {ok}/{len(statuses)} returned data")
        if ok == 0:
            raise SystemExit(
                f"\nEVERY request to {host} came back empty, so the recorded fixture\n"
                "would contain none of its candidates and the Node parity test would\n"
                "silently cover only the other source.\n"
                "  - googleapis.com: set a real GOOGLE_BOOKS_API_KEY in .env. Keyless\n"
                "    requests get 429 off a shared anonymous quota. The key is stripped\n"
                "    from every recorded URL, so it never reaches the fixture.\n"
                "  - openlibrary.org: likely offline or rate limited; retry later.\n"
                "Nothing was written."
            )


def _assert_no_credentials(text: str) -> None:
    """Belt-and-braces: never write a fixture that carries an API key."""
    if "key=" in text or "AIza" in text:
        raise SystemExit("refusing to write: recorded URLs still carry an API key")

OUT = Path("frontend/lib/server/__tests__/fixtures/claude")

captured: list[dict] = []
_canned_queue: list = []
_real_tracked_create = usage_mod.tracked_create


class _Block:
    """Minimal stand-in for an Anthropic tool_use content block."""

    def __init__(self, name: str, payload: dict):
        self.type = "tool_use"
        self.name = name
        self.input = payload


class _CannedMessage:
    """Minimal stand-in for an Anthropic Message carrying one tool_use block.

    Lets a multi-call flow run PAST its earlier Claude calls on a fixed, checked-in
    payload so a LATER prompt is deterministic and can be captured. recommend() needs
    this: its rerank prompt only exists once the seed-query call has returned.
    Offline only -- under --live the real responses flow through instead.
    """

    def __init__(self, name: str, payload: dict):
        self.content = [_Block(name, payload)]
        self.usage = None


class _StopBeforeCall(Exception):
    """Raised to abort a flow right after its target prompt is captured (offline mode)."""


def _capture(client, *, user_id, operation, **kw):
    # Record the exact kwargs Python would send. `tools`/`system`/`messages`
    # are what Node must reproduce byte-for-byte.
    entry = {"operation": operation, "user_id": user_id, "kwargs": kw}
    captured.append(entry)
    if LIVE:
        msg = _real_tracked_create(client, user_id=user_id, operation=operation, **kw)
        # Stash the real response on the same entry so main() can lift it into
        # out_responses — msg is a pydantic model, not JSON-serializable as-is.
        entry["response"] = msg.model_dump()
        return msg
    if _canned_queue:
        return _canned_queue.pop(0)
    raise _StopBeforeCall()


# Patch every module that imported tracked_create by name.
for mod in (directive_mod, archetype_mod, reveal_mod, profile_mod, recommend_mod):
    mod.tracked_create = _capture


# A fixed stand-in for what Claude would propose in stage 1b. Checked in via the
# recorded catalog URLs, so changing these strings invalidates recommend-http.json
# and requires a regeneration run.
_SEED_QUERIES_CANNED = _CannedMessage(
    "propose_search_queries",
    {
        "queries": [
            {"query": "literary science fiction political systems", "reason": "fixture"},
            {"query": "anthropological science fiction first contact", "reason": "fixture"},
        ]
    },
)


def _prepare_recommend() -> None:
    """Make the seeded library pass recommend()'s profile-freshness gate.

    The shared SEED is deliberately STALE -- books 2, 3 and 9 carry a
    feedback_updated_at after profile_meta.last_profiled_at, which is exactly what
    makes the profile_update fixture meaningful. recommend() refuses to run on a
    stale profile ("3 book(s) have been rated/reviewed since the last profile
    build"), so bump every profile_meta row past them.

    Idempotent -- both recommend scenarios call it. MUST run after profile_full and
    profile_update: SCENARIOS is a dict, dict order is run order, and bumping earlier
    would silently change those two fixtures. Append new scenarios, never insert.
    """
    import datetime

    from mylibrary.db import ProfileMeta, session_scope

    with session_scope() as session:
        for pm in session.query(ProfileMeta).all():
            pm.last_profiled_at = datetime.datetime(2026, 8, 1, 0, 0, 0)


def _run_recommend():
    _prepare_recommend()
    return recommend_mod.recommend(n=10)  # n=10 is RecommendRequest's default


# A fixed stand-in for what Claude would propose in the per-book stage 1b. Like
# _SEED_QUERIES_CANNED, these strings determine which Google Books URLs land in
# recommend-http.json, so changing them requires a regeneration run AND the same
# edit in parity-similar-prompts.test.ts.
_SIMILAR_QUERIES_CANNED = _CannedMessage(
    "propose_search_queries",
    {
        "queries": [
            {"query": "desert planet political intrigue science fiction", "reason": "fixture"},
            {"query": "ecological science fiction messianic prophecy", "reason": "fixture"},
        ]
    },
)

# Book 1 (Dune) is the anchor: the only SEED book whose enrichment carries BOTH
# subjects and a description, so the anchor JSON exercises every populated field.
# `series` stays null -- no SEED book is both enriched with a series and richly
# described -- and that null is itself asserted in the Node parity test.
SIMILAR_BOOK_ID = 1


def _run_similar():
    # No _prepare_recommend() call: recommend_similar() has no profile-missing or
    # profile-stale gate and no cold-start gating (verified by probe), so it runs
    # against the SEED as-is. Keeping it out also means these scenarios cannot
    # perturb the earlier profile_* fixtures.
    return recommend_mod.recommend_similar(SIMILAR_BOOK_ID, n=8)  # n=8 is SimilarRequest's default


# The reader's request and Claude's canned interpretation of it. These strings
# determine which catalog URLs land in recommend-http.json, so changing them
# requires a regeneration run AND the same edit in parity-discover-prompts.test.ts.
#
# The constraints block is deliberately messy: it exercises every branch of
# _clean_constraints in one shot -- case/whitespace normalization, the 2-char
# language truncation, an integer-as-string year, and two unsupported keys that
# must be dropped -- and the surviving constraints then really filter the pool
# before assembly.
DISCOVER_QUERY = "something like The Fifth Season but gentler"

_DISCOVER_INTERP_CANNED = _CannedMessage(
    "interpret_request",
    {
        "interpretation": "Epic fantasy with a broken world, but warmer in tone.",
        "queries": [
            {"query": "literary fantasy found family", "rationale": "fixture"},
            {"query": "gentle epic fantasy hopeful tone", "rationale": "fixture"},
            {"query": "   ", "rationale": "blank -- must be dropped before retrieval"},
        ],
        "constraints": {
            "languages": ["ENG", " fr ", ""],
            "min_year": "1990",
            "max_year": 2020,
            "exclude_subjects": [" War ", "grief", ""],
            "page_count_max": 400,
            "standalone": True,
        },
    },
)


def _run_discover():
    # No _prepare_recommend() call: discover() has no profile-missing or
    # profile-stale gate and no cold-start gating (verified by probe).
    return recommend_mod.discover(DISCOVER_QUERY, n=10)  # n=10 is DiscoverRequest's default


# name -> (flow, canned responses fed to earlier Claude calls, index of the call to capture)
SCENARIOS = {
    "directive_distill": (
        lambda: directive_mod.distill_directive(
            "I want more literary sci-fi, nothing grimdark, and no John Ringo.",
            current_text="Standalone novels preferred.",
        ),
        [],
        0,
    ),
    "archetype": (lambda: archetype_mod.derive_archetype(), [], 0),
    "reveal_lines": (lambda: reveal_mod.generate_reveal_lines(), [], 0),
    "profile_full": (lambda: profile_mod.extract_taste_profile(), [], 0),
    "profile_update": (lambda: profile_mod.update_taste_profile(), [], 0),
    # --- append below this line only (see _prepare_recommend) ---
    "recommend_seed": (_run_recommend, [], 0),
    "recommend_rerank": (_run_recommend, [_SEED_QUERIES_CANNED], 1),
    "similar_seed": (_run_similar, [], 0),
    "similar_rerank": (_run_similar, [_SIMILAR_QUERIES_CANNED], 1),
    "discover_interpret": (_run_discover, [], 0),
    "discover_rerank": (_run_discover, [_DISCOVER_INTERP_CANNED], 1),
}


def main() -> None:
    init_db()
    load_seed()
    out_prompts, out_responses = {}, {}
    for name, (fn, canned, take) in SCENARIOS.items():
        captured.clear()
        _canned_queue[:] = list(canned)
        try:
            fn()
        except _StopBeforeCall:
            pass
        assert len(captured) > take, (
            f"{name} captured {len(captured)} Claude call(s) but needs index {take} -- "
            "check the monkey-patch and the canned-response queue"
        )
        out_prompts[name] = captured[take]
        if LIVE:
            out_responses[name] = captured[take].pop("response")
    print("catalog traffic recorded:")
    _assert_catalog_recording_is_usable()
    catalog_json = json.dumps(catalog_http, indent=1, ensure_ascii=False)
    _assert_no_credentials(catalog_json)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "prompts.json").write_text(json.dumps(out_prompts, indent=1, ensure_ascii=False))
    (OUT / "recommend-http.json").write_text(catalog_json)
    if LIVE:
        (OUT / "responses.json").write_text(json.dumps(out_responses, indent=1, ensure_ascii=False))
    print("wrote", OUT / "prompts.json", "scenarios:", list(out_prompts))
    print("wrote", OUT / "recommend-http.json", "urls:", len(catalog_http))

if __name__ == "__main__":
    main()
