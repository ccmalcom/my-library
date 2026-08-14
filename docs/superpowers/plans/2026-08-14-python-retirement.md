# Python Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Python backend, its tooling, and the migration-era parity apparatus, leaving a single Next.js application.

**Architecture:** Deletion in dependency order. Assets that surviving tests depend on move out of the Python tree first (Task 1), then the Python-comparison tests go (Task 2), then the Python tree itself (Task 3). The backend switcher is stripped independently (Task 4). Tooling and docs are repaired last (Tasks 5–6). Task 7 is verification and is run by the controller, never delegated.

**Tech Stack:** Next.js 16 (App Router), TypeScript, drizzle-kit + Postgres, vitest (`lib/server/**`, `app/api/**`) and jest (everything else), Vercel.

**Spec:** `docs/superpowers/specs/2026-08-14-python-retirement-design.md`

## Global Constraints

1. **Do not run `git commit`.** Chase commits by hand. Leave the tree dirty and describe what changed. This overrides the commit steps that the plan template would normally include.
2. **Never name `.env` in a Codex prompt or command.** Codex runs outside `.claude/hooks/pre_bash.py`, so the local guard does not protect it. `.env.example` is fine and is the source for variable names.
3. **Record divergences, do not revert them.** If the implementation is better than what this plan describes, keep the code and write a comment explaining the deviation.
4. **State expected-red by test name, never by count.**
5. **Cite symbols, not line ranges.** Use `grep -n '<exact code>'`. Line numbers in this plan are hints to the right region, not assertions to check literally.
6. **Always `GIT_PAGER=cat`** (or `git --no-pager`); a paged git command hangs the Codex shell.
7. **Never name `npm run test:server` in a Codex prompt.** It runs ~165s against a ~10-minute budget that must also cover Codex's own exploration. Name the specific vitest file instead.
8. `vitest.config.ts` pins `include` to `lib/server/**` and `app/api/**`. A vitest command aimed anywhere else **matches zero tests and exits 0**, reading as a pass. Verify a test command matches tests before trusting it.
9. All paths below are relative to the repo root unless prefixed `frontend/`.

---

## File Structure

| File | Responsibility after this work |
|---|---|
| `frontend/lib/api.ts` | The only module that talks to the backend; hardcodes `/api` |
| `frontend/lib/backend.ts` | **Deleted** — the switcher no longer exists |
| `frontend/components/admin/SystemTab.tsx` | Debug-mode toggle and Node health only |
| `frontend/lib/server/__tests__/helpers/testEnv.ts` | Renamed from `parity.ts`; exports `setupTestEnv` only |
| `frontend/lib/server/__tests__/fixtures/seed.json` | Database seed data for 10 behavior tests |
| `frontend/lib/server/__tests__/fixtures/sample_goodreads.csv` | Real-shaped Goodreads export for CSV quoting tests |
| `.claude/hooks/on_stop.py` | JS/TS gates only; no ruff, no pytest |

---

## Task 1: Relocate assets out of the Python tree

Two files live under `tests/` or a misleadingly named fixture path but are consumed by tests that survive. They must move **before** Task 3 deletes the Python tree.

**Files:**
- Move: `tests/sample_goodreads.csv` → `frontend/lib/server/__tests__/fixtures/sample_goodreads.csv`
- Move: `frontend/lib/server/__tests__/fixtures/parity/seed.json` → `frontend/lib/server/__tests__/fixtures/seed.json`
- Modify: `frontend/lib/server/__tests__/import-csv-quotes.test.ts`
- Modify: every file importing `fixtures/parity/seed.json` (10 survivors + several files Task 2 deletes)

**Interfaces:**
- Produces: `fixtures/seed.json` at its new path; `fixtures/sample_goodreads.csv` at its new path. Task 2 relies on both existing.

- [ ] **Step 1: Move the CSV and repoint its only reader**

`import-csv-quotes.test.ts` currently reads the file by climbing out of `frontend/`:

```ts
const text = readFileSync(join(process.cwd(), '..', 'tests', 'sample_goodreads.csv'), 'utf8');
```

Replace with a path relative to the test file, so nothing depends on the working directory:

```ts
const text = readFileSync(join(__dirname, 'fixtures', 'sample_goodreads.csv'), 'utf8');
```

If `__dirname` is unavailable under this vitest/ESM config, use `new URL('./fixtures/sample_goodreads.csv', import.meta.url)` instead. Do not reintroduce a `process.cwd()`-relative path.

