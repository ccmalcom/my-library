# Node Backend Wave 4c-2 — Enrichment Jobs Implementation Plan

> **For agentic workers:** REQUIRED EXECUTION PATH: follow the `CLAUDE.md:145-199` Claude / Codex split. Claude owns planning and judgement; send each implementation task verbatim to `/codex:rescue --background <task text>`, review the resulting diff, and let Chase commit and merge by hand. Enable the review gate at the start of execution. Never commit, cherry-pick, merge, push, or deploy from an agent session.

**Goal:** Move the background enrichment job mechanism to Node: DB-enforced idempotent starts, leased and attempt-capped chunks, derived progress, secret-authenticated continuation, poll repair, daily janitor repair, and the two public-route switcher flip, while calling wave 4c-1's existing enrichment core unchanged.

**Architecture:** Keep `enrich_jobs` as the durable queue. A user-authenticated start creates or returns the one active job, claims and runs its first time-bounded chunk inline, then uses Next's `after()` only to dispatch a secret-authenticated tick. Each tick atomically claims an expired-or-unleased row, resolves the owner from that row, runs work to a named time budget at book boundaries, derives progress from persisted enrichment rows, and re-arms only after real progress. Status polling and a once-daily janitor repair expired leases. The partial unique index, lease claim, attempts cap, and no-progress failure are four separate guards.

**Tech Stack:** Next.js 16.2.9 route handlers and `after()` from `next/server`, TypeScript, Drizzle over postgres-js, Alembic/SQLAlchemy schema ownership, Postgres partial indexes and conditional `UPDATE ... RETURNING`, Vitest + PGlite, Jest backend-switcher tests, Vercel cron.

---

## Global Constraints

These apply to **every** task. Read them before starting any task.

1. **Wave 4c-2 is background job machinery only.** Add lease/attempt persistence, the Alembic migration and Drizzle/PGlite sync, `POST /enrich/start`, `GET /enrich/status/{job_id}`, the internal tick, the daily janitor, chunking/chaining/repair, `CRON_SECRET`'s name, `vercel.json`, and the two public switcher rules. Do not re-port `frontend/lib/server/enrichment.ts`; call its exported `enrichLibrary()`.

   > **AMENDMENT, 2026-08-11 (Task 4 execution), approved by Chase.** This constraint originally
   > read "do not re-port **or modify**" `enrichment.ts`. Task 4's Step 1 stop condition fired
   > correctly against it: `enrichLibrary` selects all of a user's books, filters to `work` via
   > `force || existing === null || …`, then takes `work.slice(0, limit)` with no `ORDER BY` and no
   > way to name a book (`frontend/lib/server/enrichment.ts:236-290`). Non-forced chunking is fine —
   > each enriched book gains an enrichment row and leaves `work`. **Forced chunking cannot advance:**
   > `work` is recomputed every tick and always holds every candidate, so `slice(0,1)` re-picks the
   > same first book (enrichment upserts do not move `books` heap tuples). Tick 1 enriches book 1 →
   > progress 1; tick 2 re-enriches book 1 → `progressAfter == progressBefore` → the no-progress
   > guard writes a terminal `STALLED_MESSAGE`. A forced run over more than one book dies on its
   > second tick. The plan was self-contradictory here: Task 4's *mandatory* loop shape
   > (`deps.runOne(db, next.id, options)`) requires a per-book seam that only `enrichment.ts` can
   > provide.
   >
   > **Resolution — one purely additive option on `EnrichLibraryOptions`:**
   >
   > ```ts
   > bookIds?: number[];   // when present, restrict candidates to these book ids
   > ```
   >
   > applied alongside the existing `includeUnrated`/`effectiveRating` candidate filter. When the
   > option is absent, behavior is byte-identical, so wave 4c-1's `enrichment-parity.test.ts` (which
   > calls `enrichLibrary(db, { userId: 'fixture-user' })`) and the shipped `POST /enrich` route are
   > untouched. **No other change to `enrichment.ts` is permitted**, and no schema is added: the
   > four approved columns still stand (Constraint 3). The chunk adapter becomes
   > `enrichLibrary(db, { userId, force, bookIds: [bookId] })`, and `nextUnenrichedBook` owns the
   > force-aware selection — `force` → `enrichment IS NULL OR resolved_at < job.started_at`;
   > non-force → `enrichment IS NULL`. Still add no `ORDER BY`.
   >
   > Rejected alternatives: snapshotting the run's work-list on the job row (truest to Python's
   > compute-`work`-once semantics and would also make `limit` selection deterministic, but costs
   > schema the design explicitly capped); refusing `force: true` on the Node path (a real feature
   > regression); and leaving jobs on Python through cutover.
2. **Explicitly out of scope:** Redis, arq, any queue port, a global cross-user catalog rate coordinator, QStash, admin routes, Python deletion/cutover, and every wave-5 item. The module-level throttle remains an accepted invite-only limitation across different users.
3. **DESIGN BLOCKER — RESOLVED 2026-08-11, no longer blocking.** The draft correctly identified that `POST /enrich/start` accepts `force` and `limit` (`mylibrary/schemas.py:25-29`) which Python carries in-process, while a tick receives only `job_id` — so `force: true` could not resume through the skip-existing core and `limit` could not be reconstructed after the first invocation. **Chase's decision: persist both on the job row.** The approved design now carries an amendment block; read it. Concretely: add `force BOOLEAN NOT NULL DEFAULT false` and `run_limit INTEGER NULL` to `enrich_jobs`, write them at creation, and read them in every tick. The `JobOptions` placeholder used in the sketches below is now backed by those two real columns — keep the type, drop the placeholder framing. The prohibitions still stand: never hide options in `error`, never trust them from the tick caller, never drop them, and add no columns beyond these.
4. **Progress is derived, never accumulated — and it is RELATIVE TO THE RUN.** After every completed book and before deciding terminal/re-arm state, recount from the database. Never use `progress = progress + n`: a mid-chunk crash followed by re-claim would double-count and silently corrupt the number the user watches. The rule (amended 2026-08-11, because the original "count books holding enrichment rows" reads 100% instantly under `force`, when every book already holds a row):
   - `processed_this_run` = books whose enrichment `resolved_at >= job.started_at`
   - `progress` = `processed_this_run` + (`force` ? 0 : books whose enrichment predates the run)
   - remaining work under `run_limit` = `run_limit - processed_this_run`
   - For a non-forced run this collapses back to "every book holding an enrichment row", matching Python's `skipped + i` progress and `skipped + len(work)` total.
   **Add no `ORDER BY`.** Python's book query is unordered (verified), so *which* books a limit selects was never defined; picking arbitrary unenriched books per tick is faithful, and the count is what a limit constrains.
5. **Chunks are bounded by time, never count.** Export `CHUNK_BUDGET_MS = 240_000` beside `FUNCTION_CEILING_SECONDS = 300` and explain that the 240s budget reserves write/response headroom under the assumed 300s ceiling. Pull small batches, check elapsed time, and stop only between books. There is no public or internal “chunk size” tuning knob; slow catalogs yield fewer books in the same budget.
6. **Platform assumptions are not verified facts.** Before deploy Chase must confirm that the live Vercel Hobby project has Fluid compute and supports the assumed ~300s duration, and that Hobby permits the configured approximately once-daily cron. Keep the duration/budget constants together in `enrichmentJobs.ts`; keep the cron expression in the single `vercel.json` schedule entry so either assumption is a one-line adjustment, not a redesign.
7. **All four spam guards are load-bearing:** (a) existing `RATE_LIMITS.enrichStart` is exactly 5 requests per 60 seconds per authenticated user, matching Python; (b) a DB partial unique index on `enrich_jobs(user_id) WHERE status IN ('pending','running')`; (c) an atomic lease claim; (d) attempts cap plus no-progress failure. Re-arm only when progress increased and work remains. Zero progress with work remaining is a real terminal error.
8. **The active-job index is a deliberate Python divergence.** Python inserts unconditionally, so five clicks can create five jobs. Node start is idempotent: return the existing active job with 200, and if insert loses the race, catch only the partial-index unique violation, re-read, and return the winner. A read-then-write check alone is forbidden because it loses the double-click race.
9. **Migration ordering is load-bearing.** The partial index makes Python's unguarded start raise an integrity error while a Node job is active. The migration must be applied in the same release window as the final switcher flip, never earlier. The CLI is unaffected: `cli enrich` calls `enrich_library` directly and never creates an `enrich_jobs` row.
10. **Internal endpoints are secret-authenticated, not user-authenticated.** Tick and janitor compare a bearer credential to `CRON_SECRET`, return 401 on absence/mismatch, and use constant-time comparison after equal-length conversion. Tick accepts only `job_id`; both routes resolve every user ID from DB rows. Never accept or trust caller-supplied `user_id`.
11. **Use `after()`, never `waitUntil`.** The exact import is `import { after } from 'next/server';`. Route handlers receive plain `(Request, ctx)`, not `NextFetchEvent`; `@vercel/functions` is absent and must not be added. `after()` time counts toward the invoking function, which is acceptable because its callback only dispatches a fetch; it must never run a chunk. The chunk runs in the tick's separate invocation with its own budget.
12. **Exceptions do not immediately destroy resumability.** A catalog/chunk exception leaves completed enrichment rows durable and the lease available for expiry/reclaim, except explicit guard failures (attempt overflow, no progress, stale age) which write terminal `error`, capped to 2,000 characters, and `finished_at`.
13. **`started_at` retains Python meaning.** Set it once when the job first starts; never use it as heartbeat. Lease expiration is the heartbeat/claim field. A running job older than `STALE_JOB_SECONDS = 1_800` fails with Python's interruption message on status read and janitor pass.
14. **Concurrency tests state only what they prove.** PGlite is one instance wrapped once and production has one postgres-js connection per module instance. In-process tests cannot prove true simultaneous transactions. Test the partial-index violation sequentially and conditional claim result/no-result. Postgres guarantees single-statement atomicity. A true race test belongs in a separate human-run real-Postgres integration path; do not add that path in this wave or label a sequential test a race.
15. **Complete runnable tests only.** Every test has setup, invocation, real schema fields/fixtures, cleanup, and whole-object equality so supersets fail. Never leave a `describe` block with comments, TODOs, partial assertions, `any`, invented types, or an expected failure count.
16. **Expected RED is named.** Every red gate lists failing test names, never counts.
17. **Search before implementing any helper.** Run `rg -n '<concept>' frontend/lib/server` first. Reuse existing auth, errors, serialization, rate limiting, DB, enrichment, and timestamp conventions. A second port of a Python helper is worse than none; if the existing helper is wrong, stop and report it.
18. **Executor command boundary is hard.** Codex cannot run `npm install`, any pytest command because `tests/conftest.py` imports FastAPI `TestClient`, any fixture recorder, or an Alembic migration against a real database. Those are Chase/Claude steps with exact commands. No executor step may imply it ran one. No dependency is needed for this wave.
19. **Never read or print `.env` values.** Add only `CRON_SECRET=` to `.env.example`. Chase supplies the value. Verify presence with `test -n "${CRON_SECRET+x}"`; never `cat`, `grep`, `env`, `printenv`, or shell expansion that emits the value.
20. **Every task owns all gates.** List its focused `npx vitest run <files>`, `npm run type-check`, `npx eslint <touched files>`, and `npx prettier --write <touched files>`. The final switcher task also runs its Jest file. Prettier only explicit touched files.
21. **Tasks target approximately ten executor minutes.** Split a task before implementation if it cannot fit. If a named symbol is absent, locate it with `rg`; if genuinely absent, report it instead of inventing or skipping it.
22. **Chase owns repository operations and deploy.** No task commits, cherry-picks, merges, pushes, deploys, or runs destructive git. Use `git --no-pager` or `GIT_PAGER=cat`; paged git hangs the shell.
23. **Proofs follow symbols.** Use `grep -n '<exact code>'`, never `sed -n 'N,Mp'`, for proof-of-fix checks. Inspect current files before editing because author-time line numbers drift.
24. **The switcher flip is the final implementation task.** Wave 4c-1 already routes exact `POST /enrich` to Node and asserts `/enrich/start` remains Python. Those assertions are expected to fail when deliberately changed. Flip only `POST /enrich/start` and `GET /enrich/status/{job_id}`; internal `/api` tick/janitor are never client-switcher routes.

