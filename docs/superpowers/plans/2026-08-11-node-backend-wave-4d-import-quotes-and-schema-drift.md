# Node Backend Wave 4d — Goodreads Quote Tolerance and Schema-Mirror Drift

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Make the Node import path accept the CSV that Goodreads actually exports, and stop the
test database from being more forgiving than the real one.

**Architecture:** Two independent corrective tasks, both caused by the same root failure mode — a
Node stand-in that is laxer or stricter than the Python/Postgres original, with no test that could
tell. Task 1 relaxes one `csv-parse` option to match Python's `csv` module and pins the match with a
differential matrix. Task 2 derives the real column contract from the SQLAlchemy models and asserts
both Node schema mirrors against it.

**Tech Stack:** Next.js 16 route handlers, `csv-parse`, Drizzle + postgres-js, PGlite (test), Vitest,
SQLAlchemy/Alembic (Python side, snapshot generation only).

---

## Why this wave exists

Wave 4c-2 was signed off with all five gates green. Driving the real app then found two defects in
under thirty minutes, neither of which any suite could have caught:

1. **`POST /api/import` and `POST /api/import/preview` reject real Goodreads exports.** Goodreads
   writes ISBN columns Excel-escaped as `="9780441172719"`. `csv-parse` raises
   `Invalid Opening Quote`; Python's `csv` module accepts it. Both routes flipped to Node in wave 4b,
   so on Node today the primary onboarding path fails for every genuine export. **Still open — this
   plan's Task 1.**
2. **`POST /api/enrich/start` 500'd against the real database.** `progress` and `total` are
   `NOT NULL` with no server default; the insert omitted them, drizzle emitted SQL `default`, and
   Postgres rejected it. It passed in tests only because the PGlite mirror granted defaults the
   Alembic-owned table does not have. **Already fixed and verified — see "Already landed" below.
   Task 2 prevents the class, not the instance.**

Defect 1 is reproducible right now on the checked-in fixture:

```
$ curl -s -X POST http://127.0.0.1:3000/api/import -F "file=@tests/sample_goodreads.csv"
{"detail":"Invalid Opening Quote: a quote is found on field \"ISBN\" at line 2, value is \"=\""}   # HTTP 422
$ curl -s -X POST http://127.0.0.1:3000/api/import/preview -F "file=@tests/sample_goodreads.csv"
{"detail":"Internal Server Error"}                                                                 # HTTP 500
```

while Python parses the same bytes into six clean rows with `rows[0].isbn13=9780441172719`.

> Corrected 2026-08-11 during execution. An earlier draft of this paragraph said "three clean rows
> with `isbn13=9780441478125`"; both numbers were wrong. Measured with
> `.venv/bin/python -c "from mylibrary.importers import parse_goodreads; ..."` on the checked-in
> fixture, `parse_goodreads` returns `len(rows) == 6`, `skipped == 0`, and the exact six-ISBN list
> asserted in Task 1's test. The test body was right; only this prose was stale.

## Already landed (do not redo)

These edits are in the working tree, verified live against a real Postgres, and green across all
five gates. Read them for context; do not re-implement or revert them.

| File | Change |
| --- | --- |
| `lib/server/enrichmentJobs.ts` | `createOrGetActiveJob` now passes `progress: 0, total: 0` explicitly |
| `lib/server/schema.ts` | dropped `.default()` from `enrichJobs.status`, `.progress`, `.total` |
| `lib/server/__tests__/helpers/pglite.ts` | dropped the matching defaults from the `enrich_jobs` DDL |
| 6 test files | 25 `enrich_jobs` fixtures now supply `progress: 0, total: 0` |

## Global Constraints

1. **Do not change Python.** `mylibrary/` is read-only in this wave except for the new snapshot
   script in Task 2, which only reads models.
2. **No new runtime dependencies.** `relax_quotes` is an existing `csv-parse` option;
   `npm install` is not needed and must not run.
3. **Parity means matching Python's observable behavior**, including behavior a reasonable person
   would call wrong. Where Node cannot match, record the divergence in the plan and in a code
   comment — never silently "improve" on Python.
4. **Do not touch `PY_EXCEL_WRITER_OPTIONS`.** It is the *writer* config for export and shares no
   options with the reader. Wave 4b's `quoted_match: /[\r\n]/` reasoning does not apply here.
5. **Gates for every task:** `npm run test:server`, `npm test -- --runInBand`, `npm run type-check`,
   `npx eslint <touched files>`, `npx prettier --check <touched files>`, and `.venv/bin/pytest`.
   Run every one; an unlisted gate is out of scope, but these are all listed.
6. **Never run `npx prettier --write` over a glob.** Name each file explicitly. A glob in this
   repo's `lib/server/__tests__/` reformats a dozen unrelated committed files.
7. **Do not commit, merge, push, or deploy.** Chase commits by hand.

