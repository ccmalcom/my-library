# Design: Worker retirement + cache persistence (efficiency / cost)

Date: 2026-06-26
Status: approved (design) — pending implementation plan
Owner: Chase

## Problem

The hosted deployment (Railway web + worker, Upstash Redis, Supabase) is over-provisioned
for an invite-only / free launch and will hit free-tier limits from *idle* cost, not real work.

Measured from the installed `arq 0.28.0` source (`.venv/Lib/site-packages/arq/worker.py`):

- `WorkerSettings` uses all arq defaults: `poll_delay = 0.5s`.
- An **idle** `_poll_iteration` issues exactly **1 Redis command** (`zrangebyscore`).
  `allow_abort_jobs` defaults to `False` (no abort traffic); `record_health` early-returns
  except once per `health_check_interval` (3600s).
- Idle cost: ~2 commands/sec = ~172,800/day = **~5.18M commands/month**, doing nothing.

That is ~10x the Upstash free-tier monthly command allotment, and ~$10/month even on
pay-as-you-go — for an idle worker. Real enrich jobs add a trivial few dozen commands each,
so **>99% of Upstash usage is idle polling.**

Two secondary inefficiencies compound it:

- **Two always-on Railway services**, one (the worker) idle 24/7 holding a reserved container.
- **Ephemeral filesystem defeats the catalog cache.** `railway.json` mounts no volume, so
  `data/cache/` is wiped on every deploy/restart and is not shared between the web and worker
  containers (separate filesystems). `catalog.py`'s "cache every response so re-runs never
  re-hit the network" guarantee largely does not hold in production, pushing avoidable load
  onto Open Library and the **shared** Google Books quota.

## Goals

1. Eliminate the dominant Upstash cost and the idle Railway worker service.
2. Keep enrichment robust when it now runs as a FastAPI BackgroundTask in the web process
   (notably: survive / recover cleanly from a web redeploy mid-job).
3. Make the catalog cache persistent so external-API load drops.

Non-goals: removing arq from the codebase; horizontal scaling of the web service; changing
the recommender or profile pipelines.

## Locked decisions

- **Keep arq dormant, do not delete it.** `worker.py` and the `enrich_start` enqueue branch
  stay; they are simply not activated in production (`REDIS_URL` unset). This preserves a
  one-env-var path back to a dedicated worker if scale ever demands it.
- **BackgroundTasks becomes the intended production mode**, not a "local dev fallback." Docs
  and comments reword accordingly.
- **No schema migration.** Dead-job hardening uses only existing `EnrichJob` columns
  (`status`, `started_at`).
- **Staleness cap = 30 minutes.** Generous enough for a large first-import enrich; revisit if
  real libraries legitimately run longer.

## Architecture

### Current (hosted)
```
Vercel ──HTTP──> Railway web (uvicorn) ──enqueue──> Upstash Redis ──> Railway worker (arq)
                       │                                                      │
                       └──────────────── Supabase Postgres ◄─────────────────┘
```
`enrich_start` enqueues to arq because `REDIS_URL` is set, so `app.state.arq_pool` is non-None.

### Target (hosted)
```
Vercel ──HTTP──> Railway web (uvicorn)
                       │  enrich runs as a FastAPI BackgroundTask (run_enrich_job in threadpool)
                       │  catalog cache on a persistent Railway volume (/data)
                       └── Supabase Postgres
```
`REDIS_URL` unset → `arq_pool` is None → `enrich_start` takes the existing BackgroundTask
branch. No Upstash, no worker service.

The dual-path code is unchanged in shape; only its production *configuration* changes, plus the
three hardening/persistence additions below.

## Phases

The three tracks are independent and can ship in order. Track 1 alone already captures the cost
win; 2 and 3 harden and optimize it.

### Phase 1 — Retire worker + Upstash (core)

Primarily operational; code changes are cosmetic.

