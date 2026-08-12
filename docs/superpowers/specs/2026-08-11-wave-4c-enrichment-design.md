# Wave 4c — Enrichment on Node: design

**Status:** approved 2026-08-11. Supersedes the "blocked on an architecture decision" note in
`CLAUDE.md` and the wave-4c open question in `docs/superpowers/codex-workflow-notes.md`.

**Decision in one line:** enrichment moves to Vercel as a chunked, resumable job driven by
self-chaining invocations over the existing `enrich_jobs` table, with client-poll repair and a
daily janitor as fallbacks.

---

## The problem

Python gets detached work two ways: FastAPI `BackgroundTasks` (the intended production mode at
invite-only scale, per `docs/hosting.md:57`) and a dormant Redis/arq worker. Vercel has neither,
and a real enrichment run — throttled catalog requests, several per book — takes minutes to tens
of minutes, well past the function duration ceiling every existing Node route already uses
(`maxDuration = 300`, eight routes).

`POST /discover` is not a precedent: it completes inside one HTTP request.

## Constraints that decided it

1. **Railway/Python is fully decommissioned at wave 5 cutover.** So "leave enrichment on Python" is
   a deferral, not an answer, and any design needing a persistent worker process has nowhere to run.
2. **Vercel plan is Hobby.** Cron fires once per day. It cannot drive chunking; it can only janitor.
3. **Assumption to verify before implementation:** ~300s function duration requires Fluid compute.
   Eight routes already declare `maxDuration = 300` and run in production, which is good evidence
   it is enabled, but confirm it rather than inherit it.

## Constraints that made it cheap

1. **Enrichment is idempotent unless forced** — it skips books that already hold enrichment
   (`mylibrary/enrich.py`). "The next chunk" is therefore just "whichever books still lack
   enrichment": no cursor, no offset bookkeeping, no partial-chunk rollback.

   **A chunk is bounded by time, not by count.** It pulls unenriched books in small batches and
   keeps going until the ~240s budget is spent, then stops at a book boundary. There is no fixed
   chunk size to tune, and a slow catalog simply means fewer books per chunk rather than a chunk
   that overruns the function ceiling.
2. **Enrichment never calls Claude.** Pure catalog work — no per-user Anthropic key resolution, no
   usage tracking, no Anthropic spend in this wave.
3. **Node's `catalog.ts` already has the pacing twin** (`setRate`, `MYLIBRARY_REQ_PER_SEC`,
   `throttle()`), shipped in wave 3a.
4. **The job model already exists**: `enrich_jobs` is in the Drizzle schema, `/enrich/status`
   semantics are defined, `SetupWizard` polls every 2s, and wave 3a's Postgres-backed catalog cache
   means the Railway `/data` volume is no longer load-bearing.

## Options considered

| Option | Verdict |
|---|---|
| **A. Self-chaining chunks** + poll-repair + daily janitor | **Chosen.** No new vendors or cost; reuses the whole job model. Cost is that self-invocation is the fiddliest code in the design. |
| B. Client-driven chunking (browser loops the tick) | Simplest and honestly YAGNI-correct, but closing the tab stops the work — and the progress UI implies otherwise. |
| C. External queue (Upstash QStash) | Most reliable delivery, but a new vendor, secret, and signature verification to buy reliability that A's three fallback layers mostly provide at this scale. **Kept as the escape hatch:** it replaces only the re-arm step, leaving the job model untouched. |
| D. Keep enrichment on Python | Eliminated by constraint 1. |

---

## Wave split

Wave 4c splits in two, at the same seam that worked for wave 3c.

### 4c-1 — the enrichment core, fully synchronous

Port `enrich_library`: ISBN-then-search resolution order, HIGH/MEDIUM/LOW confidence scoring, match
method, the enrichment upsert, and skip-unless-`force`. Ship behind `POST /enrich`, the existing
synchronous compatibility endpoint — deliberately not rate-limited and not exposed in the hosted UI,
so it is a safe first landing. **No background machinery at all.**