- [ ] **Step 2: Verify that test still passes**

```bash
cd frontend && npx vitest run lib/server/__tests__/import-csv-quotes.test.ts
```

Expected: PASS. If it reports "No test files found", the path is wrong — see Global Constraint 8.

- [ ] **Step 3: Move `seed.json` up one level and repoint every importer**

```bash
git mv frontend/lib/server/__tests__/fixtures/parity/seed.json \
       frontend/lib/server/__tests__/fixtures/seed.json
```

Then rewrite every `from './fixtures/parity/seed.json'` to `from './fixtures/seed.json'`. Find them with:

```bash
grep -rln "fixtures/parity/seed.json" frontend/lib frontend/app
```

Repoint **all** of them, including files Task 2 will later delete — leaving a broken import behind makes Task 2's gates unreadable.

- [ ] **Step 4: Confirm nothing still references the old path**

```bash
grep -rn "fixtures/parity/seed.json" frontend/lib frontend/app ; echo "exit=$?"
```

Expected: no matches (`exit=1`).

- [ ] **Step 5: Run the affected suites**

```bash
cd frontend && npx vitest run lib/server/__tests__/recommend-route.test.ts lib/server/__tests__/discover-route.test.ts lib/server/__tests__/similar-route.test.ts
```

Expected: PASS.

**DO-NOTs for this task:**
- Do not delete `fixtures/parity/` yet — `python-responses.json` and `write-scenarios.json` still live there and are Task 2's job.
- Do not touch any other fixture.
- Do not reformat files you are only repointing an import in.

---

## Task 2: Delete the Python-comparison tests, fixtures, and helpers

**Files:**
- Delete: 27 test files under `frontend/lib/server/__tests__/` (listed below)
- Delete: `fixtures/parity/python-responses.json`, `fixtures/parity/write-scenarios.json`, `fixtures/catalog/expected.json`, `fixtures/catalog/enrichment-expected.json`, `fixtures/schema-contract.json`
- Delete: `frontend/lib/server/__tests__/helpers/write-parity.ts`
- Rename: `helpers/parity.ts` → `helpers/testEnv.ts`, dropping `checkParity`
- Modify: `frontend/lib/server/__tests__/recommend-run.test.ts`

**Interfaces:**
- Consumes: `fixtures/seed.json` at its Task 1 path.
- Produces: `helpers/testEnv.ts` exporting `setupTestEnv(): void` (same body as the current `setupParityEnv`). Every surviving test imports this name.

- [ ] **Step 1: Delete the 27 replay test files**

All under `frontend/lib/server/__tests__/`, each with a `.test.ts` suffix:

```
catalog-search              parity-directive             parity-writes-books
enrichment-parity           parity-discover-prompts      parity-writes-directive
parity-admin-lists          parity-import-export         parity-writes-feedback
parity-admin-reads          parity-profile               parity-writes-recs
parity-archetype            parity-profile-computed      parity-writes-settings
parity-books                parity-prompts               parity-writes-traits
parity-claude-flows         parity-recommend-prompts     schema-contract
parity-recommendations      parity-settings              write-parity-masking
parity-similar-prompts      parity-stats                 parity-writes-admin
```

- [ ] **Step 2: Delete the five obsolete fixtures and the write-parity helper**

```bash
cd frontend/lib/server/__tests__
rm fixtures/parity/python-responses.json fixtures/parity/write-scenarios.json
rm fixtures/catalog/expected.json fixtures/catalog/enrichment-expected.json
rm fixtures/schema-contract.json
rm helpers/write-parity.ts
rmdir fixtures/parity   # must now be empty; if it is not, stop and report what remains
```

- [ ] **Step 3: Rename the parity helper and drop `checkParity`**

`git mv helpers/parity.ts helpers/testEnv.ts`. In the renamed file, delete the `checkParity` export entirely and rename `setupParityEnv` to `setupTestEnv`. Keep the function body byte-for-byte — it sets the environment every server test depends on.

Then repoint every importer:

```bash
grep -rln "helpers/parity" frontend/lib frontend/app
```

Each becomes `import { setupTestEnv } from './helpers/testEnv';` with the call site renamed to match.

- [ ] **Step 4: Reframe `recommend-run.test.ts` as a snapshot test**

