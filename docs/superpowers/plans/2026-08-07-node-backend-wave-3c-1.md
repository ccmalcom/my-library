# Node Backend Wave 3c-1 — Recommender Core + `POST /recommend` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `mylibrary/recommend.py`'s shared deterministic retrieval core and the `POST /recommend` two-stage flow to Next.js route handlers, proven byte-identical against prompts and catalog traffic recorded from the real Python implementation.

**Architecture:** Wave 3c is split in three because `recommend.py` is 1,887 lines with six distinct Claude prompts. **This plan is 3c-1**: everything `/recommend`, `/books/{id}/similar`, and `/discover` share (library signal, candidate filters, pool assembly, capping, similarity), plus the `/recommend` orchestrator and its two prompts. 3c-2 (`/books/{id}/similar`) and 3c-3 (`/discover`) build on the modules this plan creates and add only their own prompts and orchestrators.

Claude output is nondeterministic, so "parity" here means the **request** is byte-identical: the recorded Python `create()` kwargs (prompt text, `system`, tool JSON schema, `tool_choice`, `model`, `max_tokens`) must equal what Node builds. Because `/recommend`'s rerank prompt embeds a candidate list assembled from live catalog responses, this plan also records the Python run's catalog HTTP traffic and replays it into the Node test. That makes the prompt assertion cover the **entire deterministic retrieval core** — pool expansion, dedup, language/series/fuzzy/learner filters, author caps, and cap ordering — not just the prompt strings.

**Tech Stack:** Next.js 15 route handlers, drizzle-orm over postgres-js, vitest + PGlite, `@anthropic-ai/sdk`, zod for body validation.

---

## Global Constraints

These apply to **every** task. Read them before starting any task.

1. **Python is the specification.** When Python does something that looks wrong, reproduce it. Do not "fix" it in Node. Deviations are allowed only where this plan explicitly names one, and each must carry a comment explaining why.
2. **No Claude call inside a transaction.** `lib/server/db.ts` opens the pool with `max: 1`. Touching the outer `db` while a `tx` is open deadlocks the request. Every Claude call and every catalog fetch runs *outside* `db.transaction()`; all writes are batched into a single transaction *after* the last Claude call resolves. Python behaves the same way (it writes nothing before its calls).
3. **Ordered mappings bound for a prompt must be a `Map`.** V8 enumerates integer-like object keys (`'5'`, `'4'`, `'3'`) in ascending numeric order, silently reordering them away from Python's insertion order. `pyJsonDumps`/`pyRepr` only trust a `Map`.
4. **Python floats render differently.** `json.dumps(1.0)` → `1.0`; `JSON.stringify(1.0)` → `1`. Any float that reaches a prompt must be wrapped with `pyFloat()` from `lib/server/serialize.ts`.
5. **`{}` is truthy in JS, falsy in Python.** Every Python `if not some_dict:` becomes `if (Object.keys(d).length === 0)`, never `if (!d)`.
6. **Alembic remains the sole migration authority.** This wave adds no columns and no migrations.
7. **Never read or print values from `.env` / `.env.local`.** Variable *names* only.
8. **Do not run `git commit` unless the plan step says to commit.** Never add a `Co-Authored-By: Claude` trailer.
9. **Do not run destructive writes against the real dev Postgres.** All verification is against PGlite (tests) or a throwaway local database.
10. Run `npx prettier --write <files you touched>` before each commit. Do **not** run a repo-wide `npm run format` — it rewrites ~65 unrelated pre-existing files.

---

## Verified Facts

Every claim below was **executed and confirmed** against this repo on 2026-08-07, not inferred from reading. Trust them; do not re-derive them, and do not "correct" code that follows them.

