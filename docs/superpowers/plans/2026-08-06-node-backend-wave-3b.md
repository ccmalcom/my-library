# Node backend migration — Wave 3b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the two taste-profile Claude flows — `POST /profile` (full cold-start build) and `POST /profile/update` (incremental revision) — from `mylibrary/profile.py` to Next.js route handlers, with byte-identical prompts and identical persistence.

**Architecture:** Four new server modules under `frontend/lib/server/` (`profileTiers.ts`, `profileFeedback.ts`, `profileBuild.ts`, `profileUpdate.ts`) plus Python-repr serialization primitives in the existing `serialize.ts`. Each Claude call is made outside the DB transaction; persistence (delete prior proposed traits → insert new ones → stamp `profile_meta`) happens inside one transaction afterwards. Prompt parity is proven against `create()` kwargs recorded from the real Python code by `scripts/gen_claude_fixtures.py`.

**Tech Stack:** TypeScript, Next.js route handlers, Drizzle ORM over postgres-js (PGlite in tests), Vitest, `@anthropic-ai/sdk`, Python 3 + pytest (Task 0 only).

## Global Constraints

- **No live Anthropic spend in tests, ever.** Every test injects `fakeClaude` or asserts on prompt construction only. A test that constructs a real `Anthropic` client on a path that can reach `messages.create` is a defect, even if it currently throws first. (Wave 3a shipped exactly that bug and caught it during verification — do not repeat it.)
- **Alembic remains the only migration authority.** Wave 3b adds no tables and no columns. If you think you need a migration, you have misread the plan.
- **Parity is the acceptance bar.** Prompt string, `system`, tool JSON schema, `tool_choice`, `model`, `max_tokens`, and message-block structure must be byte-identical to Python's for the same DB state. Deviations must be deliberate, commented in code, and listed in the verification record.
- **Every query whose rows feed a Claude prompt MUST have an explicit `ORDER BY`.** Python's equivalents have none and get SQLite/Postgres physical order by luck; an unordered Drizzle query is at the mercy of the query plan and will silently break byte parity. This rule is non-negotiable for wave 3b — it has more prompt-feeding queries than 3a and 3c combined.
- **Read the Python source, not this plan's prose, when they disagree.** Wave 3a's plan contained three factual errors about `mylibrary/` that would have become bugs. If a code block here contradicts `mylibrary/profile.py`, the file wins — fix the plan and say so in your report.
- Model for both flows: `process.env.MYLIBRARY_MODEL || 'claude-sonnet-5'` (twin of `config.py:158`). This is **not** the Haiku model wave 3a's flows use.
- `max_tokens` for both flows: `3000`.
- Never append a `Co-Authored-By: Claude` trailer to a commit message.

## File Structure

| File | Responsibility |
|---|---|
| `mylibrary/profile.py` (modify) | Task 0 only: fix the `valid_ids` KeyError |
| `tests/test_profile_feedback.py` (modify) | Task 0 only: regression test |
| `frontend/lib/server/serialize.ts` (modify) | Python-repr primitives: `pyFloat`, `pyFloatStr`, `pyRepr`, `Map` support in `pyJsonDumps` |
| `frontend/lib/server/profileTiers.ts` (create) | `tierFor`, `bookPayload`, `buildTiers` — the library payload sent to Claude |
| `frontend/lib/server/profileFeedback.ts` (create) | `feedbackContext`, `feedbackBlock`, `claimTokens`, `removeRejectedClaims` |
| `frontend/lib/server/profileBuild.ts` (create) | Full-build tool/system/prompt + `extractTasteProfile` |
| `frontend/lib/server/profileUpdate.ts` (create) | `booksChangedSince`, revise tool/system/prompt + `updateTasteProfile` |
| `frontend/lib/server/claudeErrors.ts` (modify) | `PROFILE_NO_KEY_MESSAGE`, `NO_RATED_BOOKS_MESSAGE` |
| `frontend/app/api/profile/route.ts` (modify) | Add `POST` beside the existing `GET` |
| `frontend/app/api/profile/update/route.ts` (create) | `POST /api/profile/update` |
| `frontend/lib/backend.ts` (modify) | Routing-table flip |
| `scripts/gen_claude_fixtures.py` (modify) | Capture `profile_full` + `profile_update` prompts |
| `frontend/lib/server/__tests__/parity-prompts.test.ts` (modify) | Two new prompt-parity cases |
| `frontend/lib/server/__tests__/profile-serialize.test.ts` (create) | Unit tests for the repr primitives |
| `frontend/lib/server/__tests__/profile-build.test.ts` (create) | Tiers, feedback, claim-filter, persistence |
| `frontend/lib/server/__tests__/profile-update.test.ts` (create) | Change detection + update control flow |

---

## Task 0: Fix the Python `valid_ids` KeyError (prerequisite)

`mylibrary/profile.py:550` builds `valid_ids = {b["id"] for tier in tiers.values() for b in tier}`. The `rejected` tier's entries are `{"title", "author", "note"}` — they have **no `id` key** — so `extract_taste_profile()` raises `KeyError: 'id'` for any user who has ever rejected a recommendation *and written a note*. FastAPI turns that into an uncaught 500 on `POST /profile`. `POST /profile/update` inherits it through its full-rebuild fallbacks.

This is a live bug on `main`, verified by direct execution, not inference. It must be fixed before wave 3b because (a) the fixture generator's `--live` mode would crash on it, and (b) the Node port must not reproduce a crash.

**Files:**
- Modify: `mylibrary/profile.py:550`
- Test: `tests/test_profile_feedback.py`

**Interfaces:**
- Produces: no signature changes. `extract_taste_profile()` stops raising `KeyError` when `tiers["rejected"]` is non-empty.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_profile_feedback.py`. Note the module already imports `Book`, `TasteTrait`, `session_scope`, `profile` and defines `_FakeClient` — reuse them; if `Recommendation` is not imported at the top of the file, add it to the existing `from mylibrary.db import ...` line.

```python
def test_extract_taste_profile_survives_rejected_rec_with_note(monkeypatch):
    """A rejected recommendation carrying a user note lands in tiers['rejected'] as
    {title, author, note} — with no 'id' key. Building valid_ids must not blow up on it."""
    with session_scope() as session:
        session.add(Book(title="Dune", author="Frank Herbert", goodreads_rating=5))
        session.add(
            Recommendation(
                run_id="r1",
                rank=1,
                title="Blindsight",
                author="Peter Watts",
                status="rejected",
                user_note="too grim for me",
            )
        )

    payload = {
        "traits": [
            {
                "claim": "Rewards dense political world-building.",
                "polarity": "reward",
                "exhibits": [],
                "contrasts": [],
                "inference_confidence": 0.9,
            }
        ]
    }
    monkeypatch.setattr(profile, "resolve_anthropic_key", lambda uid: "test-key")
    monkeypatch.setattr(profile, "Anthropic", lambda **kw: _FakeClient(payload))

    out = profile.extract_taste_profile()

    assert out["mode"] == "full"
    assert out["traits_saved"] == 1
    assert out["tiers"]["rejected"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_profile_feedback.py::test_extract_taste_profile_survives_rejected_rec_with_note -q`
Expected: FAIL with `KeyError: 'id'` raised at `mylibrary/profile.py:550`.

If it fails for any *other* reason (e.g. `NameError: Recommendation`), fix the test's imports and re-run until you see the `KeyError`. You must observe that exact failure before proceeding.

- [ ] **Step 3: Write minimal implementation**

In `mylibrary/profile.py`, replace line 550:

```python
        valid_ids = {b["id"] for tier in tiers.values() for b in tier}
```

with:

```python
        # `rejected` (and `less_like`, when build_tiers is given one) hold
        # non-book entries with no "id" key — skip them rather than KeyError.
        valid_ids = {b["id"] for tier in tiers.values() for b in tier if "id" in b}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_profile_feedback.py -q`
Expected: PASS, whole file green.

Then the full suite: `.venv/bin/python -m pytest -q` — expected `360 passed` (359 before, +1 new).

- [ ] **Step 5: Commit**

```bash
git add mylibrary/profile.py tests/test_profile_feedback.py
git commit -m "fix(profile): skip non-book tier entries when building valid_ids

A rejected recommendation carrying a user note lands in tiers['rejected'] as
{title, author, note} with no 'id' key, so the valid_ids set comprehension
raised KeyError and POST /profile returned an uncaught 500."
```

**Report to the controller after this task:** this commit fixes a live bug on the production Python backend, not just a migration blocker. It should also be landed on `main` (cherry-pick or its own PR) so the deployed Railway service is fixed before cutover. Do not do that yourself — flag it.

---

## Task 1: Python-repr serialization primitives

Three separate ways Python renders values that `JSON.stringify` gets wrong, all load-bearing for wave 3b prompts:

1. **Floats.** `json.dumps(1.0)` → `1.0`; `JSON.stringify(1.0)` → `1`. `inference_confidence` and `user_weight` are `double precision` columns that go straight into prompts.
2. **`str(dict)` / `str(list)`.** `_build_prompt` interpolates `f"Tier sizes: {counts}"` — a Python **dict repr** (`{'5': 3, '4': 2, ...}`, single quotes) — and `_build_update_prompt` interpolates `f"...: {changed_ids}"` — a Python **list repr** (`[2, 3, 9]`, spaces after commas). Neither is JSON.
3. **Key order.** Python dicts preserve insertion order. **JavaScript objects do not**: integer-like string keys are enumerated first, in ascending numeric order. `{'5': [], '4': [], '3': [], '<=2': []}` in JS iterates as `3, 4, 5, <=2` — silently reordering both `json.dumps(tiers)` and `Tier sizes: {counts}`. This is the single most likely way to fail wave 3b's parity tests. **Use `Map` for every ordered mapping that reaches a prompt**, never a plain object.

**Files:**
- Modify: `frontend/lib/server/serialize.ts`
- Test: `frontend/lib/server/__tests__/profile-serialize.test.ts` (create)

**Interfaces:**
- Produces:
  - `pyFloat(n: number): PyFloat` — wraps a number so serializers render it Python-float style.
  - `isPyFloat(v: unknown): v is PyFloat`
  - `pyFloatStr(n: number): string`
  - `pyRepr(v: unknown): string` — Python `str()`/`repr()` of a scalar, list, or mapping.
  - `pyJsonDumps(v: unknown): string` — **existing export, extended** to handle `Map` and `PyFloat`.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/profile-serialize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pyFloat, pyFloatStr, pyRepr, pyJsonDumps } from '../serialize';

describe('pyFloatStr', () => {
  it('appends .0 to integral values the way Python repr does', () => {
    expect(pyFloatStr(1)).toBe('1.0');
    expect(pyFloatStr(0)).toBe('0.0');
    expect(pyFloatStr(-0)).toBe('-0.0');
  });

  it('leaves non-integral values as the shortest round-trip form', () => {
    expect(pyFloatStr(0.95)).toBe('0.95');
    expect(pyFloatStr(0.6)).toBe('0.6');
    expect(pyFloatStr(0.30000000000000004)).toBe('0.30000000000000004');
  });
});

describe('pyRepr', () => {
  it('renders a mapping the way Python str(dict) does', () => {
    const counts = new Map<string, number>([
      ['5', 3],
      ['4', 2],
      ['3', 0],
      ['<=2', 1],
      ['dnf', 1],
      ['rejected', 1],
    ]);
    // Insertion order preserved, single-quoted keys, ": " and ", " separators.
    expect(pyRepr(counts)).toBe("{'5': 3, '4': 2, '3': 0, '<=2': 1, 'dnf': 1, 'rejected': 1}");
  });

  it('renders a list the way Python str(list) does', () => {
    expect(pyRepr([2, 3, 9])).toBe('[2, 3, 9]');
    expect(pyRepr([])).toBe('[]');
  });

  it('renders None/True/False, not null/true/false', () => {
    expect(pyRepr(null)).toBe('None');
    expect(pyRepr(true)).toBe('True');
    expect(pyRepr(false)).toBe('False');
  });

  it('renders a PyFloat as a Python float', () => {
    expect(pyRepr(pyFloat(1))).toBe('1.0');
  });
});

describe('pyJsonDumps (wave-3b extensions)', () => {
  it('serializes a Map in insertion order, not V8 numeric-key order', () => {
    const tiers = new Map<string, unknown[]>([
      ['5', [{ id: 1 }]],
      ['4', []],
      ['3', []],
      ['<=2', []],
      ['dnf', []],
      ['rejected', []],
    ]);
    expect(pyJsonDumps(tiers)).toBe(
      '{"5": [{"id": 1}], "4": [], "3": [], "<=2": [], "dnf": [], "rejected": []}'
    );
  });

  it('proves the plain-object equivalent WOULD have been reordered', () => {
    // Guard rail: documents exactly why Map is mandatory here.
    expect(Object.keys({ '5': 1, '4': 1, '3': 1, '<=2': 1 })).toEqual(['3', '4', '5', '<=2']);
  });

  it('serializes a PyFloat with a decimal point', () => {
    expect(pyJsonDumps({ inference_confidence: pyFloat(1) })).toBe(
      '{"inference_confidence": 1.0}'
    );
    expect(pyJsonDumps({ inference_confidence: pyFloat(0.8) })).toBe(
      '{"inference_confidence": 0.8}'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/profile-serialize.test.ts`
Expected: FAIL — `pyFloat`, `pyFloatStr`, `pyRepr` are not exported from `../serialize`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/lib/server/serialize.ts`:

```ts
/**
 * A number Python would render as a float. JS has one numeric type, so an
 * integral `double precision` value (1.0) is indistinguishable from an int (1)
 * and `JSON.stringify` drops the decimal point — which breaks byte-exact prompt
 * parity for `inference_confidence` and `user_weight`. Wrap those with pyFloat().
 */
export interface PyFloat {
  __pyFloat__: number;
}

export function pyFloat(n: number): PyFloat {
  return { __pyFloat__: n };
}

export function isPyFloat(v: unknown): v is PyFloat {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PyFloat).__pyFloat__ === 'number'
  );
}

