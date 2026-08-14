# Half-Star Ratings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader rate a book in half-star steps (0.5 … 5.0) through the UI and API, and feed that finer signal into the taste profile.

**Architecture:** Widen `books.app_rating` / `books.goodreads_rating` from `integer` to `numeric(2,1)` with DB CHECK constraints pinning a 0.5 grid, give half stars their own taste-profile tiers, and revive the currently-dead `StarRating` component as the single half-aware rating control. Migration tooling switches from Alembic to drizzle-kit in the same wave, because this column change can never land in the (now dead) Python backend.

**Tech Stack:** Next.js route handlers, drizzle-orm 0.45.2 / drizzle-kit 0.31.10, Postgres 17 (Supabase), Zod, Vitest, PGlite test mirror.

**Spec:** `docs/superpowers/specs/2026-08-13-half-star-ratings-design.md`

## Global Constraints

1. **Node only.** Do not modify anything under `mylibrary/`. Python is functionally dead (Railway paused) and knowingly diverges. Do not re-record parity fixtures against it.
2. **`numeric` columns MUST use `mode: 'number'`.** Verified at `node_modules/drizzle-orm/pg-core/numeric.d.ts:98`. Without it the driver returns `"3.5"` as a string and every numeric comparison in the codebase silently misbehaves instead of failing loudly.
3. **Rating domain is 0.5–5.0 on a 0.5 grid.** `app_rating IS NULL` means "no override"; `goodreads_rating = 0` means "unrated". 0 is never a rating.
4. **Do not add a server default to `goodreads_rating`.** Verified against production 2026-08-13: `column_default` is null. Adding one invents a default production does not have.
5. **Never drop-and-recreate `books`.** Production holds 333 books with 240 real ratings. Type changes use `ALTER COLUMN ... TYPE ... USING`.
6. **Whole ratings serialize as integers** (`4`, never `4.0`); halves as `4.5`.
7. **Gates for every task:** `npm run type-check`, `npx eslint <touched files>`, `npm test`, and `npm run build`. Name expected-red tests by **name**, never by count.
8. All commands run from `frontend/` unless stated otherwise.

### Verified production facts (captured read-only 2026-08-13)

Supabase project `shelfsprite` / `lixkrhndwunhytgvpefx`, Postgres 17, ACTIVE_HEALTHY.

| Fact | Value |
| --- | --- |
| `alembic_version` | `0019_add_enrich_job_leases` (production is at Alembic head) |
| `books.app_rating` | `integer NULL`, no default |
| `books.goodreads_rating` | `integer NOT NULL`, **no default** |
| `enrich_jobs.progress` / `total` | `integer NOT NULL DEFAULT 0` |
| `uq_enrich_jobs_active_user` | present, `WHERE status IN ('pending','running')` intact |
| Data at risk | 333 books; 54 `app_rating`, 186 Goodreads ratings; values 3–5 |

---

## File Structure

**Created:**
- `frontend/drizzle/` — generated migrations + `meta/_journal.json`
- `frontend/scripts/stamp-baseline.ts` — one-shot baseline stamper
- `frontend/lib/server/rating.ts` — rating domain primitives (schema, rounding, formatting)
- `frontend/lib/server/__tests__/rating.test.ts`
- `frontend/components/ui/__tests__/StarRating.test.tsx`

**Modified:**
- `frontend/drizzle.config.ts` — introspection-only → migration mode
- `frontend/lib/server/schema.ts:87-88` (rating columns), `:229-230` (enrich_jobs defaults)
- `frontend/lib/server/serialize.ts:71-75` — `roundRatingHalfUp` retired
- `frontend/lib/server/profileTiers.ts:17-20,52-59` — tier buckets
- `frontend/lib/server/import-csv.ts:185-188` — `parseRating`
- `frontend/app/api/books/route.ts:67`, `frontend/app/api/books/[id]/feedback/route.ts:9` — validation
- `frontend/app/api/stats/route.ts:28-31` — histogram
- `frontend/components/ui/StarRating.tsx` — half support
- `frontend/components/BookEditModal.tsx:173-195`, `frontend/components/AddBookModal.tsx` — use `StarRating`
- `frontend/app/(main)/library/page.tsx:28,33-39,150,196-201` — display + filter
- `frontend/lib/server/__tests__/helpers/pglite.ts:53-54,182-183` — mirror
- `frontend/lib/server/__tests__/fixtures/schema-contract.json`
- `CLAUDE.md` — correct the stale `0019` note; record Alembic freeze

**Why `rating.ts` is a new file rather than more of `serialize.ts`:** `serialize.ts` is the Python-parity primitives module (`pyRound`, `pyRepr`, `pyJsonDumps`). Rating domain rules are a ShelfSprite concept, not a CPython-compatibility concern, and they are consumed by routes, import, and UI alike. Keeping them separate stops `serialize.ts` from becoming the junk drawer.

---

## Task 1: Adopt drizzle-kit, reconcile schema, stamp the baseline

Nothing else can proceed until migrations have an owner. This task ships no user-visible change — its deliverable is a stamped baseline that provably describes production.

**Files:**
- Modify: `frontend/drizzle.config.ts`
- Modify: `frontend/lib/server/schema.ts:229-230`
- Create: `frontend/scripts/stamp-baseline.ts`
- Create: `frontend/drizzle/` (generated)
- Test: `frontend/lib/server/__tests__/enrich-job-insert.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `frontend/drizzle/` migrations folder with `0000_*.sql` stamped as applied; `npm run db:generate` and `npm run db:migrate` scripts.

- [ ] **Step 1: Write the guard test that keeps wave 4c-2's fix alive**

Re-adding `.default(0)` to `enrich_jobs.progress`/`total` makes the columns *look* redundant at the insert site. They are not: production has the default, but a `create_all`-lineage DB and the PGlite mirror do not. Wave 4c-2's production 500 came from drizzle omitting these columns from the INSERT. This test makes a future "that's redundant" cleanup fail loudly.

Create `frontend/lib/server/__tests__/enrich-job-insert.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wave 4c-2 regression guard. `enrich_jobs.progress`/`total` are NOT NULL.
 * Production carries DEFAULT 0, but a create_all-lineage DB and the PGlite
 * mirror do not -- drizzle omitting these columns from the INSERT is what
 * 500'd POST /enrich/start. schema.ts declares .default(0) for baseline
 * fidelity ONLY; the explicit values must stay.
 */