---

## Verified Facts

Every row below was checked against the current repository, not accepted from the inventory or design sketches.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | Python start requires an `EnrichStartRequest` body with `force=False`, `limit=None`; its successful response is default status 200 and it is limited to `5/minute`. | `mylibrary/schemas.py:25-29`; `mylibrary/api.py:517-524` |
| V2 | Python start unconditionally calls `create_enrich_job`, then passes `job_id`, authenticated `user_id`, `force`, and `limit` to arq or `BackgroundTasks`. | `mylibrary/api.py:531-552` |
| V3 | `create_enrich_job` creates a UUID string and inserts a pending row without active-job lookup or concurrency guard. | `mylibrary/worker.py:177-187` |
| V4 | Python status scopes its query by both job ID and authenticated user, returns a quoted-ID 404 on a miss, and runs stale failure before serialization. | `mylibrary/api.py:559-574` |
| V5 | The public job response's exact declared order is `job_id`, `status`, `progress`, `total`, `error`, `started_at`, `finished_at`. | `mylibrary/schemas.py:32-48` |
| V6 | Python marks first start, flushes progress separately, caps exception text at 2,000 characters, and writes terminal completion/error timestamps. | `mylibrary/worker.py:107-148` |
| V7 | Python's stale threshold is 1,800 seconds and its interruption text is exactly `Enrichment was interrupted, please retry.` | `mylibrary/worker.py:32-32`; `mylibrary/worker.py:62-85` |
| V8 | Current SQLAlchemy `EnrichJob` has job/user/status/progress/total/timestamps/error only; it has no lease, attempts, force, or limit storage. | `mylibrary/db.py:250-276` |
| V9 | Current Drizzle `enrichJobs` mirrors those columns and has unique job-ID plus non-unique user-ID indexes. | `frontend/lib/server/schema.ts:153-167` |
| V10 | PGlite's test DDL has the same old job columns and no active-job partial index. | `frontend/lib/server/__tests__/helpers/pglite.ts:174-185` |
| V11 | Alembic revision `fbc5292134c4` is not the head: it branches from `0012`; the linear project chain continues through `0018_node_wave0_tables`. The new migration must inspect actual heads rather than copy the language migration's down revision. | `alembic/versions/fbc5292134c4_add_enrichment_language.py:1-16`; `alembic/versions/0018_node_wave0_tables.py:1-22` |
| V12 | `RATE_LIMITS.enrichStart` already equals `{ limit: 5, windowSeconds: 60 }`; the limiter uses atomic upsert and the shared Python-shaped 429 response. | `frontend/lib/server/ratelimit.ts:10-19`; `frontend/lib/server/ratelimit.ts:43-78` |
| V13 | `withApi` authenticates by default but supports `{ requireAuth: false }`, making it suitable for internal secret-authenticated handlers without fake user auth. | `frontend/lib/server/http.ts:22-40`; `frontend/lib/server/http.ts:49-69` |
| V14 | `enrichLibrary(db, options)` is the wave-4c-1 orchestration export; its progress callback is synchronous and it persists each resolved book before invoking progress. | `frontend/lib/server/enrichment.ts:203-218`; `frontend/lib/server/enrichment.ts:235-280` |
| V15 | Current client start always sends both defaults and status GETs the interpolated job ID; its response interface already has all seven Python fields. | `frontend/lib/api.ts:539-550`; `frontend/lib/api.ts:633-642` |
| V16 | SetupWizard polls recursively every 2 seconds, treats pending/running as active, and reads status/progress/total/error. | `frontend/components/SetupWizard.tsx:523-574` |
| V17 | Auto mode has only exact `POST /enrich`; current Jest assertions explicitly keep `/enrich/start` on Python. | `frontend/lib/backend.ts:70-72`; `frontend/lib/__tests__/backend.test.ts:93-121`; `frontend/lib/__tests__/backend.test.ts:140-142` |
| V18 | The PGlite helper creates one `PGlite` instance and one Drizzle wrapper; production configures postgres-js `max: 1`. | `frontend/lib/server/__tests__/helpers/pglite.ts:14-15`; `frontend/lib/server/__tests__/helpers/pglite.ts:218-219`; `frontend/lib/server/db.ts:23-28` |
| V19 | Installed Next exports `after` from `next/server`; no application file currently imports it and `@vercel/functions` is not a dependency. | `frontend/node_modules/next/server.d.ts:21-21`; `frontend/package.json:11-30` |
| V20 | Eight existing long-running routes declare `maxDuration = 300`, but repository code does not prove the live Vercel project has Fluid compute enabled. | `frontend/app/api/recommend/route.ts:9-9`; `frontend/app/api/discover/route.ts:11-11`; `frontend/app/api/directive/draft/route.ts:13-13`; `frontend/app/api/profile/route.ts:12-12`; `frontend/app/api/profile/update/route.ts:8-8`; `frontend/app/api/profile/archetype/route.ts:12-12`; `frontend/app/api/profile/reveal-lines/route.ts:10-10`; `frontend/app/api/books/[id]/similar/route.ts:12-12` |
| V21 | `.env.example` has no `CRON_SECRET`, and no `vercel.json` exists. | `.env.example:1-17`; `docs/superpowers/plans/2026-08-11-node-backend-wave-4c-2-inventory.md:765-779` |
| V22 | CLI enrichment calls `enrich_library` directly and does not create a job. | `mylibrary/cli.py:76-91` |
| V23 | Codex may not run pytest, fixture recorders, `npm install`, commits, pushes, or deploys. | `CLAUDE.md:171-199` |
| V24 | The approved design requires derived progress, time-bounded chunks, secret-authenticated tick ownership from the job row, the four guards, poll repair, and daily janitor. | `docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:84-125`; `docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:134-153` |

### Python quirks to reproduce, not fix

- A successful start is 200, not 201/202. The idempotent active-job response is also 200.
- The request body is required even though both fields have defaults. Missing JSON is 422; `{}` supplies defaults.
- Status hides tenant existence: a foreign job ID and missing job ID produce the same quoted-ID 404.
- The public response has exactly seven keys in the declared order; lease, attempts, and any design-amended option storage are internal and never serialized.
- Python caps thrown error text to 2,000 characters. Preserve that cap for terminal job errors.
- Python's `started_at` is first-start time, not a heartbeat. Do not refresh it per chunk.
- Python accepts five separate jobs per minute. Node deliberately does not: the active-job partial index is an intentional safety divergence, not a port defect.
- Python accepts `force` and `limit` and carries them in process rather than storing them. The serverless design must explicitly resolve durable option storage before implementation; losing them after the first invocation is not parity.

### Deliberate divergence from Python: one active job per user

Python's `create_enrich_job()` inserts without a guard. Node adds a partial unique index:

```sql
create unique index uq_enrich_jobs_active_user
on enrich_jobs (user_id)
where status in ('pending', 'running');
```

This is deliberate. Self-chaining turns five independent clicks into five independent lambda chains, which is strictly worse than Python's five in-process tasks. The database index—not a pre-insert read—closes the double-click race. Start first returns a visible active row when present; if two requests pass that read, the loser catches this index's unique violation, re-reads, and returns the winner with 200.

