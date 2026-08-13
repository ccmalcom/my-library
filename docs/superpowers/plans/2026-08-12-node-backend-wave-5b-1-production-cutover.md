# Wave 5b-1: Production Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Node backend to production — merge 123 commits to `main`, apply migrations 0018/0019, deploy, and verify every route family serves from Node in production, with Python still running as a rollback.

**Architecture:** This wave changes almost no application code. It is a release-engineering wave: reconcile the branch with `main`, apply additive database migrations while Python is still the only live backend, verify on a Vercel preview deployment, then promote. Python stays deployed and untouched throughout — it is the rollback, and deleting it is wave 5b-2's job.

**Tech Stack:** Vercel (Next.js, Root Directory `frontend`), Supabase Postgres, Alembic, Railway (FastAPI, still live), drizzle-orm/postgres-js.

## Global Constraints

1. **Python stays deployed and reachable for the whole of this wave.** Nothing in `mylibrary/`, `alembic/`, `tests/`, or `scripts/` is deleted or modified except by the `main` merge in Task 1. Deletion is wave 5b-2.
2. **Migrations are applied BEFORE Node is deployed, not after.** Both 0018 and 0019 are additive and idempotent: `0018_node_wave0_tables` creates `catalog_cache`, `app_config`, and `rate_limits` behind existence checks; `0019_add_enrich_job_leases` adds four **nullable** columns to `enrich_jobs` plus the partial index `uq_enrich_jobs_active_user`, each guarded by an `sa.inspect()` check. Python does not read any of them, so a migrated database still serves Python correctly. This ordering is what makes the migration step independently reversible.
3. **The primary rollback is a Vercel instant rollback to the previous production deployment**, not the backend switcher. The switcher's `python` override lives in `localStorage` (`mylibrary.backend`, see `frontend/lib/backend.ts`) and is therefore **per-browser** — it can mitigate for one signed-in admin, but it cannot un-break the app for other users. Do not treat it as a kill switch.
4. **No Codex dispatch in this wave may name a `.env` file, read a secret value, or be asked to inspect environment configuration.** Codex runs outside `.claude/hooks/pre_bash.py`, so the local guard does not protect that side. Every env-var and deploy-credential step in this plan is Chase-owned by design. Where a variable must be discussed, use its NAME only.
5. **Test runner scoping.** `vitest` owns `frontend/lib/server/**` and `frontend/app/api/**`; `jest` owns everything else under `frontend/` via `testPathIgnorePatterns` on those two directories; `pytest` owns Python. A command pointed at the wrong runner matches zero tests, exits 0, and reads as a pass. Verify the runner before naming any test command in a dispatch.
6. **Chase commits by hand.** No task in this plan runs `git commit`. Tasks end by reporting what is staged and why.
7. **Cite symbols, not line ranges,** in any proof-of-fix check: `grep -n '<exact code>'`, never `sed -n 'N,Mp'`. Line numbers in this document's Verified Facts are hints to the right region, not assertions to check literally.

## Verified Facts (established 2026-08-12 while authoring)