describe('enrich job insert', () => {
  it('passes progress and total explicitly', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'enrichmentJobs.ts'),
      'utf8'
    );
    expect(src).toMatch(/progress:\s*0/);
    expect(src).toMatch(/total:\s*0/);
  });
});
```

- [ ] **Step 2: Run it to confirm it passes today**

Run: `npx vitest run lib/server/__tests__/enrich-job-insert.test.ts`
Expected: PASS. It is a guard, not a red test — it pins behavior that already exists so Step 3 cannot silently break it.

If it FAILS, stop: the insert site has moved. Find it with `grep -rn "progress: 0" lib/server/` and point the test at the right file before continuing.

- [ ] **Step 3: Re-add the defaults to schema.ts**

In `frontend/lib/server/schema.ts`, replace lines 229-230:

```ts
    progress: integer().notNull(),
    total: integer().notNull(),
```

with:

```ts
    // Production carries DEFAULT 0 (the `0003` lineage), so the generated
    // baseline must too. This is for schema/baseline fidelity ONLY -- the
    // inserts still pass progress/total explicitly, because a
    // create_all-lineage DB and the PGlite mirror have no default and
    // omitting them is what 500'd POST /enrich/start in wave 4c-2.
    // Guarded by __tests__/enrich-job-insert.test.ts.
    progress: integer().notNull().default(0),
    total: integer().notNull().default(0),
```

- [ ] **Step 4: Flip drizzle.config.ts to migration mode**

Replace the whole of `frontend/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

// Migration mode (wave: half-star ratings). Alembic is frozen -- it owned
// migrations while Python was live, and `start.sh` applied them on Railway
// boot. Railway is paused, so nothing auto-applies anything: `npm run
// db:migrate` is run by hand. The Vercel build must NEVER run migrations
// (builds run per-deploy and would race).
loadEnv({ path: path.resolve(__dirname, '..', '.env') });

export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/server/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 5: Add the db scripts**

In `frontend/package.json`, add to `"scripts"`:

```json
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:stamp-baseline": "tsx scripts/stamp-baseline.ts"
```

If `tsx` is not already a devDependency, use `npx tsx`. Check with `grep -n '"tsx"' package.json` before adding a dependency.

- [ ] **Step 6: Generate the baseline migration**

Run: `npm run db:generate -- --name baseline`
Expected: `frontend/drizzle/0000_baseline.sql` plus `frontend/drizzle/meta/_journal.json`.

This file describes the **whole** schema — drizzle assumes an empty database. It will NOT be executed against production; Step 8 records it as already applied.

- [ ] **Step 7: Verify the baseline actually describes production**

This is the gate the whole task exists for. Stamping a baseline that does not match production makes every future diff wrong, silently and permanently.

Read `drizzle/0000_baseline.sql` and confirm each of these against the Verified production facts table in Global Constraints:

```bash
grep -n "app_rating\|goodreads_rating" drizzle/0000_baseline.sql
grep -n "progress\|total" drizzle/0000_baseline.sql
grep -n "uq_enrich_jobs_active_user" drizzle/0000_baseline.sql
```

Expected:
- `app_rating integer` (nullable, no default)
- `goodreads_rating integer NOT NULL` with **no** `DEFAULT`
- `progress integer DEFAULT 0 NOT NULL` and `total integer DEFAULT 0 NOT NULL`
- the partial unique index carries `WHERE ... 'pending' ... 'running'`

Any mismatch is a real `schema.ts`-vs-production divergence. **Stop and report it** rather than editing the generated SQL to look right — the generated file is a symptom, `schema.ts` is the cause.

- [ ] **Step 8: Write the baseline stamper**

Create `frontend/scripts/stamp-baseline.ts`. It computes drizzle's real hashes via `readMigrationFiles` rather than guessing them (drizzle hashes the SQL with sha256 — `node_modules/drizzle-orm/migrator.js:23`), and writes the rows drizzle's own migrator would write (`node_modules/drizzle-orm/pg-core/dialect.js:45-67`).

```ts
/**
 * One-shot: record already-applied migrations in drizzle's ledger WITHOUT
 * executing their SQL. Used once, to adopt drizzle-kit on a database that
 * Alembic built (production is at alembic head 0019_add_enrich_job_leases).
 *
 * Running this against a database that does NOT already have the schema
 * leaves you with an empty DB that drizzle believes is fully migrated.
 * Guard: it refuses to stamp unless `books` already exists.
 */
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import postgres from 'postgres';

loadEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });
  try {
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'books'
      ) as exists
    `;
    if (!exists) {
      throw new Error(
        'refusing to stamp: public.books does not exist. This script is for ' +
          'adopting drizzle on an EXISTING database, not for provisioning one.'
      );
    }

    const migrations = readMigrationFiles({
      migrationsFolder: path.join(__dirname, '..', 'drizzle'),
    });

    await sql`create schema if not exists drizzle`;
    await sql`
      create table if not exists drizzle."__drizzle_migrations" (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;

    for (const m of migrations) {
      const [row] = await sql<{ id: number }[]>`
        select id from drizzle."__drizzle_migrations" where hash = ${m.hash}
      `;
      if (row) {
        console.log(`already stamped: ${m.hash.slice(0, 12)}`);
        continue;
      }
      await sql`
        insert into drizzle."__drizzle_migrations" ("hash", "created_at")
        values (${m.hash}, ${m.folderMillis})
      `;
      console.log(`stamped: ${m.hash.slice(0, 12)} (${m.folderMillis})`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Confirm `postgres` is the driver in use: `grep -n '"postgres"\|"pg"' package.json`. If the project uses `pg` instead, swap the client but keep the logic identical.

- [ ] **Step 9: Rehearse the stamp on a throwaway database**

Do NOT point this at production first. Per `isolated-local-env` practice, bring up a scratch Postgres, apply `0000_baseline.sql` to it for real, then stamp it and confirm `npm run db:migrate` reports nothing to do:

```bash
docker run --rm -d --name halfstar-baseline -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:17
# apply the generated baseline, then stamp against that URL, then:
# DATABASE_URL=postgres://postgres:postgres@localhost:55433/postgres npm run db:migrate
```

Expected: `db:migrate` finds no pending migrations. That proves the stamp works before production sees it.

- [ ] **Step 10: Gates**

```bash
npm run type-check && npx eslint drizzle.config.ts scripts/stamp-baseline.ts lib/server/schema.ts && npm test && npm run build
```

Expected: all green. If `npm test` shows failures in the PGlite-backed suites mentioning `progress`/`total`, that is Task 2's territory — note the test **names** and continue; do not fix them here.

- [ ] **Step 11: Commit**

```bash
git add frontend/drizzle.config.ts frontend/lib/server/schema.ts frontend/scripts/stamp-baseline.ts frontend/drizzle frontend/package.json frontend/lib/server/__tests__/enrich-job-insert.test.ts
git commit -m "build: adopt drizzle-kit migrations with stamped baseline"
```

**Chase runs the production stamp** (`npm run db:stamp-baseline` against production) — it is a production write and is his call, not an executor's.

---

## Task 2: Widen the rating columns

**Files:**
- Modify: `frontend/lib/server/schema.ts:87-88`
- Create: `frontend/drizzle/0001_half_star_ratings.sql` (generated, then hand-corrected)
- Modify: `frontend/lib/server/__tests__/helpers/pglite.ts:53-54`
- Modify: `frontend/lib/server/__tests__/fixtures/schema-contract.json`

**Interfaces:**
- Consumes: Task 1's migrations folder and scripts.
- Produces: `books.appRating` / `books.goodreadsRating` typed `number | null` / `number`, backed by `numeric(2,1)`.

- [ ] **Step 1: Change the columns**

In `frontend/lib/server/schema.ts`, replace lines 87-88:

```ts
    goodreadsRating: integer('goodreads_rating').notNull(),
    appRating: integer('app_rating'),