This file is **kept**. It imports `fixtures/claude/prompts.json` and asserts the Node-built prompt matches it. That assertion is the mechanism proving the whole retrieval pipeline — pool order, dedup, language/series/fuzzy filters, author caps, cap ordering — so it stays.

Change only the framing, not the assertion. Rename any identifier or describe/it text containing "parity" or "Python" to snapshot language, and add this comment above the `prompts.json` import:

```ts
// Snapshot of the prompt as recorded at the Python cutover (2026-08-14). This is
// no longer a cross-backend parity check — it is a regression guard proving the
// deterministic retrieval pipeline still assembles an identical prompt. The
// recorder (scripts/gen_claude_fixtures.py) is gone, so if the prompt changes
// legitimately, update this fixture BY HAND and say why in the commit.
```

- [ ] **Step 5: Verify the surviving suites**

```bash
cd frontend && npx vitest run lib/server/__tests__/recommend-run.test.ts lib/server/__tests__/discover-run.test.ts lib/server/__tests__/similar-run.test.ts lib/server/__tests__/ratelimit-routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Gates**

```bash
cd frontend && npm run type-check && npx eslint lib/server/__tests__
```

Expected: both clean. A `tsc` error naming a deleted fixture means an importer was missed in Step 3.

**DO-NOTs for this task:**
- **Do not delete these 12 files.** They are behavior tests, not parity replays, and are the only coverage for `/recommend`, `/discover`, `POST /books/{id}/similar`, `POST /profile`, `/profile/update` and the per-route rate limits:
  `catalog-ranking`, `discover-route`, `discover-run`, `profile-build`, `profile-update`, `ratelimit-routes`, `rec-book-signal`, `recommend-route`, `recommend-run`, `rec-signal`, `similar-route`, `similar-run`.
- **Do not delete `fixtures/claude/recommend-http.json`, `fixtures/catalog/http.json`, `fixtures/crypto.json`, or `fixtures/claude/responses.json`.** These record third-party HTTP and crypto vectors, not Python behavior, and surviving tests replay them.
- **Do not delete `helpers/pglite.ts`** (47 importers), `helpers/fakeClaude.ts`, or `helpers/httpReplay.ts`.
- Do not "simplify" `__tests__/enrich-job-insert.test.ts` into a source-text grep. Its `@ts-expect-error` assertion is the guard that `progress`/`total` stay required on `NewJobValues`.
- Do not touch `lib/server/serialize.ts`. `pyRound`, `pyRepr`, `pyFloatStr` and `pyJsonDumps` define the current wire format; changing them changes live API responses.

---

## Task 3: Delete the Python tree and root tooling

**Files:**
- Delete: `mylibrary/`, `tests/`, `alembic/`, `alembic.ini`, `scripts/*.py`
- Delete: `requirements.txt`, `pytest.ini`, `ruff.toml`, `Dockerfile`, `.dockerignore`, `start.sh`, `railway.json`

**Interfaces:**
- Consumes: Tasks 1 and 2 complete. Nothing under `frontend/` may reference `tests/`, `mylibrary/`, or `scripts/*.py`.

- [ ] **Step 1: Prove nothing under `frontend/` reaches into the Python tree**

```bash
grep -rn "'\.\.', 'tests'\|\.\./\.\./tests\|mylibrary" frontend/lib frontend/app frontend/components frontend/hooks --include=*.ts --include=*.tsx | grep -v node_modules
```

Expected: no matches. If any appear, fix them before deleting anything — this is the failure mode Task 1 exists to prevent.

- [ ] **Step 2: Delete the trees and tooling files**

```bash
git rm -r --quiet mylibrary tests alembic
git rm --quiet alembic.ini requirements.txt pytest.ini ruff.toml Dockerfile .dockerignore start.sh railway.json
git rm --quiet scripts/*.py
```

`scripts/benchmark.mjs` is **not** Python and stays. If `scripts/` is empty afterwards other than that file, leave the directory.

- [ ] **Step 3: Remove Python caches from the working tree**

```bash
rm -rf .pytest_cache .ruff_cache scripts/__pycache__
```

These are untracked; deleting them is housekeeping, not a source change.

- [ ] **Step 4: Confirm the only remaining tracked `.py` files are the hooks**

```bash
git ls-files '*.py'
```

Expected: exactly the three files under `.claude/hooks/`.

- [ ] **Step 5: Gates**

```bash
cd frontend && npm run type-check && npx vitest run lib/server/__tests__/import-csv-quotes.test.ts
```

Expected: clean, and that test passes — it is the canary for Task 1's CSV move.

**DO-NOTs for this task:**
- Do not delete `frontend/drizzle/` or any `.sql` file. drizzle owns migrations now; Alembic's `0000_baseline.sql` counterpart already exists there.
- Do not delete `.claude/`, `.codex/`, `.superpowers/`, `.agents/`, or `docs/superpowers/`.
- Do not delete `data/` in this task — see Task 5.
- Do not touch `frontend/scripts/`.

---

## Task 4: Strip the backend switcher

Independent of Tasks 1–3; can run in parallel.

**Files:**
- Delete: `frontend/lib/backend.ts`, `frontend/lib/__tests__/backend.test.ts`
- Modify: `frontend/lib/api.ts`, `frontend/components/admin/SystemTab.tsx`

**Interfaces:**
- Produces: no exported symbol. Every consumer of `baseFor`/`pythonBase`/`getBackendChoice`/`setBackendChoice`/`BackendChoice`/`NODE_DEFAULT_ROUTES`/`NODE_ONLY_PREFIXES` must be rewritten in this task.

- [ ] **Step 1: Replace `baseFor` in `lib/api.ts` with a constant**

`lib/api.ts` calls `baseFor(path, METHOD)` in ten places — inside the five generic helpers (`get`, `post`, `patch`, `put`, `del`) and five direct call sites (`/import/preview`, `/import`, `/feedback/dismiss`, `/export`, `/admin/me`). All of them now resolve to the same value. Add near the top:

```ts
/** Every route is served same-origin by Next route handlers under /api. */
const API_BASE = '/api';
```

and replace each `${baseFor(...)}` interpolation with `${API_BASE}`. Remove the `import { baseFor } from '@/lib/backend';` line.

- [ ] **Step 2: Delete the switcher module and its test**

```bash
git rm frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts
```

- [ ] **Step 3: Strip the backend UI from `SystemTab.tsx`**

Remove the `CHOICES` array, the `choice` state and its lazy initializer, `pickBackend`, the entire "Backends" selector card, and the `getBackendChoice`/`setBackendChoice`/`pythonBase`/`BackendChoice` import.

The health effect currently pings both backends:

```ts
useEffect(() => {
  void pingBackend(pythonBase(), '/healthz').then((ok) =>
    setHealth((h) => ({ ...h, python: ok }))
  );
  void pingBackend('', '/api/healthz').then((ok) => setHealth((h) => ({ ...h, node: ok })));
}, []);
```

Reduce it to the Node ping only, and narrow the `health` state from `{ python, node }` to a single `boolean | null`. Keep `pingBackend`, `healthBadge`, the debug-mode toggle and the rest of the tab intact.

- [ ] **Step 4: Confirm no references survive**

```bash
grep -rn "baseFor\|pythonBase\|NEXT_PUBLIC_API_URL\|getBackendChoice\|setBackendChoice\|NODE_DEFAULT_ROUTES\|NODE_ONLY_PREFIXES\|mylibrary.backend" frontend/lib frontend/app frontend/components frontend/hooks | grep -v node_modules
```

Expected: no matches. One comment in `lib/server/catalog.ts` mentions `helpers/httpReplay.ts` — that helper survives, so leave the comment alone.

- [ ] **Step 5: Gates**

```bash
cd frontend && npm run type-check && npx eslint lib/api.ts components/admin/SystemTab.tsx && npx jest components/
```

Expected: clean. Expected-red: any jest test asserting the backend selector renders — report it by name rather than deleting it silently.

**DO-NOTs for this task:**
- Do not remove `app/api/healthz/route.ts`. It is the Node health probe the System tab still uses.
- Do not remove `/admin/config` handling — it is a real route, and it simply no longer needs a special prefix rule.
- Do not change any request path. Only the base changes; `/books`, `/stats` etc. stay exactly as they are.

---

## Task 5: Repair tooling and `.env.example`

**Files:**
- Modify: `.claude/hooks/on_stop.py`
- Modify: `.env.example`
- Decide: `data/`

- [ ] **Step 1: Remove the ruff and pytest gates from the stop hook**

`on_stop.py` runs both when tracked `.py` files change. After Task 3 the only tracked `.py` files are the three hooks themselves — and **`pytest -q` with zero tests collected exits 5**, which the hook would surface as `[pytest FAILED]` on any hook edit.

Delete the `# --- ruff on changed .py ---` block and the `# --- pytest on changed .py ---` block in full. Then remove whatever becomes unused: the `py` list comprehension, `venv_python`, and the `vp` binding, if nothing else references them. Keep the type-check, eslint, prettier and docs-drift blocks untouched.