## Verified Facts

Each was confirmed by running it on 2026-08-11, not read from prose. Cite symbols, not line numbers.

| Fact | Evidence |
| --- | --- |
| The reader config is `PY_DICT_READER_OPTIONS` in `frontend/lib/server/import-csv.ts`; its keys are `delimiter`, `quote`, `escape`, `relax_column_count`, `skip_empty_lines`, `record_delimiter` | read from source |
| `parseCsvRecords` is the single chokepoint — `parseGoodreads`/`parseStorygraph`/`parseCanonical`/`parseGeneric` all reach it through `baseResult` | read from source |
| `tests/sample_goodreads.csv` uses `="…"` in both ISBN columns on all 6 rows | `grep '="' tests/sample_goodreads.csv` |
| Python `csv.DictReader` yields `="9780441172719"` verbatim as the cell value | ran `parse_goodreads` on the fixture |
| `clean_isbn` / `cleanIsbn` already strip the `="…"` wrapper in both languages | `tests/test_ingest.py`, `tests/test_importers.py` |
| `relax_quotes: true` makes csv-parse accept the fixture, producing cells byte-identical to Python's | ran both parsers over the fixture |
| SQLAlchemy models are a faithful, DB-free source of the real column contract: for `enrich_jobs` they report exactly the nullability and server defaults that live Postgres `\d` shows | ran both and compared |
| `alembic/versions/0001_initial_multitenant_schema.py` builds the baseline with `Base.metadata.create_all()`, which is why the models are authoritative | read from source |

### The differential matrix, measured

`relax_quotes: true` matches Python on 6 of 8 quote shapes and is strictly better than today's 3 of 8.
Task 1 must reproduce this table exactly, including the two `NO` rows.

| Case | Input cell | Python | Node today | Node with `relax_quotes` | Match |
| --- | --- | --- | --- | --- | --- |
| `excel_escaped` | `="9780441172719"` | `="9780441172719"` | **throws** | `="9780441172719"` | YES |
| `quote_midfield` | `foo"bar` | `foo"bar` | **throws** | `foo"bar` | YES |
| `quoted_normal` | `"hello, world"` | `hello, world` | `hello, world` | `hello, world` | YES |
| `quote_then_text` | `"hello" tail` | `hello tail` | **throws** | `"hello" tail` | **NO** |
| `doubled_inner` | `"say ""hi"""` | `say "hi"` | `say "hi"` | `say "hi"` | YES |
| `bare_quote_unclosed` | `"unclosed` + EOF | `unclosed\n` | **throws** | **throws** | **NO** |
| `quoted_newline` | `"two\nlines"` | `two\nlines` | `two\nlines` | `two\nlines` | YES |
| `empty_quoted` | `""` | `` (empty) | `` (empty) | `` (empty) | YES |

**Both residual divergences are accepted, not fixed.** `quote_then_text` keeps the literal quotes
instead of dropping them, and an unterminated quote at EOF still throws where Python returns the
remainder. Neither shape occurs in a Goodreads or StoryGraph export; chasing them would mean
hand-writing a CSV state machine, which is out of proportion to the risk. They must be asserted as
divergences so a future reader knows they were measured rather than missed.

## File Structure

| File | Responsibility |
| --- | --- |
| `frontend/lib/server/import-csv.ts` | Modify: add `relax_quotes: true` to `PY_DICT_READER_OPTIONS` with a comment naming the Goodreads shape |
| `frontend/lib/server/__tests__/import-csv-quotes.test.ts` | Create: the 8-case differential matrix and the two asserted divergences |
| `scripts/dump_schema_contract.py` | Create: writes the model-derived column contract to a JSON fixture |
| `frontend/lib/server/__tests__/fixtures/schema-contract.json` | Create: generated snapshot, checked in |
| `frontend/lib/server/__tests__/schema-contract.test.ts` | Create: asserts the PGlite mirror and the Drizzle schema against the snapshot |

---

## Task 1: Accept the CSV Goodreads actually exports

**Files:**
- Modify: `frontend/lib/server/import-csv.ts` (`PY_DICT_READER_OPTIONS`)
- Test: `frontend/lib/server/__tests__/import-csv-quotes.test.ts` (create)

**Interfaces:**
- Consumes: `parseCsvRecords(text: string): ParsedCsvRecords` and `parseGoodreads(text: string): ParsedImport`, both already exported from `lib/server/import-csv.ts`.
- Produces: no new exports. `PY_DICT_READER_OPTIONS` gains one key.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/import-csv-quotes.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsvRecords, parseGoodreads } from '../import-csv';

/**
 * Goodreads writes ISBN columns Excel-escaped as ="9780441172719". Python's csv
 * module accepts a quote that is not at the start of a field; csv-parse rejects
 * it unless relax_quotes is set. Every expectation below was measured against
 * Python's csv.DictReader, including the two documented divergences.
 */