/**
 * Python `repr()` of a float. Both languages emit the shortest round-tripping
 * decimal, so the only routine difference is the trailing `.0` on integral
 * values. Exponent-form values (|x| >= 1e21 or very small) are returned as JS
 * renders them — Python writes `1e+21`/`1e-07` where JS writes `1e+21`/`1e-7`.
 * No column in this codebase carries such a value; if one ever does, extend here.
 */
export function pyFloatStr(n: number): string {
  if (Object.is(n, -0)) return '-0.0';
  const s = String(n);
  if (s.includes('e') || s.includes('.') || !Number.isFinite(n)) return s;
  return `${s}.0`;
}

/** Python repr() of a str: single-quoted unless that would need escaping. */
function pyStrRepr(s: string): string {
  const esc = s.replace(/\\/g, '\\\\');
  if (esc.includes("'") && !esc.includes('"')) return `"${esc}"`;
  return `'${esc.replace(/'/g, "\\'")}'`;
}

/**
 * Python `str()` of a value, for prompts that f-string-interpolate a container
 * (`f"Tier sizes: {counts}"`, `f"CHANGED BOOK IDS ...: {changed_ids}"`). This is
 * repr, NOT JSON: single-quoted strings, None/True/False, `', '` separators.
 * Mappings must be a Map so insertion order survives (see pyJsonDumps).
 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (isPyFloat(v)) return pyFloatStr(v.__pyFloat__);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return pyStrRepr(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (v instanceof Map) {
    return (
      '{' +
      [...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(', ') +
      '}'
    );
  }
  if (typeof v === 'object') {
    return (
      '{' +
      Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${pyStrRepr(k)}: ${pyRepr(val)}`)
        .join(', ') +
      '}'
    );
  }
  return 'None';
}
```

Then replace the **body** of the existing `pyJsonDumps` (keep its doc comment, extend it) so it handles `PyFloat` and `Map`. The two new branches must come *before* the generic `typeof v === 'object'` branch, since both are objects:

```ts
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (isPyFloat(v)) return pyFloatStr(v.__pyFloat__);
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJsonDumps).join(', ') + ']';
  // A Map is the only mapping whose key order is trustworthy: V8 enumerates
  // integer-like object keys ('5', '4', '3') in ascending numeric order, which
  // would silently reorder json.dumps(tiers) away from Python's insertion order.
  if (v instanceof Map) {
    const entries = [...v.entries()].map(
      ([k, val]) => `${JSON.stringify(String(k))}: ${pyJsonDumps(val)}`
    );
    return '{' + entries.join(', ') + '}';
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${JSON.stringify(k)}: ${pyJsonDumps(val)}`
    );
    return '{' + entries.join(', ') + '}';
  }
  return 'null';
}
```

Note the added `|| v === undefined` on the first line: Drizzle returns `null` for NULL columns, but an absent optional property reads as `undefined`, and Python would have had `None` in both cases.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/profile-serialize.test.ts
npm run test:server   # the whole server suite — pyJsonDumps already has wave-3a callers
npm run type-check
```
Expected: new file green; **194 pre-existing tests still pass** (the directive-distill prompt-parity test exercises `pyJsonDumps`, so a regression here shows up there immediately).

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/serialize.ts frontend/lib/server/__tests__/profile-serialize.test.ts
git commit -m "feat(node): Python repr primitives for prompt parity

pyFloat/pyFloatStr for float rendering, pyRepr for f-string-interpolated
containers, and Map support in pyJsonDumps so ordered mappings survive V8's
integer-like key reordering."
```

---

## Task 2: Tier construction (`profileTiers.ts`)

Port of `profile.py:117-184` (`_tier`, `_book_payload`, `build_tiers`).

**Files:**
- Create: `frontend/lib/server/profileTiers.ts`
- Test: `frontend/lib/server/__tests__/profile-build.test.ts` (create; grows in Tasks 3, 4, 6)

**Interfaces:**
- Consumes: `effectiveRating` (existing, `serialize.ts`); `schema`, `Db` (existing, `db.ts`).
- Produces:
  - `type Tiers = Map<string, Record<string, unknown>[]>`
  - `tierFor(rating: number): string`
  - `bookPayload(book: BookRow, enr: EnrichmentRow | null): Record<string, unknown>`
  - `buildTiers(db: Db, userId: string): Promise<Tiers>`
  - `type BookRow`, `type EnrichmentRow`

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/profile-build.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import type { Seed } from './helpers/pglite';
import { tierFor, buildTiers } from '../profileTiers';
import { pyJsonDumps } from '../serialize';

describe('tierFor', () => {
  it('buckets ratings the way profile._tier does', () => {
    expect(tierFor(5)).toBe('5');
    expect(tierFor(4)).toBe('4');
    expect(tierFor(3)).toBe('3');
    expect(tierFor(2)).toBe('<=2');
    expect(tierFor(1)).toBe('<=2');
  });
});

describe('buildTiers', () => {
  it('groups the seeded library into Python-ordered tiers', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');

      // Key order must match profile.py's dict literal exactly.
      expect([...tiers.keys()]).toEqual(['5', '4', '3', '<=2', 'dnf', 'rejected']);

      const ids = (k: string) => tiers.get(k)!.map((b) => b.id);
      // 1,2,11,12,13 are goodreads_rating 5; 3 is app_rating 5; 7 is app_rating 5.
      expect(ids('5')).toEqual([1, 2, 3, 7, 11, 12, 13]);
      expect(ids('4')).toEqual([4, 10, 14]);
      expect(ids('3')).toEqual([5]);
      expect(ids('<=2')).toEqual([6]);
      // Book 9 is did-not-finish; it is bucketed before its rating is considered.
      expect(ids('dnf')).toEqual([9]);
      // Book 8 is unrated and on to-read: excluded entirely.
      expect(ids('5').concat(ids('4'), ids('3'), ids('<=2'))).not.toContain(8);
      // The other tenant's books must never appear.
      expect(JSON.stringify([...tiers.values()])).not.toContain('101');
    } finally {
      await close();
    }
  });

  it('carries the payload fields profile._book_payload emits, in order', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');
      const dune = tiers.get('5')!.find((b) => b.id === 1)!;

      expect(Object.keys(dune)).toEqual([
        'id', 'title', 'author', 'year', 'pages', 'subjects', 'series', 'read_year',
      ]);
      expect(dune).toMatchObject({
        id: 1,
        title: 'Dune',
        author: 'Frank Herbert',
        year: 1965,
        pages: 412,
        subjects: ['science fiction', 'space opera', 'politics'],
        series: null,
        read_year: 2025, // date_read 2025-11-02 wins over date_added 2025-10-01
      });

      // A book with an app_review gets a trailing `review` key; one without does not.
      const phm = tiers.get('5')!.find((b) => b.id === 3)!;
      expect(Object.keys(phm)).toEqual([
        'id', 'title', 'author', 'year', 'pages', 'subjects', 'series', 'read_year', 'review',
      ]);
      expect(phm.review).toBe('Loved the problem-solving.');

      // Book 9 (DNF) has no enrichment row at all.
      const tltl = tiers.get('dnf')![0];
      expect(tltl).toMatchObject({ id: 9, subjects: [], series: null });
    } finally {
      await close();
    }
  });

  it('surfaces rejected recommendations that carry a note, and only those', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');
      // rec 1 is rejected WITH a note; rec 5 is rejected with user_note null.
      expect(tiers.get('rejected')).toEqual([
        { title: 'Blindsight', author: 'Peter Watts', note: 'not for me' },
      ]);
    } finally {
      await close();
    }
  });

  it('serializes with Python key order once handed to pyJsonDumps', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');
      const json = pyJsonDumps(tiers);
      expect(json.indexOf('"5"')).toBeLessThan(json.indexOf('"4"'));
      expect(json.indexOf('"4"')).toBeLessThan(json.indexOf('"3"'));
      expect(json.indexOf('"3"')).toBeLessThan(json.indexOf('"<=2"'));
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts`
Expected: FAIL — cannot resolve `../profileTiers`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/lib/server/profileTiers.ts`:

```ts
/**
 * Port of profile.py's tier construction (_tier, _book_payload, build_tiers).
 * The result is a Map, not an object: Python preserves the dict literal's
 * insertion order ('5','4','3','<=2','dnf','rejected') and V8 would reorder the
 * integer-like keys ahead of the rest, changing the byte-exact prompt.
 */
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { effectiveRating } from './serialize';

export type BookRow = typeof schema.books.$inferSelect;
export type EnrichmentRow = typeof schema.enrichment.$inferSelect;
export type Tiers = Map<string, Record<string, unknown>[]>;

/** Twin of profile._tier. */
export function tierFor(rating: number): string {
  if (rating >= 5) return '5';
  if (rating === 4) return '4';
  if (rating === 3) return '3';
  return '<=2';
}

/**
 * Twin of profile._book_payload. Key insertion order is load-bearing (it becomes
 * JSON in the prompt), and `review` is appended only when app_review is truthy —
 * matching Python's conditional `payload["review"] = ...`.
 */
export function bookPayload(book: BookRow, enr: EnrichmentRow | null): Record<string, unknown> {
  const subjects = enr ? ((enr.subjects as string[] | null) ?? []).slice(0, 8) : [];
  // date columns read as 'YYYY-MM-DD'; Python takes `.year` off a date object.
  const readDate = book.dateRead || book.dateAdded;
  const payload: Record<string, unknown> = {
    id: book.id,
    title: book.title,
    author: book.author,
    year: book.yearPublished,
    pages: book.pageCount,
    subjects,
    series: enr ? enr.series : null,
    read_year: readDate ? Number(readDate.slice(0, 4)) : null,
  };
  if (book.appReview) payload.review = book.appReview.trim().slice(0, 1000);
  return payload;
}