- [ ] **Step 2: Verify the hook still parses and runs**

```bash
python3 -c "import ast,pathlib; ast.parse(pathlib.Path('.claude/hooks/on_stop.py').read_text()); print('parses')"
python3 .claude/hooks/on_stop.py < /dev/null; echo "exit=$?"
```

Expected: `parses`, and a clean exit. A non-zero exit on empty input means a removed binding is still referenced.

- [ ] **Step 3: Prune `.env.example`**

Remove `NEXT_PUBLIC_API_URL`, `CORS_ORIGINS`, `MYLIBRARY_DATA_DIR`, and any `MYLIBRARY_*` variable with no reader under `frontend/`. Confirm each removal first:

```bash
grep -rn "MYLIBRARY_" frontend/lib frontend/app | grep -v node_modules
```

Keep every variable that grep proves is still read — `MYLIBRARY_MODEL`, `MYLIBRARY_REQ_PER_SEC`, `MYLIBRARY_MONTHLY_SOFT_CAP_USD` and `MYLIBRARY_USAGE_WARN_THRESHOLD` are read by the Node config module. Names only; never read or write a value.

- [ ] **Step 4: Decide `data/`**

```bash
git ls-files data/
grep -rn "data/" frontend/lib frontend/app frontend/scripts | grep -v node_modules
```

