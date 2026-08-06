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

OUT = Path("frontend/lib/server/__tests__/fixtures/claude")

captured: list[dict] = []
_real_tracked_create = usage_mod.tracked_create

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
    raise _StopBeforeCall()

class _StopBeforeCall(Exception):
    """Raised to abort a flow right after its prompt is captured (offline mode)."""

# Patch every module that imported tracked_create by name.
for mod in (directive_mod, archetype_mod, reveal_mod, profile_mod):
    mod.tracked_create = _capture

SCENARIOS = {
    "directive_distill": lambda: directive_mod.distill_directive(
        "I want more literary sci-fi, nothing grimdark, and no John Ringo.",
        current_text="Standalone novels preferred.",
    ),
    "archetype": lambda: archetype_mod.derive_archetype(),
    "reveal_lines": lambda: reveal_mod.generate_reveal_lines(),
    "profile_full": lambda: profile_mod.extract_taste_profile(),
    "profile_update": lambda: profile_mod.update_taste_profile(),
}

def main() -> None:
    init_db()
    load_seed()
    out_prompts, out_responses = {}, {}
    for name, fn in SCENARIOS.items():
        captured.clear()
        try:
            fn()
        except _StopBeforeCall:
            pass
        assert captured, f"{name} captured no Claude call — check the monkey-patch"
        out_prompts[name] = captured[0]
        if LIVE:
            out_responses[name] = captured[0].pop("response")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "prompts.json").write_text(json.dumps(out_prompts, indent=1, ensure_ascii=False))
    if LIVE:
        (OUT / "responses.json").write_text(json.dumps(out_responses, indent=1, ensure_ascii=False))
    print("wrote", OUT / "prompts.json", "scenarios:", list(out_prompts))

if __name__ == "__main__":
    main()