---

## File Structure

**New files**

| File | Responsibility |
| --- | --- |
| `alembic/versions/<generated_revision>_add_enrich_job_leases.py` | Add lease/attempts and the partial active-user unique index; include any separately approved durable option columns only after the design blocker is resolved. |
| `frontend/lib/server/enrichmentJobs.ts` | Constants, exact public serializer, idempotent creation, atomic claim, derived counts, bounded chunk, terminal transitions, stale/orphan repair. |
| `frontend/lib/server/enrichmentDispatch.ts` | Secret validation, origin-safe internal URL construction, and the one `after(() => fetch(...))` dispatch primitive. |
| `frontend/lib/server/__tests__/enrichment-jobs.test.ts` | Real-schema index, claim, progress, budget, stall, attempts, stale and janitor behavior. |
| `frontend/app/api/enrich/start/route.ts` | Authenticated, rate-limited, idempotent start and first inline chunk. |
| `frontend/app/api/enrich/start/route.test.ts` | Complete start contract, rate-limit, existing/lost-race behavior and dispatch tests. |
| `frontend/app/api/enrich/status/[job_id]/route.ts` | Authenticated tenant-scoped status plus expired-lease poll repair. |
| `frontend/app/api/enrich/status/[job_id]/route.test.ts` | Exact status, 404 isolation, stale failure and repair tests. |
| `frontend/app/api/enrich/tick/route.ts` | Secret-authenticated job-ID-only claim/chunk endpoint. |
| `frontend/app/api/enrich/tick/route.test.ts` | 401/200 secret matrix, no-op claim and no-user-input tests. |
| `frontend/app/api/enrich/janitor/route.ts` | Secret-authenticated daily stale/orphan repair. |
| `frontend/app/api/enrich/janitor/route.test.ts` | 401/200 secret matrix and exact repair summary. |
| `vercel.json` | One daily cron entry for the exact janitor path. |

**Modified files**

| File | Change |
| --- | --- |
| `mylibrary/db.py` | Sync lease/attempt metadata for Python-owned Alembic; add only approved option metadata after blocker resolution. |
| `frontend/lib/server/schema.ts` | Sync job columns and partial unique index. |
| `frontend/lib/server/__tests__/helpers/pglite.ts` | Sync real test DDL and index. |
| `frontend/lib/server/__tests__/ratelimit-routes.test.ts` | Exercise `RATE_LIMITS.enrichStart` through the real start handler. |
| `.env.example` | Add the name `CRON_SECRET=` only. |
| `frontend/lib/backend.ts` | Final task: route exact public start and status to Node. |
| `frontend/lib/__tests__/backend.test.ts` | Final task: update exact list and wave-4c-1 Python assertions. |
| `CLAUDE.md` | Final task: record completed 4c-2 boundaries without claiming deployment. |

---

## Task 1: Resolve the durable-options design blocker and prepare the migration

**Files:** approved design document decision (human-owned), `mylibrary/db.py`, `alembic/versions/<generated_revision>_add_enrich_job_leases.py`

- [ ] **Step 1: RESOLVED — do not stop, read this instead**

This blocker was real and is now closed. **Good catch by the plan draft: it correctly refused to
invent an answer.** `POST /enrich/start` accepts `force` and `limit`; Python keeps them alive in the
BackgroundTask closure; a tick that receives only a `job_id` cannot recover them. A tick silently
ignoring `force` would "complete" a forced run having re-enriched only the first chunk.

**Chase's decision, 2026-08-11: persist both on the job row.** The approved design has been amended
in `docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md` — read the amendment block
before writing any code in this wave. In summary:

- Add `force BOOLEAN NOT NULL DEFAULT false` and a nullable integer limit column to `enrich_jobs`,
  written at job creation and read by every tick.