If nothing under `frontend/` reads it, delete the directory and say so. If anything does, keep it and note what.

**DO-NOTs for this task:**
- Do not remove `.env.example` itself — it is the documented source of variable names.
- Do not read, print, or copy any value from a real environment file.
- Do not remove the docs-drift reminder block from the hook.

---

## Task 6: Documentation

**Files:**
- Rewrite: `CLAUDE.md`
- Rewrite: `docs/architecture.md`
- Modify: `docs/hosting.md`, `docs/frontend.md`, `docs/conventions.md`, `README.md`, `.github/copilot-instructions.md`, `todo.md`

- [ ] **Step 1: Rewrite `CLAUDE.md` in the present tense**

Drop all wave numbering, all Python/parity narrative, and the Claude/Codex split's Python-specific rules (the pytest-sandbox note is now moot). Reduce the Commands section to the frontend gates. Describe the system as it is: a Next.js app on Vercel, Supabase auth, Postgres via drizzle.

**These invariants must survive the rewrite.** They are load-bearing and independently verified:

- Half-star rules: the 0.5 grid, `numeric(2,1)` with `mode: 'number'`, `rating.ts` staying dependency-free, `0` as sentinel, permissive Zod plus a manual `isValidRating` guard, whole ratings serializing as integers.
- `serialize.ts`'s `pyRound`/`pyRepr`/`pyFloatStr`/`pyJsonDumps`. Reframe the *why* — these now define the wire format rather than matching Python — but keep every rule, including `Map` for ordered prompt mappings.
- The `maxDuration = 300` literal on `enrich/start` and `enrich/tick`, and why an imported binding breaks `next build`.
- Enrichment job rules: atomic conditional lease, `CHUNK_BUDGET_MS`, `after()` dispatching only a job ID, progress derived by recounting, explicit `progress: 0, total: 0`, the `NewJobValues` tsc guard.
- Admin rules: per-function transaction boundaries, `apikey`-only header, `||` not `??` in `supabaseAdmin.ts`, `admin_me` ungated.
- The proxy matcher excluding `api`, and why a 307 hid it for four waves.
- The two-runner split (`npm test` is jest, `npm run test:server` is vitest) and that `npm run build` is a required gate.
- `drizzle-kit generate` never reading the database.

- [ ] **Step 2: Rewrite `docs/architecture.md`**

Currently a Python module map (`ingest`, `catalog`, `enrich`, `profile`, `library`, `purge`, `archetype`, `recommend`, `directive`, `stats`, `worker`). Replace with the Node equivalents under `frontend/lib/server/`. The locked decisions — Goodreads is import-once, the recommender is two-stage, enrichment is the foundation, taste profile is metadata-driven — are product decisions and carry over unchanged.

- [ ] **Step 3: Update the remaining docs**