| Fact | Evidence |
| --- | --- |
| Branch `feat/node-backend` is 123 commits ahead of `main`; `main` is 1 commit ahead of the branch | `git log --oneline main..feat/node-backend \| wc -l` → 123; reverse → 1 |
| That one commit is `4714235 fix(profile): skip non-book tier entries when building valid_ids`, touching `mylibrary/profile.py` and `tests/test_profile_feedback.py` | `git show 4714235 --stat` |
| The Node port already has the equivalent guard, so no bug was inherited | `frontend/lib/server/profileBuild.ts` — `if (typeof b.id === 'number') validIds.add(b.id);` |
| Node has a route handler for every Python route except `GET /health`; `/healthz` exists on both | 49 `route.ts` files under `frontend/app/api/` vs 56 decorated routes in `mylibrary/api.py` |
| Every Python route except `/health` and `/healthz` is in `NODE_DEFAULT_ROUTES` | `frontend/lib/backend.ts` |
| `NODE_ONLY_PREFIXES` is exactly `['/admin/config']` (the debug-mode toggle), and it is checked BEFORE the `python` override, so forcing Python does not break it | `frontend/lib/backend.ts::baseFor` |
| The cron config lives at `frontend/vercel.json` (Root Directory is `frontend`; a repo-root `vercel.json` is silently ignored) and registers `/api/enrich/janitor` on `17 3 * * *` | `frontend/vercel.json` |
| The Node DB client is already serverless-shaped for Supabase's transaction pooler | `frontend/lib/server/db.ts` — `postgres(url, { prepare: false, max: 1 })` |
| Env var NAMES the Node server reads | `ADMIN_EMAILS`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, `DATABASE_URL`, `ENCRYPTION_KEY`, `FEEDBACK_PROMPTS_ENABLED`, `FEEDBACK_SNOOZE_HOURS`, `FRONTEND_URL`, `GOOGLE_BOOKS_API_KEY`, `MYLIBRARY_MODEL`, `MYLIBRARY_MONTHLY_SOFT_CAP_USD`, `MYLIBRARY_REQ_PER_SEC`, `MYLIBRARY_USAGE_WARN_THRESHOLD`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_URL`, `TZ` |
| `supabaseAdmin.ts` needs `SUPABASE_URL` **or** `NEXT_PUBLIC_SUPABASE_URL` (fallback added in wave 5a), and `SUPABASE_SECRET_KEY` | wave 5a Verification Record |

**Explicitly NOT verified — confirm in Task 2, do not assume:** that Vercel's production branch is `main`; that the Vercel project has Fluid compute enabled; that the max function duration is ≥300s (`FUNCTION_CEILING_SECONDS` assumes it); that preview deployments receive env vars pointing at the production database; the current Alembic revision in production.

## Execution Batching

Per `chase-workflow:controller-budget`, **hand off after each batch — do not start the next batch in the same session.** Each batch is 2–3 tasks (~20 turns/task). The `.superpowers/sdd/` ledger is the state of record; update it after every task, not at the end of a batch.

| Batch | Tasks | Owner shape |
| --- | --- | --- |
| A | 0, 1 | Claude (git + gates) |
| B | 2, 3 | Chase (deploy config + production migration) |
| C | 4, 5 | Claude drives browser; Chase promotes |
| D | 6, 7 | Claude verifies; Chase owns soak |

No task in this wave is a good Codex fit — see the note before Task 0.

---

## A note on Codex in this wave

Per `chase-workflow:codex-dispatch`, Codex is worth dispatching when a brief can be written so faithfully that literal execution produces correct work. This wave fails that test on nearly every task: the work is a git merge requiring conflict judgement, deploy-console configuration behind credentials, an irreversible production migration, and browser verification of a live app. There is no file-blind brief for "confirm Fluid compute is on."

**Dispatch Codex in this wave only if Task 1's merge produces a non-trivial conflict in `frontend/`,** and then only with the conflicting hunks pasted into the brief. Wave 5b-2 is where Codex earns its keep.

---

### Task 0: Establish the baseline

**Files:**
- Create: `.superpowers/sdd/2026-08-12-node-backend-wave-5b-1-production-cutover/progress.md`
- Read only: everything else

**Interfaces:**
- Produces: a recorded green-gate baseline (test counts by runner) that Tasks 1–7 compare against, and the production Alembic revision that Task 3 gates on.

**Owner:** Claude, except Step 4 which is Chase's.

- [ ] **Step 1: Create the ledger and record the starting commit**

```bash
mkdir -p .superpowers/sdd/2026-08-12-node-backend-wave-5b-1-production-cutover
git --no-pager log --oneline -1
git --no-pager status --short
```

Expected: HEAD is `e29d9a0 wave 5a work` (or later), working tree clean. If the tree is dirty, STOP and report — this wave assumes a clean baseline.

- [ ] **Step 2: Run every gate and record exact counts**

```bash
cd frontend && npx vitest run 2>&1 | tail -5
cd frontend && npx jest 2>&1 | tail -5
cd frontend && npm run type-check
cd frontend && npx eslint .
python -m pytest -q 2>&1 | tail -3
```

Expected from wave 5a's close: vitest 77 files / 551 tests, jest 41 tests, tsc clean, eslint clean, pytest 360 passed. **Record what you actually observe, not what this plan predicts** — if any number differs, that is a finding to write down before proceeding, not a discrepancy to reconcile silently.

- [ ] **Step 3: Confirm the Python-vs-Node route coverage claim still holds**

```bash
grep -cE '^@app\.(get|post|put|patch|delete)' mylibrary/api.py
cd frontend && find app/api -name route.ts | wc -l
```

Then confirm the only uncovered Python route is `GET /health`:

```bash
grep -n 'app.get("/health")' mylibrary/api.py
cd frontend && ls app/api/healthz/route.ts
```

Expected: `/health` exists in Python with no Node sibling; `/healthz` exists on both. Nothing in the frontend calls either — `health()` was deleted from `lib/api.ts` in wave 5a. Verify that:

```bash
cd frontend && grep -rn 'api\.health\|\.health()' app components lib | grep -v node_modules
```

Expected: no output.

- [ ] **Step 4: Chase — record the production Alembic revision**

This is Chase's to run; Claude's permissions classifier denies direct production database reads, and the Supabase MCP has previously seen only an unrelated inactive project.

From a shell with `DATABASE_URL` pointing at the production Supabase database:

```bash
alembic current
```

Or, equivalently, via the Supabase SQL editor:

```sql
SELECT version_num FROM alembic_version;
```

Record the exact value in the ledger. Expected `0017_user_directive` if neither Node migration has been applied. **Any value other than 0017, 0018, or 0019 means production diverged from this repo's history — STOP and reconcile before Task 3.**

- [ ] **Step 5: Write the baseline into the ledger**

Record: HEAD commit, the five gate results with exact counts, route-coverage confirmation, and the production revision from Step 4. Note explicitly that Task 3 is blocked until Step 4 has a recorded answer.

---

### Task 1: Merge `main` into the branch

**Files:**
- Modify: `mylibrary/profile.py` (via merge)
- Modify: `tests/test_profile_feedback.py` (via merge)
- Possibly modify: any file `main` touched that the branch also touched (expected: none)

**Interfaces:**
- Consumes: Task 0's green baseline.
- Produces: a branch containing every commit on `main`, so the eventual merge to `main` is a fast-forward with no surprise reverts.

**Owner:** Claude.

**Why this task exists:** `main` carries one commit the branch has never seen — `4714235`, a fix for an uncaught 500 in `POST /profile` where a rejected recommendation with a user note lands in `tiers['rejected']` as `{title, author, note}` with no `id` key, raising `KeyError` in a set comprehension. Merging to `main` without first merging `main` in risks silently reverting it.

- [ ] **Step 1: Confirm the Node port did not inherit the bug**

Before merging, establish that this is a Python-only fix:

```bash
cd frontend && grep -n "typeof b.id === 'number'" lib/server/profileBuild.ts
```

Expected: one hit, inside the `validIds` construction. This is the TypeScript equivalent of Python's `if "id" in b` guard. **If this grep returns nothing, STOP** — the Node port has the same defect and needs its own fix plus a test before this wave continues. Record the outcome either way.

- [ ] **Step 2: Merge**

```bash
git --no-pager log --oneline feat/node-backend..main
git merge main --no-edit
```

Expected: a clean merge. The branch has not touched `mylibrary/profile.py`'s `extract_taste_profile` (waves 0–5a only added to `frontend/`, `scripts/`, `alembic/versions/`, and docs).

**If there IS a conflict:** do not resolve it by preference. Both sides are live code — Python still serves production until 5b-2. Resolve by taking `main`'s fix and re-applying the branch's change on top, then re-run the full pytest suite. This is the one point in the wave where a Codex dispatch is appropriate; paste the conflicting hunks into the brief and name `python -m pytest -q tests/test_profile_feedback.py` as the gate.

- [ ] **Step 3: Verify the fix survived the merge**

```bash
grep -n 'if "id" in b' mylibrary/profile.py
grep -n 'def test_extract_taste_profile_survives_rejected_rec_with_note' tests/test_profile_feedback.py
```

Expected: one hit each. Both must be present.

- [ ] **Step 4: Re-run the gates**

```bash
python -m pytest -q 2>&1 | tail -3
cd frontend && npx vitest run 2>&1 | tail -5
cd frontend && npx jest 2>&1 | tail -5
cd frontend && npm run type-check
```

Expected: **pytest goes from 360 to 361** — the one new test is `test_extract_taste_profile_survives_rejected_rec_with_note`, named here so a changed count is recognized rather than investigated. vitest, jest, and tsc are unchanged from Task 0's baseline; the merge touches no frontend file.

- [ ] **Step 5: Report for commit**

Report the merge commit and the pytest delta. Chase commits.

---

### Task 2: Deployment readiness audit (Chase-owned)

**Files:** none — this task produces recorded answers, not code.

**Interfaces:**
- Produces: confirmation or refutation of the five unverified assumptions listed under Verified Facts. Task 4 and Task 5 are blocked until each has an answer.

**Owner:** Chase. Claude's role is to ask precisely and record the answers; Claude must not attempt to read deploy credentials or environment values.

- [ ] **Step 1: Confirm the Vercel project's production branch and root directory**

In the Vercel dashboard, or:

```bash
vercel project ls
vercel inspect <production-deployment-url>
```

Record: (a) which git branch triggers production deployments — this plan assumes `main`; (b) that Root Directory is `frontend`. The Root Directory claim is already load-bearing: `frontend/vercel.json` is only read because of it.

- [ ] **Step 2: Confirm Fluid compute and max function duration**

`FUNCTION_CEILING_SECONDS = 300` in the enrichment chunking code is an *assumption* about the platform, and `CHUNK_BUDGET_MS = 240_000` reserves headroom under it. If the real ceiling is lower, enrichment chunks will be killed mid-run.

Record: Fluid compute on/off, and the configured max duration for functions. **If the ceiling is below 300s, do not proceed to Task 5** — open a follow-up to lower `CHUNK_BUDGET_MS` and `FUNCTION_CEILING_SECONDS` to match, with headroom preserved.

- [ ] **Step 3: Confirm every required environment variable is set in Vercel, for both Production and Preview**

Check presence only — never print values. The names, from the Verified Facts table:

Required for the backend to function at all: `DATABASE_URL`, `ENCRYPTION_KEY`, `SUPABASE_SECRET_KEY`, and `SUPABASE_URL` **or** `NEXT_PUBLIC_SUPABASE_URL`.

Required for specific features: `CRON_SECRET` (janitor + tick auth — without it those routes reject every call), `ANTHROPIC_API_KEY` (fallback when a user has no personal key), `GOOGLE_BOOKS_API_KEY` (catalog; without it Google Books 429s off the shared anonymous quota), `ADMIN_EMAILS` (admin gating), `FRONTEND_URL` (governs whether invite `redirect_to` is sent at all).

Optional with defaults: `FEEDBACK_PROMPTS_ENABLED`, `FEEDBACK_SNOOZE_HOURS`, `MYLIBRARY_MODEL`, `MYLIBRARY_MONTHLY_SOFT_CAP_USD`, `MYLIBRARY_REQ_PER_SEC`, `MYLIBRARY_USAGE_WARN_THRESHOLD`, `TZ`, `SUPABASE_JWKS_URL`.

`NEXT_PUBLIC_API_URL` must remain set and pointing at Railway for the whole of 5b-1 — it is what the switcher's `python` override and any un-flipped path resolve to.

**Two specific traps, both already paid for once:**
- `SUPABASE_SECRET_KEY` must be the new-style opaque `sb_secret_*` key. Node sends it on `apikey` ONLY. A legacy JWT `service_role` key also works with apikey-only, but do not set both.
- If only `NEXT_PUBLIC_SUPABASE_URL` is set, that is now fine (wave 5a added the fallback), but confirm the deployed code contains it: `grep -n 'NEXT_PUBLIC_SUPABASE_URL' frontend/lib/server/supabaseAdmin.ts`.

- [ ] **Step 4: Confirm what environment Preview deployments point at**

Record whether Preview `DATABASE_URL` points at the production database or a separate one. **This determines how Task 4 is run.** If Preview points at production, Task 4's verification writes real data to real rows and must be limited to Chase's own account.

- [ ] **Step 5: Record the Railway state**

Record the Railway service name, its current deploy, and how to reach it directly (the value of `NEXT_PUBLIC_API_URL`'s host, not any secret). Wave 5b-2 tears this down; until then it must stay running. Confirm it is not on a plan that will sleep or evict it during the soak.

- [ ] **Step 6: Write all answers into the ledger**

Every item above gets an explicit recorded answer, including "not applicable" where that is the truth. Task 3 proceeds only when Steps 1–5 all have answers.

---

### Task 3: Apply migrations 0018 and 0019 to production (Chase-owned)

**Files:** none in the repo — this task changes the production database.

**Interfaces:**
- Consumes: Task 0 Step 4's recorded production revision; Task 2's confirmations.
- Produces: a production database at revision `0019_add_enrich_job_leases`, still serving Python correctly.

**Owner:** Chase runs the commands. Claude drafts them and verifies the result via Chase's reported output.

**Why now, before any Node deploy:** both migrations are additive and Python reads none of the new tables or columns, so a migrated database serves the *current* production (Python) unchanged. That makes this step independently verifiable and independently reversible, instead of entangled with the deploy.

- [ ] **Step 1: Check out the branch — the migration files exist only there**

```bash
git --no-pager branch --show-current
ls alembic/versions/0018_node_wave0_tables.py alembic/versions/0019_add_enrich_job_leases.py
```

Expected: `feat/node-backend`, and both files present. **`main` does not contain these files**, so running `alembic upgrade` from a `main` checkout will not find them.

- [ ] **Step 2: Take a schema snapshot first**

```bash
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" > /tmp/prod-schema-before-0018.sql
```

Keep this file. Wave 5b-2's drizzle baseline is proven against a dump like this one, and it is the only cheap way to answer "what changed?" if something looks wrong later.

- [ ] **Step 3: Review what will run**

```bash
alembic current
alembic history --verbose 2>&1 | head -20
alembic upgrade --sql 0017_user_directive:0019_add_enrich_job_leases 2>&1 | head -60
```

The `--sql` form prints the SQL without executing it. Expected content: three `CREATE TABLE` statements (`catalog_cache`, `app_config`, `rate_limits`), four `ALTER TABLE enrich_jobs ADD COLUMN` statements (`lease_expires_at`, `attempts`, `force`, `run_limit`), and one `CREATE UNIQUE INDEX uq_enrich_jobs_active_user`. **No statement should contain `NOT NULL` without a `DEFAULT`, and none should DROP anything.** If one does, STOP.

Note: both migrations guard their work behind `sa.inspect()` existence checks at runtime, so they are safe to re-run. The `--sql` offline render cannot evaluate those guards and will show the full statement set regardless of what already exists — that is expected, not a warning sign.

- [ ] **Step 4: Apply**

```bash
alembic upgrade head
alembic current
```

Expected: `alembic current` reports `0019_add_enrich_job_leases (head)`.

- [ ] **Step 5: Verify the schema landed as intended**

```sql
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'enrich_jobs'
  AND column_name IN ('lease_expires_at','attempts','force','run_limit','progress','total')