/**
 * Twin of profile.build_tiers (called without less_like_books, as api.py does, so
 * no `less_like` bucket is ever added). Both queries carry an explicit ORDER BY:
 * their rows are serialized straight into the Claude prompt.
 */
export async function buildTiers(db: Db, userId: string): Promise<Tiers> {
  const tiers: Tiers = new Map([
    ['5', []],
    ['4', []],
    ['3', []],
    ['<=2', []],
    ['dnf', []],
    ['rejected', []],
  ]);

  const rows = await db
    .select({ book: schema.books, enrichment: schema.enrichment })
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(and(eq(schema.books.userId, userId), eq(schema.books.excludeFromProfile, false)))
    .orderBy(asc(schema.books.id));

  for (const { book, enrichment } of rows) {
    if (book.exclusiveShelf === 'did-not-finish') {
      tiers.get('dnf')!.push(bookPayload(book, enrichment));
      continue;
    }
    const r = effectiveRating(book.appRating, book.goodreadsRating);
    if (r === null) continue;
    tiers.get(tierFor(r))!.push(bookPayload(book, enrichment));
  }

  const recs = await db
    .select({
      title: schema.recommendations.title,
      author: schema.recommendations.author,
      userNote: schema.recommendations.userNote,
    })
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, userId),
        eq(schema.recommendations.status, 'rejected'),
        isNotNull(schema.recommendations.userNote)
      )
    )
    .orderBy(asc(schema.recommendations.id));

  for (const rec of recs) {
    tiers.get('rejected')!.push({ title: rec.title, author: rec.author, note: rec.userNote });
  }

  return tiers;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts
npm run type-check
```
Expected: PASS.

If the tier membership assertions fail, print the actual ids and reconcile against `scripts/gen_parity_fixtures.py`'s `SEED["books"]` — the seed is the source of truth, not this plan's expected arrays. Fix whichever is wrong and note it in your report.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/profileTiers.ts frontend/lib/server/__tests__/profile-build.test.ts
git commit -m "feat(node): taste-profile tier construction"
```

---

## Task 3: Feedback context and prompt block (`profileFeedback.ts`)

Port of `profile.py:244-380` (`_feedback_context`, `_feedback_block`).

**Files:**
- Create: `frontend/lib/server/profileFeedback.ts`
- Test: `frontend/lib/server/__tests__/profile-build.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface FeedbackContext { confirmed: string[]; edited: string[]; rejected: string[]; downweighted: { claim: string; user_weight: number }[]; more_like: string[]; less_like: string[]; favorites: string[]; directive_text: string | null }`
  - `feedbackContext(db: Db, userId: string): Promise<FeedbackContext>`
  - `feedbackBlock(feedback: FeedbackContext | null): string`

- [ ] **Step 1: Write the failing test**

Append to `frontend/lib/server/__tests__/profile-build.test.ts` (add the imports to the existing import block):

```ts
import { feedbackContext, feedbackBlock } from '../profileFeedback';
import { schema } from '../db';

describe('feedbackContext', () => {
  it('buckets trait verdicts, favorites and the directive from the seed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const ctx = await feedbackContext(db, 'local');

      expect(ctx.confirmed).toEqual(['Values competence and problem-solving protagonists.']);
      expect(ctx.edited).toEqual([]);
      expect(ctx.rejected).toEqual(['Avoids grimdark tone.']);
      // Trait 4 has user_weight 0.0 but status 'rejected', so it is NOT downweighted.
      expect(ctx.downweighted).toEqual([]);
      expect(ctx.favorites).toEqual(['The Dispossessed by Ursula K. Le Guin']);
      expect(ctx.directive_text).toBe('More literary sci-fi, no grimdark.');
      // The shared seed has no taste_signal rows.
      expect(ctx.more_like).toEqual([]);
      expect(ctx.less_like).toEqual([]);
    } finally {
      await close();
    }
  });

  it('splits taste signals into more/less by direction, in id order', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Seeded out of id order on purpose: an unordered query could pass by luck.
      await db.insert(schema.tasteSignal).values([
        { id: 2, userId: 'local', targetKind: 'book', targetBookId: 5, direction: 'less' },
        { id: 1, userId: 'local', targetKind: 'book', targetBookId: 1, direction: 'more' },
        { id: 3, userId: 'local', targetKind: 'book', targetBookId: 12, direction: 'more' },
        // Another tenant's signal must be ignored.
        { id: 4, userId: 'other', targetKind: 'book', targetBookId: 101, direction: 'more' },
        // A rec-kind signal is out of scope for this bucket.
        { id: 5, userId: 'local', targetKind: 'rec', targetBookId: 2, direction: 'more' },
      ]);

      const ctx = await feedbackContext(db, 'local');
      expect(ctx.more_like).toEqual([
        'Dune by Frank Herbert',
        'The Fifth Season by N.K. Jemisin',
      ]);
      expect(ctx.less_like).toEqual(['Foundation by Isaac Asimov']);
    } finally {
      await close();
    }
  });

  it('treats an empty constraints object as no directive (Python dict falsiness)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.userDirective)
        .set({ nlText: null, constraints: {} })
        .where(eq(schema.userDirective.userId, 'local'));
      const ctx = await feedbackContext(db, 'local');
      expect(ctx.directive_text).toBeNull();
    } finally {
      await close();
    }
  });
});

describe('feedbackBlock', () => {
  const empty = {
    confirmed: [], edited: [], rejected: [], downweighted: [],
    more_like: [], less_like: [], favorites: [], directive_text: null,
  };

  it('returns an empty string when nothing is set', () => {
    expect(feedbackBlock(empty)).toBe('');
    expect(feedbackBlock(null)).toBe('');
  });

  it('merges confirmed and edited into one locked-traits line', () => {
    const out = feedbackBlock({ ...empty, confirmed: ['A.'], edited: ['B.'] });
    expect(out).toBe(
      '\n\n## User Feedback\n' +
        '- The following traits are already locked in by the user and are stored ' +
        'separately — do NOT output them (or reworded variants) in your trait ' +
        'list, and do not contradict them: A.; B.\n'
    );
  });

  it('renders a downweighted float the way Python str(float) does', () => {
    const out = feedbackBlock({
      ...empty,
      downweighted: [{ claim: 'Likes long books.', user_weight: 0.5 }, { claim: 'X.', user_weight: 1 }],
    });
    expect(out).toContain('Likes long books. (weight 0.5); X. (weight 1.0)');
  });

  it('emits one dash-prefixed line per populated bucket, in Python order', () => {
    const out = feedbackBlock({
      ...empty,
      rejected: ['R.'],
      more_like: ['M by A'],
      less_like: ['L by B'],
      favorites: ['F by C'],
      directive_text: '  Keep it literary.  ',
    });
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('rejected by the user');
    expect(lines[1]).toContain('MORE recommendations like: M by A');
    expect(lines[2]).toContain('FEWER recommendations like: L by B');
    expect(lines[3]).toContain('all-time favorite books');
    expect(lines[4]).toContain('custom instructions');
    expect(lines[4]).toContain('Keep it literary.'); // trimmed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts`
Expected: FAIL — cannot resolve `../profileFeedback`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/lib/server/profileFeedback.ts`:

```ts
/**
 * Port of profile.py's structured-feedback layer (_feedback_context, _feedback_block).
 * Every query here feeds the byte-exact Claude prompt, so every one carries an
 * explicit ORDER BY (Python's have none and rely on physical row order).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from './db';
import { pyFloatStr } from './serialize';

export interface FeedbackContext {
  confirmed: string[];
  edited: string[];
  rejected: string[];
  downweighted: { claim: string; user_weight: number }[];
  more_like: string[];
  less_like: string[];
  favorites: string[];
  directive_text: string | null;
}

function label(title: string, author: string | null): string {
  return author ? `${title} by ${author}` : title;
}

/** Twin of profile._feedback_context. */
export async function feedbackContext(db: Db, userId: string): Promise<FeedbackContext> {
  const traits = await db
    .select({
      claim: schema.tasteTraits.claim,
      status: schema.tasteTraits.status,
      userWeight: schema.tasteTraits.userWeight,
    })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(asc(schema.tasteTraits.id));

  const confirmed = traits.filter((t) => t.status === 'confirmed').map((t) => t.claim);
  const edited = traits.filter((t) => t.status === 'edited').map((t) => t.claim);
  const rejected = traits.filter((t) => t.status === 'rejected').map((t) => t.claim);
  const downweighted = traits
    .filter((t) => t.userWeight !== null && t.userWeight < 1.0 && t.status !== 'rejected')
    .map((t) => ({ claim: t.claim, user_weight: t.userWeight }));

  const signals = await db
    .select({
      targetBookId: schema.tasteSignal.targetBookId,
      direction: schema.tasteSignal.direction,
    })
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), eq(schema.tasteSignal.targetKind, 'book')))
    .orderBy(asc(schema.tasteSignal.id));

  // Python resolves each signal's book with its own userId-scoped query; batching
  // into one IN(...) is equivalent because the map is keyed by id and scoped the same.
  const bookIds = [
    ...new Set(signals.map((s) => s.targetBookId).filter((id): id is number => id != null)),
  ];
  const labels = new Map<number, string>();
  if (bookIds.length) {
    const books = await db
      .select({ id: schema.books.id, title: schema.books.title, author: schema.books.author })
      .from(schema.books)
      .where(and(eq(schema.books.userId, userId), inArray(schema.books.id, bookIds)));
    for (const b of books) labels.set(b.id, label(b.title, b.author));
  }

  const more_like: string[] = [];
  const less_like: string[] = [];
  for (const sig of signals) {
    const l = sig.targetBookId != null ? labels.get(sig.targetBookId) : undefined;
    if (l === undefined) continue;
    if (sig.direction === 'more') more_like.push(l);
    else if (sig.direction === 'less') less_like.push(l);
  }

  const favoriteBooks = await db
    .select({ title: schema.books.title, author: schema.books.author })
    .from(schema.books)
    .where(and(eq(schema.books.userId, userId), eq(schema.books.isFavorite, true)))
    .orderBy(asc(schema.books.id));
  const favorites = favoriteBooks.map((b) => label(b.title, b.author));

  const directiveRows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, userId));
  const directive = directiveRows[0];
  let directive_text: string | null = null;
  if (directive) {
    // Python: `directive.nl_text or directive.constraints` — an empty dict is
    // FALSY in Python but `{}` is truthy in JS, hence the explicit key count.
    const constraints = (directive.constraints ?? {}) as Record<string, unknown>;
    if (directive.nlText || Object.keys(constraints).length > 0) {
      directive_text = directive.nlText;
    }
  }

  return {
    confirmed,
    edited,
    rejected,
    downweighted,
    more_like,
    less_like,
    favorites,
    directive_text,
  };
}