| File | Change |
|---|---|
| `docs/hosting.md` | Railway and Alembic become history, not live systems. **Keep** the "Railway's environment, recorded at retirement" table and the `FEEDBACK_PROMPTS_ENABLED` open question. Keep the drizzle workflow, the Vercel cron notes (`frontend/vercel.json`, production-only), and the enrichment-continuation caveat. |
| `docs/frontend.md` | Remove switcher and `NEXT_PUBLIC_API_URL` references. **Keep** the invite/`redirect_to`/`FRONTEND_URL` section — still accurate and still load-bearing. |
| `docs/conventions.md` | Remove Python/CLI gotchas; keep TSX parser quirks, git rules, data invariants, recommender, profile, SWR cache. |
| `README.md` | Remove Python install/run instructions. |
| `.github/copilot-instructions.md` | Reframe "Railway vars" as Vercel env + Supabase dashboard. Keep the "not every bug is a code bug" point. |
| `todo.md` | Tick the completed items. **Keep** the pre-Railway-delete capture list — `FEEDBACK_PROMPTS_ENABLED` and the 7-day traffic log both die with the service. |

- [ ] **Step 4: Confirm no stale references remain**

```bash
grep -rln "Railway\|alembic\|pytest\|mylibrary\.cli\|NEXT_PUBLIC_API_URL" CLAUDE.md README.md docs/*.md .github/copilot-instructions.md todo.md
```

Every remaining hit must be deliberate history (the `docs/superpowers/` archive is excluded from this check entirely and must not be edited). List them and say why each stays.

**DO-NOTs for this task:**
- Do not edit anything under `docs/superpowers/`. It is a historical record.
- Do not drop an invariant because its Python rationale is gone — reframe the *why*, keep the *rule*.
- Do not invent behavior. If a doc claim cannot be verified against source, delete it rather than restate it.

---

## Task 7: Verification (controller only — do not delegate)

- [ ] **Step 1: Full gates**

```bash
cd frontend
npm run test:server
npm test
npm run type-check
npx eslint .
npx prettier --check .
npm run build
```

All six must pass. `npm run build` is non-negotiable — it is the only gate that catches Next segment-config and prerender errors, and wave 5b-1 found eight consecutive red Vercel previews sitting behind five green gates.

- [ ] **Step 2: Mutation-test the load-bearing guards**

Break each deliberately, confirm red, revert:

- Delete `progress: 0` from the `createOrGetActiveJob` call site → `npm run type-check` must fail naming `progress` and `total`.
- Change `maxDuration = 300` on `app/api/enrich/start/route.ts` to an imported binding → `enrich-max-duration.test.ts` must fail.

If either stays green, the guard is documentation rather than engineering — say so.

- [ ] **Step 3: Preview deploy**

Push the branch and confirm the Vercel preview builds green before merging.

- [ ] **Step 4: Confirm the drizzle baseline against production**

Read-only, against `information_schema.columns`: verify `enrich_jobs.progress`/`total` are `NOT NULL DEFAULT 0` and that the nine `0002_align_nullability` columns are `NOT NULL`. Never verify shape against `schema.ts` — introspection has falsified two of its comments before.

- [ ] **Step 5: Post-merge browser verification**

On `shelfsprite.app`, not a preview: load the library, run a recommendation, open `/admin` and confirm the System tab renders without the backend selector. Never claim this works from tests alone.

- [ ] **Step 6: Report**

Summarize what changed, what was deleted, which gates passed, and restate the two facts still to capture from Railway before Chase deletes it.

---

## Self-Review

**Spec coverage.** §3.1 → Task 3. §3.2 → Task 4. §4.1 → Task 1. §4.2/4.5 → Task 2. §4.4 → Task 2 Step 4. §5 → Task 5. §6 → Task 6. §8 → Task 7. §2's out-of-scope items appear only as Task 7 Step 6 reminders. No spec section is unimplemented.

**Placeholders.** One deliberate open decision remains — `data/` in Task 5 Step 4 — and it is written as a decision procedure with a command and both branches, not a TBD.

**Type consistency.** `setupParityEnv` → `setupTestEnv` is renamed in Task 2 Step 3 and referenced by that name in the File Structure table and nowhere earlier. `API_BASE` is introduced in Task 4 Step 1 and used only there. `NewJobValues`, `createOrGetActiveJob` and `enrich-max-duration.test.ts` are referenced in Tasks 2, 6 and 7 with consistent spelling.