describe('csv quote tolerance', () => {
  const cell = (text: string): string | null => {
    const { rows } = parseCsvRecords(text);
    return rows[0]?.B as string | null;
  };

  it('accepts the Excel-escaped ISBN that Goodreads exports', () => {
    expect(cell('A,B\n1,="9780441172719"\n')).toBe('="9780441172719"');
  });

  it('accepts a bare quote in the middle of an unquoted field', () => {
    expect(cell('A,B\n1,foo"bar\n')).toBe('foo"bar');
  });

  it('still parses ordinary quoted fields, doubled quotes, and embedded newlines', () => {
    expect(cell('A,B\n1,"hello, world"\n')).toBe('hello, world');
    expect(cell('A,B\n1,"say ""hi"""\n')).toBe('say "hi"');
    expect(cell('A,B\n1,"two\nlines"\n')).toBe('two\nlines');
    expect(cell('A,B\n1,""\n')).toBe('');
  });

  it('DIVERGENCE: keeps the literal quotes where Python drops them', () => {
    // Python's csv yields `hello tail`. Not reachable from a Goodreads or
    // StoryGraph export; asserted so the difference stays measured, not missed.
    expect(cell('A,B\n1,"hello" tail\n')).toBe('"hello" tail');
  });

  it('DIVERGENCE: still throws on an unterminated quote at EOF', () => {
    // Python's csv yields `unclosed\n` for a truncated file.
    expect(() => parseCsvRecords('A,B\n1,"unclosed\n')).toThrow(/Quote Not Closed/);
  });

  it('parses the checked-in Goodreads fixture end to end', () => {
    const text = readFileSync(
      join(process.cwd(), '..', 'tests', 'sample_goodreads.csv'),
      'utf8'
    );
    const parsed = parseGoodreads(text);
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.skipped).toBe(0);
    expect(parsed.rows[0]?.title).toBe('Dune');
    // cleanIsbn strips the ="..." wrapper, exactly as Python's clean_isbn does.
    expect(parsed.rows[0]?.isbn13).toBe('9780441172719');
    expect(parsed.rows.map((row) => row.isbn13)).toEqual([
      '9780441172719',
      '9780765382030',
      '9781524759780',
      '9780385539258',
      '9780593135204',
      '9780756404741',
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `cd frontend && npx vitest run lib/server/__tests__/import-csv-quotes.test.ts`

Expected: FAIL. Expected-red tests, by name:
`accepts the Excel-escaped ISBN that Goodreads exports`,
`accepts a bare quote in the middle of an unquoted field`,
`DIVERGENCE: keeps the literal quotes where Python drops them`,
`parses the checked-in Goodreads fixture end to end` — each with `Invalid Opening Quote` or
`Invalid Closing Quote`. The other two must already pass. If
`DIVERGENCE: still throws on an unterminated quote at EOF` fails at this point, stop and report:
the option set is not what this plan measured.

- [ ] **Step 3: Add the option**

In `frontend/lib/server/import-csv.ts`, inside `PY_DICT_READER_OPTIONS`, after `escape: '"'`:

```ts
  // Python's csv module accepts a quote that is not at the start of a field and
  // returns it literally; csv-parse throws Invalid Opening Quote without this.
  // Goodreads exports ISBNs Excel-escaped as ="9780441172719", so every real
  // export hits it. See import-csv-quotes.test.ts for the measured matrix and
  // the two shapes where Node still diverges from Python.
  relax_quotes: true,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run lib/server/__tests__/import-csv-quotes.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Prove no existing import behavior moved**

Run: `cd frontend && npx vitest run lib/server/__tests__/import-csv.test.ts lib/server/__tests__/import-books.test.ts`
Expected: PASS, unchanged counts. `relax_quotes` only widens what parses; any regression here means
a previously-throwing input now parses differently and must be reported, not absorbed.

- [ ] **Step 6: Run the full gate set**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint lib/server/import-csv.ts lib/server/__tests__/import-csv-quotes.test.ts
npx prettier --check lib/server/import-csv.ts lib/server/__tests__/import-csv-quotes.test.ts
cd .. && .venv/bin/pytest -p no:warnings
```

Expected: 71 files / 493 tests + the new file's 7; jest 39/39; tsc, eslint, prettier clean; pytest 360 passed.

- [ ] **Step 7: Stop and hand the diff to Chase**

Do not commit. Report the diff and the gate output.

---

## Task 2: Make the test database tell the truth about the real one

**Files:**
- Create: `scripts/dump_schema_contract.py`
- Create: `frontend/lib/server/__tests__/fixtures/schema-contract.json`
- Create: `frontend/lib/server/__tests__/schema-contract.test.ts`

**Interfaces:**
- Consumes: `makeTestDb()` from `lib/server/__tests__/helpers/pglite`, and `schema` from `lib/server/db`.
- Produces: `frontend/lib/server/__tests__/fixtures/schema-contract.json`, shape
  `{ [table: string]: { [column: string]: { nullable: boolean; serverDefault: string | null } } }`.

**Why this exists:** the PGlite mirror is hand-written and drifted from the Alembic-owned schema.
`enrich_jobs.progress` was `not null default 0` in the mirror and `NOT NULL` with no default in
production, so a broken insert passed 493 tests and 500'd on the first real request. The models are
the right oracle because `0001_initial_multitenant_schema.py` builds the baseline from
`Base.metadata.create_all()`.

- [ ] **Step 1: Write the snapshot generator**

Create `scripts/dump_schema_contract.py`:

```python
"""Dump the model-declared column contract for the Node schema mirrors to check against.

The Alembic baseline builds the database from Base.metadata.create_all(), so the
SQLAlchemy models are the authoritative source for nullability and SERVER defaults.
ORM-level defaults (Column(default=0)) are deliberately NOT included: they are applied
by Python at insert time and are invisible to any other client, which is exactly the
distinction that broke POST /enrich/start.

Run: .venv/bin/python scripts/dump_schema_contract.py
"""

from __future__ import annotations

import json
import pathlib

from mylibrary.db import Base

OUT = (
    pathlib.Path(__file__).resolve().parent.parent
    / "frontend/lib/server/__tests__/fixtures/schema-contract.json"
)


def server_default(column) -> str | None:
    if column.server_default is None:
        return None
    arg = column.server_default.arg
    return str(getattr(arg, "text", arg))


def main() -> None:
    contract = {
        name: {
            column.name: {
                "nullable": bool(column.nullable),
                "serverDefault": server_default(column),
            }
            for column in table.columns
        }
        for name, table in sorted(Base.metadata.tables.items())
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(contract, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(contract)} tables)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Generate the snapshot and eyeball the one table you already know**

Run: `.venv/bin/python scripts/dump_schema_contract.py`

Then confirm `enrich_jobs` in the generated JSON reads exactly:

```json
"progress": { "nullable": false, "serverDefault": null },
"status":   { "nullable": false, "serverDefault": null },
"total":    { "nullable": false, "serverDefault": null },
"user_id":  { "nullable": false, "serverDefault": "'local'" },
"attempts": { "nullable": false, "serverDefault": "0" },
"force":    { "nullable": false, "serverDefault": "false" }
```

If `progress` shows a `serverDefault`, stop — the generator is reading ORM defaults and the whole
guard is worthless.

- [ ] **Step 3: Write the failing test**

Create `frontend/lib/server/__tests__/schema-contract.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import contract from './fixtures/schema-contract.json';
import { makeTestDb } from './helpers/pglite';

/**
 * The PGlite mirror is hand-written. When it grants a column a default the
 * Alembic-owned table does not have, an insert that omits that column passes
 * every test and fails against the real database — which is exactly how
 * POST /enrich/start shipped broken. This asserts the mirror against the
 * model-declared contract for the tables the Node backend writes to.
 */
const WRITTEN_TABLES = [
  'books',
  'enrichment',
  'enrich_jobs',
  'feedback',
  'usage_events',
] as const;

type ColumnContract = { nullable: boolean; serverDefault: string | null };
type Contract = Record<string, Record<string, ColumnContract>>;

describe('PGlite mirror matches the Alembic-owned schema', () => {
  for (const table of WRITTEN_TABLES) {
    it(`${table}: every NOT NULL column without a server default is NOT NULL without a default`, async () => {
      const { db, close } = await makeTestDb();
      try {
        // sql`` tag, not a bare string — this is how claimJob() in
        // enrichmentJobs.ts issues raw SQL through drizzle in this codebase.
        const rows = (await db.execute(sql`
          select column_name, is_nullable, column_default
            from information_schema.columns
           where table_name = ${table}
        `)) as unknown as Array<{
          column_name: string;
          is_nullable: string;
          column_default: string | null;
        }>;
        const actual = Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows;
        expect(actual.length).toBeGreaterThan(0);

        const expected = (contract as Contract)[table];
        expect(expected, `${table} missing from schema-contract.json`).toBeTruthy();

        for (const row of actual) {
          const spec = expected[row.column_name];
          if (!spec) continue; // mirror-only helper columns are not the target here
          expect(
            { column: row.column_name, nullable: row.is_nullable === 'YES' },
            `${table}.${row.column_name} nullability`
          ).toEqual({ column: row.column_name, nullable: spec.nullable });

          // Serial primary keys legitimately carry a nextval() default on both sides.
          const isSerial = (row.column_default ?? '').startsWith('nextval(');
          if (spec.serverDefault === null && !isSerial) {
            expect(
              row.column_default,
              `${table}.${row.column_name} has a default the real schema does not`
            ).toBeNull();
          }
        }
      } finally {
        await close();
      }
    });
  }
});
```

- [ ] **Step 4: Run it and record what it finds**

Run: `cd frontend && npx vitest run lib/server/__tests__/schema-contract.test.ts`

This test's first run is a survey, not a pass/fail gate. Two outcomes are both fine:

- **All five pass** — the `enrich_jobs` fix was the only drift. Say so and move to Step 6.
- **Some fail** — each failure names a real divergence. Do not "fix" it by editing the JSON
  snapshot. For each one, decide and report: correct the PGlite DDL (almost always right), or, if
  production really is the odd one out, leave it failing and hand it to Chase with the evidence.
  **Do not change any production insert path in this task** — that is separate work with its own
  live verification.

`makeTestDb` is verified to be `(): Promise<{ db: Db; close: () => Promise<void> }>`, and
`resolveJsonModule` is already true in `frontend/tsconfig.json`, so the import and the
`{ db, close }` destructuring above are correct as written.

- [ ] **Step 5: Bring the mirror into line with the contract**

Edit only `frontend/lib/server/__tests__/helpers/pglite.ts`. For each column the test flagged, drop
the invented `default …` and keep the `not null`. Re-run:

`cd frontend && npx vitest run lib/server/__tests__/schema-contract.test.ts`
Expected: PASS, 5/5.

Then re-run the whole server suite — tightening the mirror will expose fixtures that relied on the
old defaults, exactly as it did for `enrich_jobs`:

`cd frontend && npm run test:server`

For each newly-failing fixture, supply the missing column explicitly in the **test** file. Never add
a default back to the mirror to make a test pass.

- [ ] **Step 6: Run the full gate set**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint lib/server/__tests__/schema-contract.test.ts lib/server/__tests__/helpers/pglite.ts
npx prettier --check lib/server/__tests__/schema-contract.test.ts lib/server/__tests__/helpers/pglite.ts
cd .. && .venv/bin/ruff check scripts/dump_schema_contract.py
cd .. && .venv/bin/pytest -p no:warnings
```

Expected: every suite green; pytest 360 passed.

- [ ] **Step 7: Stop and hand the diff to Chase**

Report the diff, the gate output, and — importantly — the list of drifts Step 4 found, even the
ones you fixed. That list is the actual finding of this task.

---

## Task 2 findings (recorded 2026-08-12)

Task 2's actual output is this list, per its Step 7. All six drifts are in one table, `usage_events`,
and every one has the **same shape as the `enrich_jobs.progress` bug**: the hand-written PGlite
mirror invented a default that the Alembic-owned table does not have.

| Column | PGlite mirror had | Model (production) | Fixed |
| --- | --- | --- | --- |
| `usage_events.input_tokens` | nullable, `default 0` | `NOT NULL`, no server default | yes |
| `usage_events.output_tokens` | nullable, `default 0` | `NOT NULL`, no server default | yes |
| `usage_events.cache_creation_input_tokens` | nullable, `default 0` | `NOT NULL`, no server default | yes |
| `usage_events.cache_read_input_tokens` | nullable, `default 0` | `NOT NULL`, no server default | yes |
| `usage_events.cost_usd` | nullable, `default 0` | `NOT NULL`, no server default | yes |
| `usage_events.created_at` | nullable | `NOT NULL`, server default `now()` | yes (default kept — it is real) |

The root cause is visible in `mylibrary/db.py`: `input_tokens: Mapped[int] = mapped_column(Integer,
default=0)`. That `default=0` is an **ORM-level** default applied by Python at insert time; it emits
no `DEFAULT` clause into the DDL. `Mapped[int]` (not `Optional`) is what makes the column `NOT NULL`.
Any non-Python client that omits the column therefore violates the constraint — exactly the
`POST /enrich/start` failure, one table over.

Fixed by dropping the invented defaults from `helpers/pglite.ts` and adding the missing `not null`.
Step 5 anticipated only the first half; the real drift also required adding constraints. Tightening
the mirror turned `purge-routes.test.ts`'s shared `seedUser` fixture red, which was corrected by
supplying the five columns explicitly **in the test**, never by restoring a default to the mirror.

### Two gaps found after Task 2, then closed (2026-08-12)

Both were initially deferred as out of Task 2's scope. A Codex stop-time review pushed back that
"the new schema guard is incomplete and leaves a confirmed schema drift", and on re-reading the
constraint it was right: Step 4 forbids changing a production **insert path**, and `schema.ts` is a
schema *declaration*, not an insert path. This wave's own "Already landed" table had already made
exactly this edit for `enrichJobs`. Node also has no `usage_events` INSERT at all, so the change
could not alter any live behavior. Both are now fixed.

**1. `lib/server/schema.ts` carried the identical defect. FIXED.** The Drizzle table had
phantom `.default()`s *and* missing `.notNull()`:

```ts
inputTokens: integer('input_tokens').default(0),          // production: NOT NULL, no default
outputTokens: integer('output_tokens').default(0),
cacheCreationInputTokens: integer('cache_creation_input_tokens').default(0),
cacheReadInputTokens: integer('cache_read_input_tokens').default(0),
costUsd: doublePrecision('cost_usd').default(sql`'0'`),
createdAt: timestamp('created_at', { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),  // missing notNull
```

It was **latent, not live**: Node only SELECTs and DELETEs `usage_events`
(`app/api/settings/usage/route.ts`, `lib/server/purge.ts`); the INSERT path is still Python's. It
would have become a real 500 the moment Node owned usage tracking — precisely what wave 5's cutover
does. `tsc` cannot catch it, because a `notNull()`-less column is optional in `$inferInsert`.

Now corrected to `.notNull()` on all five token/cost columns, with `createdAt` keeping its genuine
`CURRENT_TIMESTAMP` default and gaining `.notNull()`. A comment records why an ORM-level
`default=0` must not become a drizzle `.default()`.

**2. The delivered test asserted only the PGlite mirror, though the plan's Interfaces section says
it covers the Drizzle schema too. FIXED.** That unimplemented half is exactly why gap 1 had to be
found by hand. `schema-contract.test.ts` now has a second describe block that reads
`getTableColumns()` for all five written tables and asserts, against the same generated contract,
that no column declares a default the real table lacks and that nullability matches.

**The new guard was verified to fail before it was trusted.** Re-introducing
`inputTokens: integer('input_tokens').default(0)` turns it red with
`usage_events.input_tokens nullability disagrees with the models`, naming the exact table and
column; restoring `.notNull()` returns it to green. Suite went 504 → 509.

**3. Both halves only iterated the columns they happened to declare. FIXED.** I first recorded this
as a hole that "remains, deliberately" on the grounds that it could not hide an *invented* default.
A second Codex review pushed back, and it was right: a column that is **missing, renamed, or extra**
passed silently in both blocks, because each loop walked its own mirror's columns and skipped
anything absent from the contract via `if (!spec) continue`. That is not a lesser bug — a migration
adding a `NOT NULL` column that neither Node mirror declares keeps this gate green and 500s on the
first real insert, which is precisely the failure this wave exists to prevent.

Both blocks now compare the full column **sets** against the contract before any per-column check:

```ts
expect(
  actual.map((row) => row.column_name).sort(),
  `${table}: PGlite mirror column set differs from the models`
).toEqual(Object.keys(expected).sort());
```

Measured outcome: all five written tables already match exactly on both sides, so the original
`if (!spec) continue` comment about "mirror-only helper columns" was unfounded — there are none.

Verified load-bearing the same way as the rest: deleting `cost_usd` from the PGlite mirror fails
with `usage_events: PGlite mirror column set differs from the models` and prints `- "cost_usd"`,
naming the missing column. Restoring it returns the suite to green.

### Corrections made to Task 2's own deliverables

- `scripts/dump_schema_contract.py` documented `Run: .venv/bin/python scripts/dump_schema_contract.py`,
  which fails with `ModuleNotFoundError: No module named 'mylibrary'` — the venv has no editable
  install. Fixed by inserting the repo root on `sys.path` so the documented command is true. Verified:
  the command now runs and regenerates a byte-identical snapshot (md5 `a717b9c7…` before and after).
- `enrich_jobs.user_id.serverDefault` generates as `"local"`, not `"'local'"` as Step 2 predicted.
  The generated value comes straight from the model and the load-bearing assertion
  (`progress.serverDefault === null`) is correct, so the plan's prose was simply over-quoted.
- Step 6's expected count of "72 files / 499 tests" is now 73 / 504 with the five contract cases.

---

## Task 3: Prove it against the real thing

Tests are what let this wave's two defects ship. This task is the one that would have caught them.
It is run by Chase or by Claude driving the app — never accepted from a model's self-report.

**Setup** (from `docs/superpowers/codex-workflow-notes.md` and prior waves):

```bash
docker start mylib-w3b-verify          # already Alembic-migrated and seeded
# DATABASE_URL=postgresql://supabase_admin:throwaway@127.0.0.1:55432/mylibrary_verify
# Launch next dev with SUPABASE_* forced to "" for local single-user auth mode,
# and a throwaway CRON_SECRET. Browse http://localhost:3000 — never 127.0.0.1.
```

- [ ] **Step 1: Import the real fixture through the browser**, not curl. `/setup` → name → upload
  `tests/sample_goodreads.csv` → Import library. Expected: the wizard advances to Enrich and reports
  6 books in. Never click a file input; find the hidden `<input type="file">` and use `file_upload`.

- [ ] **Step 2: Import a genuine Goodreads export** if Chase has one to hand. The checked-in fixture
  is six tidy rows; a real export is thousands with empty ISBNs, unrated rows, and review text
  containing commas and quotes. This is the only step that tests the actual claim.

- [ ] **Step 3: Enrich through the UI** and confirm the job reaches `done` with progress equal to
  total, then check the rows landed:

```sql
select b.id, left(b.title,24), e.confidence_label, e.match_method
  from books b join enrichment e on e.book_id = b.id order by b.id desc limit 10;
```

- [ ] **Step 4: Export and diff against Python.** Point Python at the same container database, run
  `export_csv` / `export_json`, and diff byte-for-byte against what `GET /api/export` served. A real
  import makes this a much stronger test than the ASCII-only seed allowed before.

- [ ] **Step 5: Record the result** in this file under a Verification Record heading, with the exact
  commands run and their output. If any step fails, that is the finding — report it rather than
  retrying until it passes.

---

## Verification Record — 2026-08-12 (Claude, partial)

Run against the throwaway container `mylib-w3b-verify` (Alembic `0019_add_enrich_job_leases`,
14 pre-existing books), with `next dev` on
`DATABASE_URL=postgresql://supabase_admin:throwaway@127.0.0.1:55432/mylibrary_verify`, Supabase vars
forced to `""` for local single-user auth, `CRON_SECRET=throwaway-cron-secret`.

**This record is incomplete. The browser steps were NOT run — see "Not verified" below.**

### Verified against a real Postgres database

**1. Both previously-broken routes now accept the real Goodreads shape.** The exact reproduction
from "Why this wave exists", re-run after the fix:

```text
$ curl -s -X POST http://localhost:3000/api/import/preview -F "file=@tests/sample_goodreads.csv"
HTTP 200 — format=goodreads, ISBN cells returned verbatim as ="0441172717" / ="9780441172719"
   (was: HTTP 500 {"detail":"Internal Server Error"})

$ curl -s -X POST http://localhost:3000/api/import -F "file=@tests/sample_goodreads.csv"
HTTP 200 {"format":"goodreads","total_rows":6,"skipped":0,"inserted":6,"updated":0,"rated":5}
   (was: HTTP 422 {"detail":"Invalid Opening Quote: ... at line 2, value is \"=\""})
```

Books went 14 → 20. Rows landed with the `="…"` wrapper stripped by `cleanIsbn`, matching Python's
`clean_isbn` and the six ISBNs asserted in `import-csv-quotes.test.ts`:

```text
Dune                   | isbn13=9780441172719 | gr_rating=5 | app_rating=NULL | src=goodreads_import
The Three-Body Problem | isbn13=9780765382030 | gr_rating=4 | app_rating=NULL
Recursion              | isbn13=9781524759780 | gr_rating=3 | app_rating=NULL
A Little Life          | isbn13=9780385539258 | gr_rating=2 | app_rating=NULL
Project Hail Mary      | isbn13=9780593135204 | gr_rating=0 | app_rating=NULL
The Name of the Wind   | isbn13=9780756404741 | gr_rating=5 | app_rating=NULL
```

`app_rating` is NULL on every row — locked decision 2 (import must never clobber in-app ratings)
holds on the live path, not just in tests.

**2. Task 2's drift finding confirmed against production DDL, not just the models.** Real Postgres
`information_schema` for `usage_events`:

```text
input_tokens                 NO   NULL
output_tokens                NO   NULL
cache_creation_input_tokens  NO   NULL
cache_read_input_tokens      NO   NULL
cost_usd                     NO   NULL
created_at                   NO   now()
```

Exactly the model-derived contract, and exactly what the corrected PGlite mirror now declares. This
independently validates the choice of the SQLAlchemy models as the oracle.

**3. Export is byte-identical to Python against the same database** (Task 3 Step 4), including the
six freshly-imported rows:

- `GET /api/export?format=csv` vs `exporters.export_csv()` — **`diff` clean, byte-identical.**
- `GET /api/export?format=json` vs `json.dumps(export_json(), indent=2, ensure_ascii=True)` —
  identical apart from the inherently time-varying `exported_at` (the two runs were 23s apart).
  Normalising that one field gives matching md5 `c9186ae3b03aa33a6160aa292da9eff0` on both.

### Browser verification — completed 2026-08-12

Run in Chrome against the same container and dev server.

**Step 1 — import through the real UI.** `/settings` → "Import books" → "Import from a file" opens a
modal with a dropzone backed by a hidden `input#import-file` (`.sr-only`, `accept=".csv"`). The file
was attached with `file_upload` against that input's ref — never by clicking the input, which would
open a native picker and freeze the session. Results:

- On upload the dialog rendered **"Detected: Goodreads, 24 columns."** — `POST /api/import/preview`
  returned 200 through the real UI, where it previously 500'd.
- Clicking **Import** produced `{"route":"/api/import","method":"POST","status":200}` in the dev
  server log, and the modal closed cleanly.

**Step 3 — enrichment.** `POST /api/enrich/start` (the same call `SetupWizard` makes via
`api.enrichStart()`) returned `status:"done", progress:19, total:19`. The six Excel-escaped
Goodreads ISBNs all resolved against the **live** Open Library catalog at HIGH confidence:

```text
Dune                   | HIGH | isbn:openlibrary
The Three-Body Problem | HIGH | isbn:openlibrary
Recursion              | HIGH | isbn:openlibrary
A Little Life          | HIGH | isbn:openlibrary
The Name of the Wind   | HIGH | isbn:openlibrary
```

That is the end-to-end proof that stripping the `="…"` wrapper yields ISBNs a real catalog accepts —
something no fixture can establish. `Project Hail Mary` is correctly left unenriched: it has
`goodreads_rating=0`, and `enrich_library` enriches "rated books (or all, if `include_unrated`)".
Node matches Python here; it is not a defect.

**Locked decision 2 verified live.** With `app_rating=1` and
`app_review='in-app review must survive'` set on Dune, re-importing the same CSV (which says
Goodreads rating 5) returned `{"inserted":0,"updated":6,"rated":5}` and left **both** in-app fields
untouched. Import updates Goodreads-owned columns only.

**Export re-diffed with the richer data** — now containing real in-app review text rather than the
ASCII-only seed: `GET /api/export` vs Python's `export_csv` / `export_json` against the same
database came out **byte-identical in both formats** (JSON after normalizing `exported_at`).

One process note worth keeping: the first Import click silently did nothing. `getBoundingClientRect`
returns **CSS pixels** (viewport 1439 wide) while `computer` clicks are in **screenshot space**
(1232 wide, a 0.856 scale), so the click landed on the backdrop and closed the modal. The dev log —
showing `preview` but no `import` — is what exposed it. **Click by element `ref`, not by coordinates
derived from `getBoundingClientRect`**, and confirm UI actions by their server-side effect rather
than by the dialog closing.

### Still not verified — outstanding for Chase

- **A genuine large Goodreads export (Step 2).** Only the six-row checked-in fixture was used. The
  real artifact — thousands of rows, empty ISBNs, unrated rows, review text with commas and quotes —
  remains untested, and it is the only input that tests the actual claim at scale. Everything above
  says the *shape* is handled; nothing says the volume is.
- **The `/setup` wizard's own upload step.** Import was driven through the `/settings` modal, which
  posts to the same two routes. The wizard path was not re-run because it only renders for an empty
  library and the verification container is seeded; wave 4c-2 already live-verified the
  onboarding→enrich wizard flow.
- **`POST /enrich/start` under the wizard's polling UI.** The endpoint was called directly and
  completed; the wizard's progress rendering and `after()` continuation were verified in wave 4c-2,
  not re-run here.

To pick these up, restart the container and the dev server:

```bash
docker start mylib-w3b-verify
cd frontend && DATABASE_URL="postgresql://supabase_admin:throwaway@127.0.0.1:55432/mylibrary_verify" \
  NEXT_PUBLIC_SUPABASE_URL="" SUPABASE_URL="" SUPABASE_JWKS_URL="" \
  CRON_SECRET="throwaway-cron-secret" LOCAL_USER_ID="local" npm run dev
# then browse http://localhost:3000 — never 127.0.0.1
```

Note that running `next dev` rewrites the generated `frontend/next-env.d.ts` from
`./.next/types/routes.d.ts` to `./.next/dev/types/routes.d.ts`. That is incidental churn, not a
wave-4d change; it was reverted with `git checkout -- frontend/next-env.d.ts` and should be reverted
again after any future dev-server run so the wave's diff stays clean.

---

## Done when

- [ ] `POST /api/import` and `POST /api/import/preview` accept `tests/sample_goodreads.csv` and a
      real Goodreads export, on Node, through the browser.
- [ ] The eight-case quote matrix is asserted, including both divergences, with Python's measured
      values in comments.
- [ ] `schema-contract.json` is generated from the models and checked in, and the PGlite mirror
      matches it for every table the Node backend writes.
- [ ] Every drift Task 2 found is listed in the handoff, fixed or explicitly deferred.
- [ ] All five gates green, and the working tree contains no reformatting of files this wave did not
      set out to change.

## Explicitly out of scope

- Python cutover and route deletion — that is wave 5, and it should not start while the Node import
  path is broken.
- The `quote_then_text` and `bare_quote_unclosed` divergences. Measured, documented, accepted.
- Redis, arq, QStash, queue ports, cross-user catalog rate coordination, admin routes.
- The wave 4c-2 deployment items, which are Chase's and unchanged: apply `0019` in the same release
  window as the switcher flip, supply `CRON_SECRET`, confirm Fluid compute and the ~300s ceiling,
  and confirm the Hobby cron cadence with `vercel crons ls` after a production deploy.