/** Twin of profile._feedback_block. Returns '' when no bucket is populated. */
export function feedbackBlock(feedback: FeedbackContext | null): string {
  if (!feedback) return '';
  const lines: string[] = [];

  const locked = [...feedback.confirmed, ...feedback.edited];
  if (locked.length) {
    lines.push(
      'The following traits are already locked in by the user and are stored ' +
        'separately — do NOT output them (or reworded variants) in your trait ' +
        'list, and do not contradict them: ' +
        locked.join('; ')
    );
  }
  if (feedback.rejected.length) {
    lines.push(
      'The following traits were rejected by the user — do NOT re-derive or ' +
        'include variants of these: ' +
        feedback.rejected.join('; ')
    );
  }
  if (feedback.downweighted.length) {
    const rendered = feedback.downweighted
      .map((d) => `${d.claim} (weight ${pyFloatStr(d.user_weight)})`)
      .join('; ');
    lines.push(
      'The following traits should be softened (user finds them less ' +
        'important): ' +
        rendered
    );
  }
  if (feedback.more_like.length) {
    lines.push(
      'The user wants MORE recommendations like: ' +
        feedback.more_like.join('; ') +
        ' — treat these as strong positive signal'
    );
  }
  if (feedback.less_like.length) {
    lines.push(
      'The user wants FEWER recommendations like: ' +
        feedback.less_like.join('; ') +
        ' — treat these as strong negative signal (aversion)'
    );
  }
  if (feedback.favorites.length) {
    lines.push(
      "The following are the user's all-time favorite books — weight these " +
        'as the strongest possible positive signal when deriving taste traits: ' +
        feedback.favorites.join('; ')
    );
  }
  const directiveText = (feedback.directive_text ?? '').trim();
  if (directiveText) {
    lines.push(
      'The reader wrote these custom instructions about what they want to read next. ' +
        'Treat them as direct, high-priority guidance when deriving traits (honor them; ' +
        'do not contradict them): ' +
        directiveText
    );
  }

  if (!lines.length) return '';
  return '\n\n## User Feedback\n' + lines.map((l) => `- ${l}`).join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts
npm run type-check && npm run lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/profileFeedback.ts frontend/lib/server/__tests__/profile-build.test.ts
git commit -m "feat(node): taste-profile feedback context + prompt block"
```

---

## Task 4: Rejected-claim filtering

Port of `profile.py:383-435` (`_REJECT_STOPWORDS`, `_claim_tokens`, `_remove_rejected_claims`).

**Files:**
- Modify: `frontend/lib/server/profileFeedback.ts`
- Test: `frontend/lib/server/__tests__/profile-build.test.ts` (append)

**Interfaces:**
- Produces:
  - `claimTokens(text: string): Set<string>`
  - `removeRejectedClaims<T extends { claim?: unknown }>(newTraits: T[], rejectedClaims: string[]): T[]`

- [ ] **Step 1: Write the failing test**

Append to `frontend/lib/server/__tests__/profile-build.test.ts` (extend the `profileFeedback` import):

```ts
describe('removeRejectedClaims', () => {
  const t = (claim: string) => ({ claim });

  it('returns the input untouched when there is nothing rejected', () => {
    const traits = [t('A.')];
    expect(removeRejectedClaims(traits, [])).toBe(traits);
  });

  it('drops a case-insensitive substring match in either direction', () => {
    const kept = removeRejectedClaims(
      [t('Loves SPARKLY VAMPIRE romance above all.'), t('Rewards dense world-building.')],
      ['sparkly vampire romance']
    );
    expect(kept.map((x) => x.claim)).toEqual(['Rewards dense world-building.']);
  });

  it('drops a reworded variant on >=60% significant-token overlap', () => {
    // rejected tokens: {enjoys, sparkly, vampire, romance} -> 3/4 = 0.75
    const kept = removeRejectedClaims(
      [t('Sparkly vampire stories are a romance staple here.')],
      ['Enjoys sparkly vampire romance.']
    );
    expect(kept).toEqual([]);
  });

  it('keeps a trait below the overlap threshold', () => {
    // 1/4 = 0.25
    const kept = removeRejectedClaims([t('Enjoys hard science fiction.')], ['Enjoys sparkly vampire romance.']);
    expect(kept.map((x) => x.claim)).toEqual(['Enjoys hard science fiction.']);
  });

  it('keeps a trait whose claim is empty rather than matching everything', () => {
    // Guard on Python's `if claim_lower and ...`: '' is a substring of every string.
    const kept = removeRejectedClaims([{ claim: '' }], ['Anything at all.']);
    expect(kept).toHaveLength(1);
  });
});

describe('claimTokens', () => {
  it('lowercases, splits on non-alphanumerics and drops stopwords', () => {
    expect([...claimTokens('The reader, above all, is NOT a fan of X-99.')].sort()).toEqual(
      ['99', 'fan', 'reader', 'x'].sort()
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts`
Expected: FAIL — `claimTokens` / `removeRejectedClaims` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/lib/server/profileFeedback.ts`:

```ts
// Copied verbatim from profile._REJECT_STOPWORDS.
const REJECT_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'above', 'all', 'over', 'under', 'this', 'that', 'these', 'those', 'its',
  'it', 'is', 'are', 'be', 'as', 'than', 'but', 'not', 'no',
]);

/** Twin of profile._claim_tokens: re.findall(r"[a-z0-9]+", text.lower()) minus stopwords. */
export function claimTokens(text: string): Set<string> {
  const words = (text || '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => !REJECT_STOPWORDS.has(w)));
}

/**
 * Twin of profile._remove_rejected_claims. Drops traits that either contain (or are
 * contained by) a rejected claim case-insensitively, or share >= 60% of the rejected
 * claim's significant tokens — so a paraphrase of a killed trait cannot come back.
 */
export function removeRejectedClaims<T extends { claim?: unknown }>(
  newTraits: T[],
  rejectedClaims: string[]
): T[] {
  if (!rejectedClaims.length) return newTraits;
  const rejected = rejectedClaims.filter((r) => r && r.trim());
  const rejLower = rejected.map((r) => r.trim().toLowerCase());
  // Python tokenizes the UNTRIMMED string here; tokenizing ignores whitespace, so
  // this matches, but keep the parallel obvious.
  const rejTokens = rejected.map((r) => claimTokens(r));

  const kept: T[] = [];
  for (const trait of newTraits) {
    const claim = String(trait.claim ?? '').trim();
    const claimLower = claim.toLowerCase();
    const ct = claimTokens(claim);
    let matched = false;
    for (let i = 0; i < rejLower.length; i++) {
      const rl = rejLower[i];
      const rt = rejTokens[i];
      // Guard on a non-empty claim: '' is a substring of everything.
      if (claimLower && (claimLower.includes(rl) || rl.includes(claimLower))) {
        matched = true;
        break;
      }
      if (rt.size) {
        let overlap = 0;
        for (const w of rt) if (ct.has(w)) overlap++;
        if (overlap / rt.size >= 0.6) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) kept.push(trait);
  }
  return kept;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts
npm run type-check && npm run lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/profileFeedback.ts frontend/lib/server/__tests__/profile-build.test.ts
git commit -m "feat(node): rejected-claim paraphrase filter"
```

---

## Task 5: Full-build prompt + fixture capture + prompt parity

Port of `profile.py:38-114, 438-495` (`_TOOL`, `_SYSTEM`, `_build_prompt`), then prove byte-equality against Python's recorded `create()` kwargs.

**Files:**
- Create: `frontend/lib/server/profileBuild.ts`
- Modify: `scripts/gen_claude_fixtures.py`
- Modify: `frontend/lib/server/__tests__/fixtures/claude/prompts.json` (regenerated)
- Modify: `frontend/lib/server/__tests__/parity-prompts.test.ts`

**Interfaces:**
- Consumes: `Tiers` (Task 2), `FeedbackContext` + `feedbackBlock` (Task 3), `pyJsonDumps` + `pyRepr` (Task 1).
- Produces:
  - `PROFILE_MODEL` (getter function `profileModel(): string`, since it reads env at call time like Python)
  - `PROFILE_SYSTEM: string`, `PROFILE_TOOL: object`, `TRAIT_INPUT_SCHEMA: object`
  - `buildProfilePrompt(tiers: Tiers, feedback: FeedbackContext | null): string`

- [ ] **Step 1: Write the failing test**

First extend the generator. In `scripts/gen_claude_fixtures.py`:

Add `profile` to the import line:
```python
from mylibrary import archetype as archetype_mod, reveal as reveal_mod  # noqa: E402
from mylibrary import profile as profile_mod  # noqa: E402
```

Add it to the monkey-patch loop:
```python
for mod in (directive_mod, archetype_mod, reveal_mod, profile_mod):
    mod.tracked_create = _capture
```

Add two scenarios to `SCENARIOS` (order matters only for readability — each run clears `captured`):
```python
    "profile_full": lambda: profile_mod.extract_taste_profile(),
    "profile_update": lambda: profile_mod.update_taste_profile(),
```

Then run it and add the parity cases. Append to `frontend/lib/server/__tests__/parity-prompts.test.ts`:

```ts
import { buildTiers } from '../profileTiers';
import { feedbackContext } from '../profileFeedback';
import {
  buildProfilePrompt,
  PROFILE_SYSTEM,
  PROFILE_TOOL,
  profileModel,
} from '../profileBuild';

describe('prompt parity: full taste-profile build', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).profile_full.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const tiers = await buildTiers(db, 'local');
      const feedback = await feedbackContext(db, 'local');
      expect(buildProfilePrompt(tiers, feedback)).toBe(py.messages[0].content);
      expect(PROFILE_SYSTEM).toBe(py.system);
      expect(PROFILE_TOOL).toEqual(py.tools[0]);
      expect(profileModel()).toBe(py.model);
      expect(3000).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'record_taste_traits' });
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
.venv/bin/python scripts/gen_claude_fixtures.py
```
Expected: prints `wrote .../prompts.json scenarios: ['directive_distill', 'archetype', 'reveal_lines', 'profile_full', 'profile_update']`.

If it errors with `KeyError: 'id'`, Task 0 was not applied — stop and apply it.
If it errors with `assert captured, "profile_full captured no Claude call"`, the monkey-patch did not take: check that `profile.py` imports `tracked_create` by name (it does, line 35) and that you patched `profile_mod`, not `mylibrary.usage`.

Then: `cd frontend && npx vitest run lib/server/__tests__/parity-prompts.test.ts`
Expected: FAIL — cannot resolve `../profileBuild`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/lib/server/profileBuild.ts`. Every string below is a verbatim transcription of `mylibrary/profile.py`; a single differing character fails the parity test:

```ts
/**
 * Port of profile.py's cold-start taste-profile extractor (_TOOL, _SYSTEM,
 * _build_prompt, extract_taste_profile). Strings are copied verbatim from Python —
 * prompt parity is asserted byte-for-byte in parity-prompts.test.ts.
 */
import { eq, and } from 'drizzle-orm';
import { schema, type Db } from './db';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { pyJsonDumps, pyRepr, utcnowTs } from './serialize';
import { ApiError } from './errors';
import { buildTiers, type Tiers } from './profileTiers';
import {
  feedbackContext,
  feedbackBlock,
  removeRejectedClaims,
  type FeedbackContext,
} from './profileFeedback';
import { NO_RATED_BOOKS_MESSAGE } from './claudeErrors';

/** Twin of config.get_settings().model — read at call time, as Python does. */
export function profileModel(): string {
  return process.env.MYLIBRARY_MODEL || 'claude-sonnet-5';
}

export const PROFILE_MAX_TOKENS = 3000;

/** Shared by _TOOL and _REVISE_TOOL in Python (`"input_schema": _TOOL["input_schema"]`). */
export const TRAIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    traits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: {
            type: 'string',
            description:
              "A specific, falsifiable claim about what drives this " +
              "reader's ratings, e.g. 'Rewards dense political " +
              "world-building over fast plotting.' Avoid generic " +
              'genre statements.',
          },
          polarity: {
            type: 'string',
            enum: ['reward', 'aversion'],
            description:
              "'reward' = trait associated with higher ratings; " +
              "'aversion' = trait shared by lower-rated books.",
          },
          exhibits: {
            type: 'array',
            items: { type: 'integer' },
            description:
              "Book ids that EXHIBIT the trait: for a 'reward', the " +
              "high-rated books showing it; for an 'aversion', the " +
              'low-rated books showing it. These must be consistent ' +
              'with the polarity — do NOT put high-rated books here ' +
              'for an aversion.',
          },
          contrasts: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'Book ids that anchor the CONTRAST — the counter-examples ' +
              'that make the distinction sharp (e.g. for an aversion to ' +
              'X, similar books WITHOUT X that scored higher). May be ' +
              'empty if the trait stands on its exhibits alone.',
          },
          inference_confidence: {
            type: 'number',
            description: '0..1 — how strongly the evidence supports the claim.',
          },
        },
        required: ['claim', 'polarity', 'exhibits', 'contrasts', 'inference_confidence'],
      },
    },
  },
  required: ['traits'],
};

