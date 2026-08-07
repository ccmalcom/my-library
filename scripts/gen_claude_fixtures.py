#!/usr/bin/env python3
"""Record Python's exact Claude create() kwargs (+ responses) for Node prompt parity.

Run from the repo root:
    python scripts/gen_claude_fixtures.py            # captured prompts, canned responses
    python scripts/gen_claude_fixtures.py --live     # also record REAL Claude responses (costs money)

Isolation identical to gen_parity_fixtures.py: empty-string env overrides set
BEFORE importing mylibrary, throwaway SQLite, fixed ENCRYPTION_KEY.
"""
from __future__ import annotations
import json, os, sys, tempfile
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
# A live GOOGLE_BOOKS_API_KEY is appended to every Google Books URL by
# catalog._google_books_query, which would bake a real credential into the
# committed recommend-http.json. Force it empty. Empty string, not `del`:
# config.py calls load_dotenv(override=False), which silently refills an UNSET
# var from .env but leaves an explicitly-empty one alone.
os.environ["GOOGLE_BOOKS_API_KEY"] = ""
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

from mylibrary import usage as usage_mod, directive as directive_mod  # noqa: E402
from mylibrary import archetype as archetype_mod, reveal as reveal_mod  # noqa: E402
from mylibrary import profile as profile_mod  # noqa: E402
from mylibrary import recommend as recommend_mod, catalog as catalog_mod  # noqa: E402
from mylibrary.db import init_db  # noqa: E402
from gen_parity_fixtures import SEED, load_seed  # noqa: E402

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


def _recording_get_json(url, *, use_cache=True):
    data = _real_get_json(url, use_cache=use_cache)
    # _get_json collapses 404, network failure and non-JSON all to None. Replaying
    # any of them as a 404 reproduces the same None on the Node side.
    catalog_http[url] = {"status": 200, "body": data} if data is not None else {"status": 404}
    return data


catalog_mod._get_json = _recording_get_json

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
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "prompts.json").write_text(json.dumps(out_prompts, indent=1, ensure_ascii=False))
    (OUT / "recommend-http.json").write_text(
        json.dumps(catalog_http, indent=1, ensure_ascii=False)
    )
    if LIVE:
        (OUT / "responses.json").write_text(json.dumps(out_responses, indent=1, ensure_ascii=False))
    print("wrote", OUT / "prompts.json", "scenarios:", list(out_prompts))
    print("wrote", OUT / "recommend-http.json", "urls:", len(catalog_http))

if __name__ == "__main__":
    main()
