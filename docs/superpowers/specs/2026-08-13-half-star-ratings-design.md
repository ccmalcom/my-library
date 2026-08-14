# Half-star ratings — design

**Date:** 2026-08-13
**Status:** approved design, pending implementation plan
**Scope:** Node + Postgres only. Python (`mylibrary/`) is not changed.

## Goal

Let a reader rate a book in half-star steps (0.5 … 5.0), in the UI and through the
API, and feed that finer signal into the taste profile.

## Decisions taken during brainstorming

| Decision | Choice | Why |
| --- | --- | --- |
| Storage | `numeric(2,1)` holding `3.5` | Reads stay human-meaningful; straight type widen, no data rewrite |
| Python | Not changed; knowingly diverges | Railway is paused, Python is functionally dead |
| Tiering | Half stars get their own profile tiers | The point of the feature is finer signal; the profile is its main consumer |
| Migration tooling | Adopt `drizzle-kit` now, freeze Alembic | This column change can never land in Python, so an Alembic revision would be pure chain-keeping |

## 1. Data model

Both rating columns widen. Imports write `goodreads_rating`
(`import-books.ts:90,121`), so StoryGraph half stars are currently destroyed by
`roundRatingHalfUp` before they ever reach the DB — widening only `app_rating`
would leave the import path lossy.

| Column | Now | After |
| --- | --- | --- |
| `books.app_rating` | `integer NULL` | `numeric(2,1) NULL` |
| `books.goodreads_rating` | `integer NOT NULL`, **no server default** | `numeric(2,1) NOT NULL`, **no server default** |

**Do not add a server default to `goodreads_rating`.** Verified against production
2026-08-13: `column_default` is null. Python's `default=0` (`db.py:80`) is
ORM-level only, and `schema.ts:87` correctly declares `.notNull()` with no
`.default()`. Node already supplies the value explicitly. Adding a DB default
here would repeat the `enrich_jobs.progress` mistake in reverse — inventing a
default that production does not have.

`numeric(2,1)` spans 0.0–9.9, so 5.0 fits with headroom.

**Drizzle mapping is load-bearing.** Declare as
`numeric('app_rating', { precision: 2, scale: 1, mode: 'number' })`. Verified in
`node_modules/drizzle-orm/pg-core/numeric.d.ts:98`: without `mode: 'number'` the
driver returns `"3.5"` as a **string**, and every numeric comparison in the
codebase (`effectiveRating`, `tierFor`, `LOVED_MIN`, the stats mean, every sort)
silently misbehaves rather than failing loudly.

**Domain: 0.5–5.0 on a 0.5 grid.** `app_rating IS NULL` still means "no override";
`goodreads_rating = 0` still means "unrated". So 0.5 is the floor and 0 is not a
rating. Enforced with a DB `CHECK` rather than trusting call sites — `check()` is
available in drizzle-orm 0.45.2 (`pg-core/checks.d.ts:18`):

```
app_rating IS NULL OR (app_rating >= 0.5 AND app_rating <= 5.0 AND (app_rating * 2) % 1 = 0)
goodreads_rating = 0 OR (goodreads_rating >= 0.5 AND goodreads_rating <= 5.0 AND (goodreads_rating * 2) % 1 = 0)
```

## 2. Tiers and the taste profile

`tierFor` (`profileTiers.ts:17-20`) returns
`'5' | '4.5' | '4' | '3.5' | '3' | '<=2'`, and `buildTiers`' Map gains the two new
keys in that insertion order, ahead of `dnf` and `rejected`.

**The `Map` stays a `Map`.** Its header comment (`profileTiers.ts:1-6`) explains
that key order is load-bearing because the result is serialized into the Claude
prompt, and V8 reorders integer-like object keys. `'4.5'` and `'3.5'` are *not*
integer-like, so as a plain object they would sort differently again — the `Map`
is what keeps the order stated rather than inferred.

This changes the prompt's shape, so the `/profile` build parity fixtures go
stale. Because Python is dead, **retire** those assertions rather than re-record
them, and replace with hand-written tests pinning the eight-bucket structure.

## 3. Serialization rule that keeps existing fixtures green

**Whole ratings serialize as integers (`4`, never `4.0`); halves as `4.5`.**

Every recorded prompt and response fixture was captured from integer-only data.
With this rule they stay byte-identical — except the profile-build fixtures,
which change for the separate reason in §2 (new tier buckets) — so only
genuinely-new half-star behavior diverges. That is the difference between a
handful of expected-red tests and a full re-record. Any place that formats a rating for a prompt must go through one
helper implementing this, not ad-hoc `String(x)`.