```

with:

```ts
    // numeric(2,1) spans 0.0-9.9; ratings are 0.5-5.0 on a 0.5 grid.
    // `mode: 'number'` is LOAD-BEARING: without it the driver returns
    // "3.5" as a string and every comparison (effectiveRating, tierFor,
    // LOVED_MIN, sorts, the stats mean) misbehaves silently.
    // goodreads_rating has NO server default in production -- do not add one.
    goodreadsRating: numeric('goodreads_rating', {
      precision: 2,
      scale: 1,
      mode: 'number',
    }).notNull(),
    appRating: numeric('app_rating', { precision: 2, scale: 1, mode: 'number' }),
```

Add `numeric` to the `drizzle-orm/pg-core` import list at the top of the file (it currently imports `integer`, `doublePrecision`, etc.).

- [ ] **Step 2: Add the CHECK constraints**

`check()` is available in drizzle-orm 0.45.2 (`node_modules/drizzle-orm/pg-core/checks.d.ts:18`). Add `check` to the `drizzle-orm/pg-core` import, and add these to the `books` table's extras array (the `(table) => [...]` block that starts at line 99, alongside the existing `index(...)` entries):

```ts
    check(
      'ck_books_app_rating_half_step',
      sql`${table.appRating} is null or (${table.appRating} >= 0.5 and ${table.appRating} <= 5.0 and (${table.appRating} * 2) % 1 = 0)`
    ),
    check(
      'ck_books_goodreads_rating_half_step',
      sql`${table.goodreadsRating} = 0 or (${table.goodreadsRating} >= 0.5 and ${table.goodreadsRating} <= 5.0 and (${table.goodreadsRating} * 2) % 1 = 0)`
    ),
```

`sql` is already imported in this file; confirm with `grep -n "^import\|sql" lib/server/schema.ts | head`.

Production data is 3–5 plus 0, so both constraints validate cleanly against existing rows.

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate -- --name half_star_ratings`
Expected: `frontend/drizzle/0001_half_star_ratings.sql`.

- [ ] **Step 4: Hand-review the generated SQL — this is where data dies**

Run: `cat drizzle/0001_half_star_ratings.sql`

**If it contains `DROP COLUMN`, `DROP TABLE`, or a create-new-then-copy dance, replace it by hand.** Production holds 333 books and 240 real ratings; `books` is the only irreplaceable table in this database. The correct statements are:

```sql
ALTER TABLE "books" ALTER COLUMN "goodreads_rating" TYPE numeric(2,1) USING "goodreads_rating"::numeric(2,1);--> statement-breakpoint
ALTER TABLE "books" ALTER COLUMN "app_rating" TYPE numeric(2,1) USING "app_rating"::numeric(2,1);--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "ck_books_app_rating_half_step" CHECK ("app_rating" IS NULL OR ("app_rating" >= 0.5 AND "app_rating" <= 5.0 AND ("app_rating" * 2) % 1 = 0));--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "ck_books_goodreads_rating_half_step" CHECK ("goodreads_rating" = 0 OR ("goodreads_rating" >= 0.5 AND "goodreads_rating" <= 5.0 AND ("goodreads_rating" * 2) % 1 = 0));
```

Keep the `--> statement-breakpoint` separators exactly — drizzle splits on them.

- [ ] **Step 5: Rehearse on the throwaway database**

Against the scratch Postgres from Task 1 Step 9, seed a row with an integer rating, run `npm run db:migrate`, and confirm the value survives as `4` and that inserting `3.7` is rejected:

```sql
insert into books (title, source, goodreads_rating, app_rating) values ('T', 'test', 4, 4);
-- after migrate:
select app_rating from books;              -- expect 4.0
insert into books (title, source, goodreads_rating, app_rating)
  values ('U', 'test', 0, 3.7);            -- expect CHECK violation
```

- [ ] **Step 6: Update the PGlite mirror**

In `frontend/lib/server/__tests__/helpers/pglite.ts`, replace lines 53-54:

```
      goodreads_rating integer not null,
      app_rating integer,
```

with:

```
      goodreads_rating numeric(2,1) not null,
      app_rating numeric(2,1),
```

and add the two CHECK constraints to the same `create table books (...)` block, immediately before the closing `constraint uq_book_user_goodreads` line:

```
      constraint ck_books_app_rating_half_step check (
        app_rating is null or (app_rating >= 0.5 and app_rating <= 5.0 and (app_rating * 2) % 1 = 0)
      ),
      constraint ck_books_goodreads_rating_half_step check (
        goodreads_rating = 0 or (goodreads_rating >= 0.5 and goodreads_rating <= 5.0 and (goodreads_rating * 2) % 1 = 0)
      ),
```

Also update lines 182-183 to match production's defaults:

```
      progress integer not null default 0,
      total integer not null default 0,
```

The mirror must match production exactly. Wave 4c-2's production 500 hid behind 493 green tests precisely because this mirror invented a default the real database did not have.

- [ ] **Step 7: Run the suite and record what turns red**

Run: `npm test`

Expect failures wherever fixtures assert integer ratings. **Write down the failing test names** — the next tasks fix them, and a name list is the only way to tell an expected failure from a new one. Do not fix them here beyond the schema contract in Step 8.

- [ ] **Step 8: Update the schema contract fixture**

Run the suite's contract test and update `frontend/lib/server/__tests__/fixtures/schema-contract.json` for `app_rating` and `goodreads_rating` to reflect `numeric(2,1)`. Follow whatever shape the existing entries use — do not invent new keys. Check how the test compares types first:

```bash
grep -n "dataType\|columnType\|serverDefault" lib/server/__tests__/schema-contract.test.ts | head
```

- [ ] **Step 9: Gates and commit**

```bash
npm run type-check && npx eslint lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts && npm run build
git add frontend/lib/server/schema.ts frontend/drizzle frontend/lib/server/__tests__/helpers/pglite.ts frontend/lib/server/__tests__/fixtures/schema-contract.json
git commit -m "feat(db): widen rating columns to numeric(2,1) with half-step checks"
```