export const PROFILE_TOOL = {
  name: 'record_taste_traits',
  description:
    "Record the taste traits inferred from the reader's rated library. " +
    'Each trait must distinguish rating tiers and cite the book ids that support it.',
  input_schema: TRAIT_INPUT_SCHEMA,
};

export const PROFILE_SYSTEM =
  'You are a literary taste analyst. You infer what drives a specific reader\'s ' +
  'ratings from their library metadata. You reason about CONTRAST between rating ' +
  'tiers, never asserting a trait without citing the books that evidence it. You ' +
  'only cite book ids that appear in the provided data.';

/**
 * Twin of profile._build_prompt. `Tier sizes: {counts}` interpolates a Python DICT
 * REPR (single quotes, insertion order) — not JSON — hence pyRepr over a Map.
 */
export function buildProfilePrompt(tiers: Tiers, feedback: FeedbackContext | null): string {
  const counts = new Map<string, number>([...tiers.entries()].map(([k, v]) => [k, v.length]));
  return (
    "Below is a reader's library, grouped by star rating and status. Each book has " +
    'enriched metadata (subjects, year, length, series). Most books have no review ' +
    'text, so reason mainly from metadata + the rating tiers — but where a book ' +
    "carries a `review` field, those are the reader's own words: treat them as the " +
    'strongest, most direct signal, above any metadata inference.\n\n' +
    `Tier sizes: ${pyRepr(counts)}. Note the heavy positive skew — 'loved it' has low ` +
    'discriminative power, so focus on what is genuinely distinguishing.\n\n' +
    'The `dnf` tier contains books the reader abandoned before finishing. Treat ' +
    'these as the strongest possible aversion signal, even stronger than 1-2 star ' +
    'ratings, since the reader could not complete them. Any `review` field on a ' +
    'DNF book is direct first-person evidence explaining why they quit.\n\n' +
    'The `rejected` tier contains books the reader explicitly skipped when ' +
    'recommended, with a note explaining why. These are direct first-person ' +
    'statements of aversion — treat each `note` as reliable testimony about what ' +
    'this reader does NOT want, and use them to sharpen aversion traits.\n\n' +
    "Infer the reader's taste traits. Prioritize, in order:\n" +
    '  1. What separates the 5-star books from the 4-star books?\n' +
    "  2. What do the lowest-rated books (<=2 and 3), DNF books, and rejected recommendations share? (these are 'aversion' traits)\n" +
    '  3. Cross-cutting rewards visible across the high tiers.\n\n' +
    'For EACH trait, split the evidence into two fields:\n' +
    '  - `exhibits`: the books that SHOW the trait. These MUST match the polarity — ' +
    "an aversion's exhibits are LOW-rated books, a reward's exhibits are HIGH-rated. " +
    "Never put high-rated books in an aversion's exhibits.\n" +
    '  - `contrasts`: the counter-examples that sharpen the distinction (e.g. for an ' +
    'aversion to X, similar books WITHOUT X that scored higher). May be empty.\n\n' +
    'Temporal context: The `read_year` field shows when each book was read (or ' +
    'added to the shelf). Tastes evolve, so weight this accordingly:\n' +
    '  - Recent reads (2020+) are the strongest signal of current preferences.\n' +
    '  - Mid-era reads (2015-2019) are relevant but may reflect a transitional period.\n' +
    '  - Older reads (pre-2015) may reflect a different life stage entirely — for ' +
    "example, a heavy YA phase in one's teens is not necessarily a current preference.\n" +
    '  - Lower `inference_confidence` for traits supported only by older reads unless ' +
    'those same traits are echoed in more recent ones. If a trait is consistent across ' +
    'all eras, call it an enduring preference (and note that in the claim).\n' +
    '  IMPORTANT EXCEPTION — do NOT apply temporal discounting to traits rooted in ' +
    'values or representation (e.g. LGBTQ+ themes, feminist perspectives, racial or ' +
    "political identity in fiction). A reader's core values rarely regress with age: " +
    'the absence of such themes in recent reads more likely reflects the books ' +
    "available than a shift in the reader's preferences. If a value-based trait is " +
    'consistent across any era of the library, treat it as enduring regardless of ' +
    'when those books were read. Only downweight it if recent reads actively ' +
    'contradict it (e.g. the reader started rating books with that theme *lower*).\n\n' +
    'Quality rules:\n' +
    '  - Use ONLY book ids from the data below.\n' +
    '  - Make claims specific and falsifiable, not generic genre labels.\n' +
    "  - Do NOT force a book into a trait it doesn't fit just to pad the evidence.\n" +
    "  - Keep traits DISTINCT — don't emit two traits describing the same pattern.\n" +
    '  - Distinguish genuine taste from mechanical rating drift (e.g. later books in ' +
    'a long series slipping a star is series fatigue, not a standalone taste trait).\n' +
    '  - Lower your inference_confidence when a trait rests on very few books.\n' +
    '  - Aim for 6-12 traits. Record them with the record_taste_traits tool.\n\n' +
    'LIBRARY DATA (JSON):\n' +
    pyJsonDumps(tiers) +
    feedbackBlock(feedback)
  );
}
```

Add to `frontend/lib/server/claudeErrors.ts`:

```ts
export const PROFILE_NO_KEY_MESSAGE =
  'No Anthropic API key configured. Add your key in Settings (or set ' +
  'ANTHROPIC_API_KEY) before running the taste-profile step.';

export const NO_RATED_BOOKS_MESSAGE = 'No rated books found. Run ingest (and enrich) first.';
```

(`extractTasteProfile` itself lands in Task 6 — for now `profileBuild.ts` may import `NO_RATED_BOOKS_MESSAGE` without using it; if lint objects to the unused imports at this step, add them in Task 6 instead and keep this file to constants + prompt only.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/parity-prompts.test.ts
```
Expected: PASS.

**If the prompt assertion fails,** do not eyeball the diff — vitest truncates. Dump both to files and diff:
```bash
node -e "const p=require('./lib/server/__tests__/fixtures/claude/prompts.json');process.stdout.write(p.profile_full.kwargs.messages[0].content)" > /tmp/py.txt
# add a temporary console.log of the Node prompt into the test, rerun, then:
diff <(cat /tmp/py.txt) /tmp/node.txt | head -40
```
The three overwhelmingly likely causes, in order: (1) `Tier sizes:` rendered as JSON instead of a dict repr, (2) tier key order reordered by using a plain object somewhere, (3) a smart-quote/em-dash transcription slip.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/profileBuild.ts frontend/lib/server/claudeErrors.ts \
        scripts/gen_claude_fixtures.py \
        frontend/lib/server/__tests__/fixtures/claude/prompts.json \
        frontend/lib/server/__tests__/parity-prompts.test.ts
git commit -m "feat(node): full taste-profile prompt + byte parity fixtures"
```

---

## Task 6: `extractTasteProfile` + `POST /api/profile`

Port of `profile.py:498-582` and `api.py:642-645`.

**Files:**
- Modify: `frontend/lib/server/profileBuild.ts`
- Modify: `frontend/app/api/profile/route.ts`
- Test: `frontend/lib/server/__tests__/profile-build.test.ts` (append)

**Interfaces:**
- Produces:
  - `markProfiled(tx: Db, kind: string, userId: string): Promise<void>`
  - `extractTasteProfile(db: Db, client: ClaudeClient, userId: string, maxTokens?: number): Promise<Record<string, unknown>>`
  - `POST` export on `/api/profile`

**Design note (read before implementing):** Python holds one SQLAlchemy session open across the Claude call. Node must **not** — `db.ts` opens the pool with `max: 1`, so any query issued on the outer `db` while a transaction is open deadlocks outright. Sequence is: read (no transaction) → Claude call (no transaction) → one transaction for all writes. Nothing is written before the Claude call in Python either, so this is observationally identical.

- [ ] **Step 1: Write the failing test**

Append to `frontend/lib/server/__tests__/profile-build.test.ts`:

```ts
import { fakeClaude } from './helpers/fakeClaude';
import { extractTasteProfile } from '../profileBuild';
import { asc } from 'drizzle-orm';