ORDER BY column_name;

SELECT indexname FROM pg_indexes WHERE tablename = 'enrich_jobs';

SELECT table_name FROM information_schema.tables
WHERE table_name IN ('catalog_cache','app_config','rate_limits');
```

Expected: the four new columns all `is_nullable = YES`; `uq_enrich_jobs_active_user` present; all three tables present.

Pay attention to `progress` and `total` in that first result: they must be `NOT NULL` with **no** server default. That is the exact shape that broke `POST /enrich/start` during wave 4c-2's live verification, and the Node code now supplies both values explicitly. If they show a default, the production schema diverges from what the Node code and the schema-contract test expect — record it and stop.

- [ ] **Step 6: Confirm Python is still healthy**

This is the point of migrating first. Hit the live Railway backend:

```bash
curl -sS "$RAILWAY_HOST/health"
```

Then, in the production app (still served by the pre-merge frontend on Python), load the library, open a book, and load the profile. Expected: unchanged behavior.

**Rollback, if Python breaks:** `alembic downgrade 0017_user_directive`. This drops the three new tables and the four new columns. It is safe *only* while no Node deploy has written to them — which is why this task precedes Task 5.

- [ ] **Step 7: Record in the ledger**

Record the before/after revision, the Step 5 query results, and confirmation that Python still serves. Note the location of the schema snapshot from Step 2.

---

### Task 4: Verify on a preview deployment

**Files:** none.

**Interfaces:**
- Consumes: Task 3's migrated database; Task 2 Step 4's answer about which database Preview points at.
- Produces: a route-family pass/fail matrix recorded in the ledger, gathered from a real Vercel deployment rather than a local dev server.

**Owner:** Claude drives the browser; Chase signs in and supplies no credentials to Claude.

**Scope control:** if Task 2 Step 4 established that Preview points at the **production** database, every check below runs against Chase's own account only, and the destructive routes (`DELETE /library`, `DELETE /profile`, `DELETE /account`) are **not** exercised — they are covered by parity tests and by wave 4a, and there is no non-destructive way to prove them in production. Record that as a deliberate gap.

- [ ] **Step 1: Push the branch and get the preview URL**

```bash
git push origin feat/node-backend
```

Vercel builds a preview automatically. Record the preview URL. **Confirm the build succeeded before proceeding** — a broken build here is far cheaper than a broken build on `main`:

```bash
vercel inspect <preview-url> 2>&1 | tail -20
```

- [ ] **Step 2: Confirm the app is actually serving from Node**

Sign in, open DevTools Network, and load `/library`. Every XHR should target the preview's own origin under `/api/...`, not the Railway host.

The switcher makes this checkable directly — in the browser console:

```js
localStorage.getItem('mylibrary.backend')  // expect null → 'auto'
```

`auto` plus wave 5a's complete `NODE_DEFAULT_ROUTES` means every route family resolves to `/api`. If any request goes to the Railway host, note which path — that is a routing gap, and the path tells you which `NODE_DEFAULT_ROUTES` rule is missing or mis-scoped.

- [ ] **Step 3: Walk the read routes**

For each, record HTTP status and whether the rendered data is correct — not merely non-empty:

| Surface | Route family | What "correct" means |
| --- | --- | --- |
| `/library` | `GET /books`, `GET /stats` | book count matches the known library size |
| `/profile` | `GET /profile`, `/profile/status`, `/profile/subjects`, `/profile/highlights`, `/profile/archetype` | traits render with evidence; highlights show 4dp figures |
| `/recommendations` | `GET /recommendations`, `/recommendations/rejected` | the latest run's recs appear in rank order |
| `/settings` | `GET /settings/profile`, `/settings/usage`, `/settings/api-key/status` | usage panel shows a plausible spend total |
| `/admin` | `GET /admin/me`, `/admin/users`, `/admin/usage`, `/admin/feedback` | roster renders with `book_count`; both email joins resolve |

- [ ] **Step 4: Walk the write routes that are safe in production**

- Rate a book in-app (`PATCH /books/{id}/feedback`) and confirm it persists across a reload.
- Change a shelf (`PATCH /books/{id}/shelf`).
- Write and then clear custom instructions (`PUT /directive`, `DELETE /directive`).
- Submit feedback (`POST /feedback`).
- `POST /catalog/search` via the add-book flow, then `POST /books` to add one, then `DELETE /books/{id}` to remove it.

- [ ] **Step 5: Exercise one Claude-calling flow end to end**

Run **one** recommendation (`POST /recommend`). This is the single most integration-heavy path in the app: it touches per-user Anthropic key resolution, the catalog layer with its Postgres-backed response cache, the deterministic retrieval core, and the rerank prompt.

Record: HTTP status, wall-clock duration, the number of recommendations returned, and whether `usage_events` gained a row (visible on `/settings`). **Duration matters** — note it against the function ceiling confirmed in Task 2.

- [ ] **Step 6: Exercise background enrichment**

`POST /enrich/start` from the UI, then watch `GET /enrich/status/{job_id}` poll. Confirm: the job progresses, `after()` continuation advances it across chunk boundaries, and it reaches `done`. Then confirm the one-active-job guard by clicking start twice quickly — the second must be rejected rather than creating a second job.

**Crons do not run on preview deployments**, so the janitor cannot be verified here. It is verified in Task 6.

- [ ] **Step 7: Record the matrix**

Every row above gets pass/fail plus a note. Any failure is a blocker for Task 5 — record it, then stop and triage rather than proceeding.

---

### Task 5: Promote to production

**Files:**
- Modify: `main` (via merge)

**Interfaces:**
- Consumes: Task 4's clean matrix.
- Produces: a production deployment serving every route from Node.

**Owner:** Chase promotes; Claude prepares and verifies.

- [ ] **Step 1: Confirm the preconditions are all recorded green**

Re-read the ledger. Every one of these must have a recorded answer, not an assumption: production at revision 0019 (Task 3), Vercel production branch and root directory (Task 2), function ceiling ≥300s (Task 2), all required env vars present in Production scope (Task 2), Task 4's matrix with no failures.

- [ ] **Step 2: Note the current production deployment ID — this is the rollback target**

```bash
vercel ls --prod 2>&1 | head -5
```

Record the currently-live production deployment URL/ID **before** merging. Rolling back means promoting this one again; a rollback plan that requires finding this value under pressure is not a rollback plan.

- [ ] **Step 3: Merge to main**

```bash
git checkout main
git merge feat/node-backend --no-ff
```

Expected: a fast-forward-able merge, since Task 1 already merged `main` into the branch. `--no-ff` keeps the wave legible in history. Chase commits and pushes.

- [ ] **Step 4: Watch the production build**

```bash
vercel ls --prod 2>&1 | head -5
vercel inspect <new-production-url> 2>&1 | tail -20
```

**If the build fails, do not debug it in production** — the previous deployment is still live and serving. Roll forward only after the build is green.

- [ ] **Step 5: Confirm the cron actually registered**

```bash
vercel crons ls
```

Expected: `/api/enrich/janitor` on `17 3 * * *`. Cron jobs register only from **production** deployments, which is why this could not be checked in Task 4. **If nothing is listed, the most likely cause is Root Directory** — `frontend/vercel.json` is read only because Root Directory is `frontend`; a repo-root `vercel.json` is silently ignored.

- [ ] **Step 6: Immediate post-deploy smoke**

Re-run Task 4 Steps 2 and 3 against the production URL — routing origin plus all five read surfaces. This is deliberately narrow: the goal is to detect a catastrophic misconfiguration within minutes, not to re-verify everything.

---

### Task 6: Production verification

**Files:** none.

**Interfaces:**
- Consumes: a live production deployment.
- Produces: the completed verification record for the wave.

**Owner:** Claude drives; Chase signs in.

- [ ] **Step 1: Re-run Task 4's full matrix against production**

All of Steps 3–6, this time on the production URL. The preview run proved the code; this run proves the production *configuration* — different env vars, different scope, real cron.

- [ ] **Step 2: Verify the janitor**

The cron fires at `17 3 * * *`. Rather than waiting, invoke it directly with the shared secret — this is Chase's to run, since it requires `CRON_SECRET`:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" "https://<prod-host>/api/enrich/janitor"
```