| # | Fact | Evidence |
|---|---|---|
| V1 | The shared parity SEED trips `recommend()`'s profile-stale gate: `RuntimeError: 3 book(s) have been rated/reviewed since the last profile build. Re-profile first (POST /profile/update) so recommendations reflect your current taste.` The generator must bump `profile_meta.last_profiled_at` past every `books.feedback_updated_at` before running a recommend scenario. | Ran `recommend()` against `gen_parity_fixtures.load_seed()` |
| V2 | `gen_parity_fixtures`' import-time preamble **pops** `ANTHROPIC_API_KEY`. It must be re-set *after* that import or `recommend()` dies with "No Anthropic API key configured". `gen_claude_fixtures.py:55-56` already does this; keep it. | Same probe, first run failed exactly this way |
| V3 | `recommend()` makes **two** Claude calls: `recommend_seed` (`claude-haiku-4-5-20251001`, `max_tokens=1500`, tool `propose_search_queries`) then `recommend_rerank` (`settings.model`, `max_tokens=4000`, tool `rank_recommendations`). Both send one user message with a **2-block** content array; block 0 carries `cache_control: {"type": "ephemeral"}`. | Captured both via a monkeypatched `tracked_create` |
| V4 | A run over the seed issues **25 distinct catalog URLs** (8 OL subject + 8 GB subject + 6 GB author + seed queries + OL work-description fills). All are replayable. | Same probe |
| V5 | `difflib.SequenceMatcher(None, a, b).ratio()` is exactly reproducible in JS by the port in Task 3 — **0 mismatches over 3,908 string pairs**, including the 199/200/250-character autojunk boundary. | Differential test, Python vs Node |
| V6 | `Math.round(x*100)/100` (today's `round2`) disagrees with Python's `round(x, 2)` on **51 of 4,023** values; `Number(x.toFixed(2))` on 6; the Task 2 implementation on **0**. | Differential test |
| V7 | `Counter.most_common(n)` breaks count ties by **insertion order, earliest first** (`heapq.nlargest` decorates with a descending order counter). | `Counter(["b","a","c","a","b"]).most_common(2)` → `[('b',2),('a',2)]` |
| V8 | `list.sort(key=..., reverse=True)` is stable and does **not** reverse ties. The seed's `loved` list comes out id-ascending within each rating band. | Inspected the captured rerank prompt |
| V9 | FastAPI's `POST /recommend` returns **422** for a missing body (`{"detail":[{"type":"missing","loc":["body"],...}]}`) and for `{"n":"x"}`, but **200/400** for `{}` (all `RecommendRequest` fields have defaults). | `TestClient` probe |
| V10 | `round(0.9, 2)` renders as `0.9` and `user_weight` renders as `1.0` inside the rerank prompt's traits JSON — both floats need `pyFloat()`. | Captured prompt block 0 |
| V11 | `frontend/lib/server/serialize.ts`'s `round2`/`round4` are **dead code** — defined and unit-tested, imported nowhere in `lib/`, `app/`, or `components/`. Task 2 can change `round2`'s behavior safely. | Repo-wide grep |
| V12 | `latest_recommendations` (`GET /recommendations`) was already ported in wave 1 (`app/api/recommendations/route.ts`). **Do not re-port it.** | Read both implementations |
| V13 | `catalog.py`'s `_google_books_query` appends `&key=<GOOGLE_BOOKS_API_KEY>` when that env var is set. Recording fixtures with it set would **commit a live API key to the repo**. Both the Python generator and the Node tests must force it empty. | Read `catalog.py:340-342`; wave-3a tests already delete it |

### Python quirks to reproduce, not fix

- `_fuzzy_duplicate` compares **subtitle-stripped** titles, so `"Exodus: The Helium Sea"` and `"Exodus: The Archimedes Engine"` both normalize to `"exodus"` and score `1.0` — the recommender drops sibling-subtitle candidates. This is the same class of bug Chase fixed in the *add-book* flow (`_same_work`), but `recommend.py` was never changed. Port the existing behavior; flag it for Chase, do not change it here.
- `_apply_directive_constraints` compares a candidate's **surname** against the constraint's **full lowercased author string**, so an `exclude_authors: ["John Ringo"]` never matches. Reproduce it.
- `signal["directive_constraints"]` stays `{}` when a `user_directive` row exists with `nl_text=None` and `constraints={}`, because `{}` is falsy in Python.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `frontend/lib/server/similarity.ts` | `difflib.SequenceMatcher.ratio()` port; `titleSim`, `STRONG_SIM` |
| `frontend/lib/server/recFilters.ts` | Pure candidate predicates: dedup key, language, series, fuzzy duplicate, learner edition, author caps, directive constraints |
| `frontend/lib/server/recSignal.ts` | `buildSignal` — the library summary every recommender path consumes |
| `frontend/lib/server/recAssemble.ts` | Pool retrieval (`metadataPool`, `seedPool`), `assemble`, `capPool`, `fillOlDescriptions` |
| `frontend/lib/server/recPrompts.ts` | Verbatim tool/system strings + prompt builders for both `/recommend` Claude stages |
| `frontend/lib/server/recommendRun.ts` | The `recommend()` orchestrator and its persistence |
| `frontend/app/api/recommend/route.ts` | `POST /api/recommend` handler |
| `frontend/lib/server/__tests__/similarity.test.ts` | |
| `frontend/lib/server/__tests__/rec-filters.test.ts` | |
| `frontend/lib/server/__tests__/rec-signal.test.ts` | |
| `frontend/lib/server/__tests__/rec-assemble.test.ts` | |
| `frontend/lib/server/__tests__/parity-recommend-prompts.test.ts` | The payoff: byte-identical prompt assertions |
| `frontend/lib/server/__tests__/recommend-route.test.ts` | |
| `frontend/lib/server/__tests__/fixtures/claude/recommend-http.json` | Recorded catalog traffic (generated, committed) |

**Modified files**

| File | Change |
|---|---|
| `scripts/gen_claude_fixtures.py` | Multi-call capture, canned-response queue, catalog HTTP recorder, recommend scenarios |
| `frontend/lib/server/__tests__/fixtures/claude/prompts.json` | Regenerated; gains `recommend_seed` + `recommend_rerank` |
| `frontend/lib/server/serialize.ts` | `round2` corrected; `pyRoundHalfEven` added |
| `frontend/lib/server/catalog.ts` | `googleBooksSubject`, `googleBooksAuthor`, `openlibrarySubject`, `openlibraryWorkDescription` |
| `frontend/lib/server/claudeErrors.ts` | `RECOMMEND_NO_KEY_MESSAGE` |
| `frontend/lib/backend.ts` | `POST /recommend` flips to Node |
| `frontend/lib/__tests__/backend.test.ts` | The `/recommend` assertion flips from Python to Node |
| `frontend/lib/server/__tests__/serialize.test.ts` | `round2` cases |
| `CLAUDE.md` | Wave 3c-1 status line |

**Dependency order:** Task 1 (fixtures) → 2 (rounding) → 3 (similarity) → 4 (catalog) → 5 (filters) → 6 (signal) → 7 (assembly) → 8 (prompts + parity) → 9 (orchestrator) → 10 (route + flip).

---

## Task 1: Record the recommender's Claude prompts and catalog traffic

`gen_claude_fixtures.py` today captures exactly **one** Claude call per scenario and aborts the flow immediately after (`_StopBeforeCall`). `recommend()` makes two calls, and its second prompt embeds candidates built from live catalog responses. This task teaches the generator to (a) feed canned responses to earlier calls so a later prompt can be reached, (b) record catalog HTTP so Node can replay it, and (c) satisfy `recommend()`'s profile-freshness gate.

**Files:**
- Modify: `scripts/gen_claude_fixtures.py`
- Generate + commit: `frontend/lib/server/__tests__/fixtures/claude/prompts.json` (gains 2 keys)
- Generate + commit: `frontend/lib/server/__tests__/fixtures/claude/recommend-http.json` (new)

**Interfaces:**
- Produces: `prompts.json` keys `recommend_seed` and `recommend_rerank`, each `{operation, user_id, kwargs}` where `kwargs` has `model`, `max_tokens`, `system`, `tools`, `tool_choice`, `messages`.
- Produces: `recommend-http.json` as `{ [url: string]: { status: number, body?: unknown } }` — directly consumable by `installHttpReplay` from `helpers/httpReplay.ts`.

- [ ] **Step 1: Force the Google Books key empty in the isolation preamble**

Without this, every recorded Google Books URL embeds a live API key and gets committed (V13). Add immediately after the `ENCRYPTION_KEY` line, **before** any `mylibrary` import:

```python
# A live GOOGLE_BOOKS_API_KEY is appended to every Google Books URL by
# catalog._google_books_query, which would bake a real credential into the
# committed recommend-http.json. Force it empty. Empty string, not `del`:
# config.py calls load_dotenv(override=False), which silently refills an UNSET
# var from .env but leaves an explicitly-empty one alone.
os.environ["GOOGLE_BOOKS_API_KEY"] = ""
```

- [ ] **Step 2: Import the recommend and catalog modules**

Extend the existing import block (below the `assert settings.db_url.startswith("sqlite")` guard):

```python
from mylibrary import usage as usage_mod, directive as directive_mod  # noqa: E402
from mylibrary import archetype as archetype_mod, reveal as reveal_mod  # noqa: E402
from mylibrary import profile as profile_mod  # noqa: E402
from mylibrary import recommend as recommend_mod, catalog as catalog_mod  # noqa: E402
from mylibrary.db import init_db  # noqa: E402
from gen_parity_fixtures import SEED, load_seed  # noqa: E402
```

- [ ] **Step 3: Record every catalog fetch**

Add after the `if not LIVE: os.environ["ANTHROPIC_API_KEY"] = ...` re-set block:

```python
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
```

- [ ] **Step 4: Add the canned-response queue**

Replace the existing `_capture` / `_StopBeforeCall` block with:

```python
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
        # out_responses -- msg is a pydantic model, not JSON-serializable as-is.
        entry["response"] = msg.model_dump()
        return msg
    if _canned_queue:
        return _canned_queue.pop(0)
    raise _StopBeforeCall()


# Patch every module that imported tracked_create by name.
for mod in (directive_mod, archetype_mod, reveal_mod, profile_mod, recommend_mod):
    mod.tracked_create = _capture
```

- [ ] **Step 5: Add the recommend scenario helpers**

Add directly above `SCENARIOS`:

```python
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
```

- [ ] **Step 6: Convert SCENARIOS to `(fn, canned, take)` and update main()**

```python
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
```

Delete the now-duplicated `OUT = ...`, `captured = []`, `_real_tracked_create = ...`, old `_capture`, old `_StopBeforeCall`, and the old patch loop if they still appear elsewhere in the file — each should exist exactly once.

- [ ] **Step 7: Regenerate the fixtures**

This run hits the real Open Library and Google Books APIs (no credentials needed) and makes **zero** Claude calls. Expect roughly 30 seconds.

Run from the repo root:
```bash
.venv/bin/python scripts/gen_claude_fixtures.py
```
Expected tail:
```
wrote frontend/lib/server/__tests__/fixtures/claude/prompts.json scenarios: ['directive_distill', 'archetype', 'reveal_lines', 'profile_full', 'profile_update', 'recommend_seed', 'recommend_rerank']
wrote frontend/lib/server/__tests__/fixtures/claude/recommend-http.json urls: 25
```
The URL count may differ from 25 if the catalogs return different result counts — that is fine. **Zero URLs is a failure** (the recorder is not wired up).

- [ ] **Step 8: Verify nothing else moved**

```bash
git diff --stat frontend/lib/server/__tests__/fixtures/claude/prompts.json
grep -c '"key=' frontend/lib/server/__tests__/fixtures/claude/recommend-http.json || echo "no api key leaked: OK"
cd frontend && npx vitest run lib/server/__tests__/parity-prompts.test.ts
```
Expected: `parity-prompts.test.ts` still **6 passed**. The five pre-existing scenario blocks in `prompts.json` must be byte-identical to before — the diff should be additions only.

**If they changed:** an environment variable leaked into the recording (most likely `MYLIBRARY_MODEL`, which the preamble pins to `claude-sonnet-5`). Stop and investigate. Do not commit a fixture whose existing scenarios moved.

**If the `key=` grep finds matches:** `GOOGLE_BOOKS_API_KEY` was not forced empty. Fix Step 1, delete `recommend-http.json`, and regenerate before committing.

- [ ] **Step 9: Commit**

```bash
git add scripts/gen_claude_fixtures.py frontend/lib/server/__tests__/fixtures/claude/
git commit -m "test(node): record recommend prompts + catalog traffic for wave 3c parity"
```

---

## Task 2: Correct `round2` to Python's `round(x, 2)`

Python's `round` uses banker's rounding (ties to even) on the exact binary value. `Math.round(x*100)/100` uses ties-away-from-zero on a rescaled value and disagrees on 51 of 4,023 sampled values (V6). Rounded confidences and scores go straight into the rerank prompt, so this is load-bearing. `round2` is dead code today (V11), so changing it breaks nothing.

**Files:**
- Modify: `frontend/lib/server/serialize.ts:34-40`
- Test: `frontend/lib/server/__tests__/serialize.test.ts:46-50`

**Interfaces:**
- Produces: `round2(x: number): number` — now Python-exact. `pyRoundHalfEven(x: number): number` — Python's 1-argument `round()`, used by `capPool` in Task 7.

- [ ] **Step 1: Write the failing test**

Replace the existing `round2 / round4` test in `serialize.test.ts` with:

```ts
  test('round2 matches Python round(x, 2), including banker-rounded ties', () => {
    expect(round2(4.333333)).toBe(4.33);
    // Exact binary ties -- the only place Math.round(x*100)/100 can be wrong.
    // Ties round to EVEN: 12.5 -> 12, 37.5 -> 38, 62.5 -> 62, 87.5 -> 88.
    expect(round2(0.125)).toBe(0.12);
    expect(round2(0.375)).toBe(0.38);
    expect(round2(0.625)).toBe(0.62);
    expect(round2(0.875)).toBe(0.88);
    expect(round2(-0.125)).toBe(-0.12);
    // NOT ties: 0.015*100 is 1.4999999999999998 in binary, so it rounds DOWN,
    // which Math.round(0.015*100) gets wrong by scaling first.
    expect(round2(0.015)).toBe(0.01);
    expect(round2(0.045)).toBe(0.04);
    expect(round2(2.675)).toBe(2.67);
    expect(round2(0.95)).toBe(0.95);
    expect(round2(1)).toBe(1);
  });

  test('pyRoundHalfEven matches Python round(x)', () => {
    expect(pyRoundHalfEven(0.5)).toBe(0);
    expect(pyRoundHalfEven(1.5)).toBe(2);
    expect(pyRoundHalfEven(2.5)).toBe(2);
    expect(pyRoundHalfEven(4.5)).toBe(4);
    expect(pyRoundHalfEven(-0.5)).toBe(0);
    expect(pyRoundHalfEven(-1.5)).toBe(-2);
    expect(pyRoundHalfEven(18)).toBe(18);
    expect(pyRoundHalfEven(17.9)).toBe(18);
  });

  test('round4', () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(0)).toBe(0);
  });
```

Add `pyRoundHalfEven` to the import list at the top of `serialize.test.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/serialize.test.ts
```
Expected: FAIL — `round2` reports `0.13` where `0.12` is expected, and `pyRoundHalfEven is not a function`.

- [ ] **Step 3: Implement**

Replace `round2` in `serialize.ts` (keep `round4` exactly as it is — it is dead code with no prompt-parity role, and changing it is out of scope):

```ts
/**
 * Python's `round(x, 2)`: banker's rounding (ties to even) applied to the EXACT
 * binary value of x, not to a rescaled copy of it.
 *
 * Verified against CPython over 4,023 values: `Math.round(x * 100) / 100` (the
 * previous implementation) disagrees on 51 of them, `Number(x.toFixed(2))` on 6,
 * this function on 0.
 *
 * Why the tie test is exact: round(x, 2) is a true tie only when x * 100 is
 * exactly k + 0.5, i.e. x * 200 is an odd integer. x is a double, hence a dyadic
 * rational, so x = (2m+1)/200 forces 25 | (2m+1) and leaves x = (2m+1)/8 -- an odd
 * eighth. Multiplying a double by 8 is exact (a pure exponent shift), so "x * 8 is
 * an odd integer" decides tie-ness with no floating-point slop. Everything else is
 * a strict inequality that `toFixed` already rounds correctly.
 *
 * Domain: |x| < 1e21, above which toFixed switches to exponential notation. Every
 * caller passes a confidence or score in [0, 1].
 */
export function round2(x: number): number {
  const eighths = x * 8;
  if (Number.isInteger(eighths) && eighths % 2 !== 0) {
    const floored = Math.floor(x * 100);
    return (floored % 2 === 0 ? floored : floored + 1) / 100;
  }
  return Number(x.toFixed(2));
}

/**
 * Python's one-argument `round(x)` -> int: half to even, unlike `Math.round`'s
 * half-up. `capPool` (recAssemble.ts) uses it for `round(cap * SEED_RESERVE_SHARE)`.
 * Exact for the small magnitudes used here; `x - floor(x)` loses precision above 2^52.
 */
export function pyRoundHalfEven(x: number): number {
  const floored = Math.floor(x);
  const frac = x - floored;
  if (frac > 0.5) return floored + 1;
  if (frac < 0.5) return floored;
  return floored % 2 === 0 ? floored : floored + 1;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/serialize.test.ts
```
Expected: PASS. Then run the whole suite to confirm nothing depended on the old behavior:
```bash
cd frontend && npx vitest run
```
Expected: all previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
npx prettier --write lib/server/serialize.ts lib/server/__tests__/serialize.test.ts
git add frontend/lib/server/serialize.ts frontend/lib/server/__tests__/serialize.test.ts
git commit -m "fix(node): round2 matches Python's banker-rounded round(x, 2)"
```

---

## Task 3: Port `difflib.SequenceMatcher.ratio()`

`recommend.py`'s `_fuzzy_duplicate` uses `enrich._title_sim`, which is `SequenceMatcher(None, normalize(a), normalize(b)).ratio()`. There is no JS equivalent — Ratcliff/Obershelp with CPython's specific longest-match tie-breaking. The port below is verified exact over 3,908 pairs (V5).

**Files:**
- Create: `frontend/lib/server/similarity.ts`
- Test: `frontend/lib/server/__tests__/similarity.test.ts`

**Interfaces:**
- Consumes: `normalizeTitle` from `lib/server/dedup.ts`.
- Produces: `ratio(a: string, b: string): number`, `titleSim(a: string | null, b: string | null): number`, `STRONG_SIM = 0.85`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/similarity.test.ts
import { describe, test, expect } from 'vitest';
import { ratio, titleSim, STRONG_SIM } from '../similarity';

describe('SequenceMatcher.ratio port', () => {
  // Expected values produced by CPython:
  //   from difflib import SequenceMatcher; SequenceMatcher(None, a, b).ratio()
  test('matches CPython on identical, disjoint and partial overlaps', () => {
    expect(ratio('dune', 'dune')).toBe(1.0);
    expect(ratio('', '')).toBe(1.0); // length 0 -> Python returns 1.0, not 0.0
    expect(ratio('abc', '')).toBe(0.0);
    expect(ratio('abcd', 'bcde')).toBe(0.75);
    expect(ratio('the hobbit', 'the hobbits')).toBeCloseTo(0.9523809523809523, 15);
    expect(ratio('mistborn', 'mistborn the final empire')).toBeCloseTo(
      0.48484848484848486,
      15
    );
    expect(ratio('kindred', 'exhalation')).toBeCloseTo(0.11764705882352941, 15);
  });

  test('finds the earliest longest match, like CPython', () => {
    // "ab" occurs twice in b; CPython anchors on the first.
    expect(ratio('ab', 'abxab')).toBeCloseTo(0.5714285714285714, 15);
  });
});

describe('titleSim', () => {
  test('normalizes before comparing (subtitle and parentheticals dropped)', () => {
    expect(titleSim('Dune', 'Dune: Special Edition')).toBe(1.0);
    expect(titleSim('The Hobbit', 'The Hobbit (Illustrated)')).toBe(1.0);
    expect(titleSim('Mistborn (Mistborn, #1)', 'Mistborn')).toBe(1.0);
  });

  test('null-safe', () => {
    expect(titleSim(null, 'dune')).toBe(0.0);
    expect(titleSim(null, null)).toBe(1.0); // both normalize to "" -> Python's length-0 case
  });

  test('PYTHON QUIRK: sibling subtitles collide because normalizeTitle drops them', () => {
    // "Exodus: The Helium Sea" and "Exodus: The Archimedes Engine" are different
    // books, but _normalize_title truncates at ':' so both become "exodus".
    // recommend.py has always behaved this way (unlike the add-book flow, which
    // Chase fixed with _same_work). Reproduced deliberately -- do NOT "fix" it here.
    expect(titleSim('Exodus: The Helium Sea', 'Exodus: The Archimedes Engine')).toBe(1.0);
    expect(1.0).toBeGreaterThanOrEqual(STRONG_SIM);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/similarity.test.ts
```
Expected: FAIL — `Cannot find module '../similarity'`.

- [ ] **Step 3: Implement**

```ts
// frontend/lib/server/similarity.ts
/**
 * Port of Python's difflib.SequenceMatcher(None, a, b).ratio(), used by
 * enrich._title_sim and therefore by recommend._fuzzy_duplicate.
 *
 * Verified exact against CPython over 3,908 string pairs (book titles, random
 * strings over [a-z0-9 ], and the 199/200/250-character autojunk boundary): zero
 * mismatches, and zero disagreements on the >= STRONG_SIM decision.
 *
 * Faithful to CPython's algorithm, not merely to its output:
 *  - find_longest_match's j2len DP picks the EARLIEST longest block (ties in a
 *    first, then in b), which is why `bestsize` is only updated on a strict `>`.
 *  - The four extension loops are kept even though they are no-ops when isjunk is
 *    None and autojunk does not fire, so the code still reads as the original.
 *  - get_matching_blocks recurses via an explicit LIFO stack (CPython uses
 *    queue.pop()), then sorts and merges adjacent blocks.
 *  - _calculate_ratio returns 1.0 when both inputs are empty, NOT 0.0.
 */
import { normalizeTitle } from './dedup';

/** enrich._STRONG_SIM. */
export const STRONG_SIM = 0.85;

function buildB2J(b: string): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    const arr = b2j.get(ch);
    if (arr) arr.push(i);
    else b2j.set(ch, [i]);
  }
  // CPython's autojunk heuristic: for sequences of length >= 200, an element
  // appearing in more than 1% of positions is treated as junk (dropped from b2j).
  // Normalized titles never reach 200 characters, but the branch is ported so the
  // function stays correct if a caller ever passes something longer.
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [ch, idxs] of [...b2j.entries()]) {
      if (idxs.length > ntest) b2j.set(ch, []);
    }
  }
  return b2j;
}

function findLongestMatch(
  a: string,
  b: string,
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number
): [number, number, number] {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const idxs = b2j.get(a[i]) ?? [];
    for (const j of idxs) {
      if (j < blo) continue;
      if (j >= bhi) break; // b2j lists are ascending, so this is CPython's `break`
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }

  // CPython extends the block over adjacent equal elements. With isjunk=None and
  // no autojunk the junk set is empty, so both junk loops collapse into these two.
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (
    besti + bestsize < ahi &&
    bestj + bestsize < bhi &&
    a[besti + bestsize] === b[bestj + bestsize]
  ) {
    bestsize++;
  }
  return [besti, bestj, bestsize];
}

function matchingBlocks(a: string, b: string): Array<[number, number, number]> {
  const b2j = buildB2J(b);
  const stack: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  const blocks: Array<[number, number, number]> = [];

  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) stack.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) stack.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);

  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent: Array<[number, number, number]> = [];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([a.length, b.length, 0]);
  return nonAdjacent;
}

/** SequenceMatcher(None, a, b).ratio(). */
export function ratio(a: string, b: string): number {
  let matches = 0;
  for (const [, , k] of matchingBlocks(a, b)) matches += k;
  const length = a.length + b.length;
  return length ? (2.0 * matches) / length : 1.0;
}

/** enrich._title_sim: ratio over the SUBTITLE-STRIPPED normalized titles. */
export function titleSim(a: string | null, b: string | null): number {
  return ratio(normalizeTitle(a), normalizeTitle(b));
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/similarity.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write lib/server/similarity.ts lib/server/__tests__/similarity.test.ts
git add frontend/lib/server/similarity.ts frontend/lib/server/__tests__/similarity.test.ts
git commit -m "feat(node): port difflib.SequenceMatcher.ratio for title similarity"
```

---

## Task 4: Catalog discovery endpoints

`recommend.py` uses four catalog functions Node does not have yet. All four are thin wrappers over the existing `getJson` + `Candidate` machinery in `catalog.ts`.

**Files:**
- Modify: `frontend/lib/server/catalog.ts` (append after `searchBooks`)
- Test: `frontend/lib/server/__tests__/catalog-discovery.test.ts` (new)

**Interfaces:**
- Consumes: `getJson`, `Candidate`, `googleBooksQuery` from `catalog.ts`.
- Produces: `googleBooksSubject(db, subject, maxResults?)`, `googleBooksAuthor(db, author, maxResults?)`, `openlibrarySubject(db, subject, maxResults?)` — all `Promise<Candidate[]>`; `openlibraryWorkDescription(db, workKey)` — `Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/catalog-discovery.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import {
  googleBooksSubject,
  googleBooksAuthor,
  openlibrarySubject,
  openlibraryWorkDescription,
} from '../catalog';

// Hermeticity: a developer with GOOGLE_BOOKS_API_KEY exported would produce a
// `key=` query param that no fixture URL matches, failing every test here.
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_BOOKS_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_BOOKS_API_KEY;
  else process.env.GOOGLE_BOOKS_API_KEY = savedKey;
});

describe('googleBooksSubject / googleBooksAuthor', () => {
  test('quote the term and delegate to googleBooksQuery', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay(
      {
        'https://www.googleapis.com/books/v1/volumes?q=subject%3A%22space+opera%22&maxResults=3':
          { status: 200, body: { items: [{ id: 'g1', volumeInfo: { title: 'S' } }] } },
        'https://www.googleapis.com/books/v1/volumes?q=inauthor%3A%22Ursula+K.+Le+Guin%22&maxResults=3':
          { status: 200, body: { items: [{ id: 'g2', volumeInfo: { title: 'A' } }] } },
      },
      (u) => seen.push(u)
    );
    try {
      expect((await googleBooksSubject(db, 'space opera', 3))[0].resolved_id).toBe('g1');
      expect((await googleBooksAuthor(db, 'Ursula K. Le Guin', 3))[0].resolved_id).toBe('g2');
      expect(seen).toHaveLength(2);
    } finally {
      restore();
      await close();
    }
  });
});

describe('openlibrarySubject', () => {
  test('slugifies the subject and maps works to candidates', async () => {
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay({
      'https://openlibrary.org/subjects/science_fiction.json?limit=2': {
        status: 200,
        body: {
          works: [
            {
              key: '/works/OL1W',
              title: 'A Work',
              authors: [{ name: 'An Author' }],
              cover_id: 42,
              first_publish_year: 1999,
            },
            { key: '/works/OL2W', title: 'No Author Work', authors: [], cover_id: null },
          ],
        },
      },
    });
    try {
      const out = await openlibrarySubject(db, 'Science Fiction!', 2);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({
        source: 'openlibrary',
        resolved_id: '/works/OL1W',
        title: 'A Work',
        author: 'An Author',
        subjects: ['Science Fiction!'], // Python echoes the CALLER's subject, unslugged
        cover_url: 'https://covers.openlibrary.org/b/id/42-M.jpg',
        year: 1999,
        language: null, // Python's dict has no "language" key at all
      });
      expect(out[1].author).toBeNull();
      expect(out[1].cover_url).toBeNull();
      expect(out[1].year).toBeNull();
    } finally {
      restore();
      await close();
    }
  });

  test('returns [] for a subject that slugifies to empty, without any HTTP call', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      expect(await openlibrarySubject(db, '!!!', 5)).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });
});

describe('openlibraryWorkDescription', () => {
  test('strips the leading slash and unwraps both description shapes', async () => {
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay({
      'https://openlibrary.org/works/OL1W.json': {
        status: 200,
        body: { description: 'A plain string.' },
      },
      'https://openlibrary.org/works/OL2W.json': {
        status: 200,
        body: { description: { type: '/type/text', value: 'A typed value.' } },
      },
      'https://openlibrary.org/works/OL3W.json': {
        status: 200,
        body: { notes: 'Falls back to notes.' },
      },
      'https://openlibrary.org/works/OL4W.json': { status: 200, body: {} },
      'https://openlibrary.org/works/OL5W.json': { status: 404 },
    });
    try {
      expect(await openlibraryWorkDescription(db, '/works/OL1W')).toBe('A plain string.');
      expect(await openlibraryWorkDescription(db, 'works/OL2W')).toBe('A typed value.');
      expect(await openlibraryWorkDescription(db, '/works/OL3W')).toBe('Falls back to notes.');
      expect(await openlibraryWorkDescription(db, '/works/OL4W')).toBeNull();
      expect(await openlibraryWorkDescription(db, '/works/OL5W')).toBeNull();
      expect(await openlibraryWorkDescription(db, '')).toBeNull();
    } finally {
      restore();
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/catalog-discovery.test.ts
```
Expected: FAIL — the four functions are not exported from `catalog.ts`.

- [ ] **Step 3: Implement**

Append to `frontend/lib/server/catalog.ts`:

```ts
// --- Discovery retrieval (the two-stage recommender) -----------------------
// Ports of catalog.py:215-236, 403-419, 617-649. Unlike the enrichment helpers
// above (which resolve a KNOWN book), these surface NEW candidates and return the
// same normalized Candidate shape, so recommendRun.ts treats every source uniformly.

export async function googleBooksQueryDiscovery(
  db: Db,
  q: string,
  maxResults = 10
): Promise<Candidate[]> {
  return googleBooksQuery(db, q, maxResults);
}

export async function googleBooksSubject(
  db: Db,
  subject: string,
  maxResults = 10
): Promise<Candidate[]> {
  return googleBooksQuery(db, `subject:"${subject}"`, maxResults);
}

export async function googleBooksAuthor(
  db: Db,
  author: string,
  maxResults = 10
): Promise<Candidate[]> {
  return googleBooksQuery(db, `inauthor:"${author}"`, maxResults);
}

/** catalog.py::_ol_subject_slug — Open Library's subjects API keys on lowercase,
 *  underscore-joined slugs. Python's `.strip("_")` removes leading AND trailing runs. */
function olSubjectSlug(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export async function openlibrarySubject(
  db: Db,
  subject: string,
  maxResults = 10
): Promise<Candidate[]> {
  const slug = olSubjectSlug(subject);
  if (!slug) return [];
  const url = `https://openlibrary.org/subjects/${slug}.json?limit=${maxResults}`;
  const data = (await getJson(db, url, 'openlibrary')) as any;
  if (!data) return [];
  return (data.works ?? []).slice(0, maxResults).map((work: any): Candidate => {
    const coverId = work.cover_id;
    return {
      source: 'openlibrary',
      resolved_id: work.key ?? null,
      title: work.title ?? null,
      // Python: ((work.get("authors") or [{}])[0].get("name") if work.get("authors") else None)
      // -> an empty or missing authors list yields None, as does a first entry with no name.
      author: work.authors?.length ? (work.authors[0]?.name ?? null) : null,
      // Python echoes the CALLER's subject string, not the slug.
      subjects: [subject],
      cover_url: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null,
      year: work.first_publish_year ?? null,
      // Python's dict has no "language" key at all, so cand.get("language") is None
      // and _language_ok always passes these through. null reproduces that.
      language: null,
      raw: work,
    };
  });
}