- **The derived-progress rule changes**, because the original rule ("count books holding enrichment
  rows") reads 100% instantly under `force`. It becomes relative to the run:
  - `processed_this_run` = books whose enrichment `resolved_at >= job.started_at`
  - `progress` = `processed_this_run` + (`force` ? 0 : books whose enrichment predates the run)
  - remaining work under a limit = `limit - processed_this_run`
  - For a non-forced run this collapses back to "every book holding an enrichment row", matching
    Python's `skipped + i` progress and `skipped + len(work)` total.
- **Add no ordering.** Python's book query has no `ORDER BY` (verified), so *which* books a limit
  selects was never a defined property; selecting arbitrary unenriched books per tick is faithful,
  and the count is what a limit constrains. Do not "improve" this with an `ORDER BY`.
- `limit` may be a reserved word in this context — quote the column or name it explicitly, and make
  the Drizzle property name and PGlite DDL agree with whatever the Alembic migration creates.

- [ ] **Step 2: Inspect the real Alembic heads before naming the migration**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/alembic heads
```

Chase or Claude runs this because Alembic imports project Python configuration. Use the reported head(s); do not copy `fbc5292134c4` merely because it is the newest-looking filename.

- [ ] **Step 3: Add the SQLAlchemy metadata and hand-written migration**

The mandatory upgrade operations are:

```python
op.add_column("enrich_jobs", sa.Column("lease_expires_at", sa.DateTime(), nullable=True))
op.add_column(
    "enrich_jobs",
    sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
)
op.add_column(
    "enrich_jobs",
    sa.Column("force", sa.Boolean(), server_default=sa.text("false"), nullable=False),
)
op.add_column("enrich_jobs", sa.Column("run_limit", sa.Integer(), nullable=True))
op.create_index(
    "uq_enrich_jobs_active_user",
    "enrich_jobs",
    ["user_id"],
    unique=True,
    postgresql_where=sa.text("status IN ('pending', 'running')"),
)
```

Add the approved option persistence from Step 1, if any, in the same migration. Downgrade drops the index before its columns. Update `EnrichJob` with typed fields and server defaults. Do not alter Python worker behavior in this wave.

- [ ] **Step 4: Prove migration ordering and symbols without applying it**

```bash
cd /home/chase/Documents/Code/my-library
grep -n 'lease_expires_at' mylibrary/db.py alembic/versions/*_add_enrich_job_leases.py
grep -n 'attempts' mylibrary/db.py alembic/versions/*_add_enrich_job_leases.py
grep -n 'uq_enrich_jobs_active_user' alembic/versions/*_add_enrich_job_leases.py
grep -n "status IN ('pending', 'running')" alembic/versions/*_add_enrich_job_leases.py
git --no-pager diff --check
```

Do **not** apply this migration yet. It must land with Task 10's switcher flip because applying it early can break Python start while a Node job is active. CLI enrichment is unaffected because it does not create a job row.

- [ ] **Step 5: Human-only migration checks**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/alembic upgrade head
.venv/bin/pytest tests/test_db_migrations.py tests/test_jobs.py
```

Run only against a disposable database, then downgrade/upgrade as the migration test requires. Codex does not run either command. Record results; do not apply to shared/live DB until Task 10 deployment.

Expected: explicit design amendment exists; migration is reviewable but unapplied to shared/live DB.

---

## Task 2: Synchronize Drizzle and the real PGlite schema

**Files:** `frontend/lib/server/schema.ts`, `frontend/lib/server/__tests__/helpers/pglite.ts`, `frontend/lib/server/__tests__/enrichment-jobs.test.ts`

- [ ] **Step 1: Search for existing job/index helpers before editing**

```bash
cd /home/chase/Documents/Code/my-library
rg -n 'partial|postgresql_where|uniqueIndex|enrichJobs|leaseExpires|attempts' frontend/lib/server
```

- [ ] **Step 2: Write the complete partial-index test first**

```ts
it('the partial unique index rejects a second active job but permits terminal history', async () => {
  const { db, close } = await makeTestDb();
  try {
    await db.insert(enrichJobs).values({ jobId: 'job-1', userId: 'user-a', status: 'pending' });
    let message = '';
    try {
      await db.insert(enrichJobs).values({ jobId: 'job-2', userId: 'user-a', status: 'running' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    await db.update(enrichJobs).set({ status: 'done' }).where(eq(enrichJobs.jobId, 'job-1'));
    await db.insert(enrichJobs).values({ jobId: 'job-3', userId: 'user-a', status: 'pending' });
    const rows = await db.select({ jobId: enrichJobs.jobId, status: enrichJobs.status })
      .from(enrichJobs).where(eq(enrichJobs.userId, 'user-a'));
    expect({ rejected: message.includes('uq_enrich_jobs_active_user'), rows }).toEqual({
      rejected: true,
      rows: [
        { jobId: 'job-1', status: 'done' },
        { jobId: 'job-3', status: 'pending' },
      ],
    });
  } finally {
    await close();
  }
});
```

This is intentionally sequential. It proves the constraint rejects the second active row; it does not pretend to prove simultaneous transactions.

- [ ] **Step 3: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts
```

Expected RED by name: `the partial unique index rejects a second active job but permits terminal history` fails because the PGlite index is absent.

- [ ] **Step 4: Add exact schema declarations**

Add `leaseExpiresAt: timestamp('lease_expires_at', { mode: 'string' })`, `attempts: integer().default(0).notNull()`, the approved option fields, and:

```ts
uniqueIndex('uq_enrich_jobs_active_user')
  .on(table.userId)
  .where(sql`${table.status} in ('pending', 'running')`),
```

Mirror exact SQL in PGlite immediately after table creation:

```sql
create unique index uq_enrich_jobs_active_user
on enrich_jobs (user_id)
where status in ('pending', 'running');
```

- [ ] **Step 5: Run every task gate**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts
npm run type-check
npx eslint lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts lib/server/__tests__/enrichment-jobs.test.ts
npx prettier --write lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts lib/server/__tests__/enrichment-jobs.test.ts
grep -n "uq_enrich_jobs_active_user" lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts
grep -n "lease_expires_at" lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts
```

Expected: PASS. No true simultaneity claim appears in the test name or comments.

---

## Task 3: Implement idempotent creation, exact serialization, and atomic lease claim

**Files:** `frontend/lib/server/enrichmentJobs.ts`, `frontend/lib/server/__tests__/enrichment-jobs.test.ts`

- [ ] **Step 1: Search before adding helpers**

```bash
cd /home/chase/Documents/Code/my-library
rg -n 'randomUUID|serialize.*Job|unique.*violation|returning\(|lease|STALE_JOB_SECONDS|INTERRUPTED_MESSAGE' frontend/lib/server
```

- [ ] **Step 2: Add complete creation and claim tests**

```ts
it('returns the existing active job and serializes exactly seven public fields', async () => {
  await db.insert(enrichJobs).values({ jobId: 'winner', userId: 'user-a', status: 'running', progress: 2, total: 7, attempts: 1 });
  const result = await createOrGetActiveJob(db, 'user-a', defaultJobOptions);
  expect(result).toEqual({
    created: false,
    job: {
      job_id: 'winner', status: 'running', progress: 2, total: 7,
      error: null, started_at: null, finished_at: null,
    },
    options: defaultJobOptions,
  });
});

it('conditional UPDATE RETURNING claims once and returns no row while leased', async () => {
  await db.insert(enrichJobs).values({ jobId: 'claim-me', userId: 'user-a', status: 'pending' });
  const first = await claimJob(db, 'claim-me', new Date('2026-08-11T12:00:00Z'));
  const second = await claimJob(db, 'claim-me', new Date('2026-08-11T12:00:01Z'));
  expect({
    first: first && { jobId: first.jobId, userId: first.userId, status: first.status, attempts: first.attempts },
    second,
  }).toEqual({
    first: { jobId: 'claim-me', userId: 'user-a', status: 'running', attempts: 1 },
    second: null,
  });
});
```

Add a complete lost-race recovery test by injecting an insert collaborator that throws a real captured `uq_enrich_jobs_active_user` violation after inserting the winner through the same DB, then assert the winner is re-read and no unrelated DB error is swallowed. Do not fake this as simultaneous execution.

- [ ] **Step 3: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts
```

Expected RED by name: `returns the existing active job and serializes exactly seven public fields`, `conditional UPDATE RETURNING claims once and returns no row while leased`, and `recovers only the active-user unique violation by returning the winner` fail because the module does not exist.

- [ ] **Step 4: Implement the module primitives**

Export these constants together:

```ts
export const FUNCTION_CEILING_SECONDS = 300; // Assumption: live Vercel Hobby + Fluid compute supports this.
export const CHUNK_BUDGET_MS = 240_000; // Leaves 60s under that assumed ceiling for final writes/response.
export const LEASE_SECONDS = 300;
export const STALE_JOB_SECONDS = 1_800;
export const MAX_JOB_ATTEMPTS = 25;
export const INTERRUPTED_MESSAGE = 'Enrichment was interrupted, please retry.';
export const STALLED_MESSAGE = 'Enrichment made no progress; please retry.';
export const ATTEMPTS_MESSAGE = 'Enrichment exceeded its retry limit; please retry.';
```

Implement `serializeJob`, `findActiveJob`, `createOrGetActiveJob`, and one claim statement equivalent to:

```sql
update enrich_jobs
set status = 'running',
    started_at = coalesce(started_at, :now),
    lease_expires_at = :lease,
    attempts = attempts + 1
where job_id = :job_id
  and status in ('pending', 'running')
  and (lease_expires_at is null or lease_expires_at <= :now)
returning *;
```

Return `null` on no row. Do not pre-read to claim. Detect the named constraint, not every error with code `23505`, because job-ID uniqueness is a different failure.

- [ ] **Step 5: Run every task gate**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts
npm run type-check
npx eslint lib/server/enrichmentJobs.ts lib/server/__tests__/enrichment-jobs.test.ts
npx prettier --write lib/server/enrichmentJobs.ts lib/server/__tests__/enrichment-jobs.test.ts
grep -n 'export async function createOrGetActiveJob' lib/server/enrichmentJobs.ts
grep -n 'attempts = attempts + 1' lib/server/enrichmentJobs.ts
grep -n 'returning' lib/server/enrichmentJobs.ts
```

Expected: PASS. The conditional statement test proves row/no-row behavior; Postgres, not this one-connection test, guarantees its atomicity.

---

## Task 4: Implement derived progress and the time-bounded chunk state machine

**Files:** `frontend/lib/server/enrichmentJobs.ts`, `frontend/lib/server/__tests__/enrichment-jobs.test.ts`

- [ ] **Step 1: Search the shipped core before designing the adapter**

```bash
cd /home/chase/Documents/Code/my-library
rg -n 'export async function enrichLibrary|progress\?|limit\?|retryUnresolved|enrichment.*bookId|effectiveRating' frontend/lib/server
```

If the approved durable-options amendment cannot be expressed by calling the existing core unchanged, stop and report that the approved design still cannot work. Do not modify `enrichment.ts` in this task.

> **RESOLVED 2026-08-11 — this stop condition already fired and is now closed.** Codex correctly
> refused to implement the loop and reported that forced chunked runs cannot advance through the
> unchanged core. See the amendment on Global Constraint 1 for the verified mechanism and Chase's
> decision. The single sanctioned edit to `enrichment.ts` is adding the optional `bookIds?: number[]`
> field to `EnrichLibraryOptions` and applying it in the candidate filter. Make that edit, then
> continue with the rest of Task 4. Any *other* change to `enrichment.ts` remains forbidden — if one
> seems necessary, stop and report instead.

- [ ] **Step 2: Add complete derived-progress and guard tests**

Use real `books`, `enrichment`, and `enrich_jobs` rows. Inject only clock and one-book runner collaborators. Write full tests with exact whole objects:

```ts
it('recomputes progress from enrichment rows after each book instead of accumulating', async () => {
  await seedBooks(db, 'user-a', [1, 2, 3]);
  await seedEnrichment(db, [1]);
  await seedClaimedJob(db, { jobId: 'job', userId: 'user-a', progress: 99, total: 3, attempts: 1 });
  const result = await runClaimedChunk(db, claimed('job', 'user-a'), {
    nowMs: sequenceClock([0, 1, 2]),
    runOne: async (_db, bookId) => { await seedEnrichment(db, [bookId]); },
    dispatch: async () => undefined,
  });
  expect({ result, job: await publicJob(db, 'job') }).toEqual({
    result: { outcome: 'done', progressBefore: 1, progressAfter: 3, remaining: 0, rearmed: false },
    job: { job_id: 'job', status: 'done', progress: 3, total: 3, error: null, started_at: expect.any(String), finished_at: expect.any(String) },
  });
});

it('fails a zero-progress chunk with work remaining and does not re-arm', async () => {
  await seedBooks(db, 'user-a', [1]);
  await seedClaimedJob(db, { jobId: 'stalled', userId: 'user-a', progress: 0, total: 1, attempts: 1 });
  const dispatch = vi.fn();
  const result = await runClaimedChunk(db, claimed('stalled', 'user-a'), {
    nowMs: sequenceClock([0, 1]), runOne: async () => undefined, dispatch,
  });
  expect({ result, dispatches: dispatch.mock.calls, job: await publicJob(db, 'stalled') }).toEqual({
    result: { outcome: 'error', progressBefore: 0, progressAfter: 0, remaining: 1, rearmed: false },
    dispatches: [],
    job: { job_id: 'stalled', status: 'error', progress: 0, total: 1, error: STALLED_MESSAGE, started_at: expect.any(String), finished_at: expect.any(String) },
  });
});

it('fails attempts overflow with a real error before work and does not re-arm', async () => {
  await seedBooks(db, 'user-a', [1]);
  await seedClaimedJob(db, { jobId: 'overflow', userId: 'user-a', progress: 0, total: 1, attempts: MAX_JOB_ATTEMPTS + 1 });
  const runOne = vi.fn(); const dispatch = vi.fn();
  const result = await runClaimedChunk(db, claimed('overflow', 'user-a', MAX_JOB_ATTEMPTS + 1), { nowMs: () => 0, runOne, dispatch });
  expect({ result, work: runOne.mock.calls, dispatches: dispatch.mock.calls, job: await publicJob(db, 'overflow') }).toEqual({
    result: { outcome: 'error', progressBefore: 0, progressAfter: 0, remaining: 1, rearmed: false },
    work: [], dispatches: [],
    job: { job_id: 'overflow', status: 'error', progress: 0, total: 1, error: ATTEMPTS_MESSAGE, started_at: expect.any(String), finished_at: expect.any(String) },
  });
});
```

Also add `stops at a book boundary after CHUNK_BUDGET_MS and re-arms only after progress`, using a clock sequence that crosses 240,000 after the first persisted book; assert one work call, derived progress 1, remaining 2, running status, cleared/expired lease as designed, and exactly one dispatch.

- [ ] **Step 3: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts
```

Expected RED by name: `recomputes progress from enrichment rows after each book instead of accumulating`, `fails a zero-progress chunk with work remaining and does not re-arm`, `fails attempts overflow with a real error before work and does not re-arm`, and `stops at a book boundary after CHUNK_BUDGET_MS and re-arms only after progress` fail.

- [ ] **Step 4: Implement the bounded loop**

The loop shape is mandatory:

```ts
const startedMs = deps.nowMs();
const progressBefore = await countPersistedEnrichment(db, job.userId, options);
while (await hasWorkRemaining(db, job.userId, options)) {
  if (deps.nowMs() - startedMs >= CHUNK_BUDGET_MS) break;
  const next = await nextUnenrichedBook(db, job.userId, options); // small pull; no fixed chunk count
  if (!next) break;
  await deps.runOne(db, next.id, options); // calls wave-4c-1 enrichLibrary adapter; one book boundary
  const derived = await countPersistedEnrichment(db, job.userId, options);
  await writeDerivedProgress(db, job.jobId, derived, total);
}
const progressAfter = await countPersistedEnrichment(db, job.userId, options);
```

The actual adapter must use `enrichLibrary()` without changing it and must honor the amended `force`/`limit` semantics. Never increment the job counter. Determine `remaining` from real selection, not `progress < total` alone. Re-arm only for `progressAfter > progressBefore && remaining > 0`. Terminal/error writes clear the lease.

- [ ] **Step 5: Run every task gate and prove the constants**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts lib/server/__tests__/enrichment-run.test.ts
npm run type-check
npx eslint lib/server/enrichmentJobs.ts lib/server/__tests__/enrichment-jobs.test.ts
npx prettier --write lib/server/enrichmentJobs.ts lib/server/__tests__/enrichment-jobs.test.ts
grep -n 'CHUNK_BUDGET_MS = 240_000' lib/server/enrichmentJobs.ts
grep -n 'FUNCTION_CEILING_SECONDS = 300' lib/server/enrichmentJobs.ts
grep -n 'countPersistedEnrichment' lib/server/enrichmentJobs.ts
rg -n 'progress\s*\+|progress\+\+' lib/server/enrichmentJobs.ts
```

Expected: PASS; the forbidden accumulated-progress search prints nothing.

---

## Task 5: Add secret validation and the exact `after()` continuation

**Files:** `frontend/lib/server/enrichmentDispatch.ts`, `frontend/lib/server/enrichmentJobs.ts`, `frontend/lib/server/__tests__/enrichment-jobs.test.ts`, `.env.example`

- [ ] **Step 1: Search before adding security/URL helpers**

```bash
cd /home/chase/Documents/Code/my-library
rg -n 'timingSafeEqual|CRON_SECRET|authorization|new URL\(|after\(' frontend/lib/server frontend/app
```

- [ ] **Step 2: Write complete helper tests**

Add named tests `rejects missing and mismatched internal bearer secrets without reading a user id`, `accepts the exact internal bearer secret`, and `dispatches only job_id to the same-origin tick URL`. Set and restore `process.env.CRON_SECRET` in hooks; never log it. The dispatch assertion is exact:

```ts
expect(fetchMock.mock.calls.map(([input, init]) => ({
  url: String(input), method: init?.method, body: init?.body,
  authorization: new Headers(init?.headers).get('authorization') ? 'present' : null,
}))).toEqual([{
  url: 'https://app.test/api/enrich/tick', method: 'POST',
  body: JSON.stringify({ job_id: 'job-1' }), authorization: 'present',
}]);
```

- [ ] **Step 3: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts
```

Expected RED by name: the three Task 5 helper tests fail because `enrichmentDispatch.ts` does not exist.

- [ ] **Step 4: Implement the complete worked `after()` call site**

```ts
import { after } from 'next/server';

export function rearmAfterResponse(request: Request, jobId: string): void {
  const secret = requireCronSecret();
  const url = new URL('/api/enrich/tick', request.url);
  after(async () => {
    await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
      cache: 'no-store',
    });
  });
}
```

This callback only dispatches. `after()` time counts toward the current invocation, so never move `runClaimedChunk` into it; tick owns the chunk and its own 240s budget. Provide an injectable scheduling/fetch seam for Vitest without changing the production call site. Add only:

```dotenv
CRON_SECRET=
```

to `.env.example`; Chase supplies actual values outside the repo.

- [ ] **Step 5: Run every task gate and safe env-presence check**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-jobs.test.ts
npm run type-check
npx eslint lib/server/enrichmentDispatch.ts lib/server/enrichmentJobs.ts lib/server/__tests__/enrichment-jobs.test.ts
npx prettier --write lib/server/enrichmentDispatch.ts lib/server/enrichmentJobs.ts lib/server/__tests__/enrichment-jobs.test.ts
grep -n "import { after } from 'next/server'" lib/server/enrichmentDispatch.ts
grep -n "body: JSON.stringify({ job_id: jobId })" lib/server/enrichmentDispatch.ts
test -n "${CRON_SECRET+x}"
```

The final command checks presence only and emits nothing. If it exits 1, Chase must configure the variable; never print it.

---

## Task 6: Add idempotent authenticated `POST /enrich/start`

**Files:** `frontend/app/api/enrich/start/route.ts`, `frontend/app/api/enrich/start/route.test.ts`, `frontend/lib/server/__tests__/ratelimit-routes.test.ts`

- [ ] **Step 1: Write complete route tests before the handler**

Follow the existing real JWT/PGlite setup in `app/api/enrich/route.test.ts`. Mock the chunk runner/dispatch boundary, not authentication, DB insertion, or rate limiting. Include full tests named:

- `creates one pending job, runs the first chunk inline, and returns the exact seven-field 200 response`
- `returns the existing active job with 200 and does not run another first chunk`
- `returns the unique-race winner with 200`
- `requires a JSON body and validates force and nullable integer limit`
- `returns 401 without user authentication`
- `enforces RATE_LIMITS.enrichStart as five per minute per authenticated user`

The first assertion must compare the whole response and DB row:

```ts
expect({ status: response.status, body: await response.json(), rows, chunkCalls }).toEqual({
  status: 200,
  body: { job_id: expect.any(String), status: 'running', progress: 1, total: 2, error: null, started_at: expect.any(String), finished_at: null },
  rows: [{ jobId: expect.any(String), userId: 'user-a', status: 'running', progress: 1, total: 2, attempts: 1, leaseExpiresAt: expect.any(String) }],
  chunkCalls: [[expect.anything(), expect.objectContaining({ userId: 'user-a' })]],
});
```

Adjust internal row fields to the approved durable-options amendment, but never expose them publicly.

- [ ] **Step 2: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/start/route.test.ts lib/server/__tests__/ratelimit-routes.test.ts
```

Expected RED by name: every named Task 6 route case fails because the route does not exist; existing rate-limit cases remain green.

- [ ] **Step 3: Implement authenticated start**

Use `withApi('/api/enrich/start', ...)`, required JSON, a non-strict Zod object matching existing Node conventions, `checkRateLimit(db, { key: \`enrichStart:${ctx.user.userId}\`, ...RATE_LIMITS.enrichStart })`, and `rateLimitExceededResponse`. Call `createOrGetActiveJob`; only a newly created job is claimed/run inline. Return the exact serializer with 200. Set:

```ts
export const maxDuration = FUNCTION_CEILING_SECONDS;
```

Do not accept a user ID, call Python, or invoke `after()` with chunk work.

- [ ] **Step 4: Run every task gate**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/start/route.test.ts lib/server/__tests__/ratelimit-routes.test.ts lib/server/__tests__/enrichment-jobs.test.ts
npm run type-check
npx eslint app/api/enrich/start/route.ts app/api/enrich/start/route.test.ts lib/server/__tests__/ratelimit-routes.test.ts
npx prettier --write app/api/enrich/start/route.ts app/api/enrich/start/route.test.ts lib/server/__tests__/ratelimit-routes.test.ts
grep -n "withApi('/api/enrich/start'" app/api/enrich/start/route.ts
grep -n 'RATE_LIMITS.enrichStart' app/api/enrich/start/route.ts lib/server/__tests__/ratelimit-routes.test.ts
```

Expected: PASS. Auto mode still routes public start to Python.

---

## Task 7: Add secret-authenticated tick

**Files:** `frontend/app/api/enrich/tick/route.ts`, `frontend/app/api/enrich/tick/route.test.ts`

- [ ] **Step 1: Write the full secret/claim matrix**

Use real PGlite jobs and mock only `runClaimedChunk`. Add complete tests:

```ts
it.each([
  ['missing', undefined],
  ['wrong', 'Bearer wrong-secret'],
])('returns 401 for %s secret without claiming work', async (_label, authorization) => {
  const headers = authorization ? { authorization, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
  const response = await POST(new Request('http://test/api/enrich/tick', { method: 'POST', headers, body: JSON.stringify({ job_id: 'job-1' }) }));
  expect({ status: response.status, body: await response.json(), calls: runChunkMock.mock.calls }).toEqual({
    status: 401, body: { detail: 'Unauthorized' }, calls: [],
  });
});

it('returns 200 with the secret, claims by job_id, and resolves ownership from the row', async () => {
  await db.insert(enrichJobs).values({ jobId: 'job-1', userId: 'owner-from-row', status: 'pending' });
  runChunkMock.mockResolvedValue({ outcome: 'done', progressBefore: 0, progressAfter: 1, remaining: 0, rearmed: false });
  const response = await POST(secretRequest('/api/enrich/tick', { job_id: 'job-1' }));
  expect({ status: response.status, body: await response.json(), calls: runChunkMock.mock.calls }).toEqual({
    status: 200,
    body: { claimed: true, outcome: 'done' },
    calls: [[expect.anything(), expect.objectContaining({ jobId: 'job-1', userId: 'owner-from-row' }), expect.anything()]],
  });
});
```

Add `returns 200 claimed false when the conditional claim returns no row` and `rejects a caller-supplied user_id with 422` as complete whole-response tests.

- [ ] **Step 2: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/tick/route.test.ts
```

Expected RED by name: all four Task 7 tests fail because the route does not exist.

- [ ] **Step 3: Implement tick**

Use `withApi('/api/enrich/tick', ..., { requireAuth: false })`, validate secret before JSON/DB, accept a strict `{ job_id: z.string().min(1) }`, claim atomically, return `{ claimed: false }` with 200 on no row, and run the claimed chunk. Ownership comes only from the returned row. Export `maxDuration = FUNCTION_CEILING_SECONDS`.

- [ ] **Step 4: Run every task gate**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/tick/route.test.ts lib/server/__tests__/enrichment-jobs.test.ts
npm run type-check
npx eslint app/api/enrich/tick/route.ts app/api/enrich/tick/route.test.ts
npx prettier --write app/api/enrich/tick/route.ts app/api/enrich/tick/route.test.ts
grep -n "requireAuth: false" app/api/enrich/tick/route.ts
grep -n "job_id: z.string" app/api/enrich/tick/route.ts
rg -n 'user_id|userId.*body|waitUntil' app/api/enrich/tick/route.ts
```

Expected: PASS; forbidden caller-user/waitUntil search prints nothing.

---

## Task 8: Add user status, expired-lease poll repair, and stale failure

**Files:** `frontend/app/api/enrich/status/[job_id]/route.ts`, `frontend/app/api/enrich/status/[job_id]/route.test.ts`, `frontend/lib/server/enrichmentJobs.ts`

- [ ] **Step 1: Write complete status tests**

Add runnable cases named `returns the exact seven-field job for its authenticated owner`, `returns the same quoted-id 404 for missing and foreign jobs`, `fails a running job older than STALE_JOB_SECONDS`, and `re-arms a running job whose lease expired`. The repair assertion is:

```ts
expect({ status: response.status, body: await response.json(), dispatches: dispatchMock.mock.calls }).toEqual({
  status: 200,
  body: { job_id: 'expired', status: 'running', progress: 1, total: 3, error: null, started_at: expect.any(String), finished_at: null },
  dispatches: [[expect.any(Request), 'expired']],
});
```

Seed the lease before `now`; assert a fresh lease and terminal jobs do not dispatch in their own complete cases.

- [ ] **Step 2: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run 'app/api/enrich/status/[job_id]/route.test.ts'
```

Expected RED by name: all Task 8 cases fail because the route does not exist.

- [ ] **Step 3: Implement tenant status and repair**

Use default-authenticated `withApi`. Query both `job_id` and `ctx.user.userId`. On miss throw `ApiError(404, \`Job '${jobId}' not found\`)`. Run stale failure first; only if still running and lease is null/expired call `rearmAfterResponse(request, jobId)`. Return the exact seven-field serializer; no internal columns.

- [ ] **Step 4: Run every task gate**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run 'app/api/enrich/status/[job_id]/route.test.ts' lib/server/__tests__/enrichment-jobs.test.ts
npm run type-check
npx eslint 'app/api/enrich/status/[job_id]/route.ts' 'app/api/enrich/status/[job_id]/route.test.ts' lib/server/enrichmentJobs.ts
npx prettier --write 'app/api/enrich/status/[job_id]/route.ts' 'app/api/enrich/status/[job_id]/route.test.ts' lib/server/enrichmentJobs.ts
grep -n "Job '\${jobId}' not found" 'app/api/enrich/status/[job_id]/route.ts'
grep -n 'rearmAfterResponse' 'app/api/enrich/status/[job_id]/route.ts'
```

Expected: PASS. Poll repair schedules only a dispatch; it never claims/runs work in the status request.

---

## Task 9: Add daily secret-authenticated janitor and Vercel cron

**Files:** `frontend/app/api/enrich/janitor/route.ts`, `frontend/app/api/enrich/janitor/route.test.ts`, `frontend/lib/server/enrichmentJobs.ts`, `vercel.json`

- [ ] **Step 1: Write complete janitor tests**

Add `returns 401 without the secret and performs no query`, `returns 200 with the secret and re-arms each expired non-stale active job`, and `fails stale active jobs instead of re-arming them`. Seed fresh-leased, expired, stale, done, and error rows. Assert the whole summary:

```ts
expect({ status: response.status, body: await response.json(), dispatched: dispatchMock.mock.calls.map(([, id]) => id) }).toEqual({
  status: 200,
  body: { examined: 3, rearmed: 1, failed: 1 },
  dispatched: ['expired-job'],
});
```

The janitor takes no user ID and resolves every owner from selected rows.

- [ ] **Step 2: Run expected RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/janitor/route.test.ts
```

Expected RED by name: all three Task 9 cases fail because the route does not exist.

- [ ] **Step 3: Implement janitor with the exact cron path**

Use `withApi('/api/enrich/janitor', ..., { requireAuth: false })`, secret validation before DB, stale failure, and expired-lease dispatch. Do not claim or run chunks in the cron invocation. Create repository-root `vercel.json` with full contents:

```json
{
  "crons": [
    {
      "path": "/api/enrich/janitor",
      "schedule": "17 3 * * *"
    }
  ]
}
```

This is one approximately daily run at 03:17 UTC. Hobby cadence is an assumption Chase must confirm before deploy; if wrong, change this one schedule string.

- [ ] **Step 4: Run every task gate**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/janitor/route.test.ts app/api/enrich/tick/route.test.ts 'app/api/enrich/status/[job_id]/route.test.ts' lib/server/__tests__/enrichment-jobs.test.ts
npm run type-check
npx eslint app/api/enrich/janitor/route.ts app/api/enrich/janitor/route.test.ts lib/server/enrichmentJobs.ts
npx prettier --write app/api/enrich/janitor/route.ts app/api/enrich/janitor/route.test.ts lib/server/enrichmentJobs.ts ../vercel.json
grep -n '"path": "/api/enrich/janitor"' ../vercel.json
grep -n '"schedule": "17 3 \* \* \*"' ../vercel.json
grep -n "requireAuth: false" app/api/enrich/janitor/route.ts
```

Expected: PASS. Tick and janitor both return 401 without secret and 200 with it.

---

## Task 10: Flip only the two public job routes and record project state

**Files:** `frontend/lib/backend.ts`, `frontend/lib/__tests__/backend.test.ts`, `CLAUDE.md`

- [ ] **Step 1: Change switcher assertions before production rules**

Replace the wave-4c-1 background-Python assertion with:

```ts
test('auto: wave-4c enrichment routes are exact and method-scoped', () => {
  expect(baseFor('/enrich', 'POST')).toBe('/api');
  expect(baseFor('/enrich', 'GET')).toBe(PY);
  expect(baseFor('/enrich/child', 'POST')).toBe(PY);
  expect(baseFor('/enrich/start', 'POST')).toBe('/api');
  expect(baseFor('/enrich/start', 'GET')).toBe(PY);
  expect(baseFor('/enrich/status/job-1', 'GET')).toBe('/api');
  expect(baseFor('/enrich/status/job-1', 'POST')).toBe(PY);
});
```

Update the complete `NODE_DEFAULT_ROUTES` whole-array assertion with the two new rules. Keep the 4c-1 exact rule unchanged.

- [ ] **Step 2: Prove Jest is RED by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
```

Expected RED by name: `auto: wave-4c enrichment routes are exact and method-scoped` and the renamed complete flip-list test fail because production rules are absent. Wave 4c-1's old `/enrich/start`-stays-Python expectation is intentionally being replaced, not treated as a surprise.

- [ ] **Step 3: Add exactly two production rules**

```ts
// Wave 4c-2: public background-job API. Internal tick/janitor are same-origin /api only.
{ prefix: '/enrich/start', methods: ['POST'], exact: true },
{ prefix: '/enrich/status/', methods: ['GET'] },
```

Keep `/enrich`'s exact POST rule. The status prefix intentionally requires the slash and matches job IDs; tests guard method direction.

- [ ] **Step 4: Record completion boundaries in `CLAUDE.md`**

Record jobs/leases/derived progress/time budget/`after()`/poll repair/janitor on Node, the deliberate active-job divergence, and that migration + flip deploy together. Keep Redis/arq, global coordination, QStash, admin, Python cutover/deletion in their stated out-of-scope waves. Do not claim live deployment or platform assumptions verified.

- [ ] **Step 5: Apply migration only in the coordinated release (Chase only)**

After all frontend gates are green and immediately before/with deploying the switcher flip:

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/alembic upgrade head
```

Chase runs this against the intended real database. Never land/apply the partial index earlier. Confirm live Fluid compute/~300s duration and Hobby daily cron capability before deploy. Supply `CRON_SECRET` in Vercel without printing it.

- [ ] **Step 6: Run every task gate and inspect only**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
npx vitest run app/api/enrich/start/route.test.ts 'app/api/enrich/status/[job_id]/route.test.ts' app/api/enrich/tick/route.test.ts app/api/enrich/janitor/route.test.ts lib/server/__tests__/enrichment-jobs.test.ts lib/server/__tests__/ratelimit-routes.test.ts
npm run type-check
npx eslint lib/backend.ts lib/__tests__/backend.test.ts
npx prettier --write lib/backend.ts lib/__tests__/backend.test.ts ../CLAUDE.md
grep -n "prefix: '/enrich/start'.*methods: \['POST'\].*exact: true" lib/backend.ts lib/__tests__/backend.test.ts
grep -n "prefix: '/enrich/status/'.*methods: \['GET'\]" lib/backend.ts lib/__tests__/backend.test.ts
cd ..
git --no-pager diff --stat
```

Expected: PASS. The migration and flip are one release boundary. Diff ready for Chase's review.

---

## Task 11: Full verification and handoff

Jest owns backend switching; Vitest owns server modules and route handlers. Python, live migration, and deployment checks remain human-only.

- [ ] **Step 1: Run all frontend gates separately (Codex may run)**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand
npm run test:server
npm run type-check
npm run lint
```

- [ ] **Step 2: Run targeted formatting on the explicit touched set**

> **CORRECTION, 2026-08-11 (Task 5 execution).** `.env.example` has been REMOVED from every
> Prettier command in this plan. The installed Prettier has no parser for it and exits nonzero
> with `No parser could be inferred for file ".../.env.example"`, which would fail an otherwise
> green gate. `vercel.json` stays — JSON parses fine.

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/schema.ts lib/server/enrichmentJobs.ts lib/server/enrichmentDispatch.ts lib/server/__tests__/helpers/pglite.ts lib/server/__tests__/enrichment-jobs.test.ts lib/server/__tests__/ratelimit-routes.test.ts app/api/enrich/start/route.ts app/api/enrich/start/route.test.ts 'app/api/enrich/status/[job_id]/route.ts' 'app/api/enrich/status/[job_id]/route.test.ts' app/api/enrich/tick/route.ts app/api/enrich/tick/route.test.ts app/api/enrich/janitor/route.ts app/api/enrich/janitor/route.test.ts lib/backend.ts lib/__tests__/backend.test.ts ../vercel.json ../CLAUDE.md
```

- [ ] **Step 3: Run Python verification (Chase or Claude only)**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/pytest
```

Codex cannot run this because `tests/conftest.py` imports FastAPI `TestClient`. Record the human-run result exactly. No fixture recorder is needed or authorized in this wave.

- [ ] **Step 4: Re-run critical symbol proofs**

```bash
cd /home/chase/Documents/Code/my-library
grep -n 'lease_expires_at' mylibrary/db.py alembic/versions/*_add_enrich_job_leases.py frontend/lib/server/schema.ts frontend/lib/server/__tests__/helpers/pglite.ts
grep -n 'uq_enrich_jobs_active_user' alembic/versions/*_add_enrich_job_leases.py frontend/lib/server/schema.ts frontend/lib/server/__tests__/helpers/pglite.ts
grep -n 'CHUNK_BUDGET_MS = 240_000' frontend/lib/server/enrichmentJobs.ts
grep -n 'FUNCTION_CEILING_SECONDS = 300' frontend/lib/server/enrichmentJobs.ts
grep -n 'MAX_JOB_ATTEMPTS' frontend/lib/server/enrichmentJobs.ts
grep -n 'countPersistedEnrichment' frontend/lib/server/enrichmentJobs.ts
grep -n "import { after } from 'next/server'" frontend/lib/server/enrichmentDispatch.ts
grep -n "body: JSON.stringify({ job_id: jobId })" frontend/lib/server/enrichmentDispatch.ts
grep -n "withApi('/api/enrich/tick'" frontend/app/api/enrich/tick/route.ts
grep -n "withApi('/api/enrich/janitor'" frontend/app/api/enrich/janitor/route.ts
grep -n '"path": "/api/enrich/janitor"' vercel.json
grep -n "prefix: '/enrich/start'.*exact: true" frontend/lib/backend.ts
grep -n "prefix: '/enrich/status/'" frontend/lib/backend.ts
rg -n 'waitUntil|@vercel/functions' frontend package.json frontend/package.json
rg -n 'progress\s*\+|progress\+\+' frontend/lib/server/enrichmentJobs.ts
```

Expected: positive proofs print; forbidden `waitUntil`, dependency, and accumulated-progress searches print nothing.

- [ ] **Step 5: Inspect exact scope and migration boundary**

```bash
cd /home/chase/Documents/Code/my-library
git --no-pager diff --check
git --no-pager diff --stat
git --no-pager diff -- alembic/versions/*_add_enrich_job_leases.py mylibrary/db.py frontend/lib/server/schema.ts frontend/lib/server/enrichmentJobs.ts frontend/lib/server/enrichmentDispatch.ts frontend/lib/server/__tests__/helpers/pglite.ts frontend/lib/server/__tests__/enrichment-jobs.test.ts frontend/lib/server/__tests__/ratelimit-routes.test.ts frontend/app/api/enrich/start frontend/app/api/enrich/status frontend/app/api/enrich/tick frontend/app/api/enrich/janitor frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts .env.example vercel.json CLAUDE.md
```

Confirm no change to `frontend/lib/server/enrichment.ts`, package/lockfiles, Redis/arq, admin routes, global rate coordination, QStash, Python cutover/deletion, or unrelated deployment configuration.

- [ ] **Step 6: Human live verification and report**

Against a disposable or intended environment only after the coordinated migration/flip: import a small library, start enrichment, watch progress advance, close/reopen the polling UI to exercise repair, and confirm enrichment rows. Verify unauthorized tick/janitor are 401 without ever printing the secret. Record whether Fluid compute/~300s duration and once-daily Hobby cron were confirmed. Chase chooses commits, merges, pushes, and deploys by hand.

---

## Done when

- The approved design explicitly resolves durable `force`/`limit` semantics; no option disappears between start and a later job-ID-only tick.
- The migration, SQLAlchemy metadata, Drizzle schema, and PGlite DDL agree on lease, attempts, the partial active-user index, and any explicitly approved option storage.
- The partial index sequentially rejects a second pending/running job for one user and permits terminal history; the plan/test does not call that a simulated race.
- Idempotent start returns an existing active job with 200 and recovers a lost insert race by re-reading the named-index winner.
- `RATE_LIMITS.enrichStart` is exercised through the real handler at exactly 5/minute per authenticated user.
- Claim is one conditional `UPDATE ... WHERE ... RETURNING`; the test proves claimable row/no-row behavior and states that true simultaneity is not proven in-process.
- A separate human-run real-Postgres race test is identified as the only place to prove true simultaneity, and is not added in this wave.
- Every chunk uses `CHUNK_BUDGET_MS = 240_000` under the explicitly assumed 300-second ceiling, checks time at book boundaries, and has no count-based chunk tuning knob.
- Progress is always re-counted from actual user-owned book/enrichment joins; no accumulated progress update exists.
- Zero progress with remaining work and attempts overflow write real terminal errors and never re-arm.
- Start, tick, poll repair, and janitor re-arm only by dispatching a job-ID-only request; `after()` never contains chunk work.
- Tick and janitor return 401 without `CRON_SECRET`, 200 with it, accept no caller user ID, and resolve owners only from job rows.
- Status preserves seven-field response shape, tenant-hiding 404, first-start semantics, stale failure, and expired-lease poll repair.
- `vercel.json` contains exactly the matching `/api/enrich/janitor` daily cron; Hobby cadence remains explicitly confirmed-before-deploy rather than asserted.
- Only the name `CRON_SECRET=` is committed; no agent reads or prints its value.
- Migration application and the public start/status switcher flip occur in the same release window; CLI enrichment remains unaffected.
- Exact `POST /enrich` remains Node, only public `POST /enrich/start` and `GET /enrich/status/{job_id}` newly flip, and internal routes are not switcher entries.
- Redis/arq, QStash, global cross-user coordination, admin routes, Python cutover/deletion, and resolver changes remain absent.
- `npm test -- --runInBand`, `npm run test:server`, `npm run type-check`, and `npm run lint` pass; targeted Prettier passes; Chase/Claude records pytest and real-migration results.
- No agent ran install, fixture recording, pytest, real migration, commit, cherry-pick, merge, push, or deploy. The diff is ready for Chase's review.

---

## Verification record

**Executed 2026-08-11** by Claude (planning/review) delegating each task to Codex per the
`CLAUDE.md` split. Nothing was committed, pushed, or deployed; the migration was NOT applied to
any shared or live database.

### Gate results (all run by Claude, not accepted from a Codex self-report)

| Gate | Result |
| --- | --- |
| `npm test -- --runInBand` (Jest) | 5 suites, 39/39 passed |
| `npm run test:server` (Vitest) | 71 files, 493/493 passed |
| `npm run type-check` | clean |
| `npm run lint` | clean |
| `.venv/bin/pytest` | 360 passed, 0 failed |
| `git --no-pager diff --check` | clean |

Scope confirmed via `git status --short --untracked-files=all`: no package/lockfile change, no
Redis/arq/QStash, no admin routes, no global rate coordination, no Python cutover or deletion.

### Design blocker resolved mid-execution (Task 4)

Task 4's Step 1 stop condition fired correctly and Codex refused to implement the loop. Verified
mechanism: `enrichLibrary` (`frontend/lib/server/enrichment.ts:236-290`) selects all of a user's
books, filters to `work` via `force || existing === null || …`, then takes `work.slice(0, limit)`
with no `ORDER BY` and no way to name a book. Non-forced chunking advances fine — each enriched
book gains an enrichment row and leaves `work`. Forced chunking cannot: `work` is recomputed every
tick and always holds every candidate, so `slice(0,1)` re-picks the same first book (enrichment
upserts do not move `books` heap tuples). Tick 1 enriches book 1 → progress 1; tick 2 re-enriches
book 1 → `progressAfter == progressBefore` → the no-progress guard writes a terminal
`STALLED_MESSAGE`. A forced run over more than one book died on its second tick.

The plan was self-contradictory: Global Constraint 1 forbade touching `enrichment.ts`, but Task 4's
*mandatory* loop shape (`deps.runOne(db, next.id, options)`) required a per-book seam only
`enrichment.ts` could provide. **Chase chose the additive `bookIds?: number[]` option**; see the
amendment on Global Constraint 1. `enrichment-parity.test.ts` still passes, proving the option is
inert when absent.

### Two defects found by running gates, not by reading code

1. **Migration was not idempotent** (found by `pytest`, invisible to every frontend gate).
   `tests/test_beta_feedback.py::test_migration_idempotency` failed with
   `duplicate column name: lease_expires_at`. Root cause:
   `alembic/versions/0001_initial_multitenant_schema.py:30` runs
   `Base.metadata.create_all()` **from the live models**, so a fresh database already had the four
   new columns by the time `0019` ran. Every post-baseline migration in this repo is written
   idempotently for exactly this reason (`0002`, `0003`, `0005`, `0007`); the plan's mandatory
   upgrade sketch was not. `0019` now inspects existing columns and indexes before adding.

2. **Partial index was not partial on SQLite.** `postgresql_where` is a dialect kwarg SQLite
   ignores, so the migration created a plain `UNIQUE(user_id)` index there — permitting only ONE
   `enrich_jobs` row per user forever, across every status. Since Python's `create_enrich_job`
   inserts unconditionally, a user's *second* ever enrichment start on a migrated SQLite database
   would have raised an IntegrityError. Fixed by adding `sqlite_where`. Proven empirically against
   a throwaway SQLite database: pending insert succeeds → second active insert fails uniqueness →
   after marking the first `done`, a new pending insert succeeds.

### Plan corrections applied

- `.env.example` removed from every Prettier command: Prettier has no parser for it and exits
  nonzero, which would fail an otherwise green gate. `vercel.json` stays — JSON parses fine.
- Task 8's Decision A sketch wrongly suggested stale-failure applies to `pending` jobs. Codex
  checked Python and followed it: `mylibrary/worker.py:65-66` returns early unless
  `status == "running"` with a non-null `started_at`, and the threshold is strictly `>` 1,800s.
- A duplicated dispatch body in `enrichmentDispatch.ts` was collapsed: the test seam and the
  production `after()` branch were near-identical copies, so tests exercised a *copy* of the
  production path and drift would have shipped green.

### Open items for Chase — none of these are code, and none were verified here

1. **Apply the migration in the same release window as the switcher flip.** `.venv/bin/alembic
   upgrade head` against the intended database. Applying it earlier breaks Python's unguarded
   start while a Node job is active (Global Constraint 9).
2. **Supply `CRON_SECRET`** in Vercel. Only the name is committed. No agent read or printed a value.
3. **Confirm Vercel Fluid compute and the assumed ~300s duration.** `FUNCTION_CEILING_SECONDS` and
   `CHUNK_BUDGET_MS` sit together in `enrichmentJobs.ts` so this is a one-line adjustment.
4. **Confirm Hobby permits the ~daily cron** (`17 3 * * *`). Still unconfirmed — Vercel's docs
   search did not surface the per-plan cron limits table, so this remains a dashboard check.
   Two related facts that did turn up and matter:
   - **Cron jobs are only active on PRODUCTION deployments.** The project's latest deployment is a
     preview of `feat/node-backend` (`target: null`, project `live: false`), so the janitor will
     not run until this reaches production.
   - After a production deploy, `vercel crons ls` (or `--format json`) lists what Vercel actually
     registered — the direct way to prove the cron exists rather than assuming it.
5. ~~**Confirm the Vercel project root.**~~ **RESOLVED 2026-08-11 — and the plan was wrong.**
   Task 9 followed the plan and created `vercel.json` at the repository root. That location is
   **ignored**: build logs for the project's latest deployment show it clones the repo and
   immediately runs `mylibrary-frontend@0.1.0 build` / `next build` with no `cd frontend` and no
   custom build command, and there is no `package.json` or `next.config.*` at the repository root
   at all. The Vercel project's Root Directory is therefore `frontend`, and a repo-root
   `vercel.json` would have meant the janitor cron **never fired**. The file has been moved to
   `frontend/vercel.json`. The cron `path` stays `/api/enrich/janitor` — it is relative to the
   deployed app root, so it is unaffected by the move.
6. **Live verification** (per the global "never claim it works from tests alone" rule): import a
   small library, start enrichment, watch progress advance, close and reopen the polling UI to
   exercise poll repair, and confirm unauthorized tick/janitor are 401 without printing the secret.

### Known sharp edges, recorded rather than fixed

- **True concurrency is not proven in-process.** PGlite is one instance and production uses one
  postgres-js connection per module instance, so the partial-index and lease-claim tests are
  sequential by design and are named as such. Postgres guarantees single-statement atomicity; a
  real race test belongs in a separate human-run real-Postgres path, deliberately not added here.
- **`deriveState` is O(library) and runs a few times per book**, since it re-reads the full
  books⋈enrichment join to satisfy the derived-progress rule. Catalog HTTP dominates the 240s
  budget by orders of magnitude, so this is not a practical bottleneck — but it is the obvious
  first optimization if chunk throughput ever matters.
- **PGlite declares `job_id text not null unique` inline**, which Postgres auto-names
  `enrich_jobs_job_id_key`, while production's migration names it `ix_enrich_jobs_job_id`. This
  pre-dates wave 4c-2 and has no behavioral impact here, since the lost-race recovery matches only
  `uq_enrich_jobs_active_user` by name.

## Live verification record — 2026-08-11 (closes open item 6)

Run by Claude driving the real app against a throwaway Docker Postgres
(`mylib-w3b-verify`, Alembic-migrated to `0019`), never dev Supabase. `next dev` in local
single-user auth mode with a locally-generated throwaway `CRON_SECRET`; the real deployment
secret was never read or used.

### One blocking defect, found on the first real request

**`POST /enrich/start` 500'd against the real schema.** `enrich_jobs.progress` and `.total` are
`NOT NULL` with **no server default** — Python supplies them from ORM-level `default=0`. The Node
insert omitted them, drizzle emitted SQL `default`, and Postgres answered
`null value in column "progress" of relation "enrich_jobs" violates not-null constraint`.

It passed 493 tests because **the PGlite mirror granted defaults production does not have**
(`progress integer not null default 0`). The mirror was more forgiving than the database it
mirrors, so no test could have caught this. Fixed in three places, all verified:

| File | Change |
| --- | --- |
| `lib/server/enrichmentJobs.ts` | `createOrGetActiveJob` passes `progress: 0, total: 0` explicitly |
| `lib/server/schema.ts` | dropped `.default()` from `enrichJobs.status`, `.progress`, `.total` |
| `lib/server/__tests__/helpers/pglite.ts` | dropped the same three defaults from the mirror DDL |

Tightening the mirror turned 24 tests red across 6 files — every one a fixture that had relied on
the invented defaults. All 25 fixtures now supply `progress: 0, total: 0`, which reproduces the old
implicit value exactly, so no assertion changed. Note `npm run type-check` does **not** catch this:
drizzle's `$inferInsert` leaves a `notNull()` column without `.default()` optional, so the only
signal is a runtime constraint violation.

Generalizing this guard is Task 2 of
`2026-08-11-node-backend-wave-4d-import-quotes-and-schema-drift.md`.

### What was exercised, and what it proved

| Behavior | Evidence |
| --- | --- |
| Full onboarding → enrich through the browser | `/setup` wizard reached Enrich, ran, advanced to Profile |
| Real enrichment against live catalogs | 7 books resolved: `isbn:googlebooks`, `isbn:openlibrary`, `search:openlibrary`; HIGH/MEDIUM labels, real descriptions and subjects |
| Job completes and clears its lease | `status=done`, `progress=14`, `total=14`, `attempts=1`, `lease_expires_at=NULL` |
| **`after()` continuation in a real Next runtime** | With `CHUNK_BUDGET_MS` temporarily at 1500: one `POST /enrich/start` chunk (1790ms) then exactly one `POST /api/enrich/tick` (634ms) that finished the run. **The highest-risk unprecedented piece works.** |
| One active job per user | Two genuinely concurrent `POST /enrich/start` returned the **same** `job_id`; one row in `enrich_jobs` |
| Poll repair | A `running` job with an expired lease was re-armed by a `GET /enrich/status/{id}` and ran to `done` |
| Janitor | `{"examined":3,"rearmed":1,"failed":1}` — re-armed the expired lease, failed the stale job, left the healthy one untouched |
| Stale threshold is strictly `>` 1800s | 1801s old → `error` + `Enrichment was interrupted, please retry.`; 1800s old → untouched |
| `CRON_SECRET` auth | tick and janitor both 401 with no header and with a wrong bearer; 200 with the right one. No secret value printed. |
| Rate limit | starts 1–5 → 200, starts 6 and 7 → 429 `Rate limit exceeded: 5 per 1 minute` |
| Migration `0019` on real Postgres | applied cleanly; `uq_enrich_jobs_active_user` is genuinely partial: `UNIQUE, btree (user_id) WHERE status::text = ANY (...)` |

`CHUNK_BUDGET_MS` was returned to `240_000` and the final run re-verified at the production value.

### Measured, not assumed

- A `CHUNK_BUDGET_MS` small enough to expire **before the first book** fails the job as
  `STALLED_MESSAGE` rather than re-arming, because the budget check sits at the top of the loop.
  Harmless at 240s against sub-second per-book work; worth knowing before anyone lowers it.
- Re-enrichment is much faster than first enrichment (14 books in ~2.4s) — wave 3a's Postgres
  catalog cache is doing the work. Chunk-count intuitions from a forced re-run do not transfer to a
  cold library.

### Gates after the fix

Jest 39/39 · Vitest 493/493 (71 files) · `tsc` clean · `eslint` clean · `prettier --check` clean on
touched files · pytest 360 passed. Nothing committed, pushed, or deployed.

### Still open for Chase

Items 1–4 of the previous section are unchanged: apply `0019` in the same release window as the
switcher flip, supply `CRON_SECRET`, confirm Fluid compute and the ~300s ceiling, and confirm the
Hobby cron cadence with `vercel crons ls` after a **production** deploy.