Then confirm a call **without** the header returns 401. Both halves matter: the janitor must work, and it must not be publicly invocable.

- [ ] **Step 3: Verify the rate limiters under production conditions**

The Postgres fixed-window limiter is the SlowAPI parity port, and it depends on the `rate_limits` table that migration 0018 created. Confirm it exists and is being written:

```sql
SELECT COUNT(*) FROM rate_limits;
```

Expected: non-zero after Task 6 Step 1's traffic. A zero count means the limiter is not recording, which means it is not limiting.

Then confirm one limit actually fires: call `POST /enrich/start` six times in a minute (`RATE_LIMITS.enrichStart` is 5/60s). Expected: the sixth returns 429.

- [ ] **Step 4: Confirm Python is receiving no traffic**

Check Railway's request logs for the deploy window. Expected: effectively zero application requests — `health()` was removed from `lib/api.ts` in wave 5a, and every route family is in `NODE_DEFAULT_ROUTES`.

**A non-trivial request rate here is a finding, not noise:** it means some path is still resolving to `pythonBase()`, and the log will name it.

- [ ] **Step 5: Write the verification record**

Into both the ledger and this plan file, under `## Verification Record`. Follow wave 5a's shape: what was verified and how, what was NOT verified and why, and any side effects on production data. Be explicit about the destructive routes deliberately left unexercised.