/** catalog.py::_ol_description — description wins over notes; a typed dict unwraps to .value. */
function olDescription(record: any): string | null {
  const desc = record?.description || record?.notes;
  if (desc && typeof desc === 'object' && !Array.isArray(desc)) return desc.value ?? null;
  return typeof desc === 'string' ? desc : null;
}

/**
 * Fetch a description from an OL Work record (e.g. '/works/OL82584W').
 * OL Edition/ISBN records rarely carry descriptions; the Work record is the
 * authoritative place. Cached in catalog_cache, so repeat calls are free.
 */
export async function openlibraryWorkDescription(
  db: Db,
  workKey: string
): Promise<string | null> {
  if (!workKey) return null;
  const key = workKey.replace(/^\/+/, ''); // Python's lstrip("/")
  const data = await getJson(db, `https://openlibrary.org/${key}.json`, 'openlibrary');
  if (!data) return null;
  return olDescription(data);
}
```

Delete `googleBooksQueryDiscovery` — it was listed above only to make the mapping from `catalog.py::googlebooks_query` explicit, and `googleBooksQuery` already covers it. Do not export a second name for the same function.

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/catalog-discovery.test.ts lib/server/__tests__/catalog-search.test.ts lib/server/__tests__/catalog-fetch.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write lib/server/catalog.ts lib/server/__tests__/catalog-discovery.test.ts
git add frontend/lib/server/catalog.ts frontend/lib/server/__tests__/catalog-discovery.test.ts
git commit -m "feat(node): catalog subject/author/work-description discovery endpoints"
```

---

## Task 5: Candidate filters

Pure predicates, no database, no network. Every one is shared by all three 3c waves.

**Files:**
- Create: `frontend/lib/server/recFilters.ts`
- Test: `frontend/lib/server/__tests__/rec-filters.test.ts`

**Interfaces:**
- Consumes: `normalizeTitle`, `surname` (`dedup.ts`); `titleSim`, `STRONG_SIM` (`similarity.ts`).
- Produces: `dedupKey`, `EMPTY_DEDUP_KEY`, `allowedLanguages`, `languageOk`, `seriesInfo`, `seriesOk`, `fuzzyDuplicate`, `isLearnerEdition`, `applyAuthorCaps`, `subjectHits`, `applyDirectiveConstraints`, `MAX_PER_AUTHOR`, `MAX_LIBRARY_AUTHOR_SHARE`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/rec-filters.test.ts
import { describe, test, expect } from 'vitest';
import {
  dedupKey,
  EMPTY_DEDUP_KEY,
  allowedLanguages,
  languageOk,
  seriesInfo,
  seriesOk,
  fuzzyDuplicate,
  isLearnerEdition,
  applyAuthorCaps,
  subjectHits,
  applyDirectiveConstraints,
} from '../recFilters';

describe('dedupKey', () => {
  test('is normalized title + author surname', () => {
    expect(dedupKey('Dune: Special Edition', 'Frank Herbert')).toBe(dedupKey('Dune', 'Herbert'));
    expect(dedupKey(null, null)).toBe(EMPTY_DEDUP_KEY);
  });

  test('separator cannot be forged from normalized text', () => {
    // normalizeTitle emits only [a-z0-9 ], so "a b"/"" and "a"/"b" cannot collide.
    expect(dedupKey('a b', null)).not.toBe(dedupKey('a', 'b'));
  });
});

describe('language', () => {
  test('empty library languages default to en', () => {
    expect(allowedLanguages(new Set())).toEqual(new Set(['en']));
    expect(allowedLanguages(new Set(['fr', 'en']))).toEqual(new Set(['fr', 'en']));
  });

  test('unknown language always passes; known must be allowed', () => {
    const allowed = new Set(['en']);
    expect(languageOk(null, allowed)).toBe(true);
    expect(languageOk('', allowed)).toBe(true);
    expect(languageOk('en', allowed)).toBe(true);
    expect(languageOk('fr', allowed)).toBe(false);
  });
});

describe('series', () => {
  test('parses the trailing (Series, #N) marker', () => {
    expect(seriesInfo('Mistborn (Mistborn, #6)')).toEqual(['mistborn', 6]);
    expect(seriesInfo('Words of Radiance (The Stormlight Archive, Book 2)')).toEqual([
      'the stormlight archive',
      2,
    ]);
    expect(seriesInfo('Dune (Dune Chronicles, Vol. 1)')).toEqual(['dune chronicles', 1]);
    expect(seriesInfo('Just A Title')).toBeNull();
    expect(seriesInfo(null)).toBeNull();
  });

  test('is not stateful across calls (regex must not be global)', () => {
    expect(seriesInfo('Mistborn (Mistborn, #6)')).toEqual(['mistborn', 6]);
    expect(seriesInfo('Mistborn (Mistborn, #6)')).toEqual(['mistborn', 6]);
  });

  test('blocks book N>1 of an unstarted series, allows everything else', () => {
    const owned = new Map([['mistborn', new Set([1])]]);
    expect(seriesOk('Mistborn (Mistborn, #2)', owned)).toBe(true);
    expect(seriesOk('Elantris (Elantris, #2)', owned)).toBe(false);
    expect(seriesOk('Elantris (Elantris, #1)', owned)).toBe(true); // position <= 1
    expect(seriesOk('An Unmarked Standalone', owned)).toBe(true); // no marker -> pass
  });
});

describe('fuzzyDuplicate', () => {
  test('catches near-identical normalized titles regardless of author', () => {
    expect(fuzzyDuplicate('The Hobbit (Illustrated)', ['The Hobbit'])).toBe(true);
    expect(fuzzyDuplicate('Kindred', ['The Hobbit', 'Dune'])).toBe(false);
    expect(fuzzyDuplicate(null, ['The Hobbit'])).toBe(false);
    expect(fuzzyDuplicate('Anything', [])).toBe(false);
  });
});

describe('isLearnerEdition', () => {
  test('flags graded-reader / ESL phrasing in title or subjects', () => {
    expect(isLearnerEdition({ title: 'Dune: A Graded Reader', subjects: [] })).toBe(true);
    expect(isLearnerEdition({ title: 'Dune', subjects: ['Readers for foreign speakers'] })).toBe(
      true
    );
    expect(isLearnerEdition({ title: 'Dune', subjects: ['Science Fiction'] })).toBe(false);
    expect(isLearnerEdition({ title: null, subjects: null })).toBe(false);
  });
});

describe('applyAuthorCaps', () => {
  const c = (title: string, author: string | null) => ({ title, author });

  test('caps each author at 2 and never caps authorless candidates', () => {
    const out = applyAuthorCaps(
      [c('a', 'Ursula Le Guin'), c('b', 'Ursula Le Guin'), c('c', 'Ursula Le Guin'), c('d', null)],
      new Set()
    );
    expect(out.map((x) => x.title)).toEqual(['a', 'b', 'd']);
  });

  test('trims library-author candidates past 40% and reorders new authors first', () => {
    // 5 kept -> maxLib = trunc(5 * 0.4) = 2. 3 library-author candidates -> 1 dropped.
    const out = applyAuthorCaps(
      [c('lib1', 'Herbert'), c('new1', 'Chiang'), c('lib2', 'Butler'), c('new2', 'Jemisin'), c('lib3', 'Herbert')],
      new Set(['herbert', 'butler'])
    );
    expect(out.map((x) => x.title)).toEqual(['new1', 'new2', 'lib1', 'lib2']);
  });

  test('maxLib floors at 1, and an empty input returns empty', () => {
    const out = applyAuthorCaps([c('lib1', 'Herbert'), c('lib2', 'Butler')], new Set(['herbert', 'butler']));
    expect(out.map((x) => x.title)).toEqual(['lib1']); // trunc(2*0.4)=0 -> max(1,0)=1
    expect(applyAuthorCaps([], new Set())).toEqual([]);
  });
});

describe('subjectHits', () => {
  test('matches whole words only, and escapes regex metacharacters', () => {
    expect(subjectHits('war', 'war fiction')).toBe(true);
    expect(subjectHits('war', 'warmth')).toBe(false);
    expect(subjectHits('war', 'steward')).toBe(false);
    expect(subjectHits('sci-fi', 'sci-fi novels')).toBe(true);
    expect(subjectHits('c++', 'c++ programming')).toBe(true); // would throw if unescaped
  });
});

