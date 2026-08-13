# Wave 5b-2: Python Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete Python from MyLibrary entirely — `mylibrary/`, `tests/`, `alembic/`, and the fixture recorders — after transferring database schema ownership from Alembic to drizzle-kit and removing the migration scaffolding from the frontend.

**Architecture:** The order is dictated by one rule: prove the replacement before deleting the original. Schema ownership moves to drizzle-kit and is proven against a real production schema dump on a throwaway database *first*; only then does `mylibrary/` go. The frontend switcher is removed in the middle, because it is independent of both and it is what still makes `NEXT_PUBLIC_API_URL` load-bearing.

**Tech Stack:** drizzle-kit (migrations, taking over from Alembic), Next.js route handlers, Vercel, Supabase Postgres, Docker (throwaway Postgres for migration proof).

## Blocked Until

**This wave does not start until wave 5b-1's soak criteria are met.** They are recorded in `docs/superpowers/plans/2026-08-12-node-backend-wave-5b-1-production-cutover.md` under Task 7 Step 2. In summary: 14 days on Node with no rollback, every route family exercised by real usage, the janitor fired on its own schedule, at least one other invited user served by Node, no unexplained 5xx, and Anthropic spend consistent with pre-cutover levels.

Task 0 re-reads those criteria and refuses to proceed if any is unmet. Do not soften this — every task after Task 3 destroys something that git history alone will not conveniently give back.

## Global Constraints

