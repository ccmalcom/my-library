# Hosting & Deployment — ShelfSprite

## Current runtime

ShelfSprite is one Next.js application deployed on Vercel. Pages and same-origin `/api` route
handlers run from `frontend/`; server modules access Supabase Postgres through drizzle-orm and
verify Supabase sessions through JWKS. There is no separate web service or resident worker.

The product is invite-only. Users may store an encrypted Anthropic key, with a server-level key as
fallback, and the Google Books integration may use a shared server key.

## Configuration ownership

Application environment variables live in **Vercel project settings**. Auth redirect policy,
users, and other Supabase-managed settings live in the **Supabase dashboard**. Treat both as part
of the deployed system: a missing variable or dashboard allowlist entry is not repairable with a
code-only change.

Current source readers under `frontend/lib`, `frontend/app`, and `frontend/utils` use:

| Variable                               | Purpose                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                         | Supabase Postgres connection used by `getDb`; required for data access.  |
| `NEXT_PUBLIC_SUPABASE_URL`             | Browser Supabase client and server-side fallback for the project URL.    |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser/session middleware key.                                          |
| `SUPABASE_URL`                         | Preferred server-side Supabase URL for JWKS and admin calls.             |
| `SUPABASE_JWKS_URL`                    | Optional explicit JWKS endpoint override.                                |
| `SUPABASE_SECRET_KEY`                  | Server-only GoTrue admin credential for invite/list/delete calls.        |
| `ADMIN_EMAILS`                         | Comma-separated, case-insensitive admin allowlist.                       |
| `FRONTEND_URL`                         | Public app origin used to build invite `redirect_to`; no trailing slash. |
| `ENCRYPTION_KEY`                       | AES-256-GCM key for stored per-user Anthropic credentials.               |
| `ANTHROPIC_API_KEY`                    | Server fallback when a user has no stored key.                           |
| `GOOGLE_BOOKS_API_KEY`                 | Optional Google Books credential.                                        |
| `MYLIBRARY_MODEL`                      | Claude model override; defaults to `claude-sonnet-5`.                    |
| `MYLIBRARY_REQ_PER_SEC`                | Catalog request-rate override.                                           |
| `MYLIBRARY_MONTHLY_SOFT_CAP_USD`       | Per-user monthly visibility cap; warn-only.                              |
| `MYLIBRARY_USAGE_WARN_THRESHOLD`       | Fraction of the soft cap at which the warning appears.                   |
| `FEEDBACK_PROMPTS_ENABLED`             | Global targeted-feedback prompt switch; defaults to `true`.              |
| `FEEDBACK_SNOOZE_HOURS`                | Prompt snooze period; defaults to 72 hours.                              |
| `CRON_SECRET`                          | Bearer secret for enrichment tick and janitor routes.                    |

`getDb` requires Postgres even when auth is disabled. When the public Supabase variables are
absent, page middleware is a no-op. API auth resolves the single `local` user only when no
`SUPABASE_URL`, public project URL, or explicit JWKS URL enables bearer verification; that is the
current local-development mode.

### Invite redirect configuration

`supabaseAdmin.ts#inviteUser` includes
`redirect_to=<FRONTEND_URL>/auth/callback` only when `FRONTEND_URL` is set. The exact callback URL
must also appear in Supabase Auth → URL Configuration → Redirect URLs. If either half is absent,
GoTrue falls back to its configured Site URL and invite tokens can land on a page that does not
establish the session. Because the app is invite-only, this configuration is load-bearing.

At the 2026-08-14 retirement capture, `FRONTEND_URL` was absent from Vercel. The open remediation
is recorded in `todo.md`; do not assume an external setting changed merely because the code is
correct.

## Railway's environment, recorded at retirement (2026-08-14)

Railway's variable set was captured before the service disappeared. Only names were recorded;
values were never read. Eleven variables were present:

`ADMIN_EMAILS`, `CORS_ORIGINS`, `DATABASE_URL`, `ENCRYPTION_KEY`, `FEEDBACK_PROMPTS_ENABLED`,
`FEEDBACK_SNOOZE_HOURS`, `FRONTEND_URL`, `GOOGLE_BOOKS_API_KEY`, `MYLIBRARY_DATA_DIR`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`.

Two absences were findings. `REDIS_URL` was never set, confirming that the optional queue was not
the production path. None of the four `MYLIBRARY_*` tuning variables (`MODEL`, `REQ_PER_SEC`,
`MONTHLY_SOFT_CAP_USD`, `USAGE_WARN_THRESHOLD`) was set, so the retired service used code
defaults.

`CORS_ORIGINS` and `MYLIBRARY_DATA_DIR` died with that service: same-origin route handlers need no
CORS setting, and catalog caching is in Postgres. `SUPABASE_SERVICE_ROLE_KEY` was the old name for
the credential now read as `SUPABASE_SECRET_KEY` in Vercel.

Three values used by the current app were present on Railway and absent from Vercel at capture
time:

| Variable                   | Current reader                | Fallback when unset | Retirement finding                            |
| -------------------------- | ----------------------------- | ------------------- | --------------------------------------------- |
| `FEEDBACK_SNOOZE_HOURS`    | `feedbackPrompts.ts`          | `72`                | Benign.                                       |
| `FEEDBACK_PROMPTS_ENABLED` | `feedbackPrompts.ts`          | `true`              | Benign only if the old value was also `true`. |
| `FRONTEND_URL`             | `supabaseAdmin.ts#inviteUser` | Omits `redirect_to` | Invite configuration defect until set.        |

The value of `FEEDBACK_PROMPTS_ENABLED` was masked during the capture and remains an open question.
If Railway held `false`, leaving it unset in Vercel silently re-enabled targeted prompts. Preserve
this question until the old value is independently confirmed or the desired current value is set
explicitly.