`npm test` is expected red here; `type-check`, `eslint` and `build` must be green.

---

## Task 3: Rating domain primitives

**Files:**
- Create: `frontend/lib/server/rating.ts`
- Create: `frontend/lib/server/__tests__/rating.test.ts`
- Modify: `frontend/lib/server/serialize.ts:71-75`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RATING_STEP = 0.5`, `RATING_MIN = 0.5`, `RATING_MAX = 5`
  - `ratingSchema: z.ZodNumber` — accepts 0.5-grid values in [0.5, 5]
  - `roundRatingHalfStar(value: number): number | null` — nearest 0.5, clamped, `null` at or below 0
  - `isHalfStep(value: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `frontend/lib/server/__tests__/rating.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isHalfStep, ratingSchema, roundRatingHalfStar } from '../rating';

describe('roundRatingHalfStar', () => {
  it('keeps values already on the half-star grid', () => {
    expect(roundRatingHalfStar(4.5)).toBe(4.5);
    expect(roundRatingHalfStar(3)).toBe(3);
  });

  it('rounds to the nearest half star, halves going up', () => {
    expect(roundRatingHalfStar(4.24)).toBe(4);
    expect(roundRatingHalfStar(4.25)).toBe(4.5);
    expect(roundRatingHalfStar(3.7)).toBe(3.5);
    expect(roundRatingHalfStar(3.8)).toBe(4);
  });

  it('clamps to the 0.5-5.0 domain', () => {
    expect(roundRatingHalfStar(7)).toBe(5);
    expect(roundRatingHalfStar(0.3)).toBe(0.5);
  });

  it('treats zero and below as unrated', () => {
    expect(roundRatingHalfStar(0)).toBeNull();
    expect(roundRatingHalfStar(-2)).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(roundRatingHalfStar(Number.NaN)).toBeNull();
    expect(roundRatingHalfStar(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('isHalfStep', () => {
  it('accepts the grid and rejects everything else', () => {
    expect(isHalfStep(0.5)).toBe(true);
    expect(isHalfStep(5)).toBe(true);
    expect(isHalfStep(3.7)).toBe(false);
    expect(isHalfStep(0.25)).toBe(false);
  });
});

describe('ratingSchema', () => {
  it('accepts half stars and whole stars', () => {
    expect(ratingSchema.safeParse(4.5).success).toBe(true);
    expect(ratingSchema.safeParse(1).success).toBe(true);
  });

  it('rejects off-grid, out-of-range, and zero', () => {
    for (const bad of [3.7, 0.25, 0, 5.5, -1]) {
      expect(ratingSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('serialization rule', () => {
  // Global Constraint 6: whole ratings serialize as integers, halves as .5.
  // `mode: 'number'` gives this for free -- this test pins it so a future
  // pyFloatStr-style formatter cannot quietly turn 4 into "4.0" in a prompt.
  it('renders whole ratings without a decimal', () => {
    expect(JSON.stringify({ rating: 4 })).toBe('{"rating":4}');
    expect(JSON.stringify({ rating: 4.5 })).toBe('{"rating":4.5}');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/rating.test.ts`
Expected: FAIL — cannot resolve `../rating`.

- [ ] **Step 3: Implement**

Create `frontend/lib/server/rating.ts`:

```ts
/**
 * Rating domain rules. Ratings live on a 0.5 grid from 0.5 to 5.0.
 *
 * `app_rating IS NULL` means "no in-app override"; `goodreads_rating = 0`
 * means "unrated". Zero is never a rating, so 0.5 is the floor.
 *
 * This is deliberately NOT in serialize.ts: that module is the CPython
 * compatibility layer (pyRound/pyRepr/pyJsonDumps), and these are
 * ShelfSprite domain rules consumed by routes, import, and UI alike.
 */
import { z } from 'zod';

export const RATING_STEP = 0.5;
export const RATING_MIN = 0.5;
export const RATING_MAX = 5;

/** True when `value` sits exactly on the half-star grid. */
export function isHalfStep(value: number): boolean {
  return Number.isFinite(value) && (value * 2) % 1 === 0;
}

/**
 * Round an arbitrary rating to the nearest half star, clamped to
 * [0.5, 5.0]. Exact halves round up. Returns null for "unrated" (<= 0)
 * and for non-finite input.
 *
 * Replaces roundRatingHalfUp, which rounded to the nearest WHOLE star and
 * so destroyed StoryGraph's half stars on import.
 */
export function roundRatingHalfStar(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  const snapped = Math.round(value * 2) / 2;
  if (snapped < RATING_MIN) return RATING_MIN;
  if (snapped > RATING_MAX) return RATING_MAX;
  return snapped;
}

/**
 * Zod validator for an incoming rating. `.multipleOf` uses decimal-safe
 * comparison, so 3.7 and 0.25 are rejected without float slop.
 */
export const ratingSchema = z
  .number()
  .min(RATING_MIN)
  .max(RATING_MAX)
  .multipleOf(RATING_STEP);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/server/__tests__/rating.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Retire `roundRatingHalfUp`**

Delete `roundRatingHalfUp` from `frontend/lib/server/serialize.ts:71-75`. Find every caller first:

```bash
grep -rn "roundRatingHalfUp" lib app components --include=*.ts --include=*.tsx
```

Task 6 rewrites the `import-csv.ts` caller. If any other caller exists, note it and report — the spec accounted for exactly one.

- [ ] **Step 6: Gates and commit**

```bash
npm run type-check && npx eslint lib/server/rating.ts lib/server/serialize.ts && npm run build
git add frontend/lib/server/rating.ts frontend/lib/server/__tests__/rating.test.ts frontend/lib/server/serialize.ts
git commit -m "feat: add half-star rating domain primitives"
```

`npm test` stays red until Task 6 (import-csv still references the deleted helper). That is expected; `type-check` will name the file.

---

## Task 4: Half-star taste-profile tiers

**Files:**
- Modify: `frontend/lib/server/profileTiers.ts:15-20,52-59`
- Test: `frontend/lib/server/__tests__/profile-build.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `tierFor(rating: number): '5' | '4.5' | '4' | '3.5' | '3' | '<=2'`; `buildTiers` returning a `Map` with keys in the order `5, 4.5, 4, 3.5, 3, <=2, dnf, rejected`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/lib/server/__tests__/profile-build.test.ts` (match the file's existing import style):

```ts
describe('tierFor with half stars', () => {
  it('gives half stars their own buckets', () => {
    expect(tierFor(5)).toBe('5');
    expect(tierFor(4.5)).toBe('4.5');
    expect(tierFor(4)).toBe('4');
    expect(tierFor(3.5)).toBe('3.5');
    expect(tierFor(3)).toBe('3');
  });

  it('collapses everything at or below 2.5 into <=2', () => {
    expect(tierFor(2.5)).toBe('<=2');
    expect(tierFor(2)).toBe('<=2');
    expect(tierFor(0.5)).toBe('<=2');
  });

  it('still treats above-5 as the top tier', () => {
    expect(tierFor(5.5)).toBe('5');
  });
});

describe('buildTiers key order', () => {
  it('emits buckets in prompt order', () => {
    // Order is load-bearing: the Map is serialized into the Claude prompt,
    // and '4.5'/'3.5' are not integer-like, so a plain object would order
    // them differently again.
    const tiers = new Map([
      ['5', []], ['4.5', []], ['4', []], ['3.5', []],
      ['3', []], ['<=2', []], ['dnf', []], ['rejected', []],
    ]);
    expect([...tiers.keys()]).toEqual([
      '5', '4.5', '4', '3.5', '3', '<=2', 'dnf', 'rejected',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/profile-build.test.ts -t "half stars"`
Expected: FAIL — `tierFor(4.5)` returns `'<=2'` today, because 4.5 matches neither `>= 5` nor `=== 4`.

- [ ] **Step 3: Implement `tierFor`**

In `frontend/lib/server/profileTiers.ts`, replace lines 15-20:

```ts
/** Twin of profile._tier. */
export function tierFor(rating: number): string {
  if (rating >= 5) return '5';
  if (rating === 4) return '4';
  if (rating === 3) return '3';
  return '<=2';
}
```

with:

```ts
/**
 * Half stars get their own tiers so the profile sees the distinction the
 * reader actually drew. Diverges from Python's profile._tier on purpose --
 * Python is dead (Railway paused) and is not being kept in step.
 */
export function tierFor(rating: number): string {
  if (rating >= 5) return '5';
  if (rating >= 4.5) return '4.5';
  if (rating >= 4) return '4';
  if (rating >= 3.5) return '3.5';
  if (rating >= 3) return '3';
  return '<=2';
}
```

Note the `>=` chain rather than `===`: it keeps whole-star behavior byte-identical while making every half land in its own bucket.

- [ ] **Step 4: Add the buckets to `buildTiers`**

In the same file, in `buildTiers`, replace the Map literal (around lines 52-59):

```ts
  const tiers: Tiers = new Map([
    ['5', []],
    ['4', []],
    ['3', []],
    ['<=2', []],
    ['dnf', []],
    ['rejected', []],
  ]);
```

with:

```ts
  const tiers: Tiers = new Map([
    ['5', []],
    ['4.5', []],
    ['4', []],
    ['3.5', []],
    ['3', []],
    ['<=2', []],
    ['dnf', []],
    ['rejected', []],
  ]);
```

Leave the file's header comment about `Map` vs object in place, and extend it with: `'4.5'` and `'3.5'` are not integer-like, so an object would order them differently again — the `Map` is what keeps the order stated rather than inferred.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run lib/server/__tests__/profile-build.test.ts`
Expected: the new cases PASS.

Any **profile-build parity** case that now fails is expected: the prompt's bucket structure changed by design. Per Global Constraint 1, retire those specific assertions rather than re-recording them against Python — replace each with an assertion on the new eight-bucket structure. Record the retired names in the commit message.

- [ ] **Step 6: Gates and commit**

```bash
npm run type-check && npx eslint lib/server/profileTiers.ts && npm run build
git add frontend/lib/server/profileTiers.ts frontend/lib/server/__tests__/profile-build.test.ts
git commit -m "feat(profile): give half stars their own taste tiers"
```

---

## Task 5: API validation

**Files:**
- Modify: `frontend/app/api/books/route.ts:67`
- Modify: `frontend/app/api/books/[id]/feedback/route.ts:9`
- Test: `frontend/lib/server/__tests__/parity-writes-books.test.ts` (new cases only)

**Interfaces:**
- Consumes: `ratingSchema` from `lib/server/rating.ts` (Task 3).
- Produces: both routes accept `4.5` and reject `3.7` with 422.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/lib/server/__tests__/parity-writes-books.test.ts`, following that file's existing request-helper style (read the top of the file first — do NOT hand-roll a step loop; the house rule is `write-parity.ts::runScenario` plus a `REGISTRY` row):

```ts
describe('half-star validation', () => {
  it('accepts a half-star rating', async () => {
    const res = await patchFeedback({ rating: 4.5 });
    expect(res.status).toBe(200);
  });

  it('rejects an off-grid rating with 422', async () => {
    const res = await patchFeedback({ rating: 3.7 });
    expect(res.status).toBe(422);
  });

  it('rejects zero as a rating', async () => {
    const res = await patchFeedback({ rating: 0 });
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/parity-writes-books.test.ts -t "half-star validation"`
Expected: FAIL — `z.number().int()` rejects 4.5 with 422 and accepts 0.

- [ ] **Step 3: Swap in `ratingSchema`**

In `frontend/app/api/books/route.ts`, add the import and replace line 67:

```ts
import { ratingSchema } from '@/lib/server/rating';
```

```ts
  rating: ratingSchema.nullish(),
```

In `frontend/app/api/books/[id]/feedback/route.ts`, add the same import and replace line 9 identically.

**Check the clear-rating path before moving on.** The CLI clears a rating with `rate ID 0`, and `BookEditModal` has a "Clear" button. `ratingSchema` now rejects `0`, so if either sends `0` to mean "clear", it will 422. Find out which sentinel the route expects:

```bash
grep -n "rating" app/api/books/\[id\]/feedback/route.ts | head -20
```

If `0` is the clear sentinel, keep it working by accepting it explicitly rather than loosening the schema:

```ts
  rating: z.union([ratingSchema, z.literal(0)]).nullish(),
```

and leave a comment saying `0` is the clear sentinel, not a rating.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/server/__tests__/parity-writes-books.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Gates and commit**

```bash
npm run type-check && npx eslint "app/api/books/route.ts" "app/api/books/[id]/feedback/route.ts" && npm run build
git add "frontend/app/api/books/route.ts" "frontend/app/api/books/[id]/feedback/route.ts" frontend/lib/server/__tests__/parity-writes-books.test.ts
git commit -m "feat(api): accept half-star ratings"
```

---

## Task 6: Preserve half stars on import

**Files:**
- Modify: `frontend/lib/server/import-csv.ts:185-188`
- Test: `frontend/lib/server/__tests__/import-csv.test.ts`

**Interfaces:**
- Consumes: `roundRatingHalfStar` from `lib/server/rating.ts` (Task 3).
- Produces: StoryGraph `Star Rating` values survive as halves; Goodreads behavior unchanged.

- [ ] **Step 1: Write the failing test**

Add to `frontend/lib/server/__tests__/import-csv.test.ts`:

```ts
describe('storygraph half stars', () => {
  it('preserves a half-star rating', () => {
    const csv =
      'Title,Authors,Contributors,ISBN/UID,Read Status,Star Rating,Review,Last Date Read,Date Added\n' +
      'Piranesi,Susanna Clarke,,,read,4.5,,2024-01-02,2024-01-01\n';
    const parsed = parseStorygraph(csv);
    expect(parsed.rows[0].rating).toBe(4.5);
  });

  it('snaps an off-grid rating to the nearest half', () => {
    const csv =
      'Title,Authors,Contributors,ISBN/UID,Read Status,Star Rating,Review,Last Date Read,Date Added\n' +
      'Piranesi,Susanna Clarke,,,read,3.7,,2024-01-02,2024-01-01\n';
    const parsed = parseStorygraph(csv);
    expect(parsed.rows[0].rating).toBe(3.5);
  });
});
```

Match the file's existing accessor for parsed rows — if it is not `parsed.rows`, read a neighbouring test and use the same shape.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/import-csv.test.ts -t "storygraph half stars"`
Expected: FAIL — 4.5 currently becomes 5 (or the module fails to import, since Task 3 deleted `roundRatingHalfUp`).

- [ ] **Step 3: Implement**

In `frontend/lib/server/import-csv.ts`, change the import on line 4 from `roundRatingHalfUp` (in `./serialize`) to `roundRatingHalfStar` from `./rating`, and replace `parseRating` at lines 185-188:

```ts
function parseRating(raw: string | null): number | null {
  const value = parsePythonFloat(raw);
  return value == null ? null : roundRatingHalfStar(value);
}
```

Goodreads keeps its tolerant `int(float(s))` parse untouched — Goodreads has no half stars, so `4.9` still becomes 4 there by design (CLAUDE.md records this as deliberate).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/server/__tests__/import-csv.test.ts`
Expected: PASS. If a Goodreads case changed behavior, you edited the wrong path — revert and re-read Step 3.

- [ ] **Step 5: Gates and commit**

```bash
npm run type-check && npx eslint lib/server/import-csv.ts && npm test && npm run build
git add frontend/lib/server/import-csv.ts frontend/lib/server/__tests__/import-csv.test.ts
git commit -m "feat(import): preserve StoryGraph half-star ratings"
```

`npm test` should be substantially greener now — Tasks 3 and 6 together close the `roundRatingHalfUp` removal.

---

## Task 7: Stats histogram

**Files:**
- Modify: `frontend/app/api/stats/route.ts:28-31`
- Test: `frontend/lib/server/__tests__/parity-stats.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `by_star` keyed by up to 10 buckets (`"0.5"` … `"5"`), whole values keyed without a decimal.

- [ ] **Step 1: Write the failing test**

Add to `frontend/lib/server/__tests__/parity-stats.test.ts`, seeding through that file's existing helper:

```ts
describe('by_star with half stars', () => {
  it('keys whole ratings without a decimal and halves with one', async () => {
    // seed: one book at 4, one at 4.5
    const body = await getStats();
    expect(body.by_star['4']).toBe(1);
    expect(body.by_star['4.5']).toBe(1);
    expect(body.by_star['4.0']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/server/__tests__/parity-stats.test.ts -t "by_star with half stars"`
Expected: FAIL until a book with 4.5 can be seeded and returned.

- [ ] **Step 3: Confirm the route needs no change**

The existing code at lines 28-31 is:

```ts
  const ratingDist: Record<string, number> = {};
  for (const b of rated) {
    const r = String(effectiveRating(b.appRating, b.goodreadsRating));
    ratingDist[r] = (ratingDist[r] ?? 0) + 1;
  }
```

With `mode: 'number'`, `String(4)` is `"4"` and `String(4.5)` is `"4.5"` — which is exactly Global Constraint 6. **Expect to change nothing here.** If the test passes without an edit, that is the correct outcome; say so rather than inventing a change.

Add only a clarifying comment above the loop:

```ts
  // Keys are "0.5".."5" -- String() on a numeric-mode rating gives "4" for
  // whole stars and "4.5" for halves, per the serialization rule.
```

- [ ] **Step 4: Widen the frontend consumers**

Find every reader of `by_star`:

```bash
grep -rn "by_star" app components --include=*.tsx
```

For each, confirm it renders an arbitrary set of keys rather than a hardcoded `[5,4,3,2,1]`. Where a component hardcodes five buckets, replace the literal with the keys present in the response, sorted descending numerically:

```ts
const buckets = Object.keys(byStar)
  .map(Number)
  .sort((a, b) => b - a);
```

- [ ] **Step 5: Run to verify pass, then gates and commit**

```bash
npx vitest run lib/server/__tests__/parity-stats.test.ts
npm run type-check && npx eslint "app/api/stats/route.ts" && npm run build
git add "frontend/app/api/stats/route.ts" frontend/lib/server/__tests__/parity-stats.test.ts
git commit -m "feat(stats): report half-star buckets in by_star"
```

---

## Task 8: Half-aware StarRating component

`components/ui/StarRating.tsx` is currently dead code — exported at `components/ui/index.ts:8` with zero consumers (`grep -rn "StarRating" components app --include=*.tsx` returns only the definition and the export). This task makes it the real control; Task 9 wires it in.

**Files:**
- Modify: `frontend/components/ui/StarRating.tsx`
- Create: `frontend/components/ui/__tests__/StarRating.test.tsx`

**Interfaces:**
- Consumes: `RATING_MAX`, `RATING_STEP` from `lib/server/rating.ts` (Task 3).
- Produces: `<StarRating value={number} onChange={(v: number) => void} allowHalf readOnly size label />`, where `value` is 0 for unrated and 0.5–5 otherwise.

- [ ] **Step 1: Write the failing test**

Create `frontend/components/ui/__tests__/StarRating.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StarRating } from '../StarRating';

function halfClick(el: Element, fraction: number) {
  // jsdom gives every element a zero-size rect, so drive the handler with an
  // explicit width and offset instead of relying on layout.
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 0, width: 20, right: 20, top: 0, bottom: 20, height: 20, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  fireEvent.click(el, { clientX: 20 * fraction });
}

describe('StarRating half stars', () => {
  it('reports a half when the left side of a star is clicked', () => {
    const onChange = vi.fn();
    render(<StarRating value={0} onChange={onChange} allowHalf />);
    halfClick(screen.getAllByRole('radio')[3], 0.25);
    expect(onChange).toHaveBeenCalledWith(3.5);
  });

  it('reports a whole star when the right side is clicked', () => {
    const onChange = vi.fn();
    render(<StarRating value={0} onChange={onChange} allowHalf />);
    halfClick(screen.getAllByRole('radio')[3], 0.75);
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('steps by half with arrow keys when allowHalf is set', () => {
    const onChange = vi.fn();
    render(<StarRating value={3} onChange={onChange} allowHalf />);
    fireEvent.keyDown(screen.getAllByRole('radio')[2], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(3.5);
  });

  it('steps by a whole star when allowHalf is not set', () => {
    const onChange = vi.fn();
    render(<StarRating value={3} onChange={onChange} />);
    fireEvent.keyDown(screen.getAllByRole('radio')[2], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('never goes below half a star or above the max', () => {
    const onChange = vi.fn();
    render(<StarRating value={0.5} onChange={onChange} allowHalf />);
    fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it('announces a half rating accessibly', () => {
    render(<StarRating value={3.5} readOnly allowHalf label="Your rating" />);
    expect(screen.getByRole('radiogroup')).toHaveAttribute(
      'aria-label',
      'Your rating: 3.5 of 5'
    );
  });
});
```

Confirm the project's component-test setup first: `ls frontend/vitest.config.* frontend/vitest.setup.*` and check `@testing-library/react` is a devDependency. If component tests are not yet configured, configure jsdom + testing-library as part of this task — it is scaffolding for this deliverable, not a separate concern.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run components/ui/__tests__/StarRating.test.tsx`
Expected: FAIL — `allowHalf` does not exist and clicks report whole stars only.

- [ ] **Step 3: Implement**

Replace `frontend/components/ui/StarRating.tsx` entirely:

```tsx
'use client';
import { useState, KeyboardEvent, MouseEvent } from 'react';
import { RATING_MAX, RATING_STEP } from '@/lib/server/rating';

interface StarRatingProps {
  /** 0 = unrated; otherwise 0.5-5 (whole stars only when allowHalf is false). */
  value: number;
  onChange?: (value: number) => void;
  max?: number;
  label?: string;
  readOnly?: boolean;
  size?: number;
  /** Enable half-star selection: left half of a star picks the .5 value. */
  allowHalf?: boolean;
}

export function StarRating({
  value,
  onChange,
  max = RATING_MAX,
  label = 'Rating',
  readOnly = false,
  size = 20,
  allowHalf = false,
}: StarRatingProps) {
  const [hovered, setHovered] = useState(0);
  const step = allowHalf ? RATING_STEP : 1;
  const min = step;

  function clamp(next: number) {
    return Math.min(max, Math.max(min, next));
  }

  /** Which value a pointer at `e` over star `star` represents. */
  function valueAt(e: MouseEvent<HTMLButtonElement>, star: number) {
    if (!allowHalf) return star;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 1;
    return fraction <= 0.5 ? star - 0.5 : star;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (readOnly || !onChange) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(clamp(value + step));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(clamp(value - step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(min);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(max);
    } else if (e.key >= '1' && e.key <= String(max)) {
      e.preventDefault();
      onChange(Number(e.key));
    }
  }

  const display = readOnly ? value : hovered || value;

  return (
    <div
      role="radiogroup"
      aria-label={`${label}: ${value || 0} of ${max}`}
      className="flex items-center gap-1"
    >
      {Array.from({ length: max }, (_, i) => {
        const star = i + 1;
        // 1 = full, 0.5 = half, 0 = empty.
        const fill = display >= star ? 1 : display >= star - 0.5 ? 0.5 : 0;
        const tabIdx = star === Math.ceil(value || 1) ? 0 : -1;

        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value > star - 1 && value <= star}
            aria-label={star === 1 ? '1 star' : `${star} stars`}
            disabled={readOnly}
            tabIndex={tabIdx}
            onClick={(e) => !readOnly && onChange && onChange(valueAt(e, star))}
            onMouseMove={(e) => !readOnly && setHovered(valueAt(e, star))}
            onMouseLeave={() => !readOnly && setHovered(0)}
            onKeyDown={handleKeyDown}
            className={[
              'rounded transition-transform',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'focus-visible:ring-offset-1 focus-visible:ring-offset-base',
              readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-110 active:scale-95',
            ].join(' ')}
          >
            <StarIcon fill={fill} size={size} index={star} />
          </button>
        );
      })}
    </div>
  );
}

const STAR_PATH =
  'M10 1.5l2.47 5.02 5.54.8-4.01 3.91.95 5.52L10 14.27l-4.95 2.48.95-5.52L2 7.32l5.54-.8L10 1.5z';

function StarIcon({ fill, size, index }: { fill: number; size: number; index: number }) {
  // A half star is the outline plus a left-clipped fill. clipPath ids must be
  // unique per instance or every star renders the first one's clip.
  const clipId = `star-half-${index}`;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="10" height="20" />
        </clipPath>
      </defs>
      <path fill="none" stroke="var(--border)" strokeWidth="1.5" d={STAR_PATH} />
      {fill === 1 && <path fill="var(--accent)" d={STAR_PATH} />}
      {fill === 0.5 && <path fill="var(--accent)" d={STAR_PATH} clipPath={`url(#${clipId})`} />}
    </svg>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run components/ui/__tests__/StarRating.test.tsx`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
npm run type-check && npx eslint components/ui/StarRating.tsx && npm run build
git add frontend/components/ui/StarRating.tsx frontend/components/ui/__tests__/StarRating.test.tsx
git commit -m "feat(ui): add half-star support to StarRating"
```

---

## Task 9: Wire StarRating into the edit and add modals

**Files:**
- Modify: `frontend/components/BookEditModal.tsx:119,173-195`
- Modify: `frontend/components/AddBookModal.tsx` (rating block around lines 264-300)

**Interfaces:**
- Consumes: `StarRating` with `allowHalf` (Task 8), `ratingSchema`-backed routes (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Replace the hand-rolled stars in BookEditModal**

In `frontend/components/BookEditModal.tsx`, delete the `shown` local at line 119 (`const shown = hover || rating;`) and the `hover` state that feeds it, then replace the whole star block (lines 173-195, the `<div className="flex gap-1" onMouseLeave={...}>` through its closing `</div>`) with:

```tsx
        <StarRating
          value={rating}
          onChange={setRating}
          allowHalf
          size={30}
          label="Your rating"
        />
```

Add `import { StarRating } from '@/components/ui';` to the imports.

Leave the surrounding "Clear" button and the `rating === 0` hint exactly as they are — `0` still means unrated, and `StarRating` never emits it.

- [ ] **Step 2: Confirm the clear path still round-trips**

`BookEditModal` sends `req.rating = rating` when `ratingChanged`. If the "Clear" button sets `rating` to 0, that 0 reaches the API — which Task 5 Step 3 made a rejected value unless it was kept as an explicit clear sentinel. Verify the two agree:

```bash
grep -n "setRating(0)\|req.rating" components/BookEditModal.tsx
```

If they disagree, fix it here (the route is the contract; the modal follows it), and note the resolution in the commit message.

- [ ] **Step 3: Replace the hand-rolled stars in AddBookModal**

Same edit in `frontend/components/AddBookModal.tsx`: drop `shownStars` (line 109) and the hover state, replace the star block around lines 264-300 with the same `<StarRating ... allowHalf />` element bound to its `rating`/`setRating`, and add the import. Leave `rating: rating > 0 ? rating : undefined` at line 83 alone — it already means "omit when unrated".

- [ ] **Step 4: Verify in the browser, not just the type-checker**

Per Chase's standing rule, tests do not close this. Run the app and exercise both modals:

```bash
npm run dev
```

Confirm: clicking the left half of the 4th star shows 3.5; the value persists after save and reload; the "Clear" button returns the book to unrated; keyboard arrows step by half.

- [ ] **Step 5: Gates and commit**

```bash
npm run type-check && npx eslint components/BookEditModal.tsx components/AddBookModal.tsx && npm test && npm run build
git add frontend/components/BookEditModal.tsx frontend/components/AddBookModal.tsx
git commit -m "feat(ui): use half-star StarRating in book modals"
```

---

## Task 10: Library display and filter

**Files:**
- Modify: `frontend/app/(main)/library/page.tsx:28,33-39,150,196-201`

**Interfaces:**
- Consumes: `StarRating` (Task 8).
- Produces: no new exports.

- [ ] **Step 1: Fix `StarDisplay`**

`'★'.repeat(rating)` truncates its argument, so a 3.5 renders 3 filled plus `repeat(1.5)` → 1 empty: four stars, silently wrong. Replace lines 33-39 with:

```tsx
function StarDisplay({ rating }: { rating: number | null }) {
  if (!rating) return <span className="font-mono text-xs text-faint">unrated</span>;
  return <StarRating value={rating} readOnly allowHalf size={14} label="Rating" />;
}
```

Add `import { StarRating } from '@/components/ui';`.

- [ ] **Step 2: Make the filter half-aware**

The chips are built from `STARS = [5, 4, 3, 2, 1]` (line 28) and matched with exact equality at line 150, so half-rated books are unreachable by every chip.

Keep five chips — ten would crowd the row — and make each chip mean "this star band", covering the half below it. Replace line 150:

```tsx
    .filter((b) => (filterStar !== null ? b.effective_rating === filterStar : true))
```

with:

```tsx
    // A chip covers its own star and the half below it, so a 3.5 is reachable
    // from the "4" chip. Without this, half-rated books match no chip at all.
    .filter((b) =>
      filterStar !== null
        ? b.effective_rating !== null &&
          b.effective_rating > filterStar - 1 &&
          b.effective_rating <= filterStar
        : true
    )
```

- [ ] **Step 3: Verify in the browser**

```bash
npm run dev
```

Confirm: a book rated 3.5 displays as three and a half stars in the library list, and is returned by the "4" filter chip. Confirm the sort options still order correctly with mixed whole and half values.

- [ ] **Step 4: Gates and commit**

```bash
npm run type-check && npx eslint "app/(main)/library/page.tsx" && npm test && npm run build
git add "frontend/app/(main)/library/page.tsx"
git commit -m "fix(library): render and filter half-star ratings correctly"
```

---

## Task 11: Documentation and end-to-end verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/hosting.md`

- [ ] **Step 1: Correct the stale migration note in CLAUDE.md**

CLAUDE.md states that `0019_add_enrich_job_leases` "has not been applied and must be applied in the same release window as the switcher flip." Production reads `0019_add_enrich_job_leases` in `alembic_version` (verified 2026-08-13). Replace that claim with the verified state, and record that Alembic is now **frozen**: it owned migrations while Python was live, new migrations go to drizzle-kit, and nobody should add an `0020`.

- [ ] **Step 2: Document the migration workflow in docs/hosting.md**

Add a section covering: `npm run db:generate` to author, hand-review of generated SQL for drop-and-recreate before any `books` change, `npm run db:migrate` run **manually** against production, and the explicit rule that the Vercel build must never run migrations (builds run per-deploy and would race). Record that the baseline was stamped, not executed, and that `scripts/stamp-baseline.ts` is a one-shot that refuses to run against a database without `books`.

- [ ] **Step 3: Full end-to-end verification**

Tests do not close this. With production migrated, exercise the real flow in the browser:

1. Rate a book 3.5 in the library; reload; confirm it persists as 3.5.
2. Confirm `/stats` shows a `3.5` bucket.
3. Import a StoryGraph CSV containing a 4.5 and confirm it lands as 4.5, not 5.
4. Export, and confirm the half star round-trips.
5. Rebuild the taste profile and confirm the half-star books land in the `4.5`/`3.5` tiers.
6. Clear a rating and confirm the book returns to unrated.

- [ ] **Step 4: Full gates and commit**

```bash
npm run type-check && npx eslint . && npm test && npm run build
git add CLAUDE.md docs/hosting.md
git commit -m "docs: record drizzle migration workflow and verified production state"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 data model, `mode: 'number'`, CHECK, no `goodreads_rating` default | 2 (+ Global Constraints 2-4) |
| §2 half-star tiers, `Map` ordering, retire stale profile assertions | 4 |
| §3 whole-vs-half serialization rule | 3 (test), 7 (confirmed no-op) |
| §4 `ratingSchema`, `roundRatingHalfStar`, Goodreads unchanged | 3, 5, 6 |
| §5 revive `StarRating`, modals, `StarDisplay` bug, filter bug, `by_star` consumers | 7, 8, 9, 10 |
| §6 drizzle-kit adoption, baseline stamp, `enrich_jobs` defaults, freeze Alembic | 1, 11 |
| §7 PGlite mirror, schema contract, unit tests, live verification | 2, 3, 4, 8, 9, 10, 11 |

**Deliberately deferred:** §7's optional "build the PGlite mirror from generated migration SQL" is not a task. The spec marks it severable, and folding a test-infrastructure rewrite into a data-type migration doubles the blast radius. Task 2 Step 6 keeps the mirror correct by hand; the generated-mirror cleanup is a follow-up.

**Type consistency:** `roundRatingHalfStar`, `ratingSchema`, `isHalfStep`, `RATING_MIN`, `RATING_MAX`, `RATING_STEP` are defined in Task 3 and used under those exact names in Tasks 5, 6, and 8. `tierFor` keeps its existing name and signature. `StarRating`'s `allowHalf` prop is introduced in Task 8 and consumed in Tasks 9 and 10.

**Known risk carried by design:** Task 5 Step 3 and Task 9 Step 2 both probe the "clear a rating" sentinel, because `ratingSchema` rejects `0` while the existing UI and CLI use `0` to mean "clear". The plan makes that collision explicit at both ends rather than assuming which way it resolves.