`LOVED_MIN = 4` (`recSignal.ts:22`) is unchanged: 4.5 counts as loved, 3.5 does
not, and the comparison already operates on numbers.

## 4. API and import

- One shared `ratingSchema` — `z.number().multipleOf(0.5).min(0.5).max(5)`,
  `.nullish()` where the current field is — replaces `z.number().int()` at
  `app/api/books/route.ts:67` and `app/api/books/[id]/feedback/route.ts:9`.
  `multipleOf` uses decimal-safe comparison, so `3.7` and `0.25` are rejected.
- `roundRatingHalfUp` (`serialize.ts:71-75`) rounds to the nearest **0.5** instead
  of the nearest 1, clamped to 0.5–5.0, preserving StoryGraph half stars.
- Goodreads keeps its tolerant `int(float(s))` parse — Goodreads has no half
  stars, so that path's behavior is unchanged by design.

## 5. UI

`components/ui/StarRating.tsx` is **dead code**: exported at `ui/index.ts:8` with
zero consumers. The live controls are hand-rolled `★` buttons in
`BookEditModal.tsx:119-193` and `AddBookModal.tsx`.

Revive `StarRating` as the single rating control with half support — left half of
a star selects `.5`, arrow keys step `0.5`, half-filled render via SVG clip — and
replace both hand-rolled copies. The feature and the dead-code cleanup are the
same edit.

Two display bugs that half stars *create*:

- `library/page.tsx:33-39` renders `'★'.repeat(rating)`. `repeat` truncates its
  argument, so a 3.5 draws 3 filled plus `repeat(1.5)` → 1 empty: four stars,
  silently wrong.
- The star filter at `library/page.tsx:150` is exact equality
  (`effective_rating === filterStar`), so half-rated books become unreachable by
  every filter chip.

`/stats`'s `by_star` histogram (`app/api/stats/route.ts:28-31,69`) grows from 5
keys to 10; its consumers on the home and profile pages must render the wider
distribution.

## 6. Migration tooling: adopt drizzle-kit, freeze Alembic