---

### Task 7: Define the soak, and drill the rollback

**Files:**
- Modify: this plan file (append the soak criteria)

**Interfaces:**
- Produces: the go/no-go criteria that gate wave 5b-2. Until these are met, Python does not get deleted.

**Owner:** Chase owns the soak; Claude writes the criteria and runs the drill.

- [ ] **Step 1: Drill the rollback before you need it**

A rollback plan that has never been executed is a hypothesis. With Chase present:

```bash
vercel rollback <previous-production-deployment-from-Task-5-Step-2>
```

Confirm the app returns to serving from Railway, load `/library` to prove it works, then roll forward again. **Record how long the whole cycle took.** That number is what you will want to know at 2am.

Note the one asymmetry: rolling back the frontend does not roll back the database. Production stays at revision 0019. That is safe — Python ignores every column and table 0019 and 0018 added — and it is the reason Task 3 came before Task 5.

- [ ] **Step 2: Write the soak criteria into this file**

Concretely, wave 5b-2 is unblocked when all of the following hold:

- At least **14 days** of production traffic on Node with no rollback.
- Every route family in Task 4's matrix has been exercised by real usage, not just by verification — in particular at least one real `POST /recommend`, one `POST /discover`, one `POST /books/{id}/similar`, one full `POST /profile` rebuild, and one background enrichment run to completion.
- The janitor has fired on its own schedule at least once, verified in Vercel's cron logs rather than by manual invocation.
- At least one **other** invited user has used the app on Node (not just Chase's account) — multi-tenancy is the thing local verification is worst at proving.
- **A genuine large Goodreads export has been imported through `POST /import` on Node.** This has been open since wave 4d and belongs here: `relax_quotes: true` and the `="9780441172719"` Excel-escaped ISBN shape were fixed against `tests/sample_goodreads.csv`, not against a real multi-thousand-row export. It also exercises `MAX_IMPORT_BYTES` (10 MiB/413), which has no Python counterpart and has never met a real file.
- No unexplained 5xx in Vercel's runtime logs for the window.
- Anthropic spend in `usage_events` for the window is consistent with pre-cutover levels — a large jump would indicate retry or duplicate-call behavior the parity tests cannot see.

- [ ] **Step 3: Record the residual risks that the soak cannot retire**

Name them explicitly so wave 5b-2 inherits them rather than rediscovering them:

- The three destructive purge routes are unexercised in production by design.
- `DELETE /account` in particular has never been run against a real Supabase user other than during wave 5a's revoke.
- Parity fixtures freeze permanently once 5b-2 deletes the recorders. Anything not covered by a fixture today will never be covered by one.

- [ ] **Step 4: Close the wave in the ledger**

Mark 5b-1 complete, record the soak start date, and state plainly that wave 5b-2 is blocked until the Step 2 criteria are met.

---

## Self-Review

**Spec coverage.** Merge reconciliation (Task 1), deployment configuration (Task 2), migrations (Task 3), pre-promotion verification (Task 4), promotion (Task 5), production verification (Task 6), rollback and soak (Task 7). The decision that Python stays live throughout is enforced by Global Constraint 1 and by Task 2 Step 5.

**Known gaps, stated rather than hidden.** The three destructive purge routes are not exercised in production. `GET /health` has no Node counterpart and is deliberately not ported — nothing calls it, and Railway's own health check dies with Railway in 5b-2. Preview deployments cannot verify crons.

**Assumption audit.** Five assumptions are marked NOT verified under Verified Facts, and each has a Task 2 step that resolves it. Task 3 and Task 5 both open by re-reading recorded answers rather than trusting that the audit happened.