## Vercel cron and enrichment continuation

`frontend/vercel.json` registers one cron:

```text
/api/enrich/janitor  17 3 * * *
```

Vercel cron jobs run against **production deployments only**. Preview deployments do not exercise
this schedule. When `CRON_SECRET` exists, Vercel sends it as `Authorization: Bearer
$CRON_SECRET`; `isValidCronSecret` fails closed when the value or header is absent.

The enrichment flow is serverless:

- `POST /api/enrich/start` creates/claims a durable job and runs one bounded chunk.
- `frontend/app/api/enrich/start/route.ts` and `tick/route.ts` each export the literal
  `maxDuration = 300`.
- `CHUNK_BUDGET_MS = 240_000` stops work below that function ceiling.
- `rearmAfterResponse` uses Next's `after()` to send only the job ID to
  `POST /api/enrich/tick`; chunk work never runs inside `after()`.
- `GET /api/enrich/status/{job_id}` can repair an active reclaimable job during polling.
- The janitor calls `repairActiveJobs` to mark stale work failed or re-arm an expired/null lease.

Dispatch failures are guarded. `runClaimedChunk` preserves progress and returns `rearmed: false`
when synchronous scheduling fails; `repairActiveJobs` catches failures per job and reports them in
`dispatchFailed`. This is recoverable, not self-healing: if a missing `CRON_SECRET` also prevents
the janitor from authenticating, the job remains intact but cannot resume until configuration is
fixed and a healthy repair path runs.

`frontend/proxy.ts` must continue to exclude `api`. Internal tick and cron calls carry a bearer
secret but no Supabase session cookie; when page middleware matched `/api/*`, it redirected those
requests to `/login`. A 307 did not throw, so the failure looked like successful scheduling.
`rearmAfterResponse` now checks `response.ok` and logs non-2xx outcomes.

### Continuation verification caveat

Continuation can be tested reliably only through the production custom domain. The dispatcher
builds the tick URL from the request origin. Vercel deployment protection can intercept a preview
self-fetch before the route handler sees `CRON_SECRET`, producing the same symptom as a broken
secret. Do not diagnose that path from a protected preview URL.

A useful smoke test must force more than one chunk. Tick count alone is insufficient: status-poll
repair can schedule repeated ticks while progress remains frozen. Require both a successful tick
invocation and persisted progress advancing across the chunk boundary.

Production verification on 2026-08-13 used a temporary 100-second chunk budget and a forced
159-book run. One tick advanced the job across the boundary and it completed at 159/159; the budget
was restored to 240 seconds immediately afterward. This proves start→tick continuation. It does
**not** prove tick→tick chaining, because the first tick completed the remaining work. Exercising
that caveat requires a substantially larger library or a temporary budget near 40 seconds.

The scheduled janitor's first observed run remains an operational follow-up in `todo.md`. Vercel's
runtime-log retention did not cover the original observation window, so an absent log line was not
evidence that the cron failed.

## Database migrations: drizzle-kit

All new migrations use drizzle-kit from `frontend/`:

```bash
cd frontend
npm run db:generate
# inspect drizzle/NNNN_*.sql before continuing
npm run db:migrate
```

`drizzle-kit generate` compares `lib/server/schema.ts` with `drizzle/meta/*.json`. It **never reads
the database**, so an empty diff says nothing about production drift. Verify production columns,
nullability, and defaults through direct database introspection.

Always inspect generated SQL. A drop-and-recreate for a `books` type change can destroy ratings;
type changes must be expressed as an in-place `ALTER COLUMN ... TYPE ... USING ...` operation.
`0001_half_star_ratings.sql` is the worked example.

Migrations are manual and never part of `npm run build`. Vercel builds may run concurrently for
production, previews, and rollbacks; applying schema changes there can race or target the wrong
database. Apply a reviewed migration in a deliberate release window against a known
`DATABASE_URL`.

### Baseline adoption and schema drift

`drizzle/0000_baseline.sql` snapshots the production schema that already existed. It was stamped,
not executed: `npm run db:stamp-baseline` records only migration `0000` in drizzle's ledger after
confirming `public.books` exists. Later migrations must be applied normally; stamping them would
mark real work complete without running its SQL.

The baseline came from a production `pg_dump`, never from a fresh `alembic upgrade head`. The two
lineages gave `enrich_jobs.progress` and `total` different, legitimate server-default shapes.
Current code is compatible with both because job creation explicitly supplies `progress: 0` and
`total: 0`, and `NewJobValues` keeps those fields required at compile time.

`0002_align_nullability.sql` is intentionally hand-written. The checked-in schema and snapshots
already said the affected fields were not null, so generate could not detect that the live
database differed. It is safe on both lineages because setting NOT NULL on an already-NOT NULL
column is a no-op.

Server defaults that remain only in production do not need to be copied into the drizzle schema
when application inserts always supply the values. Adding such defaults to `schema.ts` can weaken
drizzle's inferred insert type and remove useful compile-time checks.

## Retired migration and deployment history

Alembic owned the production schema while the retired service was live and stopped at
`0019_add_enrich_job_leases`. The database's historical `alembic_version` row and the deleted
`alembic/versions/` chain explain the lineage from which `0000_baseline.sql` was captured; neither
is a live migration mechanism now. Do not author a new legacy revision or restore migration-on-boot
behavior.

The old container ran `alembic upgrade head` before binding its web port. That made a deployment
depend on the image containing the database's recorded revision and caused a real failure when a
migration was applied from a branch the deployed image did not contain. This remains useful
history, but it is not a Vercel runbook: current schema changes follow the manual drizzle workflow
above.