This is where the *domain* risk lives: confidence scoring is the foundation of everything downstream
(locked decision #5).

### 4c-2 — the job mechanism

Lease columns and migration, `POST /enrich/start`, `GET /enrich/status/{job_id}`, the tick endpoint,
`waitUntil` chaining, poll-repair, the janitor cron, and the switcher flip.

This is where the *platform* risk lives. Splitting keeps a resolver bug and a chaining bug out of the
same diff.

---

## Architecture (4c-2)

> **CORRECTION, 2026-08-11 (post-inventory).** This spec originally said `waitUntil`. **That API is
> not reachable here.** Next `16.2.9`'s `next/server` exports `NextFetchEvent` — whose *instances*
> carry `waitUntil` — and route handlers in this repo receive plain `(Request, ctx)`, never a
> `NextFetchEvent`. `@vercel/functions`, which exports a standalone `waitUntil`, is not a
> dependency. The continuation mechanism is therefore **`after()` from `next/server`**, which the
> installed version does export and which is the Next-native "run this after the response is sent"
> primitive. The architecture is unchanged — fire a continuation after responding — only the API
> name differs. Adding `@vercel/functions` was the alternative and was rejected: `after()` needs no
> new dependency. Note that `after()` work still counts toward the function's duration, which is
> fine here because the continuation only *dispatches* a fetch; the chunk itself runs in the tick's
> own invocation with its own budget.

```
POST /enrich/start ──► create job row (pending)          [idempotent: see guards]
                       run chunk 1 inline ──► progress saved
                       after(fetch /api/enrich/tick)      [fire-and-forget]
                                    │
/api/enrich/tick  ◄─────────────────┘   secret-authed, NOT user-authed
   claim: UPDATE ... WHERE lease expired RETURNING   (atomic, one winner)
   work until ~240s budget, heartbeat progress
   if books remain AND progress was made ──► re-arm next tick
   else ──► terminal state
GET /enrich/status/{job_id}   user-authed, already polled every 2s
   if running AND lease expired ──► re-arm a tick        [repair layer]
daily cron /api/enrich/janitor                            [last-resort layer]
   re-arm orphans; fail jobs past STALE_JOB_SECONDS
```

Three properties make this safe rather than clever:

1. **Idempotency does the resumption** (see constraints above).
2. **The tick endpoint is secret-authenticated, not user-authenticated.** The work outlives the
   user's request and cannot carry their JWT. It takes a `job_id` and resolves ownership **from the
   job row** — it must never trust a `user_id` supplied by its caller.
3. **The lease makes double-invocation harmless.** Poll-repair and cron may fire simultaneously;
   the atomic claim means exactly one wins.

**Progress is derived, not accumulated.** Each chunk recomputes progress from the database rather
than incrementing a counter. Every crash mid-chunk is therefore harmless: no double-counting, and a
re-claim resumes exactly where reality is.

> **AMENDMENT, 2026-08-11 (post-inventory), approved by Chase.** The original rule — "count the
> user's books that hold enrichment rows" — is **wrong under `force`**, where every book already
> holds a row and progress would read 100% immediately. It also left a hole the plan draft caught:
> `POST /enrich/start` accepts `force` and `limit`, Python keeps them alive in the BackgroundTask
> closure, and a tick that receives only a `job_id` has no way to recover them.
>
> Resolution — **persist both on the job row** (`force boolean not null default false`,
> `limit integer null`), read by every tick, and make the progress rule **relative to the run**:
>
> - `processed_this_run` = books whose enrichment `resolved_at >= job.started_at`
> - `progress` = `processed_this_run` + (`force` ? 0 : books whose enrichment predates the run)
> - remaining work under `limit` = `limit - processed_this_run`
>
> For a non-forced run this collapses back to "every book holding an enrichment row", matching
> Python's `skipped + i` progress and `skipped + len(work)` total. It stays derived, so it stays
> crash-safe.
>
> **No ordering change is needed**, and none should be added: Python's book query has no `ORDER BY`
> (verified), so *which* books a `limit` selects was never a defined property. Selecting arbitrary
> unenriched books per tick is faithful to Python, and the count is what `limit` actually constrains.
>
> Practical exposure today is nil — `SetupWizard.tsx:565` is the only caller and passes neither
> option — but the API contract accepts both, and a tick silently ignoring `force` would "complete"
> a forced run having re-enriched only the first chunk.

---

## Spam and concurrency guards

Python has **no** guard: `worker.create_enrich_job` unconditionally inserts a new pending row, and
the only protection is SlowAPI's `5/minute`. Five clicks in a minute gives five concurrent jobs. On
one Railway process they share a throttle and partially collapse via idempotency; on Node with
chaining the same spam becomes five independent chains in five lambdas with five independent
throttles — strictly worse. **This is therefore a deliberate divergence from Python, recorded here.**

Defense in depth, cheapest layer first:

| Layer | Mechanism | Stops |
|---|---|---|
| 1 | `RATE_LIMITS.enrichStart` = 5/min per user (existing Postgres limiter) | Casual button-mashing; matches Python |
| 2 | Partial unique index on `enrich_jobs (user_id) WHERE status IN ('pending','running')` | A second concurrent job existing at all — race-proof |
| 3 | Lease claim on tick | Two processors on one job |
| 4 | `attempts` cap + no-progress detection | A bug re-arming forever |

**Layer 2 is the real fix, and it must be DB-enforced.** A read-then-write check loses exactly the
race that matters — the double-click. `POST /enrich/start` becomes **idempotent**: when an active job
exists it returns that job (200) instead of creating a second, and a unique violation from a lost
race is caught and resolved the same way (re-read, return the winner).

**Layer 4** guards a failure mode Python does not have: a chunk that processes zero books and still
re-arms. Rule: **re-arm only if the previous chunk made progress and work remains.** Zero progress
with work remaining is a stall — fail the job with a real error rather than loop.

### Known limitation, recorded deliberately

Node's throttle is module-level per lambda instance, so it does **not** coordinate across
concurrently-enriching *different* users the way Python's single process did. Acceptable at
invite-only scale. The fix, if it ever bites, is a Postgres token bucket. Written down now rather
than discovered later as a regression.

### Migration-ordering constraint

The partial unique index makes Python's unguarded `create_enrich_job` fail with an integrity error
while a Node job is active. **The migration must land with the switcher flip in 4c-2**, at which
point Python's `/enrich/start` is dead by design. The CLI is unaffected: `cli enrich` calls
`enrich_library` directly and never creates a job row.

---

## Schema changes

On `enrich_jobs`, via Alembic (Python owns migrations until wave 5) **and** the Drizzle schema:

| Change | Purpose |
|---|---|
| `lease_expires_at TIMESTAMP NULL` | The claim. Expired-or-null means claimable. |
| `attempts INTEGER NOT NULL DEFAULT 0` | Incremented per claim; feeds guard layer 4. |
| `force BOOLEAN NOT NULL DEFAULT false` | Run option that must survive across ticks (see amendment). |
| `limit INTEGER NULL` | Run option that must survive across ticks (see amendment). Quote the column name if `limit` is reserved in this context. |
| Partial unique index on `(user_id) WHERE status IN ('pending','running')` | Guard layer 2. |

`started_at` keeps its current meaning (first start) rather than being overloaded as a heartbeat, so
Python's existing `fail_if_stale` semantics stay intact and the UI stays honest.

New env var: **`CRON_SECRET`** — absent from `.env.example` today. Used by the tick and janitor
endpoints. Add the *name* to `.env.example`; Chase fills the value.

---

## Failure modes

| Failure | Recovery |
|---|---|
| Chunk throws (catalog 500, bad payload) | Lease expires → next trigger re-claims; finished books persist |
| Lambda killed at the duration ceiling | ~240s budget of 300s so the heartbeat write lands first; lease expiry re-claims |
| `waitUntil` fetch never delivers | Poll-repair (seconds, if watched) → janitor (worst case 24h) |
| User closes the tab | Chain continues — the reason A beat B |
| Catalog 429s | Surface the `http` block Python already returns; back off within the chunk |
| Job stuck `running` past `STALE_JOB_SECONDS` (1800) | `fail_if_stale` twin on status read (Python parity) + janitor |
| Two triggers race | Atomic lease claim; loser no-ops |
| Tick called by a stranger | Secret check; ownership resolved from the job row, never from caller input |

**Accepted weak point:** an unwatched job whose chain dies waits up to 24 hours for the daily
janitor — the price of Hobby's cron limit. It is recoverable and self-heals the moment the user
opens the app (poll-repair). If it proves annoying, option C replaces only the re-arm step.

---

## Testing

**4c-1** rides the existing pattern: replay recorded catalog HTTP (the wave-3c harness), then assert
enrichment rows field-for-field. Plus unit tests where a subtle port bug would be invisible:
HIGH/MEDIUM/LOW confidence boundaries, ISBN-then-search resolution order, skip-unless-`force`, and
the upsert shape.

> **CORRECTION, 2026-08-11 (post-inventory).** "The tests must actually race" is **not achievable
> with the current harness**, and the plan must not pretend otherwise. `helpers/pglite.ts` creates a
> single `PGlite` instance wrapped once by Drizzle, and production uses a one-connection postgres-js
> pool per module instance — so there is no way to open two genuinely overlapping transactions on
> separate connections in-process. No existing Node test races two writers; the one test labelled
> concurrency interleaves sequentially inside a fake client.
>
> What the in-process tests CAN prove, and must:
> - the partial unique index really rejects a second active job (sequential insert → violation),
>   which is the property that matters, since the index is what closes the double-click race;
> - the lease claim's conditional `UPDATE ... WHERE ... RETURNING` returns a row when claimable and
>   **no row** when not — atomicity of a single statement is Postgres's guarantee, not something a
>   test needs to re-derive;
> - every guard built on those: attempts cap, no-progress stall, status re-arm, secret check.
>
> What they CANNOT prove is true simultaneity. The plan must **state that limitation explicitly**
> rather than write a sequential test and describe it as a race. If a real race test is wanted, it
> belongs in a separate human-run integration path against a real Postgres, not in the Vitest suite.

**4c-2 is concurrency, so the tests must be honest about what they prove:**

- Two simultaneous claims on one job → exactly one winner, one no-op
- Two simultaneous `POST /enrich/start` → exactly one job row (proves the index, not just the check)
- A chunk making zero progress with work remaining → job fails, does **not** re-arm
- `attempts` past the cap → fails with a real error
- Status read on an expired lease → re-arms
- Tick without the secret → 401; with it → 200
- Rate limit exercised through the real handler, following `ratelimit-routes.test.ts`

**Workflow constraint the plan must encode:** Codex cannot run `npm install`, pytest (anything
importing FastAPI's `TestClient`, which `tests/conftest.py` does), or the fixture recorders.
Recording the catalog fixtures for 4c-1 is Claude's or Chase's work, and the plan must say so rather
than hand Codex a step it can only fake.

**Live verification is required** per the global rule: import → enrich → watch the progress bar →
confirm enrichment rows. Nothing here counts as verified from tests alone.

---

## Out of scope

- Admin routes and the Python cutover (wave 5).
- Any Redis/arq port. arq is dormant in production and dies with Railway.
- A global cross-user rate coordinator (see known limitation).
- Replacing the re-arm mechanism with QStash — kept as a documented escape hatch, not built.