function traitsResponse(traits: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: 'record_taste_traits', input: { traits } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

describe('extractTasteProfile', () => {
  it('persists returned traits, replaces prior proposed ones, and stamps profile_meta', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        traitsResponse([
          {
            claim: '  Rewards dense political world-building.  ',
            polarity: 'reward',
            exhibits: [1, 2, 9999], // 9999 is not in the library and must be filtered
            contrasts: [6],
            inference_confidence: 0.87,
          },
        ]),
      ]);

      const out = await extractTasteProfile(db, client, 'local');

      expect(out.mode).toBe('full');
      expect(out.traits_saved).toBe(1);
      expect(out.model).toBe('claude-sonnet-5');
      expect(out.rated_books).toBe(13); // every tier except `rejected`

      const rows = await db
        .select()
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.userId, 'local'))
        .orderBy(asc(schema.tasteTraits.id));

      const proposed = rows.filter((r) => r.status === 'proposed');
      expect(proposed).toHaveLength(1);
      expect(proposed[0].claim).toBe('Rewards dense political world-building.'); // trimmed
      expect(proposed[0].exhibits).toEqual([1, 2]); // 9999 filtered out
      expect(proposed[0].contrasts).toEqual([6]);

      // Seeded confirmed (id 2) and rejected (id 4) traits survive; proposed 1 and 3 are gone.
      const statuses = rows.map((r) => r.status).sort();
      expect(statuses).toEqual(['confirmed', 'proposed', 'rejected']);

      const meta = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(meta[0].lastProfileKind).toBe('full');
      expect(meta[0].lastProfiledAt).not.toBe('2026-07-01 12:00:00');
    } finally {
      await close();
    }
  });

  it('drops traits that paraphrase a rejected or user-locked claim', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        traitsResponse([
          { claim: 'Avoids grimdark tone entirely.', polarity: 'aversion', exhibits: [6], contrasts: [], inference_confidence: 0.5 },
          { claim: 'Values competence and problem-solving protagonists.', polarity: 'reward', exhibits: [3], contrasts: [], inference_confidence: 0.9 },
          { claim: 'Rewards slow, atmospheric fiction.', polarity: 'reward', exhibits: [1], contrasts: [], inference_confidence: 0.6 },
        ]),
      ]);

      const out = await extractTasteProfile(db, client, 'local');
      expect(out.traits_saved).toBe(1);

      const proposed = await db
        .select()
        .from(schema.tasteTraits)
        .where(and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed')));
      expect(proposed.map((p) => p.claim)).toEqual(['Rewards slow, atmospheric fiction.']);
    } finally {
      await close();
    }
  });

  it('records a usage_events row under operation profile_full', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await extractTasteProfile(db, fakeClaude([traitsResponse([])]), 'local');
      const events = await db.select().from(schema.usageEvents);
      expect(events.some((e) => e.operation === 'profile_full' && e.userId === 'local')).toBe(true);
    } finally {
      await close();
    }
  });

  it('throws a 400-shaped error when the user has no rated books', async () => {
    const { db, close } = await makeTestDb();
    try {
      // No seed at all: zero books.
      const client = fakeClaude([]);
      await expect(extractTasteProfile(db, client, 'local')).rejects.toThrow(
        'No rated books found. Run ingest (and enrich) first.'
      );
      // And it must fail BEFORE any Claude call.
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts`
Expected: FAIL — `extractTasteProfile` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/lib/server/profileBuild.ts`:

```ts
/** Twin of profile.mark_profiled — clears the 'dirty' state. Must run inside a tx. */
export async function markProfiled(tx: Db, kind: string, userId: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.profileMeta.id })
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  const stamp = { lastProfiledAt: utcnowTs(), lastProfileKind: kind };
  if (rows[0]) {
    await tx.update(schema.profileMeta).set(stamp).where(eq(schema.profileMeta.id, rows[0].id));
  } else {
    await tx.insert(schema.profileMeta).values({ userId, ...stamp });
  }
}

/**
 * Twin of profile.extract_taste_profile, minus key resolution (the route does that,
 * matching the wave-3a pattern, so this takes an already-built client and is
 * directly testable with fakeClaude).
 *
 * Python holds one session across the Claude call; Node cannot (db.ts uses max: 1,
 * so touching `db` inside an open transaction deadlocks). Reads happen first, the
 * Claude call runs with no transaction open, and all writes land in one transaction
 * afterwards. Python writes nothing before the call either, so this is equivalent.
 */
export async function extractTasteProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number = PROFILE_MAX_TOKENS
): Promise<Record<string, unknown>> {
  const tiers = await buildTiers(db, userId);
  let totalRated = 0;
  for (const [k, v] of tiers) if (k !== 'rejected') totalRated += v.length;
  if (totalRated === 0) throw new ApiError(400, NO_RATED_BOOKS_MESSAGE);

  const feedback = await feedbackContext(db, userId);
  const prompt = buildProfilePrompt(tiers, feedback);
  const model = profileModel();

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_full' },
    {
      model,
      max_tokens: maxTokens,
      system: PROFILE_SYSTEM,
      tools: [PROFILE_TOOL],
      tool_choice: { type: 'tool', name: 'record_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  // Python breaks on the FIRST tool_use block regardless of its name.
  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];

  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  const validIds = new Set<number>();
  for (const [, list] of tiers) {
    for (const b of list) {
      if (typeof b.id === 'number') validIds.add(b.id);
    }
  }

  const saved = await db.transaction(async (tx) => {
    await tx
      .delete(schema.tasteTraits)
      .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));

    let n = 0;
    for (const t of traits) {
      await tx.insert(schema.tasteTraits).values({
        userId,
        claim: String(t.claim ?? '').trim(),
        polarity: String(t.polarity ?? 'reward'),
        exhibits: asIdList(t.exhibits, validIds),
        contrasts: asIdList(t.contrasts, validIds),
        inferenceConfidence: Number(t.inference_confidence ?? 0.0),
        status: 'proposed',
      });
      n++;
    }
    await markProfiled(tx, 'full', userId);
    return n;
  });

  const tierCounts: Record<string, number> = {};
  for (const [k, v] of tiers) tierCounts[k] = v.length;

  return {
    mode: 'full',
    rated_books: totalRated,
    tiers: tierCounts,
    traits_saved: saved,
    model,
  };
}

/** Python: `[i for i in t.get("exhibits", []) if i in valid_ids]`. */
function asIdList(raw: unknown, validIds: Set<number>): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is number => typeof i === 'number' && validIds.has(i));
}
```

Note on `polarity`: Python's `t.get("polarity", "reward")` returns `None` if the key exists with a null value; the tool schema marks it required, so a well-formed response always has it. `String(t.polarity ?? 'reward')` differs only for an explicit `null`, where Python would insert `None` and hit a NOT NULL violation. Node's fallback is strictly safer; call it out as a deliberate deviation in the file comment if a reviewer asks.

Then add the `POST` handler to `frontend/app/api/profile/route.ts` (keep the existing `GET` untouched, add the imports):

```ts
import { ApiError } from '@/lib/server/http';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { PROFILE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { extractTasteProfile } from '@/lib/server/profileBuild';

// A full Sonnet build over a whole library is the longest Claude call in the app.
// 300s is Vercel Hobby's maximum and the default on every tier (verified 2026-08-06).
export const maxDuration = 300;

/** Port of api.py::profile (642-645): RuntimeError -> 400. */
export const POST = withApi('/api/profile', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) throw new ApiError(400, PROFILE_NO_KEY_MESSAGE);
  const client = makeAnthropicClient(apiKey);

  const out = await extractTasteProfile(db, client, ctx.user.userId);
  ctx.timer.mark('claude');
  return Response.json(out);
});
```

**Documented deviation to record:** the `tiers` sub-object in the response body is a plain JS object with integer-like keys, so `JSON.stringify` emits them as `3, 4, 5, <=2, dnf, rejected` where FastAPI emits `5, 4, 3, ...`. JSON object key order is semantically insignificant and every consumer reads by key, so this is invisible in practice — but note it, and make any parity assertion compare *parsed* objects, never raw body strings.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/profile-build.test.ts
npm run test:server && npm run type-check && npm run lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/profileBuild.ts frontend/app/api/profile/route.ts \
        frontend/lib/server/__tests__/profile-build.test.ts
git commit -m "feat(node): POST /api/profile (full taste-profile build)"
```

---

## Task 7: Change detection + revise prompt (`profileUpdate.ts`)

Port of `profile.py:209-232` (`books_changed_since`) and `595-647` (`_REVISE_TOOL`, `_REVISE_SYSTEM`, `_build_update_prompt`).

**Files:**
- Create: `frontend/lib/server/profileUpdate.ts`
- Test: `frontend/lib/server/__tests__/profile-update.test.ts` (create)
- Modify: `frontend/lib/server/__tests__/parity-prompts.test.ts`

**Interfaces:**
- Produces:
  - `booksChangedSince(db: Db, since: string | null, userId: string): Promise<BookRow[]>`
  - `REVISE_SYSTEM: string`, `REVISE_TOOL: object`
  - `buildUpdatePrompt(currentTraits, booksMeta, changedIds, feedback): string` where `currentTraits: Record<string, unknown>[]`, `booksMeta: Map<string, Record<string, unknown>>`, `changedIds: number[]`

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/profile-update.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import type { Seed } from './helpers/pglite';
import { booksChangedSince, buildUpdatePrompt } from '../profileUpdate';
import { pyFloat } from '../serialize';

describe('booksChangedSince', () => {
  it('returns rated/DNF/favorited books whose feedback changed after the cutoff', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const changed = await booksChangedSince(db, '2026-07-01 12:00:00', 'local');
      // 2: favorited (unrated by app but goodreads 5) @ 07-15
      // 3: re-rated @ 07-20
      // 9: DNF @ 07-18
      // 7 changed @ 06-01, before the cutoff.
      expect(changed.map((b) => b.id)).toEqual([2, 3, 9]);
    } finally {
      await close();
    }
  });

  it('treats a null cutoff as "everything carrying feedback"', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const changed = await booksChangedSince(db, null, 'local');
      expect(changed.map((b) => b.id)).toEqual([2, 3, 7, 9]);
    } finally {
      await close();
    }
  });
});

describe('buildUpdatePrompt', () => {
  it('renders changed ids as a Python list repr, not a JS join', () => {
    const out = buildUpdatePrompt([], new Map(), [2, 3, 9], null);
    expect(out).toContain('CHANGED BOOK IDS (the edits driving this update): [2, 3, 9]');
    expect(out).not.toContain('2,3,9');
  });

  it('renders an empty changed list as []', () => {
    expect(buildUpdatePrompt([], new Map(), [], null)).toContain('update): []\n');
  });

  it('renders an integral inference_confidence as a Python float', () => {
    const traits = [
      { id: 1, claim: 'A.', polarity: 'reward', inference_confidence: pyFloat(1), exhibits: [1], contrasts: [] },
    ];
    const out = buildUpdatePrompt(traits, new Map(), [1], null);
    expect(out).toContain('"inference_confidence": 1.0');
    expect(out).not.toContain('"inference_confidence": 1,');
  });
});
```

Then append the parity case to `frontend/lib/server/__tests__/parity-prompts.test.ts`:

```ts
import {
  buildUpdatePrompt,
  REVISE_SYSTEM,
  REVISE_TOOL,
  collectUpdateInputs,
} from '../profileUpdate';

describe('prompt parity: incremental profile update', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).profile_update.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const inputs = await collectUpdateInputs(db, 'local', '2026-07-01 12:00:00');
      const feedback = await feedbackContext(db, 'local');
      expect(
        buildUpdatePrompt(inputs.currentTraits, inputs.booksMeta, inputs.changedIds, feedback)
      ).toBe(py.messages[0].content);
      expect(REVISE_SYSTEM).toBe(py.system);
      expect(REVISE_TOOL).toEqual(py.tools[0]);
      expect(profileModel()).toBe(py.model);
      expect(3000).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'revise_taste_traits' });
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run lib/server/__tests__/profile-update.test.ts lib/server/__tests__/parity-prompts.test.ts`
Expected: FAIL — cannot resolve `../profileUpdate`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/lib/server/profileUpdate.ts`:

```ts
/**
 * Port of profile.py's incremental re-profile (_REVISE_TOOL, _REVISE_SYSTEM,
 * _build_update_prompt, books_changed_since, update_taste_profile).
 */
import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { effectiveRating, pyFloat, pyJsonDumps, pyRepr } from './serialize';
import { bookPayload, type BookRow, type EnrichmentRow } from './profileTiers';
import {
  feedbackContext,
  feedbackBlock,
  removeRejectedClaims,
  type FeedbackContext,
} from './profileFeedback';
import {
  PROFILE_MAX_TOKENS,
  TRAIT_INPUT_SCHEMA,
  extractTasteProfile,
  markProfiled,
  profileModel,
} from './profileBuild';

export const REVISE_TOOL = {
  name: 'revise_taste_traits',
  description:
    "Return the REVISED full taste-trait set after accounting for the reader's " +
    'latest rating/review changes. Keep traits that still hold (adjusting confidence ' +
    'or evidence as warranted), drop traits the new evidence contradicts, and add new ' +
    'traits the changes reveal. Cite only book ids present in the provided data.',
  // Same per-trait shape as the cold-start tool, so persistence is identical.
  input_schema: TRAIT_INPUT_SCHEMA,
};

export const REVISE_SYSTEM =
  "You are a literary taste analyst maintaining a reader's evolving taste profile. " +
  'You are given the profile you previously inferred plus the reader\'s most recent ' +
  'rating and review changes. You make the SMALLEST revision that honors the new ' +
  'evidence: keep what still holds, adjust confidence where the new data strengthens ' +
  'or weakens a claim, retire claims the new evidence contradicts, and add genuinely ' +
  "new traits. Review text is the reader's own words — weight it above metadata " +
  'inference. Cite only book ids that appear in the provided data.';

/**
 * Twin of profile.books_changed_since. The rated/DNF/favorite filter is applied in
 * application code, exactly as Python does, because `effective_rating` is a Python
 * property with no SQL equivalent. ORDER BY id keeps `changed_ids` deterministic —
 * it is interpolated into the prompt.
 */
export async function booksChangedSince(
  db: Db,
  since: string | null,
  userId: string
): Promise<BookRow[]> {
  const conds = [
    eq(schema.books.userId, userId),
    isNotNull(schema.books.feedbackUpdatedAt),
  ];
  if (since !== null) conds.push(gt(schema.books.feedbackUpdatedAt, since));

  const rows = await db
    .select()
    .from(schema.books)
    .where(and(...conds))
    .orderBy(asc(schema.books.id));

  return rows.filter(
    (b) =>
      effectiveRating(b.appRating, b.goodreadsRating) !== null ||
      b.exclusiveShelf === 'did-not-finish' ||
      b.isFavorite
  );
}

/**
 * Twin of profile._build_update_prompt. `CHANGED BOOK IDS` interpolates a Python
 * LIST REPR (`[2, 3, 9]`), and `booksMeta` must be a Map so its String(id) keys keep
 * query order rather than V8's numeric-key order.
 */
export function buildUpdatePrompt(
  currentTraits: Record<string, unknown>[],
  booksMeta: Map<string, Record<string, unknown>>,
  changedIds: number[],
  feedback: FeedbackContext | null
): string {
  return (
    'The reader has updated some ratings and/or written new reviews since this ' +
    'profile was last built. Revise the profile accordingly — do NOT re-derive it ' +
    'from scratch.\n\n' +
    'You are NOT given the whole library, only the books needed to reason about the ' +
    'change: the books that changed, plus the books the current traits already cite. ' +
    'Cite book ids only from the BOOKS map below.\n\n' +
    'How to revise:\n' +
    '  - Keep traits that still hold. Raise/lower `inference_confidence` if the new ' +
    'evidence strengthens or weakens them, and add/remove cited book ids as fitting.\n' +
    '  - Drop a trait whose evidence the changes now contradict (e.g. the reader ' +
    're-rated its key exhibit, or a new review states the opposite).\n' +
    '  - Add new traits the changes reveal — especially anything stated outright in a ' +
    'review.\n' +
    '  - A new/edited `review` is direct testimony; prefer it over metadata guesses.\n' +
    '  - Return the COMPLETE revised trait set (the unchanged traits too), 6-12 traits, ' +
    'via the revise_taste_traits tool.\n\n' +
    `CHANGED BOOK IDS (the edits driving this update): ${pyRepr(changedIds)}\n\n` +
    'CURRENT TRAITS (JSON):\n' +
    pyJsonDumps(currentTraits) +
    '\n\nBOOKS (id -> metadata; the only books you may cite) (JSON):\n' +
    pyJsonDumps(booksMeta) +
    feedbackBlock(feedback)
  );
}

export interface UpdateInputs {
  currentTraits: Record<string, unknown>[];
  booksMeta: Map<string, Record<string, unknown>>;
  changedIds: number[];
}

/**
 * Gathers the incremental prompt's two payloads: the current proposed traits and
 * the books they cite unioned with the changed books (profile.py:750-783).
 * `inference_confidence` is wrapped in pyFloat so an integral 1.0 serializes as
 * `1.0`, matching Python, rather than JSON.stringify's `1`.
 */
export async function collectUpdateInputs(
  db: Db,
  userId: string,
  since: string | null
): Promise<UpdateInputs> {
  const changed = await booksChangedSince(db, since, userId);
  const changedIds = changed.filter((b) => !b.excludeFromProfile).map((b) => b.id);

  const currentRows = await db
    .select()
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')))
    .orderBy(asc(schema.tasteTraits.id));

  const currentTraits = currentRows.map((t) => ({
    id: t.id,
    claim: t.claim,
    polarity: t.polarity,
    inference_confidence: pyFloat(t.inferenceConfidence),
    exhibits: (t.exhibits as number[] | null) ?? [],
    contrasts: (t.contrasts as number[] | null) ?? [],
  }));

  const citedIds = new Set<number>();
  for (const t of currentRows) {
    for (const i of ((t.exhibits as number[] | null) ?? [])) citedIds.add(i);
    for (const i of ((t.contrasts as number[] | null) ?? [])) citedIds.add(i);
  }
  const wantedIds = [...new Set([...citedIds, ...changedIds])];

  const booksMeta = new Map<string, Record<string, unknown>>();
  if (wantedIds.length) {
    const rows = await db
      .select({ book: schema.books, enrichment: schema.enrichment })
      .from(schema.books)
      .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
      .where(and(eq(schema.books.userId, userId), inArray(schema.books.id, wantedIds)))
      .orderBy(asc(schema.books.id));
    for (const { book, enrichment } of rows) {
      const payload = bookPayload(book, enrichment as EnrichmentRow | null);
      payload.rating = effectiveRating(book.appRating, book.goodreadsRating);
      booksMeta.set(String(book.id), payload);
    }
  }

  return { currentTraits, booksMeta, changedIds };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/profile-update.test.ts lib/server/__tests__/parity-prompts.test.ts
npm run type-check
```
Expected: PASS.

If the parity prompt differs, check `booksMeta` key order first — Python's `Book.id.in_(...)` query has no `ORDER BY`, and the captured fixture reflects whatever order SQLite returned (which is id-ascending). If the fixture disagrees with id-ascending, follow the **fixture**, and document why in a comment.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/profileUpdate.ts \
        frontend/lib/server/__tests__/profile-update.test.ts \
        frontend/lib/server/__tests__/parity-prompts.test.ts
git commit -m "feat(node): incremental profile revise prompt + change detection"
```

---

## Task 8: `updateTasteProfile` control flow + `POST /api/profile/update`

Port of `profile.py:650-848` and `api.py:909-916`. This task is **all about the branch table** — five distinct outcomes, four of which never call Claude.

| Condition | Outcome |
|---|---|
| No proposed traits, or `last_profiled_at` is null | delegate to `extractTasteProfile` (mode `full`) |
| `enrichment_corrected_at > since` | delegate to `extractTasteProfile` (mode `full`) |
| No changed ids, no changed books at all, no feedback since | early return, mode `update`, with a `note` and **no `books_sent` key** |
| No changed ids, but some changed books (exclusion toggles only), no feedback since | delegate to `extractTasteProfile` (mode `full`) |
| No changed ids, but feedback since | fall through to the Claude call with `changedIds = []` |
| Changed ids present | fall through to the Claude call |

**Files:**
- Modify: `frontend/lib/server/profileUpdate.ts`
- Create: `frontend/app/api/profile/update/route.ts`
- Test: `frontend/lib/server/__tests__/profile-update.test.ts` (append)

**Interfaces:**
- Produces: `updateTasteProfile(db, client, userId, maxTokens?): Promise<Record<string, unknown>>`; `POST` on `/api/profile/update`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/lib/server/__tests__/profile-update.test.ts` (add imports for `fakeClaude`, `schema`, `eq`, `and`, `updateTasteProfile`):

```ts
function reviseResponse(traits: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: 'revise_taste_traits', input: { traits } }],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

describe('updateTasteProfile', () => {
  it('revises the trait set from the seeded changes', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        reviseResponse([
          { claim: 'Rewards problem-solving under pressure.', polarity: 'reward', exhibits: [3], contrasts: [9999], inference_confidence: 0.9 },
        ]),
      ]);

      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('update');
      expect(out.changed_books).toBe(3); // books 2, 3, 9
      expect(out.traits_before).toBe(2); // seeded proposed traits 1 and 3
      expect(out.traits_after).toBe(1);
      expect(typeof out.books_sent).toBe('number');

      const proposed = await db
        .select()
        .from(schema.tasteTraits)
        .where(and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed')));
      expect(proposed).toHaveLength(1);
      // 9999 is not in books_meta, so it is filtered from contrasts.
      expect(proposed[0].contrasts).toEqual([]);

      const events = await db.select().from(schema.usageEvents);
      expect(events.some((e) => e.operation === 'profile_update')).toBe(true);
    } finally {
      await close();
    }
  });

  it('falls back to a full build when there is no prior profile', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .delete(schema.tasteTraits)
        .where(and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed')));

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      // The full builder must have been the one that called Claude.
      expect(client.calls[0].params.tool_choice).toEqual({
        type: 'tool',
        name: 'record_taste_traits',
      });
    } finally {
      await close();
    }
  });

  it('falls back to a full build after an enrichment correction', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.profileMeta)
        .set({ enrichmentCorrectedAt: '2026-07-25 12:00:00' })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
    } finally {
      await close();
    }
  });

  it('returns the up-to-date note without calling Claude when nothing changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Push the last-profiled stamp past every change in the seed.
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([]);
      const out = await updateTasteProfile(db, client, 'local');

      expect(out).toEqual({
        mode: 'update',
        changed_books: 0,
        traits_before: 2,
        traits_after: 2,
        note: 'Profile already up to date — no rating/review changes since last build.',
        model: 'claude-sonnet-5',
      });
      expect('books_sent' in out).toBe(false);
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('falls back to a full build when only exclusion toggles changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));
      // One excluded book with feedback after the cutoff: it counts as `changed`
      // but is filtered out of `changed_ids`.
      await db
        .update(schema.books)
        .set({ excludeFromProfile: true, feedbackUpdatedAt: '2027-02-01 00:00:00' })
        .where(eq(schema.books.id, 3));

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/profile-update.test.ts`
Expected: FAIL — `updateTasteProfile` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/lib/server/profileUpdate.ts`:

```ts
/**
 * Twin of profile.update_taste_profile. Four of its six branches never reach Claude;
 * see the branch table in the wave-3b plan. Like extractTasteProfile, the Claude call
 * runs outside any transaction and all writes land in one transaction afterwards.
 */
export async function updateTasteProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number = PROFILE_MAX_TOKENS
): Promise<Record<string, unknown>> {
  const model = profileModel();

  const existing = await db
    .select({ id: schema.tasteTraits.id })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));

  // Python's get_profile_meta creates the row on first use and commits it.
  const meta = await ensureMeta(db, userId);
  const since = meta.lastProfiledAt;

  if (!existing.length || since === null) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  const changed = await booksChangedSince(db, since, userId);
  const changedIds = changed.filter((b) => !b.excludeFromProfile).map((b) => b.id);

  const traitVerdicts = await db
    .select({ id: schema.tasteTraits.id })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), gt(schema.tasteTraits.verdictUpdatedAt, since)))
    .limit(1);
  const newSignals = await db
    .select({ id: schema.tasteSignal.id })
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), gt(schema.tasteSignal.createdAt, since)))
    .limit(1);
  const hasFeedbackSince =
    traitVerdicts.length > 0 ||
    newSignals.length > 0 ||
    (meta.recFeedbackUpdatedAt !== null && meta.recFeedbackUpdatedAt > since);

  // A LOW-confidence match correction changes metadata without touching feedback
  // timestamps, so it never shows up in `changed`; force a full rebuild.
  if (meta.enrichmentCorrectedAt !== null && meta.enrichmentCorrectedAt > since) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  if (!changedIds.length) {
    if (!changed.length && !hasFeedbackSince) {
      return {
        mode: 'update',
        changed_books: 0,
        traits_before: existing.length,
        traits_after: existing.length,
        note: 'Profile already up to date — no rating/review changes since last build.',
        model,
      };
    }
    if (!hasFeedbackSince) {
      // Only exclusion toggles changed; the incremental prompt cannot re-derive
      // their (removed) metadata signal.
      return extractTasteProfile(db, client, userId, maxTokens);
    }
    // Feedback-only update: fall through with an empty changedIds list.
  }

  const inputs = await collectUpdateInputs(db, userId, since);
  const feedback = await feedbackContext(db, userId);
  const prompt = buildUpdatePrompt(
    inputs.currentTraits,
    inputs.booksMeta,
    inputs.changedIds,
    feedback
  );

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_update' },
    {
      model,
      max_tokens: maxTokens,
      system: REVISE_SYSTEM,
      tools: [REVISE_TOOL],
      tool_choice: { type: 'tool', name: 'revise_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];
  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  // Unlike the full build, valid ids come from books_meta, not the tiers.
  const validIds = new Set<number>([...inputs.booksMeta.keys()].map((k) => Number(k)));

  const saved = await db.transaction(async (tx) => {
    await tx
      .delete(schema.tasteTraits)
      .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));
    let n = 0;
    for (const t of traits) {
      await tx.insert(schema.tasteTraits).values({
        userId,
        claim: String(t.claim ?? '').trim(),
        polarity: String(t.polarity ?? 'reward'),
        exhibits: filterIds(t.exhibits, validIds),
        contrasts: filterIds(t.contrasts, validIds),
        inferenceConfidence: Number(t.inference_confidence ?? 0.0),
        status: 'proposed',
      });
      n++;
    }
    await markProfiled(tx, 'update', userId);
    return n;
  });

  return {
    mode: 'update',
    changed_books: inputs.changedIds.length,
    books_sent: inputs.booksMeta.size,
    traits_before: existing.length,
    traits_after: saved,
    model,
  };
}

function filterIds(raw: unknown, validIds: Set<number>): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is number => typeof i === 'number' && validIds.has(i));
}

/** Twin of profile.get_profile_meta — fetch or create. */
async function ensureMeta(db: Db, userId: string) {
  const rows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  if (rows[0]) return rows[0];
  const [created] = await db.insert(schema.profileMeta).values({ userId }).returning();
  return created;
}
```

Note: `ensureMeta` duplicates `profileMeta.ts`'s `ensureProfileMeta`. Prefer importing the existing helper — `import { ensureProfileMeta } from './profileMeta'` — and delete the local copy. Two functions doing the same thing is exactly the drift wave 3a's reviewer flagged. Only keep a local version if `ensureProfileMeta`'s signature genuinely does not fit, and say why.

Create `frontend/app/api/profile/update/route.ts`:

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { PROFILE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { updateTasteProfile } from '@/lib/server/profileUpdate';

// May delegate to the full builder, so it inherits that flow's ceiling.
export const maxDuration = 300;

/** Port of api.py::update_profile (909-916): RuntimeError -> 400. */
export const POST = withApi('/api/profile/update', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) throw new ApiError(400, PROFILE_NO_KEY_MESSAGE);
  const client = makeAnthropicClient(apiKey);

  const out = await updateTasteProfile(db, client, ctx.user.userId);
  ctx.timer.mark('claude');
  return Response.json(out);
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/server/__tests__/profile-update.test.ts
npm run test:server && npm run type-check && npm run lint
```
Expected: PASS, whole server suite green.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/server/profileUpdate.ts frontend/app/api/profile/update/route.ts \
        frontend/lib/server/__tests__/profile-update.test.ts
git commit -m "feat(node): POST /api/profile/update (incremental re-profile)"
```

---

## Task 9: Flip the routing table

**Files:**
- Modify: `frontend/lib/backend.ts`
- Test: `frontend/lib/__tests__/backend.test.ts`

**Interfaces:**
- Consumes: `NODE_DEFAULT_ROUTES`, `baseFor` (existing).

`exact: true` is mandatory on both new rules. Without it, `{ prefix: '/profile', methods: ['POST'] }` would match `POST /profile/archetype`, `POST /profile/reveal-lines` (already Node — harmless) **and** `POST /profile/{anything wave 3c adds}` (not harmless). `/profile/update` needs its own rule because `/profile` with `exact` will not match it.

- [ ] **Step 1: Write the failing test**

Append to `frontend/lib/__tests__/backend.test.ts`, inside the existing `describe` that covers `baseFor` (match the file's existing helper for stubbing `localStorage`/`NEXT_PUBLIC_API_URL` — reuse it rather than inventing a new one):

```ts
  it('routes POST /profile and POST /profile/update to Node in auto mode', () => {
    expect(baseFor('/profile', 'POST')).toBe('/api');
    expect(baseFor('/profile/update', 'POST')).toBe('/api');
  });

  it('leaves DELETE /profile on Python (not ported in wave 3b)', () => {
    expect(baseFor('/profile', 'DELETE')).toBe(pythonBase());
  });

  it('does not let the exact POST /profile rule swallow sub-paths', () => {
    // /profile/subjects has no POST in Python; the point is that the exact rule
    // must not match sub-paths generically.
    expect(baseFor('/profile/subjects', 'POST')).toBe(pythonBase());
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/__tests__/backend.test.ts`
Expected: FAIL — `baseFor('/profile', 'POST')` returns the Python base.

- [ ] **Step 3: Write minimal implementation**

In `frontend/lib/backend.ts`, add two rules to `NODE_DEFAULT_ROUTES`. Place them **next to the other `/profile/*` POST rules**, above the general `{ prefix: '/profile', methods: ['GET', 'PATCH'] }` entry (order does not affect matching — `.some()` — but grouping keeps the table readable):

```ts
  { prefix: '/profile', methods: ['POST'], exact: true }, // wave 3b: full build. exact keeps it off /profile/* sub-paths
  { prefix: '/profile/update', methods: ['POST'], exact: true }, // wave 3b: incremental re-profile
```

Also update the block comment above `NODE_DEFAULT_ROUTES` with a `Wave 3b:` line describing the flip, matching how waves 1 and 2 documented theirs.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run lib/__tests__/backend.test.ts && npm run test:server
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts
git commit -m "feat(node): flip wave-3b profile routes to Node in auto mode"
```

---

## Task 10: Full verification

No new code. Prove the wave, then write the record.

- [ ] **Step 1: Every suite, re-run by you (not trusted from task reports)**

```bash
cd frontend && npx jest                 # expect 35/35
cd frontend && npm run test:server      # expect all green, ~210+ tests
cd frontend && npm run type-check       # clean
cd frontend && npm run lint             # clean
cd /home/chase/Documents/Code/my-library && .venv/bin/python -m pytest -q   # expect 360 passed
```

- [ ] **Step 2: Isolated local side-by-side (both backends, throwaway Postgres)**

Wave 3a proved this recipe works; reuse it verbatim. **Never point either backend at the real dev Supabase database for this** — wave 3b writes taste traits and deletes existing ones.

```bash
docker run -d --name mylib-w3b-verify -e POSTGRES_PASSWORD=throwaway \
  -e POSTGRES_DB=mylibrary_verify -p 55432:5432 public.ecr.aws/supabase/postgres:17.6.1.143
sleep 15
docker exec mylib-w3b-verify psql -U supabase_admin -d mylibrary_verify -c \
  "grant all on schema public to postgres; grant all on database mylibrary_verify to postgres; alter schema public owner to postgres;"
DATABASE_URL="postgresql://postgres:throwaway@127.0.0.1:55432/mylibrary_verify" .venv/bin/alembic upgrade head
```

Seed a handful of rated books via the CLI against that URL, then start **both** backends against it (Python on :8010, Next on :3000) per `.claude/skills/isolated-local-env/SKILL.md`.

**Prove isolation before any write** — `curl` the book list on both and confirm you see only your seeded books, not the real library's. Record the counts in the verification doc. Do not proceed until this is confirmed.

Then compare, both backends:
- `POST /profile` with **no** key configured → 400 with the exact `PROFILE_NO_KEY_MESSAGE` on both.
- `POST /profile` on a library with **zero** rated books → 400 `No rated books found. Run ingest (and enrich) first.` on both.
- `POST /profile/update` immediately after a successful build → the "already up to date" note, `books_sent` absent, and **no** `usage_events` row added (prove no Claude call happened).
- The real success path for both routes: this costs money (Sonnet, full library). Ask Chase before spending; if he declines, say so plainly in the record rather than implying it was covered.

- [ ] **Step 3: Real-app pass**

Try the browser first:
```
mcp__claude-in-chrome__tabs_context_mcp
```
If it returns "Browser extension is not connected" (it has in waves 0, 2 and 3a), fall back to driving the same running handlers by `curl` — and **say explicitly in the record that no browser click-through happened**. Do not describe curl-through-handlers as a UI verification.

If the browser *is* available: on `/profile`, run "Rebuild profile" and confirm the network tab shows `POST /api/profile` (Node, same-origin) rather than the Railway URL, that traits re-render, and that the profile-status banner clears.

- [ ] **Step 4: Tear down**

```bash
docker rm -f mylib-w3b-verify
```
Confirm ports 3000/8010/55432 are free (use `curl`/`nc`, not `pgrep -f` — it matches its own command line and gives false positives). Confirm `git status` is clean apart from known loose ends.

- [ ] **Step 5: Write the record and push**

Write `docs/superpowers/plans/wave-3b-verification.md` following `wave-3a-verification.md`'s structure: per-task findings, what was verified live vs. by test, every deliberate deviation, everything left for Chase, and any plan defects you found (this plan will have some — say which).

Push is authorized as part of this plan; announce before pushing.

```bash
git add docs/superpowers/plans/wave-3b-verification.md
git commit -m "docs(node): wave-3b verification record"
git push origin feat/node-backend
```

---

## Known risks

Each of these has been verified against the source at plan-writing time. If your reading disagrees, the source wins — fix the plan and report it.

1. **V8 reorders integer-like object keys.** `{'5':…,'4':…,'3':…}` iterates as `3,4,5`. This silently corrupts both `json.dumps(tiers)` and `Tier sizes: {counts}`. Mitigated by using `Map` throughout (Tasks 1, 2, 5, 7). If a prompt-parity test fails with the right *content* in the wrong *order*, this is why.
2. **`JSON.stringify(1.0)` is `1`; Python's is `1.0`.** Affects `inference_confidence` (update prompt) and `user_weight` (feedback block). Mitigated by `pyFloat`/`pyFloatStr`. The shared seed happens to contain no integral confidence, so the prompt-parity fixture alone will **not** catch a regression here — the dedicated unit tests in Tasks 1 and 7 are what protect it.
3. **`f"...{dict}"` is a repr, not JSON.** Single quotes, `', '` separators, `None`/`True`/`False`. Two prompts interpolate a container this way. Mitigated by `pyRepr`.
4. **Unordered prompt-feeding queries.** Python has seven of them in `profile.py` with no `ORDER BY`; every port adds `ORDER BY id ASC`. This is a *behavior improvement* that happens to match what SQLite returned when the fixture was captured. If a future Postgres plan change made Python's order differ, the two backends would diverge — acceptable, since Python retires at cutover.
5. **`{}` is truthy in JS, falsy in Python.** `_feedback_context`'s directive check and any other `or dict` idiom need an explicit key count. Wave 2 hit this exact bug in `/directive`; do not re-introduce it.
6. **The Claude call cannot be inside the transaction.** `db.ts` opens the pool with `max: 1`. Mixing the outer `db` with an open `tx` deadlocks rather than failing fast. Read → call → write-in-one-transaction.
7. **`extract_taste_profile` is reachable from `update_taste_profile` three ways.** A test asserting `mode === 'update'` can pass while silently exercising the full builder. Assert on `tool_choice` in `client.calls[0].params` when the distinction matters (Task 8 does).
8. **Two timestamps are compared as strings, in JS, not by Postgres.** `meta.recFeedbackUpdatedAt > since` and `meta.enrichmentCorrectedAt > since` compare Drizzle `mode: 'string'` values lexicographically. That is correct for the fixed `YYYY-MM-DD HH:MM:SS[.ffffff]` format both backends write (Python writes microseconds, Node milliseconds — a shorter string still sorts correctly against a longer one with the same prefix). Do not "fix" this by wrapping in `new Date()` without checking the timezone handling; the stored values are naive UTC. The `verdictUpdatedAt` and `createdAt` comparisons use SQL `gt()` and are Postgres-side.
9. **Payload objects are `Record<string, unknown>`, so tests need casts.** `bookPayload` returns a heterogeneous map matching Python's dict, so `b.id` is `unknown`. Where `tsc` objects in a test, cast at the access point — `(b as { id: number }).id` — rather than loosening the production type. Run `npm run type-check` after each task; do not defer it to Task 10.

## Out of scope for wave 3b

- `DELETE /profile` (clear-profile) is still Python and is **not** assigned to a wave in the spec. Flag it to Chase; it most naturally belongs with wave 4's purge/delete-account group.
- The recommender trio (`POST /recommend`, `/books/{id}/similar`, `/discover`) is wave 3c.
- Regenerating `responses.json` with `--live` Claude responses. Wave 3b's tests use hand-authored `tool_use` fixtures, which exercise every persistence branch without spend. If Chase wants real recorded responses, `.venv/bin/python scripts/gen_claude_fixtures.py --live` works after Task 0 — it costs two Sonnet calls over the seed library, on the order of a few cents.