1. **Prove, then delete.** No deletion task runs before its replacement is proven. Specifically: `alembic/` and `mylibrary/db.py` survive until the drizzle baseline has been applied to an empty database and diffed clean against a production schema dump (Task 2).
2. **Deletion is one-way in practice.** Git history retains everything, but a future contributor will not find it. Anything worth keeping must be moved, not merely deleted — see Task 6's frozen-fixture README and Task 8's docs rewrite.
3. **Codex dispatch rules** (from `chase-workflow:codex-dispatch`) apply to every task marked *Codex-dispatchable*:
   - Never name a `.env` file or ask Codex to inspect secrets or environment configuration. Codex runs outside `.claude/hooks/pre_bash.py`. Use `.env.example` for variable names.
   - Name every gate in every prompt, including `npm run type-check` and `npx eslint <touched files>`. An unlisted gate is out of scope, not forgotten.
   - Name only fast, scoped gates. Do not put the whole vitest suite in a Codex prompt — the controller re-runs it regardless, and a slow suite can eat the ~10-minute budget.
   - **Codex cannot run pytest at all** (`tests/conftest.py` imports FastAPI's `TestClient`, which hangs its sandbox), cannot `npm install`, and cannot run the fixture recorders. Say so in the prompt.
   - Always pass `GIT_PAGER=cat` or `git --no-pager`; a paged git command hangs the shell.
   - If a fix round requires an **edit**, dispatch fresh rather than resuming — write access does not reliably survive a `SendMessage` resume. Run `git status` after any killed run; applied changes are not rolled back.
4. **Test runner scoping.** `vitest` owns `frontend/lib/server/**` and `frontend/app/api/**`; `jest` owns everything else under `frontend/`. A command pointed at the wrong runner matches zero tests, exits 0, and reads as a pass. This bit wave 5a's Task 9 and is the reason `lib/__tests__/backend.test.ts` must be run with jest, not vitest.
5. **Chase commits by hand.** No task runs `git commit`.
6. **Cite symbols, not line ranges** in any proof-of-fix check: `grep -n '<exact code>'`, never `sed -n 'N,Mp'`.

## Verified Facts (established 2026-08-12 while authoring)

| Fact | Evidence |
| --- | --- |
| Alembic is the schema authority; its metadata comes from the Python models | `alembic/env.py` — `from mylibrary.db import Base`, `target_metadata = Base.metadata` |
| drizzle is currently introspection-only and has **zero** migration files | `frontend/drizzle.config.ts` — "Introspection-only config. Alembic owns migrations until cutover — never run drizzle-kit generate/migrate/push with this config, only `drizzle-kit pull`." No `.sql` or `meta/` directory exists under `frontend/` |
| `schema.ts` does capture the hard cases, including the partial unique index | `frontend/lib/server/schema.ts` — `uniqueIndex('uq_enrich_jobs_active_user').on(table.userId).where(sql\`${table.status} in ('pending', 'running')\`)` |
| The schema-contract test's source is the SQLAlchemy models | `scripts/dump_schema_contract.py` — `from mylibrary.db import Base` |
| Exactly four frontend files consume the switcher | `components/admin/SystemTab.tsx`, `lib/api.ts`, `lib/backend.ts`, `lib/__tests__/backend.test.ts` |
| `lib/api.ts` calls `baseFor(...)` at roughly 13 sites, all of the form `` `${baseFor(path, METHOD)}${path}` `` | `grep -n baseFor lib/api.ts` |
| `SystemTab.tsx` hosts BOTH the backend chooser (to be deleted) and the debug-mode toggle (to be kept) | `components/admin/SystemTab.tsx` — `pickBackend` and the `debug_mode` control |
| `/admin/config` is the debug-mode route and is unrelated to the switcher | `frontend/app/api/admin/config/route.ts` — `DEBUG_MODE_KEY` |
| 18 test files plus `conftest.py` import FastAPI's `TestClient`; `scripts/gen_parity_fixtures.py` does too | `grep -ln "TestClient\|from mylibrary.api" scripts/*.py tests/*.py` |
| The stop hook runs ruff and pytest on changed `.py` files | `.claude/hooks/on_stop.py` |

## Execution Batching

Per `chase-workflow:controller-budget`, **hand off after each batch — do not start the next batch in the same session.** Batches are 2–3 tasks. Update `.superpowers/sdd/` after every task, not at the end of a batch, because the handoff is only cheap if the ledger is the state of record.

| Batch | Tasks | Shape |
| --- | --- | --- |
| A | 0, 1, 2 | Schema ownership handover — the irreversibility gate |
| B | 3, 4 | Frontend scaffolding removal — Codex-dispatchable |
| C | 5, 6 | Python deletion |
| D | 7, 8 | Docs, tooling, and Railway teardown |

---

### Task 0: Confirm the soak passed and re-baseline

**Files:**
- Create: `.superpowers/sdd/2026-08-12-node-backend-wave-5b-2-python-retirement/progress.md`

**Interfaces:**
- Produces: a recorded go/no-go against 5b-1's soak criteria, plus a fresh gate baseline that every later task compares against.

**Owner:** Claude asks; Chase answers the production-observability questions.

- [ ] **Step 1: Check each soak criterion explicitly, one line each**

Read 5b-1's Task 7 Step 2 list and record a yes/no plus evidence for every item. "Probably fine" is not an answer. **If any criterion is unmet, stop the wave here** and record what is outstanding.

The two easiest to hand-wave and most worth insisting on: *another invited user has used the app on Node*, and *the janitor fired on its own schedule* (Vercel cron logs, not a manual `curl`).

- [ ] **Step 2: Record the current gate baseline**

```bash
cd frontend && npx vitest run 2>&1 | tail -5
cd frontend && npx jest 2>&1 | tail -5
cd frontend && npm run type-check
cd frontend && npx eslint .
python -m pytest -q 2>&1 | tail -3
```

Expected after 5b-1: vitest 77 files / 551 tests, jest 41, pytest **361** (5b-1's merge added `test_extract_taste_profile_survives_rejected_rec_with_note`). Record what you observe.

- [ ] **Step 3: Confirm you are on a branch, not on main**

```bash
git --no-pager branch --show-current
```

This wave deletes a great deal. Work on a branch — `chore/retire-python` — so the whole thing is one reviewable diff and one revert if needed.

---

### Task 1: Give drizzle-kit real migrations and generate the baseline

**Files:**
- Modify: `frontend/drizzle.config.ts`
- Create: `frontend/drizzle/0000_baseline.sql` (name assigned by drizzle-kit; record the real one)
- Create: `frontend/drizzle/meta/_journal.json` and `frontend/drizzle/meta/0000_snapshot.json` (drizzle-kit generates both)
- Modify: `frontend/package.json` (scripts)

**Interfaces:**
- Produces: a checked-in drizzle migration that, applied to an empty database, is *claimed* to reproduce production. Task 2 tests that claim — do not trust it here.

**Owner:** Claude. Not a Codex fit: the config edit is three lines and the rest is running a generator and reading its output.

- [ ] **Step 1: Rewrite the config for migrations**

Replace `frontend/drizzle.config.ts` with:

```ts
import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

// drizzle-kit owns migrations as of wave 5b-2 (Alembic is retired).
// `schema.ts` is now the authoritative schema — it is hand-maintained, no longer
// introspected. NEVER run `drizzle-kit push` against production: it diffs and
// applies without generating a reviewable migration file.
loadEnv({ path: path.resolve(__dirname, '..', '.env') });

export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/server/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 2: Generate the baseline**

```bash
cd frontend && npx drizzle-kit generate --name baseline
```

Expected: a new `drizzle/0000_baseline.sql` plus `drizzle/meta/`. This runs entirely offline from `schema.ts` — it does **not** read the database.

- [ ] **Step 3: Read the generated SQL in full and check the known-hard cases**

Do not skim this. Confirm by grep that each of these landed:

```bash
cd frontend && grep -n 'uq_enrich_jobs_active_user' drizzle/0000_baseline.sql
cd frontend && grep -n 'where' drizzle/0000_baseline.sql
cd frontend && grep -nE 'CREATE TABLE' drizzle/0000_baseline.sql | wc -l
cd frontend && grep -n 'progress' drizzle/0000_baseline.sql
```

Specifically verify:
- `uq_enrich_jobs_active_user` is a **partial** unique index carrying its `WHERE status in ('pending','running')` clause. A unique index without the predicate would reject every second job a user ever runs.
- `enrich_jobs.progress` and `.total` are `NOT NULL` with **no** default. That exact shape is what broke `POST /enrich/start` in wave 4c-2, and the Node code compensates by passing both explicitly. A `DEFAULT 0` here would be a silent divergence from production.
- The table count matches the number of `pgTable` declarations in `schema.ts`.

- [ ] **Step 4: Add migration scripts**

In `frontend/package.json`, under `scripts`:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:check": "drizzle-kit check"
```

Deliberately **no** `db:push` script. `drizzle-kit push` applies a computed diff directly with no reviewable artifact; making it one keystroke away from a production database is how schemas drift.

- [ ] **Step 5: Gates**

```bash
cd frontend && npm run type-check
cd frontend && npx eslint drizzle.config.ts
cd frontend && npx prettier --check drizzle.config.ts package.json
```

- [ ] **Step 6: Record**

Record the generated filename, the table count, and the three hard-case grep results.

---

### Task 2: Prove the baseline reproduces production, then adopt it

**Files:**
- Possibly modify: `frontend/lib/server/schema.ts` (only to fix real divergences the diff exposes)
- Possibly regenerate: `frontend/drizzle/0000_baseline.sql`

**Interfaces:**
- Consumes: Task 1's baseline.
- Produces: a proven-equivalent baseline, and a production `__drizzle_migrations` table that records it as already applied.

**Owner:** Claude runs the Docker half; Chase supplies the production schema dump and runs the production write in Step 6.

**This is the irreversibility gate for the whole wave.** Nothing after this can be undone by reverting a commit. Do not shortcut it.

- [ ] **Step 1: Get a production schema dump**

Chase runs, from a shell with `DATABASE_URL` pointing at production:

```bash
pg_dump --schema-only --no-owner --no-privileges --no-comments "$DATABASE_URL" > /tmp/prod-schema.sql
```

If 5b-1 Task 3 Step 2's snapshot still exists, take a **fresh** one anyway — the point is to diff against what production is now, not what it was before the migrations.

- [ ] **Step 2: Stand up a throwaway Postgres**

```bash
docker run -d --name mylib-drizzle-baseline \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mylibrary \
  -p 55433:5432 postgres:16
sleep 5
docker exec mylib-drizzle-baseline pg_isready
```

Port 55433 avoids colliding with any local Postgres and with the `mylib-w3b-verify` container from earlier waves.

- [ ] **Step 3: Apply the baseline to the empty database**

```bash
cd frontend && DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55433/mylibrary' npx drizzle-kit migrate
```

Expected: the baseline applies cleanly and drizzle creates its own `__drizzle_migrations` bookkeeping table.

- [ ] **Step 4: Dump and diff**

```bash
docker exec mylib-drizzle-baseline pg_dump --schema-only --no-owner --no-privileges --no-comments -U postgres mylibrary > /tmp/drizzle-schema.sql
diff <(sort /tmp/prod-schema.sql) <(sort /tmp/drizzle-schema.sql) | head -100
```

A sorted diff deliberately ignores statement ordering, which differs harmlessly between the two generators. Then look at the unsorted diff for anything structural:

```bash
diff /tmp/prod-schema.sql /tmp/drizzle-schema.sql | head -150
```

**Expected benign differences** — record them, do not chase them: the `alembic_version` table (production only), the `__drizzle_migrations` table (throwaway only), sequence and constraint naming where Alembic and drizzle-kit pick different conventions, and `public.` schema qualification.

**Differences that are real defects, and must be fixed in `schema.ts` and regenerated:** a missing or extra table; a column present on one side only; a nullability mismatch; a differing column type; a missing index, especially a partial one losing its predicate; a missing foreign key. Note that this repo declares at least one foreign key via drizzle's table-level `foreignKey({...})` form rather than `references()`, so grepping for `references(` alone is not proof of absence.

- [ ] **Step 5: Iterate until the diff holds no defects**

For each real defect: fix `schema.ts`, delete the generated `drizzle/` directory, re-run Task 1 Steps 2–3, then repeat Steps 2–4 against a **fresh** container (`docker rm -f mylib-drizzle-baseline` first — an already-migrated database will not re-prove anything).

Record every divergence found and its resolution. This list is the single most valuable artifact of the wave: it is the set of places where the checked-in schema did not match reality.

- [ ] **Step 6: Baseline production — mark the migration as already applied**

Production already has this schema; applying the baseline there would fail on every `CREATE TABLE`. Instead, record it as applied so future `drizzle-kit migrate` runs start from the right place.

Chase runs, against production:

```sql
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
```

Then insert the row matching the generated migration, taking `hash` and `when` from `frontend/drizzle/meta/_journal.json`:

```sql
INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ('<hash from _journal.json>', <when from _journal.json>);
```

Verify the bookkeeping is consistent by running a no-op migrate against production:

```bash
cd frontend && npx drizzle-kit migrate
```

Expected: drizzle reports nothing to apply. **If it tries to apply the baseline, stop immediately** — the hash does not match and applying it would error partway through, leaving production in an unknown state.

- [ ] **Step 7: Tear down and record**

```bash
docker rm -f mylib-drizzle-baseline
```

Record: the full divergence list from Step 5, the hash inserted in Step 6, and confirmation that the no-op migrate is clean. **Wave 5b-2 is now past its point of no return** — say so explicitly in the ledger.

---

### Task 3: Delete the backend switcher

**Files:**
- Delete: `frontend/lib/backend.ts`
- Delete: `frontend/lib/__tests__/backend.test.ts`
- Modify: `frontend/lib/api.ts`
- Modify: `frontend/components/admin/SystemTab.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is independent of the schema work.
- Produces: a frontend that talks only to same-origin `/api`, with `NEXT_PUBLIC_API_URL` no longer read anywhere.

**Owner:** Codex-dispatchable. This is the one genuinely mechanical task in the wave — roughly 13 call-site rewrites of an identical shape, plus one component section removal.

- [ ] **Step 1: Write the failing test first**

The switcher's own test file is being deleted, so the replacement assertion belongs with the API client. Add to `frontend/lib/__tests__/api.test.ts` (create it if absent — this is a **jest** file, since `lib/__tests__` is outside vitest's `lib/server/**` and `app/api/**` scope):

```ts
import fs from 'node:fs';
import path from 'node:path';

describe('api client base URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api.ts'), 'utf8');

  it('never imports the deleted backend switcher', () => {
    expect(src).not.toMatch(/from '@\/lib\/backend'/);
    expect(src).not.toMatch(/baseFor|pythonBase/);
  });

  it('never reads NEXT_PUBLIC_API_URL', () => {
    expect(src).not.toMatch(/NEXT_PUBLIC_API_URL/);
  });

  it('routes every request to the same-origin /api base', () => {
    const fetches = src.match(/fetch\(`[^`]+`/g) ?? [];
    expect(fetches.length).toBeGreaterThan(5);
    for (const f of fetches) {
      expect(f).toMatch(/fetch\(`\$\{API_BASE\}/);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx jest lib/__tests__/api.test.ts
```

Expected: FAIL — `api.ts` still imports `baseFor`. **Confirm this command matches tests at all.** `lib/__tests__` belongs to jest; running it under vitest matches zero tests and exits 0, which reads as a pass. If jest reports "0 tests found", stop and fix the invocation before continuing.

- [ ] **Step 3: Rewrite `lib/api.ts`**

Replace the import with a constant:

```ts
/** Every route is served by Next.js route handlers at same-origin /api. */
const API_BASE = '/api';
```

Then rewrite each call site by dropping the `baseFor(...)` call and keeping the path:

```ts
// before
const res = await fetch(`${baseFor(path, 'GET')}${path}`, {
// after
const res = await fetch(`${API_BASE}${path}`, {
```

```ts
// before
const res = await fetch(`${baseFor('/import/preview', 'POST')}/import/preview`, {
// after
const res = await fetch(`${API_BASE}/import/preview`, {
```

Apply the same transformation to every remaining site: `/import`, `/feedback/dismiss`, `/export?format=${format}`, `/admin/me`, and the five generic verb helpers. Also update the file's header comment — it currently says "Typed fetch client for the MyLibrary FastAPI backend," which stops being true here.

- [ ] **Step 4: Strip the backend chooser from `SystemTab.tsx`, keeping debug mode**

Remove the `CHOICES` array, the `choice` state, `pickBackend`, the radio group, and the "Backends" heading and its description. Remove `getBackendChoice`, `setBackendChoice`, `pythonBase`, `BackendChoice`, and `pingBackend` from the `@/lib/backend` import, then delete the now-empty import entirely.

**Keep the debug-mode toggle.** It is backed by `/admin/config` and `DEBUG_MODE_KEY`, is unrelated to the migration, and stays.

If the Node health indicator is worth keeping, inline it rather than importing from the deleted module:

```ts
const ok = await fetch('/api/healthz').then((r) => r.ok).catch(() => false);
```

- [ ] **Step 5: Delete the switcher and its test**

```bash
cd frontend && rm lib/backend.ts lib/__tests__/backend.test.ts
```

- [ ] **Step 6: Prove nothing still references it**

```bash
cd frontend && grep -rn "lib/backend\|baseFor\|pythonBase\|BackendChoice\|NEXT_PUBLIC_API_URL\|mylibrary.backend" app components lib --include=*.ts --include=*.tsx
```

Expected: no output.

- [ ] **Step 7: Gates**

```bash
cd frontend && npx jest lib/__tests__/api.test.ts
cd frontend && npx jest
cd frontend && npm run type-check
cd frontend && npx eslint lib/api.ts components/admin/SystemTab.tsx
cd frontend && npx prettier --check lib/api.ts components/admin/SystemTab.tsx
```

Expected: the new api test passes; **jest drops from 41 to a lower count** because `backend.test.ts` is deleted — the removed tests are the `baseFor` routing cases and the `NODE_DEFAULT_ROUTES` snapshot assertion, replaced by the three new cases above. Record the exact number; state the change by test name, never by count alone.

- [ ] **Step 8: Verify in the running app, not just in tests**

```bash
cd frontend && npm run dev
```

Load the app, open DevTools Network, and confirm every XHR targets same-origin `/api/...`. Then open `/admin` and confirm the System tab still renders with the debug-mode toggle working and no backend chooser.

---

### Task 4: Remove `NEXT_PUBLIC_API_URL` from configuration

**Files:**
- Modify: `.env.example`
- Modify: `docs/hosting.md`

**Interfaces:**
- Consumes: Task 3's proof that no code reads the variable.
- Produces: configuration that no longer references the Python backend.

**Owner:** Claude for the repo files; Chase for the Vercel dashboard. **Not Codex-dispatchable** — Global Constraint 3 forbids handing Codex any task whose text concerns environment configuration.

- [ ] **Step 1: Confirm again that nothing reads it**

```bash
grep -rn "NEXT_PUBLIC_API_URL" --include=*.ts --include=*.tsx --include=*.md --include=*.json . | grep -v node_modules
```

Expected: only documentation hits remain after Task 3.

- [ ] **Step 2: Remove it from `.env.example` and document the removal in `docs/hosting.md`**

In `hosting.md`, do not simply delete the row — replace it with a line recording that the variable was retired in wave 5b-2 when the Python backend was removed. A reader finding it set in an old Vercel project needs to know it is inert, not wonder what broke.

- [ ] **Step 3: Chase — remove the variable from Vercel**

Delete `NEXT_PUBLIC_API_URL` from Production, Preview, and Development scopes. Because it is `NEXT_PUBLIC_`, it is inlined at **build** time, so the removal only takes effect on the next deployment — which is fine, since Task 3 already removed every read.

- [ ] **Step 4: Gates**

```bash
cd frontend && npm run build
```

A full build is warranted here specifically because `NEXT_PUBLIC_` variables are build-time inlined; `type-check` alone would not catch a stale reference in a client component.

---

### Task 5: Delete the Python HTTP layer, the test suite, and the recorders

**Files:**
- Delete: `mylibrary/api.py`, `mylibrary/worker.py`, `mylibrary/auth.py`, `mylibrary/admin.py`, `mylibrary/schemas.py`, and the rest of `mylibrary/`
- Delete: `tests/` (entire directory)
- Delete: `alembic/`, `alembic.ini`
- Delete: `scripts/gen_parity_fixtures.py`, `scripts/gen_claude_fixtures.py`, `scripts/gen_catalog_fixtures.py`, `scripts/gen_crypto_fixture.py`, `scripts/dump_schema_contract.py`
- Delete: `requirements.txt`, and any `pytest.ini` / `setup.cfg` / `pyproject.toml` pytest configuration
- Modify: `frontend/lib/server/__tests__/schema-contract.test.ts` (retire)

**Interfaces:**
- Consumes: Task 2's proven drizzle baseline — this is the task that task existed to unblock.
- Produces: a repo with no Python.

**Owner:** Claude. Not a Codex fit: the judgement is about *what may safely go*, and Codex cannot run the pytest suite to observe consequences.

- [ ] **Step 1: Confirm production is not serving Python**

Before deleting anything, re-confirm 5b-1 Task 6 Step 4's finding:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$RAILWAY_HOST/health"
```

and check Railway's request logs for the last 7 days. Expected: effectively zero application traffic. **A live request rate means something still calls Python** — find it before deleting.

- [ ] **Step 2: Retire the schema-contract test**

`schema-contract.test.ts` compares `schema.ts` against a contract dumped from the SQLAlchemy models. Once those models are gone, `schema.ts` *is* the authority and the test compares the schema to itself — tautological, and worse, misleading, because it would still look like verification.

Delete `frontend/lib/server/__tests__/schema-contract.test.ts` and its fixture. In its place, add a comment at the top of `frontend/lib/server/schema.ts`:

```ts
/**
 * AUTHORITATIVE SCHEMA. As of wave 5b-2, drizzle-kit owns migrations and this
 * file is the single source of truth — it is hand-maintained, no longer
 * introspected, and no longer cross-checked against SQLAlchemy models.
 *
 * The guarantee the deleted schema-contract test used to provide is now
 * structural: `npm run db:generate` diffs this file against the migration
 * history, so a change here that is never migrated shows up as an
 * uncommitted migration. Run `npm run db:check` in CI to catch that.
 *
 * The specific trap it caught, worth remembering: drizzle's `$inferInsert`
 * leaves a `notNull()` column without `.default()` OPTIONAL, so `tsc` cannot
 * catch a missing required value. `enrich_jobs.progress`/`total` are exactly
 * that shape and must always be passed explicitly.
 */
```

- [ ] **Step 3: Freeze the fixtures with a README**

The recorders die with `mylibrary/`, so the parity fixtures become permanent historical artifacts. That is correct — after this wave there is nothing to be at parity *with*, and the tests become regression baselines. But a future reader will find generator-shaped JSON with no generator.

Create `frontend/lib/server/__tests__/fixtures/README.md`:

```markdown
# Frozen fixtures

These fixtures were recorded from the Python FastAPI backend, which was deleted
in wave 5b-2 (2026-08). **They can no longer be regenerated** — the recorders
(`scripts/gen_parity_fixtures.py`, `gen_claude_fixtures.py`,
`gen_catalog_fixtures.py`, `gen_crypto_fixture.py`) went with it.

What that changes:

- These are now **regression baselines**, not parity tests. They prove the Node
  backend still behaves as it did at cutover — not that it matches Python.
- A deliberate behavior change means **hand-editing the fixture** and saying so
  in the commit message. There is no re-record path.
- Anything not covered by a fixture today will never be covered by one.

To recover a recorder, retrieve it from git history:

    git log --all --oneline -- scripts/gen_parity_fixtures.py
    git show <sha>:scripts/gen_parity_fixtures.py

It will not run without `mylibrary/`, which the same history retains.
```

- [ ] **Step 4: Delete**

```bash
git rm -r mylibrary tests alembic scripts/gen_parity_fixtures.py \
  scripts/gen_claude_fixtures.py scripts/gen_catalog_fixtures.py \
  scripts/gen_crypto_fixture.py scripts/dump_schema_contract.py \
  alembic.ini requirements.txt
```

Then check for leftovers:

```bash
find . -name '*.py' -not -path './node_modules/*' -not -path './.venv/*' -not -path './.claude/*'
ls scripts/
```

Expected: no `.py` files outside `.claude/hooks/` and `.venv/`. `scripts/` should retain only `benchmark.mjs`.

- [ ] **Step 5: Check for orphaned configuration**

```bash
grep -rn "mylibrary\|alembic\|pytest\|requirements.txt" --include=*.json --include=*.toml --include=*.cfg --include=*.yml --include=*.yaml . | grep -v node_modules
```

Anything found — CI workflows, a `pyproject.toml`, editor config — needs cleaning too. Record each.

- [ ] **Step 6: Gates**

```bash
cd frontend && npx vitest run 2>&1 | tail -5
cd frontend && npx jest 2>&1 | tail -5
cd frontend && npm run type-check
cd frontend && npx eslint .
```

Expected: **vitest drops by the schema-contract test's case count** — name it as `schema-contract.test.ts`, and record the exact before/after. Every parity test must still pass: they replay recorded JSON and never imported Python. **If any parity test fails here, it was reaching into the Python tree** — that is a real finding, not a cleanup nuisance.

`pytest` is no longer runnable and that is the expected end state, not a failure.

- [ ] **Step 7: Verify the app still runs**

```bash
cd frontend && npm run dev
```

Load the library, the profile, and `/admin`. Run one recommendation. A green suite does not prove a deletion was safe.

---

### Task 6: Update the stop hook and developer tooling

**Files:**
- Modify: `.claude/hooks/on_stop.py`
- Modify: `.claude/hooks/pre_bash.py` (only if it references Python paths)
- Modify: `frontend/package.json` if a CI script references pytest

**Interfaces:**
- Consumes: Task 5's deletion.
- Produces: tooling that does not reference a language the repo no longer contains.

**Owner:** Codex-dispatchable, with the caveat below.

**Codex caveat:** `.claude/hooks/pre_bash.py` is the guard that blocks reading `.env` values. Codex is not covered by it, and a brief that asks Codex to *edit* it is a brief about secret-handling machinery. Dispatch Codex for `on_stop.py` only; Claude edits `pre_bash.py` if it needs touching.

- [ ] **Step 1: Establish what the hook currently gates**

```bash
grep -nE 'pytest|ruff|\.py' .claude/hooks/on_stop.py
```

The hook runs `ruff check` on changed `.py` files and `pytest -q` when any tracked `.py` changed. With no `.py` files left, both are inert — but they are dead code that reads as active configuration, and the venv-interpreter lookup may error rather than skip.

- [ ] **Step 2: Remove the ruff and pytest blocks**

Delete both sections and their guards, and update the module docstring's list of gates. Keep the tsc, eslint, and prettier blocks unchanged.

- [ ] **Step 3: Verify the hook still runs cleanly**

```bash
python3 .claude/hooks/on_stop.py < /dev/null
echo "exit: $?"
```

Expected: clean exit, no traceback. The hook must tolerate being invoked with no changed files.

Then make a trivial frontend edit and confirm the hook still fires its tsc/eslint/prettier gates on a real turn — an inert hook and a working hook look identical when there is nothing to check.

- [ ] **Step 4: Record**

Note that the repo no longer has a Python gate, and that `.venv/` can be deleted locally at Chase's discretion (it is not tracked).

---

### Task 7: Rewrite the documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`, `docs/hosting.md`, `docs/conventions.md`
- Modify: `README.md` if present

**Interfaces:**
- Produces: documentation describing the system as it is, not as it was mid-migration.

**Owner:** Claude. **Not Codex-dispatchable** — this is judgement about which hard-won invariants survive, and getting it wrong quietly discards the reason a piece of code looks strange.

- [ ] **Step 1: Rewrite CLAUDE.md's "What this is" and "Current state"**

The current text is a wave-by-wave migration narrative. That was the right shape while migrating and is the wrong shape now. Replace it with a description of the system as it stands: a Next.js app with route handlers backed by Supabase Postgres, drizzle-owned schema, no Python.

**Preserve every invariant whose reason is not visible in the code.** These are the expensive ones — each cost a wave to learn:

- The `pyRound` / `pyRepr` / `pyFloatStr` / `pyJsonDumps` / `pyJsonDumpsIndented` primitives in `serialize.ts` and why they exist. They now look like gratuitous CPython emulation with no CPython in sight; without the note, someone "simplifies" `pyRound` into `Math.round(x * 100) / 100` and silently changes `/stats`, `/settings/usage`, and `/profile/highlights`.
- Ordered mappings bound for a prompt must be a `Map`, because V8 reorders integer-like object keys.
- Wave 5a's transaction-boundary rules: `backfillFromSupabase` transactional, `createInvite` and `revokeUser` not, and why harmonizing them is a bug. Keep the note that the hand-written purge-failure test is the only thing catching a `revokeUser` regression and must never become a `runScenario` call.
- `supabaseAdmin.ts` uses `||` not `??`, and sends the key on `apikey` only.
- The enrichment quirks: any nonempty ISBN result is HIGH with no verification; the `0.60` weak threshold is inert; scores are never compared across catalogs; a resolved upsert is replacement, not fill-blanks.
- `MAX_IMPORT_BYTES` has no Python counterpart and must not be removed for parity. `relax_quotes: true` in `PY_DICT_READER_OPTIONS` is what makes a real Goodreads export parse at all.
- The `exact: true` flag on the `/enrich` route rule, and the enrich-job invariants: progress derived by recounting rather than accumulating, chunks bounded by time not count, one active job per user.
- Discovery's oddities: an empty metadata pool, a stated language constraint replacing library languages, and the standing directive deliberately not steering it.

Reframe each from "this matches Python" to "this is the behavior, and here is why it looks odd" — the justification changes even though the rule does not.

- [ ] **Step 2: Replace the Commands section**

Every `python -m mylibrary.cli ...` command is gone. Document what replaces each, or state plainly that it has no replacement:

| Retired command | Status after 5b-2 |
| --- | --- |
| `ingest`, `add`, `rate`, `review`, `directive`, `remove-book` | Available in the web UI |
| `enrich`, `profile`, `recommend`, `reprofile`, `recs`, `traits`, `stats`, `profile-status` | Available in the web UI |
| `clear-profile`, `clear-library`, `delete-account` | Available in the web UI as the three purge routes |
| `serve` | Replaced by `cd frontend && npm run dev` |
| `backfill-descriptions --all-users` | **No replacement.** Record this explicitly — it was an ops repair tool with no UI equivalent. If it is ever needed again, it is hand-written SQL or a one-off script. |

- [ ] **Step 3: Update the Claude/Codex split section**

The gates listed there include pytest and ruff, which no longer exist. Update the standing-rules description and the note that "Codex cannot run the pytest suite at all" — still true, now vacuously.

- [ ] **Step 4: Update `docs/architecture.md` and `docs/hosting.md`**

`architecture.md` lists Python pipeline modules (`ingest`, `catalog`, `enrich`, `profile`, `library`, `purge`, `archetype`, `recommend`, `directive`, `stats`, `worker`). Map each to its Node counterpart under `frontend/lib/server/`, and note the ones with no counterpart.

`hosting.md` needs: Railway removed, Alembic replaced with the drizzle-kit workflow from Task 1, and the environment-variable list trimmed to what Node actually reads.

- [ ] **Step 5: Add the migration workflow to `docs/conventions.md`**

Document the new schema-change loop, since it is entirely new muscle memory:

1. Edit `frontend/lib/server/schema.ts`.
2. `npm run db:generate` — review the generated SQL by hand, every time.
3. Commit the migration file with the schema change, never separately.
4. `npm run db:migrate` against production during a release window.
5. Never `drizzle-kit push`.

- [ ] **Step 6: Verify the docs against the tree**

For every command and file path in the rewritten docs, confirm it exists. Stale docs after a deletion wave are the default outcome, not the exception.

---

### Task 8: Tear down Railway (Chase-owned)

**Files:** none.

**Interfaces:**
- Consumes: everything above. This is the last irreversible external step.

**Owner:** Chase.

- [ ] **Step 1: Confirm zero traffic one last time**

Railway request logs for the preceding 7 days. Expected: nothing.

- [ ] **Step 2: Capture anything only Railway holds**

Before deleting: export any logs worth keeping, and record the service's environment-variable NAMES (not values) into the ledger. If any variable exists only on Railway and nowhere in `.env.example` or Vercel, that is a configuration fact about to be lost.

- [ ] **Step 3: Stop before deleting**

Pause or stop the service rather than deleting it, and leave it stopped for a week. A stopped service costs nothing and is instantly restartable; a deleted one is a rebuild. There is no deadline pressure here.

- [ ] **Step 4: Delete the service and its database if it has one**

After the stopped week with no consequence. Confirm the Supabase database is untouched — Railway hosted the API, not the data.

- [ ] **Step 5: Close the wave**

Record in the ledger: Railway state, the date Python was deleted, and the final gate counts. Then update `CLAUDE.md`'s current-state line to say the migration is complete, with no wave numbering left in the present tense.

---

## Self-Review

**Spec coverage.** Schema handover (Tasks 1–2), frontend scaffolding (Tasks 3–4), Python deletion (Task 5), tooling (Task 6), documentation (Task 7), infrastructure (Task 8). Chase's decision to delete all of `mylibrary/` including the CLI is honored, with the one casualty — `backfill-descriptions --all-users` — named explicitly in Task 7 Step 2 rather than quietly dropped.

**Ordering audit.** Every deletion is preceded by a proof: Task 5 cannot run before Task 2 proves the drizzle baseline; Task 4 cannot run before Task 3 proves no code reads the variable; Task 8 cannot run before Task 5 confirms zero traffic. Task 2 Step 7 marks the point of no return explicitly so no one crosses it unaware.

**Type consistency.** `API_BASE` is introduced in Task 3 Step 3 and asserted in Task 3 Step 1's test under the same name. The npm scripts `db:generate` / `db:migrate` / `db:check` are defined in Task 1 Step 4 and referenced with those exact names in Task 5 Step 2 and Task 7 Step 5.

**Known risk not eliminated.** Task 2's diff-based proof is only as good as the reviewer's ability to tell a benign naming difference from a real structural one. The mitigation is Step 5's requirement to record every divergence and its resolution — a list a second reader can audit, rather than a private judgement.