- **Railway:** unset `REDIS_URL` on the web service; delete the worker service.
- **Behavior:** `enrich_start` (`api.py:337`) falls back to
  `background_tasks.add_task(run_enrich_job, ...)`. `run_enrich_job` is a sync `def`, so
  Starlette runs it in its AnyIO threadpool (default 40 workers) — it does not block the event
  loop. Adequate for invite-only concurrency.
- **Code:** reword the "local dev fallback" comments in `api.py` and `worker.py` to state that
  BackgroundTasks is the supported production mode and arq is opt-in via `REDIS_URL`. No logic
  change.

### Phase 2 — Dead-job hardening

A web redeploy/restart kills an in-flight BackgroundTask, leaving an `EnrichJob` stuck
`pending`/`running` that the frontend polls forever. Two layers, no migration:

- **Startup recovery (primary)** — in `lifespan` (`api.py:90`), on boot, mark every job still
  `pending`/`running` as `error` with message "interrupted by restart" and set `finished_at`.
  A fresh boot means no in-process BackgroundTask survived, so this is deterministic.
  **Gated on `settings.redis_url is None`**: in arq mode the worker is a separate process and a
  web restart must not kill live jobs.
  - Single-instance caveat (documented): if the web service is ever scaled to >1 instance,
    one instance booting would wrongly error another's live jobs. Acceptable for invite-only;
    revisit before horizontal scale.
  - Query is global (not user-scoped): it is a system-recovery sweep.
- **Staleness cap (defense-in-depth)** — `enrich_status` (`api.py:378`) treats a `running` job
  whose `started_at` is older than 30 minutes as `error` on read (covers an in-process hang
  without a restart). Computed from the existing `started_at`; no new column.
- **Frontend** — already branches on `status === 'error'`. Ensure the error state shows a
  friendly "enrichment was interrupted — retry" using the existing retry path
  (`SetupWizard.tsx` enrich step). Minimal change.

### Phase 3 — Persist catalog cache

- **Railway:** attach a volume (mount `/data`, ~1 GB) to the web service; set
  `MYLIBRARY_DATA_DIR=/data`.
- **Code:** none — `config._resolve_data_dir` (`config.py:106`) already honors
  `MYLIBRARY_DATA_DIR`.
- **Scope of the volume:** in hosted mode the DB is Postgres and `init_db` returns early, so the
  volume holds only the **catalog cache** (`data/cache/`) and uploaded CSVs
  (`data/goodreads_library_export.csv`) — both benefit from persistence.
- **Synergy with Phase 1:** with the worker gone, enrich and recommend run in the same web
  process and finally share one cache. (Railway volumes are per-service and cannot be shared
  across services, so this only works *because* there is now a single service.)

### Docs / ops (accompanies the phases)

- `CLAUDE.md` Phase 4/5 notes: BackgroundTasks is the default production path; arq is opt-in via
  `REDIS_URL`; the volume holds the cache; startup recovery + staleness cap exist.
- `mylibrary-phase5-deploy-runbook.md`: mark the worker service + Upstash as optional; add the
  volume + `MYLIBRARY_DATA_DIR` steps; note `REDIS_URL` unset for the BackgroundTask mode.

## Testing

- **Unit:** startup recovery flips orphaned `pending`/`running` jobs to `error`, and is a no-op
  when `REDIS_URL` is set.
- **Unit:** `enrich_status` reports a `running` job older than the 30-min cap as `error`.
- **Regression:** existing enrich / BackgroundTask tests stay green.
- **Manual smoke (live):** run an enrich to `done` via BackgroundTasks; redeploy mid-job and
  confirm the job flips to `error` and the frontend offers retry; confirm the catalog cache
  persists across a redeploy (a repeated search/enrich does not re-hit the network).

## Risks

- **Threadpool saturation:** many simultaneous enrich jobs could exhaust the 40-worker AnyIO
  pool. Acceptable at invite-only scale; if it bites, re-enable arq via `REDIS_URL`.
- **Single web instance assumption** for startup recovery (see Phase 2 caveat).
- **Volume size:** catalog JSON is small; 1 GB is generous. Monitor and resize if needed.