describe('applyDirectiveConstraints', () => {
  const cand = (over: Record<string, unknown> = {}) => ({
    title: 't',
    author: 'Frank Herbert',
    year: 1990,
    subjects: ['Science Fiction'],
    ...over,
  });

  test('an empty constraints object is a no-op (Python: {} is falsy)', () => {
    const all = [cand()];
    expect(applyDirectiveConstraints(all, {})).toBe(all);
  });

  test('filters on year range, but only for integer years', () => {
    expect(applyDirectiveConstraints([cand({ year: 1980 })], { min_year: 1990 })).toEqual([]);
    expect(applyDirectiveConstraints([cand({ year: 2000 })], { max_year: 1990 })).toEqual([]);
    expect(applyDirectiveConstraints([cand({ year: null })], { min_year: 1990 })).toHaveLength(1);
    // Python's isinstance(year, int) is False for a float -> the candidate passes.
    expect(applyDirectiveConstraints([cand({ year: 1980.5 })], { min_year: 1990 })).toHaveLength(1);
  });

  test('drops candidates whose subjects hit an excluded term', () => {
    expect(
      applyDirectiveConstraints([cand({ subjects: ['War Fiction'] })], {
        exclude_subjects: ['war'],
      })
    ).toEqual([]);
    expect(
      applyDirectiveConstraints([cand({ subjects: ['Warmth'] })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
    expect(
      applyDirectiveConstraints([cand({ subjects: null })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
  });

  test('PYTHON QUIRK: exclude_authors compares a SURNAME against a full name', () => {
    // Python: `_surname(cand["author"]).lower() in {a.lower() for a in exclude_authors}`.
    // "herbert" is never equal to "frank herbert", so a full-name exclude silently
    // does nothing. Reproduced deliberately -- do NOT "fix" it here.
    expect(
      applyDirectiveConstraints([cand()], { exclude_authors: ['Frank Herbert'] })
    ).toHaveLength(1);
    expect(applyDirectiveConstraints([cand()], { exclude_authors: ['Herbert'] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/rec-filters.test.ts
```
Expected: FAIL — `Cannot find module '../recFilters'`.

- [ ] **Step 3: Implement**

```ts
// frontend/lib/server/recFilters.ts
/**
 * Pure candidate predicates ported from mylibrary/recommend.py. No database, no
 * network. Shared by /recommend (wave 3c-1), /books/{id}/similar (3c-2) and
 * /discover (3c-3), which is why they live apart from the orchestrators.
 */
import { normalizeTitle, surname } from './dedup';
import { titleSim, STRONG_SIM } from './similarity';

/** recommend.py:59-60 tuning knobs. */
export const MAX_PER_AUTHOR = 2;
export const MAX_LIBRARY_AUTHOR_SHARE = 0.4;

/**
 * recommend._dedup_key. Python returns a (normalized title, surname) TUPLE and uses
 * it as a set/dict key; JS has no tuple keys, so it is flattened with a NUL
 * separator. Safe because normalizeTitle and surname emit only [a-z0-9 ], so no
 * title/author pair can forge a different pair's key.
 */
export function dedupKey(title: string | null, author: string | null): string {
  return `${normalizeTitle(title)}\u0000${surname(author)}`;
}

/** Python's `key == ("", "")` guard in _assemble. */
export const EMPTY_DEDUP_KEY = dedupKey(null, null);

/** recommend._allowed_languages: an empty library language set means English only. */
export function allowedLanguages(libraryLanguages: Set<string>): Set<string> {
  return libraryLanguages.size ? new Set(libraryLanguages) : new Set(['en']);
}

/** recommend._language_ok: unknown language always passes; a known one must be allowed. */
export function languageOk(lang: string | null | undefined, allowed: Set<string>): boolean {
  if (!lang) return true;
  return allowed.has(lang);
}

// Not global: a /g regex carries lastIndex between .exec calls and would return
// null on every other invocation.
const SERIES_PAREN_RE = /\(([^()]+?),\s*(?:#|book\s+|vol\.?\s+|volume\s+)(\d{1,3})\)/i;

/**
 * recommend._series_info: pull (series name, position) out of a Goodreads/OL-style
 * trailing parenthetical like '(Mistborn, #6)' or '(The Stormlight Archive, Book 2)'.
 * Most books carry no such marker; null just means we cannot tell from the title.
 */
export function seriesInfo(title: string | null): [string, number] | null {
  if (!title) return null;
  const m = SERIES_PAREN_RE.exec(title);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim().toLowerCase();
  if (!name) return null;
  return [name, parseInt(m[2], 10)];
}

/**
 * recommend._series_ok: block book N (N > 1) of a series the reader has not started.
 * Titles with no detectable marker always pass -- dropping candidates on a guess would
 * silently remove unrelated standalones too.
 */
export function seriesOk(title: string | null, librarySeries: Map<string, Set<number>>): boolean {
  const info = seriesInfo(title);
  if (info === null) return true;
  const [name, position] = info;
  if (position <= 1) return true;
  const owned = librarySeries.get(name);
  if (!owned) return false;
  for (const p of owned) if (p < position) return true;
  return false;
}

/**
 * recommend._fuzzy_duplicate: catches same-work editions that survive the exact
 * (title, author) dedup key -- an abridged or reissued edition credited to a
 * different "author". Author agreement is deliberately NOT required.
 *
 * Python iterates `set(library_titles)`, whose order is arbitrary; irrelevant here
 * because the result is a short-circuiting `any()`.
 */
export function fuzzyDuplicate(title: string | null, libraryTitles: string[]): boolean {
  if (!title) return false;
  for (const lt of new Set(libraryTitles)) {
    if (titleSim(title, lt) >= STRONG_SIM) return true;
  }
  return false;
}

const LEARNER_EDITION_MARKERS = [
  'graded reader',
  'for foreign speakers',
  'for esl',
  'for efl',
  'esl reader',
  'efl reader',
  'english language learners',
  'simplified english edition',
  "learner's edition",
  'students of english',
];

/** recommend._is_learner_edition: graded-reader / ESL reissues are dropped outright. */
export function isLearnerEdition(cand: {
  title?: string | null;
  subjects?: string[] | null;
}): boolean {
  const haystack = [cand.title || '', ...(cand.subjects ?? [])].join(' | ').toLowerCase();
  return LEARNER_EDITION_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * recommend._apply_author_caps: cap per-author candidates and the overall share from
 * authors already in the library, so small libraries do not return same-author clones.
 *
 * The library-author trim REORDERS (new authors first). Python notes that capPool
 * re-sorts by retrieval_pool downstream, so the ordering is absorbed -- but it is
 * still observable when the pool is already under the cap, so it is reproduced exactly.
 */
export function applyAuthorCaps<T extends { author?: string | null }>(
  candidates: T[],
  libraryAuthors: Set<string>
): T[] {
  const perAuthor = new Map<string, number>();
  const kept: T[] = [];
  for (const c of candidates) {
    const a = surname(c.author ?? null);
    if (a) {
      const n = perAuthor.get(a) ?? 0;
      if (n >= MAX_PER_AUTHOR) continue;
      perAuthor.set(a, n + 1);
    }
    kept.push(c);
  }

  const total = kept.length;
  if (!total) return kept;
  const lib = kept.filter((c) => libraryAuthors.has(surname(c.author ?? null)));
  const non = kept.filter((c) => !libraryAuthors.has(surname(c.author ?? null)));
  // Python's int() truncates toward zero, unlike Math.round.
  const maxLib = Math.max(1, Math.trunc(total * MAX_LIBRARY_AUTHOR_SHARE));
  if (lib.length > maxLib) return [...non, ...lib.slice(0, maxLib)];
  return kept;
}

/**
 * Python's `re.escape` escapes every character outside [A-Za-z0-9_]; this escapes
 * only JS regex metacharacters. The two produce equivalent patterns -- Python's extra
 * escapes (space, '-', '#') are semantic no-ops -- and this form stays valid under a
 * future /u flag, which blanket backslash-escaping would not.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * recommend._subject_hits: true when `term` appears as a whole word inside `subject`
 * (both already lowercased). Whole-word so excluding 'war' does not trip 'warmth'.
 *
 * DEVIATION: Python's `\b` is Unicode-aware for str patterns; JS's is ASCII-only.
 * Both operands here are lowercased English subject headings, where the two agree.
 */
export function subjectHits(term: string, subject: string): boolean {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(subject);
}

export interface ConstrainableCandidate {
  author?: string | null;
  year?: number | null;
  subjects?: string[] | null;
}

/**
 * recommend._apply_directive_constraints: filter assembled candidates by the standing
 * directive's hard constraints (year range, exclude_subjects, exclude_authors).
 * Language is handled upstream by overriding the signal's allowed-language set.
 * Unknown/missing fields always PASS -- never drop a candidate for lacking metadata.
 */
export function applyDirectiveConstraints<T extends ConstrainableCandidate>(
  candidates: T[],
  constraints: Record<string, unknown>
): T[] {
  // Python's `if not constraints` -- an EMPTY object is falsy there but truthy in JS.
  if (!constraints || Object.keys(constraints).length === 0) return candidates;

  const minYear = constraints.min_year as number | null | undefined;
  const maxYear = constraints.max_year as number | null | undefined;
  const excludeSubjects = ((constraints.exclude_subjects as string[] | null) ?? []).map((s) =>
    s.toLowerCase()
  );
  const excludeAuthors = new Set(
    ((constraints.exclude_authors as string[] | null) ?? []).map((a) => a.toLowerCase())
  );

  return candidates.filter((cand) => {
    const year = cand.year;
    // Python's isinstance(year, int): a float year fails the check and passes the filter.
    if (typeof year === 'number' && Number.isInteger(year)) {
      if (minYear != null && year < minYear) return false;
      if (maxYear != null && year > maxYear) return false;
    }
    if (excludeSubjects.length) {
      const subjects = (cand.subjects ?? []).map((s) => String(s).toLowerCase());
      for (const term of excludeSubjects) {
        if (subjects.some((s) => subjectHits(term, s))) return false;
      }
    }
    // PYTHON QUIRK: a candidate's SURNAME is compared against the constraint's full
    // lowercased author string, so `exclude_authors: ["John Ringo"]` never matches.
    // Reproduced on purpose.
    if (excludeAuthors.size && excludeAuthors.has(surname(cand.author ?? null).toLowerCase())) {
      return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/rec-filters.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write lib/server/recFilters.ts lib/server/__tests__/rec-filters.test.ts
git add frontend/lib/server/recFilters.ts frontend/lib/server/__tests__/rec-filters.test.ts
git commit -m "feat(node): port the recommender's candidate filters"
```

---

## Task 6: The library signal

`_build_signal` is the recommender's single read of the library: exclusion sets, loved books, top subjects/authors, traits, feedback steering, and the standing directive. Its output feeds both Claude prompts, so every ordering decision here is load-bearing.

**Files:**
- Create: `frontend/lib/server/recSignal.ts`
- Test: `frontend/lib/server/__tests__/rec-signal.test.ts`

**Interfaces:**
- Consumes: `dedupKey`, `seriesInfo` (`recFilters.ts`); `effectiveRating`, `round2`, `pyFloat`, `type PyFloat` (`serialize.ts`); `surname` (`dedup.ts`).
- Produces: `buildSignal(db, userId): Promise<RecSignal>`, `isColdStart(signal)`, `mostCommon(counts, n)`, the `RecSignal`/`LovedBook`/`TraitPayload` types, and the knobs `LOVED_MIN`, `LOVED_SAMPLE`, `TOP_SUBJECTS`, `TOP_AUTHORS`, `COLD_START_LOVED`, `COLD_START_RATED`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/rec-signal.test.ts
import { describe, test, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { buildSignal, isColdStart, mostCommon } from '../recSignal';
import { isPyFloat } from '../serialize';

describe('mostCommon', () => {
  test('sorts by count desc, breaking ties by insertion order (Counter.most_common)', () => {
    const counts = new Map([
      ['b', 2],
      ['a', 2],
      ['c', 1],
    ]);
    expect(mostCommon(counts, 2)).toEqual(['b', 'a']);
    expect(mostCommon(counts, 10)).toEqual(['b', 'a', 'c']);
    expect(mostCommon(new Map(), 3)).toEqual([]);
  });
});

describe('buildSignal', () => {
  test('summarizes the seeded library the way Python does', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const s = await buildSignal(db, 'local');

      // loved = effective_rating >= 4, sorted by (rating, read_year||0) DESC, stable.
      // Dune (5, read 2025) leads; the other 5s keep id order because read_year is null.
      expect(s.loved.map((b) => b.id)).toEqual([1, 2, 3, 7, 11, 12, 13, 4, 10, 14]);
      expect(s.loved[0]).toMatchObject({ id: 1, title: 'Dune', rating: 5, read_year: 2025 });
      expect(s.loved[1].read_year).toBeNull();
      expect(s.loved[0].subjects).toHaveLength(3);

      // Exclusion sets cover the WHOLE library, not just loved books.
      expect(s.library_keys.size).toBeGreaterThanOrEqual(14);
      expect(s.library_isbns.has('9780441013593')).toBe(true);
      expect(s.library_titles).toContain('Piranesi'); // to-read shelf still excluded
      expect(s.library_authors.has('herbert')).toBe(true);

      // Another tenant's books never leak in.
      expect(s.library_titles).not.toContain("Someone Else's Book");

      expect(s.rated_count).toBeGreaterThan(0);
      expect(s.top_subjects.length).toBeLessThanOrEqual(8);
      expect(s.top_authors.length).toBeLessThanOrEqual(6);

      // Traits: rejected ones are dropped; confidence and user_weight are PyFloats so
      // they render as 0.95 / 1.0 rather than JS's 0.95 / 1.
      expect(s.traits.every((t) => t.status !== 'rejected')).toBe(true);
      expect(isPyFloat(s.traits[0].confidence)).toBe(true);
      expect(isPyFloat(s.traits[0].user_weight)).toBe(true);

      // Ordered mappings must be Maps, not objects (V8 reorders integer-like keys).
      expect(s.reject_reason_counts).toBeInstanceOf(Map);
      expect(s.library_series).toBeInstanceOf(Map);
    } finally {
      await close();
    }
  });

  test('an empty library yields an empty, well-formed signal', async () => {
    const { db, close } = await makeTestDb();
    try {
      const s = await buildSignal(db, 'local');
      expect(s.loved).toEqual([]);
      expect(s.rated_count).toBe(0);
      expect(s.traits).toEqual([]);
      expect(s.directive_text).toBeNull();
      expect(s.directive_constraints).toEqual({});
      expect(isColdStart(s)).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('isColdStart', () => {
  test('trips below either threshold', () => {
    const mk = (loved: number, rated: number) =>
      ({ loved: Array(loved).fill({}), rated_count: rated }) as any;
    expect(isColdStart(mk(8, 12))).toBe(false);
    expect(isColdStart(mk(7, 12))).toBe(true);
    expect(isColdStart(mk(8, 11))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/rec-signal.test.ts
```
Expected: FAIL — `Cannot find module '../recSignal'`.

- [ ] **Step 3: Implement**

```ts
// frontend/lib/server/recSignal.ts
/**
 * Port of recommend._build_signal — the recommender's single read of the library.
 *
 * DEVIATION (deliberate, same as wave 3b's profileTiers): every query here carries an
 * explicit ORDER BY that Python does not have. Python relies on Postgres's arbitrary
 * row order, which happens to be insertion order on a freshly-seeded table. That is
 * good enough for Python but not for a byte-identical prompt assertion, so Node pins
 * the order. If a prompt-parity test ever disagrees with the recorded fixture, adjust
 * the SEED -- do not remove these ORDER BYs.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { surname } from './dedup';
import { dedupKey, seriesInfo } from './recFilters';
import { effectiveRating, pyFloat, round2, type PyFloat } from './serialize';

/** recommend.py:51-62 tuning knobs. */
export const TOP_SUBJECTS = 8;
export const TOP_AUTHORS = 6;
export const LOVED_MIN = 4; // effective rating at/above which a book counts as "loved"
export const LOVED_SAMPLE = 20; // loved books shown to Claude for context
export const COLD_START_LOVED = 8;
export const COLD_START_RATED = 12;

const REJECTED_STATUS = 'rejected';

export interface LovedBook {
  id: number;
  title: string;
  author: string | null;
  rating: number;
  year: number | null;
  subjects: string[];
  read_year: number | null;
}

export interface TraitPayload {
  id: number;
  claim: string;
  polarity: string | null;
  confidence: PyFloat;
  user_weight: PyFloat;
  status: string;
}

export interface RejectedNote {
  title: string;
  author: string | null;
  note: string;
}

export interface RecSignal {
  library_keys: Set<string>;
  library_isbns: Set<string>;
  library_languages: Set<string>;
  library_authors: Set<string>;
  library_titles: string[];
  library_series: Map<string, Set<number>>;
  loved: LovedBook[];
  rated_count: number;
  top_subjects: string[];
  top_authors: string[];
  traits: TraitPayload[];
  more_like: string[];
  less_like: string[];
  /** Map, not an object: _user_steering_block joins these in insertion order. */
  reject_reason_counts: Map<string, number>;
  rejected_with_notes: RejectedNote[];
  directive_text: string | null;
  directive_constraints: Record<string, unknown>;
}

/**
 * Twin of collections.Counter.most_common(n): count descending, ties broken by
 * INSERTION order, earliest first. (CPython routes through heapq.nlargest, which
 * decorates each item with a descending order counter, giving exactly this.) The
 * index tiebreak is explicit rather than relying on Array.sort's stability.
 */
export function mostCommon(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .map(([key, count], index) => ({ key, count, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, n)
    .map((e) => e.key);
}

/** recommend._is_cold_start: thin libraries cannot support author/subject inference. */
export function isColdStart(signal: Pick<RecSignal, 'loved' | 'rated_count'>): boolean {
  return (signal.loved?.length ?? 0) < COLD_START_LOVED || (signal.rated_count ?? 0) < COLD_START_RATED;
}

export async function buildSignal(db: Db, userId: string): Promise<RecSignal> {
  const rows = await db
    .select({ b: schema.books, enr: schema.enrichment })
    .from(schema.books)
    // Safe against fan-out: enrichment.book_id carries a UNIQUE index, so this is 1:1.
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));

  const library_keys = new Set<string>();
  const library_isbns = new Set<string>();
  const library_languages = new Set<string>();
  const library_authors = new Set<string>();
  const library_titles: string[] = [];
  const library_series = new Map<string, Set<number>>();
  const loved: LovedBook[] = [];
  const subjectCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  let rated_count = 0;

  for (const { b, enr } of rows) {
    library_keys.add(dedupKey(b.title, b.author));
    if (b.title) library_titles.push(b.title);
    const info = seriesInfo(b.title);
    if (info !== null) {
      const [name, position] = info;
      let owned = library_series.get(name);
      if (!owned) {
        owned = new Set<number>();
        library_series.set(name, owned);
      }
      owned.add(position);
    }
    if (b.isbn13) library_isbns.add(b.isbn13);
    const enrLang = enr?.language ?? null;
    if (enrLang) library_languages.add(enrLang);
    if (b.author) library_authors.add(surname(b.author));

    const rating = effectiveRating(b.appRating, b.goodreadsRating);
    if (rating !== null) rated_count++;
    if (rating === null || rating < LOVED_MIN) continue;

    const subjects = ((enr?.subjects as string[] | null) ?? []) as string[];
    for (const s of subjects) subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
    if (b.author) authorCounts.set(b.author, (authorCounts.get(b.author) ?? 0) + 1);
    // Python's `b.date_read or b.date_added`: a date object is never falsy, so this
    // is a plain null-coalesce, not a truthiness fallback.
    const readDate = b.dateRead ?? b.dateAdded;
    loved.push({
      id: b.id,
      title: b.title,
      author: b.author,
      rating,
      year: b.yearPublished,
      subjects: subjects.slice(0, 8),
      read_year: readDate ? Number(readDate.slice(0, 4)) : null,
    });
  }

  // Explicitly rejected recommendations are excluded too, so they never resurface.
  const rejected = await db
    .select()
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, userId),
        eq(schema.recommendations.status, REJECTED_STATUS)
      )
    )
    .orderBy(asc(schema.recommendations.id));

  const rejected_with_notes: RejectedNote[] = [];
  for (const r of rejected) {
    library_keys.add(dedupKey(r.title, r.author));
    if (r.title) library_titles.push(r.title);
    if (r.isbn13) library_isbns.add(r.isbn13);
    if (r.userNote) {
      rejected_with_notes.push({ title: r.title, author: r.author, note: r.userNote });
    }
  }

  // Python: `loved.sort(key=lambda d: (d["rating"], d["read_year"] or 0), reverse=True)`.
  // reverse=True is STABLE in CPython -- it does not reverse equal elements -- and
  // Array.prototype.sort is stable in V8, so returning 0 on a full tie matches.
  loved.sort((x, y) => y.rating - x.rating || (y.read_year ?? 0) - (x.read_year ?? 0));

  const traitRows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(desc(schema.tasteTraits.inferenceConfidence), asc(schema.tasteTraits.id));

  // Rejected traits are dead to the reranker -- excluded entirely. Each survivor
  // carries its user_weight + status so stage 2 can weight its influence.
  const traits: TraitPayload[] = traitRows
    .filter((t) => (t.status || 'proposed') !== REJECTED_STATUS)
    .map((t) => ({
      id: t.id,
      claim: t.claim,
      polarity: t.polarity,
      // pyFloat so json.dumps parity holds: Python renders 1.0, JSON.stringify renders 1.
      confidence: pyFloat(round2(t.inferenceConfidence)),
      user_weight: pyFloat(t.userWeight ?? 1.0),
      status: t.status || 'proposed',
    }));

  // more/less-like book labels, same join as profile._feedback_context.
  const bookById = new Map(rows.map(({ b }) => [b.id, b]));
  const signalRows = await db
    .select()
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), eq(schema.tasteSignal.targetKind, 'book')))
    .orderBy(asc(schema.tasteSignal.id));

  const more_like: string[] = [];
  const less_like: string[] = [];
  for (const sig of signalRows) {
    if (sig.targetBookId === null) continue;
    // bookById comes from the user-scoped query above, so this preserves Python's
    // `Book.user_id == user_id` filter without a second round trip.
    const book = bookById.get(sig.targetBookId);
    if (book === undefined) continue;
    const label = book.author ? `${book.title} by ${book.author}` : book.title;
    if (sig.direction === 'more') more_like.push(label);
    else if (sig.direction === 'less') less_like.push(label);
  }

  const reasonRows = await db
    .select()
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, userId),
        eq(schema.recommendations.status, REJECTED_STATUS),
        isNotNull(schema.recommendations.rejectReasons)
      )
    )
    .orderBy(asc(schema.recommendations.id));

  const reject_reason_counts = new Map<string, number>();
  for (const r of reasonRows) {
    for (const reason of ((r.rejectReasons as string[] | null) ?? []) as string[]) {
      reject_reason_counts.set(reason, (reject_reason_counts.get(reason) ?? 0) + 1);
    }
  }

  const directiveRows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, userId));
  const directive = directiveRows[0];
  const storedConstraints = (directive?.constraints as Record<string, unknown> | null) ?? null;
  let directive_text: string | null = null;
  let directive_constraints: Record<string, unknown> = {};
  // Python: `if directive is not None and (directive.nl_text or directive.constraints)`.
  // `{}` is FALSY in Python, so a row with no text and empty constraints is ignored
  // entirely -- `!storedConstraints` would not reproduce that in JS.
  if (
    directive &&
    (directive.nlText || (storedConstraints && Object.keys(storedConstraints).length > 0))
  ) {
    directive_text = directive.nlText;
    directive_constraints = storedConstraints ?? {};
  }

  return {
    library_keys,
    library_isbns,
    library_languages,
    library_authors,
    library_titles,
    library_series,
    loved,
    rated_count,
    top_subjects: mostCommon(subjectCounts, TOP_SUBJECTS),
    top_authors: mostCommon(authorCounts, TOP_AUTHORS),
    traits,
    more_like,
    less_like,
    reject_reason_counts,
    rejected_with_notes,
    directive_text,
    directive_constraints,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/rec-signal.test.ts
```
Expected: PASS.

If `s.loved.map(b => b.id)` comes back in a different order, do **not** relax the assertion — check that the `orderBy(asc(schema.books.id))` is present and that the sort comparator returns `0` (not `-1`) on a full tie.

- [ ] **Step 5: Commit**

```bash
npx prettier --write lib/server/recSignal.ts lib/server/__tests__/rec-signal.test.ts
git add frontend/lib/server/recSignal.ts frontend/lib/server/__tests__/rec-signal.test.ts
git commit -m "feat(node): port the recommender's library signal"
```

---

## Task 7: Pool retrieval and assembly

Stage 1's deterministic half: expand the library's subjects/authors into catalog candidates, run Claude's seed queries, then merge, filter, dedupe, cap.

**Files:**
- Create: `frontend/lib/server/recAssemble.ts`
- Test: `frontend/lib/server/__tests__/rec-assemble.test.ts`

**Interfaces:**
- Consumes: `openlibrarySubject`, `googleBooksSubject`, `googleBooksAuthor`, `googleBooksQuery`, `openlibraryWorkDescription`, `type Candidate` (`catalog.ts`); the Task 5 filters; `pyRoundHalfEven` (`serialize.ts`); `RecSignal` (`recSignal.ts`).
- Produces: `metadataPool`, `seedPool`, `assemble`, `capPool`, `fillOlDescriptions`, `type PoolEntry`, `type AssembledCandidate`, and the knobs `PER_QUERY`, `SEED_QUERIES`, `MAX_CANDIDATES`, `SEED_RESERVE_SHARE`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/rec-assemble.test.ts
import { describe, test, expect } from 'vitest';
import { assemble, capPool, type AssembledCandidate, type PoolEntry } from '../recAssemble';
import type { Candidate } from '../catalog';

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  source: 'googlebooks',
  resolved_id: 'g1',
  title: 'A Candidate',
  author: 'Some Author',
  subjects: [],
  description: null,
  cover_url: null,
  year: 2000,
  language: null,
  raw: {},
  ...over,
});

const emptySignal = () => ({
  library_keys: new Set<string>(),
  library_isbns: new Set<string>(),
  library_series: new Map<string, Set<number>>(),
  library_titles: [] as string[],
  library_languages: new Set<string>(),
  library_authors: new Set<string>(),
});

const entry = (c: Candidate, reason = 'subject:x'): PoolEntry => [c, reason];

describe('assemble', () => {
  test('tags provenance and merges a candidate seen in both pools', () => {
    const out = assemble(
      [entry(cand({ title: 'Shared', author: 'A B', description: null }))],
      [entry(cand({ title: 'Shared', author: 'A B', description: 'filled in' }), 'query:q')],
      emptySignal(),
      60
    );
    expect(out).toHaveLength(1);
    expect(out[0].retrieval_pool).toBe('both');
    // seed_reason comes from the FIRST sighting; description backfills from the second.
    expect(out[0].seed_reason).toBe('subject:x');
    expect(out[0].description).toBe('filled in');
  });

  test('drops library books, library ISBNs, and untitled candidates', () => {
    const signal = emptySignal();
    signal.library_keys.add('dune\u0000herbert');
    signal.library_isbns.add('9780000000001');
    const out = assemble(
      [
        entry(cand({ title: 'Dune', author: 'Frank Herbert' })),
        entry(cand({ title: 'Kept', author: 'New Author', isbn13: '9780000000002' })),
        entry(cand({ title: 'Blocked By Isbn', author: 'X Y', isbn13: '9780000000001' })),
        entry(cand({ title: null })),
      ],
      [],
      signal,
      60
    );
    expect(out.map((c) => c.title)).toEqual(['Kept']);
  });

  test('applies the language, series, fuzzy and learner-edition filters', () => {
    const signal = emptySignal();
    signal.library_languages.add('en');
    signal.library_titles.push('The Hobbit');
    const out = assemble(
      [
        entry(cand({ title: 'French Book', author: 'A B', language: 'fr' })),
        entry(cand({ title: 'Unknown Lang', author: 'C D', language: null })),
        entry(cand({ title: 'Sequel (Unstarted, #4)', author: 'E F' })),
        entry(cand({ title: 'The Hobbit (Illustrated)', author: 'G H' })),
        entry(cand({ title: 'Reader', author: 'I J', subjects: ['Graded reader'] })),
      ],
      [],
      signal,
      60
    );
    expect(out.map((c) => c.title)).toEqual(['Unknown Lang']);
  });
});

describe('capPool', () => {
  const mk = (n: number, pool: string, withDesc = false): AssembledCandidate[] =>
    Array.from({ length: n }, (_, i) => ({
      title: `${pool}-${i}`,
      author: null,
      year: null,
      isbn13: null,
      subjects: [],
      description: withDesc ? 'd' : null,
      cover_url: null,
      catalog_source: null,
      catalog_id: null,
      language: null,
      seed_reason: 'r',
      retrieval_pool: pool,
    }));

  test('returns the input untouched when it already fits', () => {
    const all = mk(3, 'metadata');
    expect(capPool(all, 60)).toBe(all);
  });

  test('reserves 30% of the cap for seed-only candidates', () => {
    // cap 10 -> seedQuota = round(10 * 0.3) = 3. No "both" candidates.
    const out = capPool([...mk(20, 'metadata'), ...mk(20, 'claude_seed')], 10);
    expect(out).toHaveLength(10);
    expect(out.filter((c) => c.retrieval_pool === 'claude_seed')).toHaveLength(3);
    expect(out.filter((c) => c.retrieval_pool === 'metadata')).toHaveLength(7);
  });

  test('keeps every "both" candidate first', () => {
    const out = capPool([...mk(4, 'both'), ...mk(20, 'metadata'), ...mk(20, 'claude_seed')], 10);
    expect(out.slice(0, 4).every((c) => c.retrieval_pool === 'both')).toBe(true);
  });

  test('backfills with leftover seed candidates when metadata runs short', () => {
    const out = capPool([...mk(2, 'metadata'), ...mk(20, 'claude_seed')], 10);
    expect(out).toHaveLength(10);
    expect(out.filter((c) => c.retrieval_pool === 'claude_seed')).toHaveLength(8);
  });

  test('sorts description-carrying candidates first within each bucket', () => {
    const out = capPool([...mk(5, 'metadata', false), ...mk(5, 'metadata', true)], 5);
    expect(out.every((c) => c.description === 'd')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/rec-assemble.test.ts
```
Expected: FAIL — `Cannot find module '../recAssemble'`.

- [ ] **Step 3: Implement**

```ts
// frontend/lib/server/recAssemble.ts
/**
 * Stage 1 retrieval: port of recommend._metadata_pool, _seed_pool, _assemble,
 * _cap_pool and _fill_ol_descriptions.
 *
 * Every catalog call is awaited SEQUENTIALLY, exactly as Python runs them. Do not
 * "optimize" these loops into Promise.all: the request order is what the recorded
 * catalog fixture replays, and catalog.ts's throttle assumes serial calls.
 */
import {
  googleBooksAuthor,
  googleBooksQuery,
  googleBooksSubject,
  openlibrarySubject,
  openlibraryWorkDescription,
  type Candidate,
} from './catalog';
import type { Db } from './db';
import {
  allowedLanguages,
  applyAuthorCaps,
  dedupKey,
  EMPTY_DEDUP_KEY,
  fuzzyDuplicate,
  isLearnerEdition,
  languageOk,
  seriesOk,
} from './recFilters';
import type { RecSignal } from './recSignal';
import { pyRoundHalfEven } from './serialize';

/** recommend.py:53-56 tuning knobs. */
export const PER_QUERY = 8; // catalog hits per subject/author/seed query
export const SEED_QUERIES = 8; // search terms to ask Claude to propose
export const MAX_CANDIDATES = 60; // cap on the pool handed to the reranker (token budget)
export const SEED_RESERVE_SHARE = 0.3; // min share of the cap reserved for seed-only candidates

/** Python's (candidate, reason) tuple. */
export type PoolEntry = [Candidate, string];

export interface AssembledCandidate {
  title: string;
  author: string | null;
  year: number | null;
  isbn13: string | null;
  subjects: string[];
  description: string | null;
  cover_url: string | null;
  catalog_source: string | null;
  catalog_id: string | null;
  language: string | null;
  seed_reason: string;
  retrieval_pool: string;
}

/** The subset of the signal that assembly reads — lets 3c-2/3c-3 pass a book-anchored signal. */
export type AssembleSignal = Pick<
  RecSignal,
  | 'library_keys'
  | 'library_isbns'
  | 'library_series'
  | 'library_titles'
  | 'library_languages'
  | 'library_authors'
>;

/**
 * Deterministic expansion from the reader's loved subjects/authors. In cold-start
 * (thin library) author expansion is skipped -- it produces same-author clones -- and
 * discovery leans on subjects plus the Claude-seeded comp queries.
 */
export async function metadataPool(
  db: Db,
  signal: Pick<RecSignal, 'top_subjects' | 'top_authors'>,
  perQuery: number,
  coldStart: boolean
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const subject of signal.top_subjects) {
    for (const c of await openlibrarySubject(db, subject, perQuery)) {
      pool.push([c, `subject:${subject}`]);
    }
    for (const c of await googleBooksSubject(db, subject, perQuery)) {
      pool.push([c, `subject:${subject}`]);
    }
  }
  if (!coldStart) {
    for (const author of signal.top_authors) {
      for (const c of await googleBooksAuthor(db, author, perQuery)) {
        pool.push([c, `author:${author}`]);
      }
    }
  }
  return pool;
}

/** Run Claude's proposed search terms against the live catalog (recommend._seed_pool). */
export async function seedPool(
  db: Db,
  queries: string[],
  perQuery: number
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const q of queries) {
    for (const c of await googleBooksQuery(db, q, perQuery)) {
      pool.push([c, `query:${q}`]);
    }
  }
  return pool;
}

type PendingCandidate = Omit<AssembledCandidate, 'retrieval_pool'> & { pools: Set<string> };

/** Merge both pools, drop library books + duplicates, tag provenance, cap size. */
export function assemble(
  metadataEntries: PoolEntry[],
  seedEntries: PoolEntry[],
  signal: AssembleSignal,
  cap: number
): AssembledCandidate[] {
  const allowedLangs = allowedLanguages(signal.library_languages);
  // A Map, so values() yields Python's dict insertion order.
  const byKey = new Map<string, PendingCandidate>();

  const add = (cand: Candidate, reason: string, poolName: string): void => {
    const title = cand.title;
    if (!title) return;
    const key = dedupKey(title, cand.author ?? null);
    if (signal.library_keys.has(key) || key === EMPTY_DEDUP_KEY) return;
    const isbn = cand.isbn13 ?? null;
    if (isbn && signal.library_isbns.has(isbn)) return;
    if (!languageOk(cand.language, allowedLangs)) return;
    if (!seriesOk(title, signal.library_series)) return;
    if (fuzzyDuplicate(title, signal.library_titles)) return;
    if (isLearnerEdition(cand)) return;

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        title,
        author: cand.author ?? null,
        year: cand.year ?? null,
        isbn13: isbn,
        subjects: (cand.subjects ?? []).slice(0, 8),
        description: cand.description ?? null,
        cover_url: cand.cover_url ?? null,
        catalog_source: cand.source ?? null,
        catalog_id: cand.resolved_id ?? null,
        language: cand.language ?? null,
        pools: new Set([poolName]),
        seed_reason: reason,
      });
    } else {
      existing.pools.add(poolName);
      if (!existing.author && cand.author) existing.author = cand.author;
      if (!existing.subjects.length && cand.subjects?.length) {
        existing.subjects = cand.subjects.slice(0, 8);
      }
      if (!existing.description && cand.description) existing.description = cand.description;
      if (!existing.language && cand.language) existing.language = cand.language;
    }
  };

  for (const [cand, reason] of metadataEntries) add(cand, reason, 'metadata');
  for (const [cand, reason] of seedEntries) add(cand, reason, 'claude_seed');

  const candidates: AssembledCandidate[] = [];
  for (const { pools, ...rest } of byKey.values()) {
    candidates.push({ ...rest, retrieval_pool: pools.size > 1 ? 'both' : [...pools][0] });
  }
  return capPool(applyAuthorCaps(candidates, signal.library_authors), cap);
}

/**
 * Trim to `cap` without letting the (larger) metadata pool starve the Claude-seeded
 * one. If we paid for seed queries, their candidates must actually reach the
 * reranker. 'both'-pool candidates are the most grounded and are always kept.
 * Within each bucket, candidates with a description sort first.
 */
export function capPool(
  candidates: AssembledCandidate[],
  cap: number
): AssembledCandidate[] {
  if (candidates.length <= cap) return candidates;

  // Python's sorted() is stable, as is Array.sort in V8, so equal keys keep order.
  const descFirst = (lst: AssembledCandidate[]) =>
    [...lst].sort((a, b) => (a.description ? 0 : 1) - (b.description ? 0 : 1));

  const both = descFirst(candidates.filter((c) => c.retrieval_pool === 'both'));
  const meta = descFirst(candidates.filter((c) => c.retrieval_pool === 'metadata'));
  const seed = descFirst(candidates.filter((c) => c.retrieval_pool === 'claude_seed'));

  let chosen = both.slice(0, cap);
  const remaining = cap - chosen.length;
  if (remaining <= 0) return chosen;

  // Guarantee seed-only candidates a minimum slice of what is left (if any exist).
  // pyRoundHalfEven, not Math.round: Python's round() breaks .5 toward even.
  const seedQuota = Math.min(seed.length, pyRoundHalfEven(cap * SEED_RESERVE_SHARE), remaining);
  chosen = chosen.concat(seed.slice(0, seedQuota));
  chosen = chosen.concat(meta.slice(0, cap - chosen.length));
  // Backfill any slack (e.g. too few metadata hits) with leftover seed candidates.
  if (chosen.length < cap) {
    chosen = chosen.concat(seed.slice(seedQuota, seedQuota + (cap - chosen.length)));
  }
  return chosen.slice(0, cap);
}

/**
 * Fetch Work descriptions for OL candidates the pool query left without one. The OL
 * subjects endpoint returns works but no descriptions; we already hold the work key,
 * so one extra cached GET per OL candidate fills the gap. MUTATES in place, like Python.
 */
export async function fillOlDescriptions(
  db: Db,
  candidates: AssembledCandidate[]
): Promise<void> {
  for (const c of candidates) {
    if (c.description || c.catalog_source !== 'openlibrary') continue;
    const workKey = c.catalog_id;
    // Python assigns unconditionally, so a miss overwrites null with null.
    if (workKey) c.description = await openlibraryWorkDescription(db, workKey);
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/rec-assemble.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write lib/server/recAssemble.ts lib/server/__tests__/rec-assemble.test.ts
git add frontend/lib/server/recAssemble.ts frontend/lib/server/__tests__/rec-assemble.test.ts
git commit -m "feat(node): port the recommender's pool retrieval and assembly"
```

---

## Task 8: Prompt module and prompt parity

Every string below is copied **verbatim** from `recommend.py`. A single changed character fails the parity assertion, which is the point. Do not reflow, re-punctuate, or "improve" any of them.

**Files:**
- Create: `frontend/lib/server/recPrompts.ts`
- Create: `frontend/lib/server/__tests__/parity-recommend-prompts.test.ts`
- Modify: `frontend/lib/server/__tests__/helpers/parity.ts` (add `GOOGLE_BOOKS_API_KEY` to `ENV_KEYS` and delete it in `beforeEach`)

**Interfaces:**
- Consumes: `pyJsonDumps` (`serialize.ts`); `RecSignal`, `LOVED_SAMPLE` (`recSignal.ts`); `AssembledCandidate` (`recAssemble.ts`); `profileModel` (`profileBuild.ts`).
- Produces: `SEED_TOOL`, `SEED_SYSTEM`, `SEED_MODEL`, `SEED_MAX_TOKENS`, `RANK_TOOL`, `RANK_SYSTEM`, `RANK_MAX_TOKENS`, `rankModel()`, `buildSeedPrompt(signal, nQueries)`, `userSteeringBlock(signal)`, `buildRerankPrompt(candidates, signal, n)`, `type PromptBlock`.

- [ ] **Step 1: Extend the shared parity env helper**

In `frontend/lib/server/__tests__/helpers/parity.ts`, add `'GOOGLE_BOOKS_API_KEY'` to the `ENV_KEYS` array and add this line to `beforeEach`, next to the other deletes:

```ts
    // The Python fixture generator forces this empty so no live key is baked into a
    // recorded URL; a developer with it exported would build `...&key=...` URLs that
    // match no fixture entry and fail every replayed catalog fetch.
    delete process.env.GOOGLE_BOOKS_API_KEY;
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/lib/server/__tests__/parity-recommend-prompts.test.ts
import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { buildSignal, isColdStart } from '../recSignal';
import {
  assemble,
  fillOlDescriptions,
  metadataPool,
  seedPool,
  MAX_CANDIDATES,
  PER_QUERY,
  SEED_QUERIES,
} from '../recAssemble';
import { applyDirectiveConstraints } from '../recFilters';
import {
  buildSeedPrompt,
  buildRerankPrompt,
  SEED_SYSTEM,
  SEED_TOOL,
  SEED_MODEL,
  SEED_MAX_TOKENS,
  RANK_SYSTEM,
  RANK_TOOL,
  RANK_MAX_TOKENS,
  rankModel,
} from '../recPrompts';

// Must stay identical to _SEED_QUERIES_CANNED in scripts/gen_claude_fixtures.py --
// these strings determine which Google Books URLs recommend-http.json contains.
const CANNED_SEED_QUERIES = [
  'literary science fiction political systems',
  'anthropological science fiction first contact',
];

describe('prompt parity: recommend stage 1b (seed queries)', () => {
  setupParityEnv();

  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).recommend_seed.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = await buildSignal(db, 'local');
      // The seed prompt is built from the signal alone -- no catalog, no profile gate.
      expect(buildSeedPrompt(signal, SEED_QUERIES)).toEqual(py.messages[0].content);
      expect(SEED_SYSTEM).toBe(py.system);
      expect(SEED_TOOL).toEqual(py.tools[0]);
      expect(SEED_MODEL).toBe(py.model);
      expect(SEED_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'propose_search_queries' });
      expect(py.messages[0].role).toBe('user');
    } finally {
      await close();
    }
  });
});

describe('prompt parity: recommend stage 2 (rerank)', () => {
  setupParityEnv();

  it('rebuilds Python\'s candidate list and rerank prompt from replayed catalog traffic', async () => {
    const py = (prompts as any).recommend_rerank.kwargs;
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const signal = await buildSignal(db, 'local');
      const coldStart = isColdStart(signal);
      // The seeded library is deliberately NOT cold-start (10 loved, 12 rated), so
      // author expansion runs -- which is what the recorded inauthor: URLs cover.
      expect(coldStart).toBe(false);

      const meta = await metadataPool(db, signal, PER_QUERY, coldStart);
      const seed = await seedPool(db, CANNED_SEED_QUERIES, PER_QUERY);
      let candidates = assemble(meta, seed, signal, MAX_CANDIDATES);
      candidates = applyDirectiveConstraints(candidates, signal.directive_constraints);
      await fillOlDescriptions(db, candidates);
      expect(candidates.length).toBeGreaterThan(0);

      // This single assertion covers the whole deterministic retrieval core: pool
      // order, dedup, every filter, author caps and cap ordering all feed the
      // CANDIDATES JSON inside this prompt.
      expect(buildRerankPrompt(candidates, signal, 10)).toEqual(py.messages[0].content);
      expect(RANK_SYSTEM).toBe(py.system);
      expect(RANK_TOOL).toEqual(py.tools[0]);
      expect(rankModel()).toBe(py.model);
      expect(RANK_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'rank_recommendations' });
    } finally {
      restore();
      await close();
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/parity-recommend-prompts.test.ts
```
Expected: FAIL — `Cannot find module '../recPrompts'`.

- [ ] **Step 4: Implement**

```ts
// frontend/lib/server/recPrompts.ts
/**
 * Port of recommend.py's two /recommend prompts (_SEED_TOOL/_SEED_SYSTEM and
 * _RANK_TOOL/_RANK_SYSTEM) plus their builders.
 *
 * Every string here is copied VERBATIM from Python and asserted byte-for-byte in
 * parity-recommend-prompts.test.ts. Do not reflow or re-punctuate them.
 */
import { profileModel } from './profileBuild';
import type { AssembledCandidate } from './recAssemble';
import { LOVED_SAMPLE, type RecSignal } from './recSignal';
import { pyJsonDumps } from './serialize';

export interface PromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

// --- stage 1b: propose search queries --------------------------------------

export const SEED_MODEL = 'claude-haiku-4-5-20251001';
export const SEED_MAX_TOKENS = 1500;

export const SEED_TOOL = {
  name: 'propose_search_queries',
  description:
    'Propose catalog SEARCH queries that would surface books this reader is likely ' +
    'to love next. These are search terms (subjects, micro-genres, comp-author ' +
    'phrasings), NOT specific book titles. Each is run against a live book catalog.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                "A catalog search query, e.g. 'literary science fiction " +
                'first contact\' or \'inauthor:"Ursula K. Le Guin"\'. Avoid ' +
                'naming books the reader already owns.',
            },
            reason: {
              type: 'string',
              description: 'Which trait/pattern this query chases.',
            },
          },
          required: ['query', 'reason'],
        },
      },
    },
    required: ['queries'],
  },
};

export const SEED_SYSTEM =
  "You expand a reader's taste profile into catalog search queries for discovery. You " +
  'propose search TERMS, never specific titles, and you aim the queries at the reader\'s ' +
  'distinguishing traits (what separates their 5-star from 4-star books), not generic ' +
  'bestsellers.';

// --- stage 2: rerank + explain ---------------------------------------------

export const RANK_MAX_TOKENS = 4000;

/** Python reads settings.model at call time; profileModel() is the same env lookup. */
export function rankModel(): string {
  return profileModel();
}

export const RANK_TOOL = {
  name: 'rank_recommendations',
  description:
    "Rank the provided real catalog candidates by how well they fit this reader's " +
    'taste profile, and explain each pick. Choose ONLY from the given candidates.',
  input_schema: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate_index: {
              type: 'integer',
              description: 'The `idx` of a provided candidate. Must exist.',
            },
            score: {
              type: 'number',
              description: "0..1 fit with the reader's taste profile.",
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a well-read friend: what the ' +
                'book does, anchored to at most two library books by title, ' +
                'naming the mechanism of the fit. Honest about stretch picks. ' +
                'Plain punctuation, no em dashes. No generic praise, no ' +
                'clinical trait-speak.',
            },
            grounded_trait_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Trait ids (from the profile) this pick leans on.',
            },
            grounded_book_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Library book ids this candidate is most like.',
            },
          },
          required: [
            'candidate_index',
            'score',
            'rationale',
            'grounded_trait_ids',
            'grounded_book_ids',
          ],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const RANK_SYSTEM =
  'You are a book recommender. You rank a fixed list of real catalog candidates against ' +
  "a reader's evidence-backed taste profile. You never invent books; you only rank the " +
  'candidates given. Every pick cites the trait ids and library book ids it is grounded ' +
  'in, drawn only from the provided data. You prefer specific fit over popularity, and ' +
  'you respect aversion traits (penalize candidates that trip them).\n\n' +
  'Write each rationale like a well-read friend pressing the book into their hands, in ' +
  '1-2 sentences: lead with what the book does, then anchor it to at most two of their ' +
  'library books by title. Name the mechanism of the fit (pace, voice, structure, mood: ' +
  'whatever the trait actually is), never just shared genre. If the pick is a stretch, ' +
  'say so honestly and name what still connects. Use plain punctuation only: no em ' +
  'dashes. Never write "you\'ll love this", generic praise, or clinical trait ' +
  'language.\n\n' +
  'Examples of the target voice:\n' +
  '- Technically sci-fi, but it moves like the quiet family novels you rate highest: one ' +
  'household, twenty years, every chapter a knife slid in slowly.\n' +
  "- A reach: you rarely go for war fiction. But it's told in the clipped, unsentimental " +
  "voice that carried The Remains of the Day for you, and it's short enough to bail on " +
  'cheap.\n' +
  '- Romance-adjacent without the love-triangle stall you keep one-starring: the couple ' +
  'is together by chapter three, and the book is about what happens after.';

// --- builders ---------------------------------------------------------------

function tasteAndLoved(signal: RecSignal): string {
  return (
    'TASTE TRAITS (JSON):\n' +
    pyJsonDumps(signal.traits) +
    '\n\nLOVED BOOKS (JSON):\n' +
    pyJsonDumps(signal.loved.slice(0, LOVED_SAMPLE))
  );
}

/** recommend._claude_seed_queries' message content. */
export function buildSeedPrompt(signal: RecSignal, nQueries: number): PromptBlock[] {
  const profileContext = tasteAndLoved(signal);

  let steering = '';
  if (signal.more_like.length) {
    steering +=
      ' Bias the queries toward the qualities of these books the reader wants ' +
      'more of: ' +
      pyJsonDumps(signal.more_like) +
      '.';
  }
  if (signal.less_like.length) {
    steering +=
      ' Avoid the qualities of these books the reader wants less of: ' +
      pyJsonDumps(signal.less_like) +
      '.';
  }

  const taskPrompt =
    "A reader's taste profile and a sample of their loved books are above. Propose " +
    `up to ${nQueries} CATALOG SEARCH QUERIES (search terms, not book titles) that ` +
    'would surface books they are likely to rate highly. Chase their distinguishing ' +
    'traits, cover their range, and avoid generic bestseller terms.' +
    steering;

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

/**
 * recommend._user_steering_block: the `## User Steering` section appended to the
 * cached profile prefix. The trailing weighting instruction is ALWAYS emitted, so
 * this never returns "" -- the reranker must always know traits carry weights.
 */
export function userSteeringBlock(signal: RecSignal): string {
  const directiveText = (signal.directive_text ?? '').trim();
  const lines: string[] = ['\n\n## User Steering'];

  if (signal.more_like.length) {
    lines.push(
      'MORE LIKE (books the reader explicitly wants more of):\n' + pyJsonDumps(signal.more_like)
    );
  }
  if (signal.less_like.length) {
    lines.push(
      'LESS LIKE (books the reader explicitly wants less of):\n' + pyJsonDumps(signal.less_like)
    );
  }
  if (signal.reject_reason_counts.size) {
    // A Map, so this joins in Python's dict insertion order.
    const reasons = [...signal.reject_reason_counts.entries()]
      .map(([r, c]) => `${r}: ${c} times`)
      .join(', ');
    lines.push('FREQUENT REJECT REASONS: ' + reasons);
  }
  if (directiveText) {
    lines.push(
      "CUSTOM INSTRUCTIONS (the reader's own standing guidance, in their words; honor " +
        'it as direct high-priority intent, second only to the hard constraints already ' +
        'applied to the candidate set):\n' +
        directiveText
    );
  }
  lines.push(
    'Favor candidates resembling the more-like books; penalize candidates ' +
      'resembling the less-like books; penalize candidates matching frequent reject ' +
      'reasons; weight trait influence by each trait\'s `user_weight`: traits with a ' +
      'lower weight should influence the score less (0.0 = ignore, 1.0 = normal).'
  );
  return lines.join('\n\n');
}

/** recommend._claude_rerank's message content. */
export function buildRerankPrompt(
  candidates: AssembledCandidate[],
  signal: RecSignal,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    title: c.title,
    author: c.author,
    year: c.year,
    subjects: c.subjects ?? [],
  }));

  const rejectedBlock = signal.rejected_with_notes.length
    ? '\n\nREJECTED RECOMMENDATIONS WITH NOTES (JSON):\n' +
      'These are books the reader explicitly skipped with an explanation. Treat ' +
      'each note as direct testimony about what to avoid; heavily penalize ' +
      'candidates that share the same qualities.\n' +
      pyJsonDumps(signal.rejected_with_notes)
    : '';

  const profileContext = tasteAndLoved(signal) + rejectedBlock + userSteeringBlock(signal);

  const taskPrompt =
    `Rank the best ${n} candidates for this reader and explain each. Choose ONLY from ` +
    'the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit. Penalize ' +
    "anything that trips an aversion trait or resembles a rejected book's noted reason. " +
    'Ground every pick in specific trait ids ' +
    'and the library book ids it most resembles - use only ids that appear above.\n\n' +
    'CANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/parity-recommend-prompts.test.ts
```
Expected: PASS.

**Debugging a failure:** vitest prints a character-level diff of the two prompt strings. Read it before changing anything.
- A `1` where the fixture has `1.0` → a float reached the prompt without `pyFloat()`.
- Keys in a different order → an object was used where a `Map` is required.
- Candidate list differs → the bug is in Task 5/6/7, not here. Run `rec-signal` and `rec-assemble` first.
- Only `model` differs → `MYLIBRARY_MODEL` leaked; confirm `setupParityEnv()` is called inside the describe.

- [ ] **Step 6: Commit**

```bash
npx prettier --write lib/server/recPrompts.ts lib/server/__tests__/parity-recommend-prompts.test.ts lib/server/__tests__/helpers/parity.ts
git add frontend/lib/server/recPrompts.ts frontend/lib/server/__tests__/parity-recommend-prompts.test.ts frontend/lib/server/__tests__/helpers/parity.ts
git commit -m "feat(node): recommend prompts, proven byte-identical to Python"
```

---

## Task 9: The `recommend()` orchestrator

**Files:**
- Create: `frontend/lib/server/recommendRun.ts`
- Modify: `frontend/lib/server/claudeErrors.ts`
- Test: `frontend/lib/server/__tests__/recommend-run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–8, plus `trackedCreate` (`anthropic.ts`), `toolInput` / `type ClaudeClient` (`claude.ts`), `ensureProfileMeta` (`profileMeta.ts`), `booksChangedSince` (`profileUpdate.ts`).
- Produces: `runRecommend(db, client, userId, opts): Promise<Record<string, unknown>>` and `RECOMMEND_NO_KEY_MESSAGE`.

- [ ] **Step 1: Add the error message**

Append to `frontend/lib/server/claudeErrors.ts`:

```ts
/** recommend._client's RuntimeError, surfaced by api.py as a 400. */
export const RECOMMEND_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before running recommend.';
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/lib/server/__tests__/recommend-run.test.ts
import { describe, test, expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { fakeClaude } from './helpers/fakeClaude';
import { schema } from '../db';
import { runRecommend } from '../recommendRun';

const PROFILED_AT = '2026-08-01 00:00:00'; // mirrors _prepare_recommend in the generator

/** Same canned payload the Python fixture generator fed its seed call. */
const seedResponse = {
  content: [
    {
      type: 'tool_use',
      name: 'propose_search_queries',
      input: {
        queries: [
          { query: 'literary science fiction political systems', reason: 'fixture' },
          { query: 'anthropological science fiction first contact', reason: 'fixture' },
        ],
      },
    },
  ],
  usage: null,
};

const rerankResponse = (indices: number[]) => ({
  content: [
    {
      type: 'tool_use',
      name: 'rank_recommendations',
      input: {
        recommendations: indices.map((idx, i) => ({
          candidate_index: idx,
          score: 1 - i * 0.1,
          rationale: `  Because reasons ${idx}.  `,
          grounded_trait_ids: [1, 999], // 999 is not a real trait id
          grounded_book_ids: [1, 888], // 888 is not a loved book id
        })),
      },
    },
  ],
  usage: null,
});

async function seeded() {
  const { db, close } = await makeTestDb();
  await loadSeed(db, seedJson as any);
  await db.update(schema.profileMeta).set({ lastProfiledAt: PROFILED_AT });
  return { db, close };
}

describe('runRecommend gates', () => {
  setupParityEnv();

  test('400s on an empty library, a missing profile, and a stale profile', async () => {
    const { db, close } = await makeTestDb();
    try {
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No loved books found'),
      });

      await loadSeed(db, seedJson as any);
      await db.update(schema.profileMeta).set({ lastProfiledAt: null });
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No taste profile found'),
      });

      // The seed is deliberately stale: 3 books carry a later feedback_updated_at.
      await db.update(schema.profileMeta).set({ lastProfiledAt: '2026-07-01 12:00:00' });
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: '3 book(s) have been rated/reviewed since the last profile build. Re-profile first (POST /profile/update) so recommendations reflect your current taste.',
      });
    } finally {
      await close();
    }
  });

  test('400s with the no-key message when a Claude stage is reached without a client', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
    } finally {
      restore();
      await close();
    }
  });
});

describe('runRecommend happy path', () => {
  setupParityEnv();

  test('sends exactly the requests Python sends', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      await runRecommend(db, client, 'local', opts());
      expect(client.calls).toHaveLength(2);
      // Total equality: no extra params, no missing params, byte-identical prompts.
      expect(client.calls[0].params).toEqual((prompts as any).recommend_seed.kwargs);
      expect(client.calls[1].params).toEqual((prompts as any).recommend_rerank.kwargs);
    } finally {
      restore();
      await close();
    }
  });

  test('persists the served set and validates the ids Claude cited', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.served).toBe(3);
      expect(out.cold_start).toBe(false);
      expect(out.run_id).toMatch(/^[0-9a-f]{12}$/);
      expect(out.seed_queries).toEqual([
        'literary science fiction political systems',
        'anthropological science fiction first contact',
      ]);
      expect(out.recommendations[0].rank).toBe(1);
      // Rationale is trimmed. Do NOT assert WHICH candidate lands at rank 1: after the
      // score sort, _claude_rerank re-orders description-carrying candidates first, so
      // the winner depends on the replayed catalog payloads.
      expect(out.recommendations[0].rationale).toMatch(/^Because reasons \d+\.$/);

      const rows = await db
        .select()
        .from(schema.recommendations)
        .where(eq(schema.recommendations.runId, out.run_id))
        .orderBy(asc(schema.recommendations.rank));
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
      expect(rows.every((r) => r.status === 'served')).toBe(true);
      // Hallucinated ids are dropped (999 / 888); real ones survive.
      expect(rows.every((r) => JSON.stringify(r.groundedTraitIds) === '[1]')).toBe(true);
      expect(rows.every((r) => JSON.stringify(r.groundedBookIds) === '[1]')).toBe(true);
    } finally {
      restore();
      await close();
    }
  });

  test('drops out-of-range and duplicate candidate indices', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 0, 9999, 1])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.served).toBe(2); // idx 0 once, idx 1 once
    } finally {
      restore();
      await close();
    }
  });

  test('use_claude_seeds=false makes no seed call and reports an empty seed pool', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([rerankResponse([0])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', {
        n: 10,
        useMetadata: true,
        useClaudeSeeds: false,
      })) as any;
      expect(client.calls).toHaveLength(1);
      expect(out.pool_seed).toBe(0);
      expect(out.seed_queries).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });

  test('returns the no-candidates note without a rerank call when retrieval is empty', async () => {
    const { db, close } = await seeded();
    const client = fakeClaude([] as any);
    try {
      const out = (await runRecommend(db, client, 'local', {
        n: 10,
        useMetadata: false,
        useClaudeSeeds: false,
      })) as any;
      expect(client.calls).toHaveLength(0);
      expect(out).toMatchObject({ run_id: null, served: 0, candidates: 0, recommendations: [] });
      expect(out.note).toContain('Retrieval surfaced no new candidates');
    } finally {
      await close();
    }
  });
});

function opts() {
  return { n: 10, useMetadata: true, useClaudeSeeds: true };
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/recommend-run.test.ts
```
Expected: FAIL — `Cannot find module '../recommendRun'`.

- [ ] **Step 4: Implement**

```ts
// frontend/lib/server/recommendRun.ts
/**
 * Port of recommend.recommend() — the two-stage recommender orchestrator.
 *
 * Locked decision: the LLM is NOT the recommender. Final picks are always real
 * catalog books that survived retrieval; Claude only reranks and explains them, and
 * every id it cites is validated before persisting.
 *
 * Structure differs from Python in one way, deliberately: Python holds a single
 * session across the whole flow, but db.ts opens the pool with max: 1, so touching
 * the outer `db` while a transaction is open deadlocks. Both Claude calls and every
 * catalog fetch therefore run OUTSIDE any transaction, and the recommendation rows
 * are written in one transaction afterwards. Python writes nothing before its calls
 * either, so the observable behavior matches.
 */
import { randomUUID } from 'node:crypto';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { NO_LOVED_BOOKS_MESSAGE, NO_PROFILE_MESSAGE, RECOMMEND_NO_KEY_MESSAGE } from './claudeErrors';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import { ensureProfileMeta } from './profileMeta';
import { booksChangedSince } from './profileUpdate';
import {
  assemble,
  fillOlDescriptions,
  metadataPool,
  seedPool,
  MAX_CANDIDATES,
  PER_QUERY,
  SEED_QUERIES,
  type AssembledCandidate,
} from './recAssemble';
import { applyDirectiveConstraints } from './recFilters';
import {
  buildRerankPrompt,
  buildSeedPrompt,
  rankModel,
  RANK_MAX_TOKENS,
  RANK_TOOL,
  RANK_SYSTEM,
  SEED_MAX_TOKENS,
  SEED_MODEL,
  SEED_SYSTEM,
  SEED_TOOL,
} from './recPrompts';
import { buildSignal, isColdStart, type RecSignal } from './recSignal';
import { round2, utcnowTs } from './serialize';

export interface RecommendOptions {
  n: number;
  useMetadata: boolean;
  useClaudeSeeds: boolean;
}

interface RankedCandidate extends AssembledCandidate {
  score: number;
  rationale: string;
  grounded_trait_ids: number[];
  grounded_book_ids: number[];
}

export async function runRecommend(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  opts: RecommendOptions
): Promise<Record<string, unknown>> {
  const { n, useMetadata, useClaudeSeeds } = opts;

  // Python's _client() checks the key at point of USE, so a caller that never reaches
  // a Claude stage (use_claude_seeds=false and an empty candidate pool) still succeeds.
  const requireClient = (): ClaudeClient => {
    if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);
    return client;
  };

  let signal = await buildSignal(db, userId);
  if (signal.loved.length === 0) throw new ApiError(400, NO_LOVED_BOOKS_MESSAGE);

  // Block recommendations when the taste profile is missing or stale. Python computes
  // `changed` BEFORE testing last_profiled_at, then raises the missing-profile error
  // first; the order matters only for which message a brand-new user sees.
  const meta = await ensureProfileMeta(db, userId);
  const changed = await booksChangedSince(db, meta.lastProfiledAt, userId);
  if (meta.lastProfiledAt === null) throw new ApiError(400, NO_PROFILE_MESSAGE);
  if (changed.length > 0) {
    throw new ApiError(
      400,
      `${changed.length} book(s) have been rated/reviewed since the last profile ` +
        'build. Re-profile first (POST /profile/update) so recommendations ' +
        'reflect your current taste.'
    );
  }

  const directiveConstraints = signal.directive_constraints ?? {};
  const statedLanguages = directiveConstraints.languages as string[] | undefined;
  if (statedLanguages && statedLanguages.length) {
    // A stated language constraint overrides the reader's library languages for this
    // run (same semantics as discover): assemble() reads library_languages via
    // allowedLanguages, so overriding it here is enough.
    signal = { ...signal, library_languages: new Set(statedLanguages) } as RecSignal;
  }

  const coldStart = isColdStart(signal);
  const metaPool = useMetadata ? await metadataPool(db, signal, PER_QUERY, coldStart) : [];

  let seedQueries: string[] = [];
  let seedEntries: Awaited<ReturnType<typeof seedPool>> = [];
  if (useClaudeSeeds) {
    seedQueries = await claudeSeedQueries(db, requireClient(), signal, userId, SEED_QUERIES);
    seedEntries = await seedPool(db, seedQueries, PER_QUERY);
  }

  let candidates = assemble(metaPool, seedEntries, signal, MAX_CANDIDATES);
  candidates = applyDirectiveConstraints(candidates, directiveConstraints);
  await fillOlDescriptions(db, candidates);

  if (candidates.length === 0) {
    return {
      run_id: null,
      served: 0,
      candidates: 0,
      cold_start: coldStart,
      note: 'Retrieval surfaced no new candidates (catalog empty/offline?).',
      recommendations: [],
    };
  }

  const ranked = await claudeRerank(db, requireClient(), candidates, signal, userId, n);

  const runId = randomUUID().replace(/-/g, '').slice(0, 12); // uuid4().hex[:12]
  const createdAt = utcnowTs();
  const recsOut: Record<string, unknown>[] = [];

  await db.transaction(async (tx) => {
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      const rank = i + 1;
      await tx.insert(schema.recommendations).values({
        userId,
        runId,
        rank,
        title: c.title,
        author: c.author,
        year: c.year,
        isbn13: c.isbn13,
        coverUrl: c.cover_url,
        subjects: c.subjects ?? [],
        description: c.description,
        catalogSource: c.catalog_source,
        catalogId: c.catalog_id,
        retrievalPool: c.retrieval_pool,
        seedReason: c.seed_reason,
        score: c.score,
        rationale: c.rationale,
        groundedTraitIds: c.grounded_trait_ids ?? [],
        groundedBookIds: c.grounded_book_ids ?? [],
        status: 'served',
        createdAt,
      });
      recsOut.push({
        rank,
        title: c.title,
        author: c.author,
        year: c.year,
        score: round2(c.score),
        rationale: c.rationale,
        retrieval_pool: c.retrieval_pool,
        seed_reason: c.seed_reason,
        grounded_trait_ids: c.grounded_trait_ids ?? [],
        grounded_book_ids: c.grounded_book_ids ?? [],
      });
    }
  });

  return {
    run_id: runId,
    served: recsOut.length,
    candidates: candidates.length,
    cold_start: coldStart,
    pool_metadata: metaPool.length,
    pool_seed: seedEntries.length,
    seed_queries: seedQueries,
    model: rankModel(),
    recommendations: recsOut,
  };
}

/** recommend._claude_seed_queries: stage 1b. Returns query strings only. */
async function claudeSeedQueries(
  db: Db,
  client: ClaudeClient,
  signal: RecSignal,
  userId: string,
  nQueries: number
): Promise<string[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'recommend_seed' },
    {
      model: SEED_MODEL,
      max_tokens: SEED_MAX_TOKENS,
      system: SEED_SYSTEM,
      tools: [SEED_TOOL],
      tool_choice: { type: 'tool', name: 'propose_search_queries' },
      messages: [{ role: 'user', content: buildSeedPrompt(signal, nQueries) }],
    }
  );
  // Python matches the FIRST tool_use block without checking its name.
  const input = toolInput(message as any, '');
  if (!input) return [];
  const items = (input.queries as Array<{ query?: string }> | undefined) ?? [];
  return items
    .filter((q) => (q?.query ?? '').trim() !== '')
    .map((q) => String(q.query).trim());
}

/** recommend._claude_rerank: stage 2. */
async function claudeRerank(
  db: Db,
  client: ClaudeClient,
  candidates: AssembledCandidate[],
  signal: RecSignal,
  userId: string,
  n: number
): Promise<RankedCandidate[]> {
  const validTraitIds = new Set(signal.traits.map((t) => t.id));
  const validBookIds = new Set(signal.loved.map((b) => b.id));

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'recommend_rerank' },
    {
      model: rankModel(),
      max_tokens: RANK_MAX_TOKENS,
      system: RANK_SYSTEM,
      tools: [RANK_TOOL],
      tool_choice: { type: 'tool', name: 'rank_recommendations' },
      messages: [{ role: 'user', content: buildRerankPrompt(candidates, signal, n) }],
    }
  );

  const input = toolInput(message as any, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];

  const out: RankedCandidate[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Drop hallucinated / duplicate indices.
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= candidates.length ||
      seenIdx.has(idx)
    ) {
      continue;
    }
    seenIdx.add(idx);
    out.push({
      ...candidates[idx],
      score: Number(r.score ?? 0),
      rationale: String(r.rationale ?? '').trim(),
      grounded_trait_ids: asValidIds(r.grounded_trait_ids, validTraitIds),
      grounded_book_ids: asValidIds(r.grounded_book_ids, validBookIds),
    });
  }

  out.sort((a, b) => b.score - a.score);
  // Prefer candidates with descriptions (better UX), but never drop below n if
  // description-having candidates are scarce.
  const withDesc = out.filter((c) => c.description);
  const withoutDesc = out.filter((c) => !c.description);
  return [...withDesc, ...withoutDesc].slice(0, n);
}

function asValidIds(raw: unknown, valid: Set<number>): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is number => typeof i === 'number' && valid.has(i));
}
```

Also add to `claudeErrors.ts` (alongside `RECOMMEND_NO_KEY_MESSAGE`):

```ts
export const NO_LOVED_BOOKS_MESSAGE =
  'No loved books found (need books rated >= 4). Run ingest + enrich ' +
  '(and ideally profile) first.';

export const NO_PROFILE_MESSAGE =
  "No taste profile found. Run 'profile' (or POST /profile) before " +
  'generating recommendations.';
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/recommend-run.test.ts
```
Expected: PASS. The `client.calls[i].params` equality assertions are the strongest check in the wave — if either fails, fix the producer, never the expectation.

- [ ] **Step 6: Commit**

```bash
npx prettier --write lib/server/recommendRun.ts lib/server/claudeErrors.ts lib/server/__tests__/recommend-run.test.ts
git add frontend/lib/server/recommendRun.ts frontend/lib/server/claudeErrors.ts frontend/lib/server/__tests__/recommend-run.test.ts
git commit -m "feat(node): port the two-stage recommend() orchestrator"
```

---

## Task 10: Route handler and backend flip

**Files:**
- Create: `frontend/app/api/recommend/route.ts`
- Test: `frontend/lib/server/__tests__/recommend-route.test.ts`
- Modify: `frontend/lib/backend.ts`, `frontend/lib/__tests__/backend.test.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `runRecommend` (`recommendRun.ts`), `resolveAnthropicKey` / `makeAnthropicClient` (`claude.ts`), `withApi` / `ApiError` (`http.ts`).
- Produces: `POST /api/recommend`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/recommend-route.test.ts
import { describe, test, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { setupParityEnv } from './helpers/parity';
import { _setDbForTests } from '../db';
import { schema } from '../db';
import { POST } from '@/app/api/recommend/route';

const req = (body?: unknown) =>
  new Request('http://test/api/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('POST /api/recommend', () => {
  setupParityEnv();

  test('422s on a missing body and on a non-integer n, like FastAPI', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      expect((await POST(req())).status).toBe(422);
      expect((await POST(req({ n: 'x' }))).status).toBe(422);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s (not 422) on an empty body, because every field has a default', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const res = await POST(req({}));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No loved books found');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s with the no-key message when no API key is configured', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await db.update(schema.profileMeta).set({ lastProfiledAt: '2026-08-01 00:00:00' });
      _setDbForTests(db);
      // setupParityEnv deletes ANTHROPIC_API_KEY, and the seed stores no user key.
      const res = await POST(req({ n: 3 }));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run lib/server/__tests__/recommend-route.test.ts
```
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Implement the route**

```ts
// frontend/app/api/recommend/route.ts
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { runRecommend } from '@/lib/server/recommendRun';

// Two Claude calls (a Haiku seed pass and a Sonnet rerank) plus ~25 catalog fetches.
// 300s is Vercel Hobby's maximum and the default on every tier (verified 2026-08-06).
export const maxDuration = 300;

/** Twin of schemas.RecommendRequest — every field defaulted. */
const Body = z.object({
  n: z.number().int().default(10),
  use_metadata: z.boolean().default(true),
  use_claude_seeds: z.boolean().default(true),
});

/** Port of api.py::make_recommendations (918-929): RuntimeError -> 400. */
export const POST = withApi('/api/recommend', async (req, ctx) => {
  // FastAPI 422s on a MISSING body for a Pydantic-model parameter even when every
  // field is defaulted, but accepts `{}` and fills the defaults in (verified against
  // the real app). A failed parse is the missing-body case.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(422, 'validation error: body is required');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    // DEVIATION: FastAPI returns a structured detail ARRAY; every Node route in this
    // migration returns a string detail instead. Established in wave 2, kept here.
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  // Resolve the key once and hand it down. NOT raised here: Python checks the key at
  // point of use, so a run that never reaches a Claude stage still succeeds.
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  const out = await runRecommend(db, client, ctx.user.userId, {
    n: parsed.data.n,
    useMetadata: parsed.data.use_metadata,
    useClaudeSeeds: parsed.data.use_claude_seeds,
  });
  ctx.timer.mark('claude');
  return Response.json(out);
});
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run lib/server/__tests__/recommend-route.test.ts
```
Expected: PASS.

- [ ] **Step 5: Flip the backend switcher**

In `frontend/lib/backend.ts`, add to `NODE_DEFAULT_ROUTES` immediately after the wave-3b `/profile/update` rule, and extend the doc comment above the array with a wave-3c-1 line:

```ts
  // Wave 3c-1: the two-stage recommender. `exact` is LOAD-BEARING -- '/recommendations'
  // starts with '/recommend', so a prefix rule here would capture that group too.
  { prefix: '/recommend', methods: ['POST'], exact: true },
```

In `frontend/lib/__tests__/backend.test.ts`, line 96 currently asserts `POST /recommend` routes to Python with a `// 3c` marker. Flip it:

```ts
    expect(baseFor('/recommend', 'POST')).toBe(NODE); // wave 3c-1
    // Guard the exact-match rule: the recommendations group must NOT follow it to Node.
    expect(baseFor('/recommendations', 'POST')).toBe(PY);
    expect(baseFor('/recommendations/12/feedback', 'POST')).toBe(PY);
```

(Use whatever the file already names the Node constant — check the top of `backend.test.ts` and match it.)

- [ ] **Step 6: Full verification**

```bash
cd frontend && npx vitest run && npx tsc --noEmit && npx eslint .
```
Expected: every suite green, no type errors, no lint errors.

```bash
cd /home/chase/Documents/Code/my-library && .venv/bin/python -m pytest -q
```
Expected: unchanged from before this wave — no Python source was modified, only `scripts/`.

- [ ] **Step 7: Update CLAUDE.md**

In the Node-migration paragraph, replace the sentence beginning "Wave 3c (`/recommend`, `/books/{id}/similar`, `/discover`) is next" with:

```
Wave 3c is split in three. Wave 3c-1 shipped the shared deterministic retrieval core
(`similarity.ts`'s `difflib.SequenceMatcher` port, `recFilters.ts`, `recSignal.ts`,
`recAssemble.ts`) plus `POST /recommend`. Its parity test replays catalog HTTP recorded
from the Python run, so the byte-identical rerank prompt also proves the whole retrieval
pipeline -- pool order, dedup, language/series/fuzzy/learner filters, author caps and cap
ordering. `scripts/gen_claude_fixtures.py` now feeds canned responses to earlier Claude
calls so a multi-call flow's later prompt can be captured. Wave 3c-2
(`/books/{id}/similar`, which must also reproduce Python's 15/minute rate limit) and 3c-3
(`/discover`) are next, then wave 4 (jobs + imports) and wave 5 (admin + cutover).
```

- [ ] **Step 8: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write app/api/recommend/route.ts lib/backend.ts lib/__tests__/backend.test.ts lib/server/__tests__/recommend-route.test.ts
cd /home/chase/Documents/Code/my-library
npx prettier --write CLAUDE.md
git add frontend/app/api/recommend frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts frontend/lib/server/__tests__/recommend-route.test.ts CLAUDE.md
git commit -m "feat(node): POST /api/recommend and flip it to Node in auto mode"
```

---

## Manual verification (Chase, not the executor)

Tests alone do not close this out. Before wave 3c-2, exercise the real flow:

1. Follow the `isolated-local-env` skill to stand up a throwaway library (empty-string env overrides, throwaway `MYLIBRARY_DATA_DIR`, verify `settings.db_url` is SQLite before trusting it).
2. Seed ~14 books with varied ratings, run `profile`, then hit `POST /api/recommend` against the Node backend with `/admin` System tab set to **node**.
3. Confirm in the database: one `run_id`, rows in rank order with `status='served'`, non-empty `rationale`, `grounded_trait_ids` containing only real trait ids, and **two** `usage_events` rows (`recommend_seed` on Haiku, `recommend_rerank` on the Sonnet model).
4. Compare the same request against the Python backend (System tab set to **python**) and eyeball that the shape and quality match.

**Still open from wave 3b — carry forward:**
- `MYLIBRARY_MODEL` must be set in Vercel's environment. Live `usage_events` show Python running `claude-sonnet-4-6`, so it is set locally; if Vercel's is unset, Node falls back to `claude-sonnet-5` and the two backends silently diverge on model, cost and output. `POST /recommend` is now the third Node route depending on it.
- The Python `valid_ids` fix (commit `2c231f8`) is still only on `feat/node-backend`. Until it reaches `main`, `POST /profile` 500s in production for any user with a rejected recommendation carrying a note.

---

## Self-Review

**Spec coverage.** Every function `recommend()` reaches is assigned: `_is_cold_start`, `_apply_author_caps`, `_dedup_key`, `_allowed_languages`, `_language_ok`, `_series_info`, `_series_ok`, `_fuzzy_duplicate`, `_is_learner_edition`, `_build_signal`, `_feedback_book_signals`, `_reject_reason_counts`, `_metadata_pool`, `_claude_seed_queries`, `_seed_pool`, `_subject_hits`, `_apply_directive_constraints`, `_fill_ol_descriptions`, `_assemble`, `_cap_pool`, `_user_steering_block`, `_claude_rerank`, `recommend`, and the four catalog helpers. `latest_recommendations` is deliberately absent — wave 1 already ported it (V12).

**Deferred to 3c-2 / 3c-3, by design:** `_build_book_signal`, `_BOOK_FACET_SYSTEM`, `_book_facet_queries`, `_similar_seed_pool`, `_SIMILAR_RANK_*`, `_rerank_similar`, `recommend_similar`; `_DISCOVER_*`, `_clean_constraints`, `_interpret_query`, `_discovery_pool`, `_apply_discovery_constraints`, `_DISCOVER_RANK_*`, `_rerank_discovery`, `discover`. Both consume Tasks 3–7 unchanged; neither needs a new shared module. 3c-2 additionally owes a Node reproduction of `@limiter.limit("15/minute")` via `lib/server/ratelimit.ts`, and 3c-3 owes `30/minute`.

**Type consistency.** `RecSignal` is produced once (Task 6) and consumed by Tasks 7, 8, 9 under the same name. `AssembledCandidate` is produced in Task 7 and consumed in Tasks 8 and 9. `PoolEntry` is the `[Candidate, string]` tuple throughout. `AssembleSignal` is the `Pick<>` that lets 3c-2 pass a book-anchored signal into the same `assemble`. `pyRoundHalfEven` is defined in Task 2 and used in Task 7. `titleSim`/`STRONG_SIM` are defined in Task 3 and used only by `fuzzyDuplicate` in Task 5.

**Known risk.** The rerank prompt-parity test depends on Open Library and Google Books returning the same payloads at fixture-recording time as they did in the Python run — which is exactly why the traffic is recorded and replayed rather than re-fetched. If Task 1's generator is re-run later, `recommend-http.json` and the `recommend_rerank` prompt must be regenerated **together**; a mismatched pair fails Task 8 with a confusing candidate-list diff.