Today `drizzle.config.ts` is introspection-only ("never run drizzle-kit
generate/migrate/push"), Alembic owns migrations, and `start.sh` applied them on
Railway boot. **Railway is paused, so nothing auto-applies migrations anymore.**

### 6.1 Prerequisite: verify production's real schema

This must happen before any baseline is generated, and it is Chase's to run — the
ShelfSprite Supabase project is not reachable from the assistant's MCP connection,
and `.env` values are off-limits.

CLAUDE.md's warning applies directly: *"The drizzle baseline must come from a
`pg_dump` of production, never a fresh `alembic upgrade head`."* Production's
state is genuinely uncertain — `0018` was hand-applied from a branch the
deployment did not track, `0019` was recorded as not-yet-applied, and
`enrich_jobs.progress`/`total` have two legitimate shapes depending on DB age.

**`pg_dump` is not required and is not installed here.** `drizzle-kit` 0.31.10 is
already a devDependency and `drizzle.config.ts` is already configured for exactly
this — its own comment sanctions `drizzle-kit pull`. That captures tables,
columns, types, defaults, indexes, constraints and FKs, and emits output directly
comparable to `schema.ts`.

**Point it at production explicitly.** `drizzle.config.ts` reads `DATABASE_URL`
from the repo-root `.env`, which is the *dev* database. Capturing dev and stamping
it as the production baseline is the precise failure this section exists to
prevent, and it fails silently.

### 6.1.1 Production state, verified 2026-08-13

Captured read-only from the `shelfsprite` Supabase project (`lixkrhndwunhytgvpefx`,
Postgres 17, ACTIVE_HEALTHY) via `information_schema` / `pg_indexes`:

| Fact | Value |
| --- | --- |
| `alembic_version` | `0019_add_enrich_job_leases` |
| `uq_enrich_jobs_active_user` | present, `WHERE status IN ('pending','running')` intact |
| `enrich_jobs.progress` / `total` | `integer NOT NULL DEFAULT 0` (the `0003` lineage) |
| `books.app_rating` | `integer NULL`, no default |
| `books.goodreads_rating` | `integer NOT NULL`, no default |
| Data at risk | 333 books; 54 with `app_rating`, 186 with a Goodreads rating; values 3–5 |

**`0019` is applied.** CLAUDE.md's note that it "has not been applied and must be
applied in the same release window as the switcher flip" is stale and should be
corrected. Production is at the Alembic head, so the baseline is the `0019` shape.

**One known `schema.ts`-vs-production divergence to reconcile before stamping:**
production has `DEFAULT 0` on `enrich_jobs.progress`/`total`, while `schema.ts`
deliberately dropped those `.default()`s during wave 4c-2's fix. Both are
*correct* for their own purpose, but a baseline generated from `schema.ts` will
not describe production.

**Decided: re-add `.default(0)` to `enrich_jobs.progress`/`total` in `schema.ts`**,
so the schema describes production and the generated baseline matches it.

**This must not undo wave 4c-2's fix.** The inserts that pass `progress: 0,
total: 0` explicitly **stay exactly as they are**. The `.default(0)` is for
schema/baseline fidelity only — it is not a license to drop the explicit values.
Wave 4c-2's 500 happened because drizzle omitted the columns from the INSERT and
the target DB had no server default; production has one today, but a
`create_all`-lineage DB (and the PGlite mirror) does not. Add a comment at the
column saying so, and a test asserting the insert payload still carries both
values, so a future "the DB has a default, this is redundant" cleanup fails loudly
instead of reintroducing the outage.

The existing-data figures also make §6.3's warning concrete rather than
theoretical: a drop-and-recreate would destroy 240 real ratings.

Alternatives if a true `pg_dump` is ever wanted: run it from the `postgres:17`
Docker image (no install), or `sudo dnf install postgresql` for the client tools
on Nobara. Neither is needed for the baseline.

Deliverable: production's captured schema, diffed against `schema.ts`, with every
difference resolved **before** stamping.

### 6.2 Baseline stamp

1. Flip `drizzle.config.ts` to migration mode: add `schema: './lib/server/schema.ts'`,
   point `out` at a migrations directory, drop the introspection-only comment.
2. `drizzle-kit generate` produces an initial migration describing the *whole*
   current schema (drizzle assumes an empty DB).
3. **Stamp it as already applied** — record it in `__drizzle_migrations` without
   executing its SQL. This is the standard adopt-on-an-existing-DB move.
4. Gate before stamping: build a throwaway Postgres from the generated migration
   and diff it against the production `pg_dump`. Stamping a baseline that does not
   match production makes every future diff wrong, silently.

### 6.3 The half-star migration

A second `drizzle-kit generate` emits the `ALTER TABLE … TYPE numeric(2,1)` pair
plus the two CHECK constraints. Review the generated SQL by hand: drizzle-kit
sometimes emits drop-and-recreate for a type change, which would destroy ratings —
CLAUDE.md is explicit that `books` holds the only irreplaceable data. Replace with
an explicit `ALTER COLUMN … TYPE … USING …` if so.

### 6.4 Applying migrations from here on

No auto-runner. Add `npm run db:migrate` (`drizzle-kit migrate`), run manually
against production, documented in `docs/hosting.md`. **The Vercel build must not
run migrations** — builds run per-deploy and would race.

### 6.5 Freeze Alembic

`alembic/` and `start.sh` are left untouched; they die with Python. Record in
CLAUDE.md that Alembic is no longer authoritative and new migrations go to
drizzle, so nobody adds an `0020` that never runs.

## 7. Testing

- **PGlite mirror.** `helpers/pglite.ts:46` builds `books` from hand-written
  `create table` SQL. It must gain the exact type, NOT NULL and default. Wave
  4c-2's production 500 hid behind 493 green tests precisely because this mirror
  invented a default the real DB did not have.
  *Recommended, severable:* now that migrations are generated, build the mirror
  **from the generated migration SQL** instead of hand-maintaining it, retiring
  that whole bug class. Cut this if the wave gets long.
- `schema-contract.json` regenerated for the two columns.
- New unit tests: `tierFor` half cases; `ratingSchema` rejecting `3.7` / `0.25` /
  `0`; StoryGraph import preserving `4.5`; `StarRating` half-click and keyboard
  stepping; the whole-vs-half serialization rule.
- Expected-red fixtures listed **by name**, never by count.
- **Live verification** per Chase's standing rule: run the app, rate a book 3.5,
  confirm it persists, renders correctly in the library, survives export/import,
  and lands in the right tier on a profile rebuild. Tests alone do not close this.

## Out of scope

- Changing Python, or re-recording parity fixtures against it.
- Deleting Python / finishing wave 5b.
- Quarter stars, or any rating scale other than 0.5 steps.
- Backfilling or reinterpreting existing integer ratings — they stay as they are.
