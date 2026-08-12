# Wave 4c-2 repository inventory

Read-only inspection only; no files were changed.

## 1. Python job API and worker semantics

### `POST /enrich/start`

The request body is `EnrichStartRequest`, with fields in this order:

1. `force: bool = False`
2. `limit: int | None = None`

The body is required because the route parameter has no default. [mylibrary/schemas.py:25](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:25) [mylibrary/api.py:519](/home/chase/Documents/Code/my-library/mylibrary/api.py:519)

The response model is `EnrichJobOut`, serialized in this exact declared key order:

1. `job_id: str`
2. `status: str`
3. `progress: int`
4. `total: int`
5. `error: str | null`
6. `started_at: datetime | null`
7. `finished_at: datetime | null`

The last three fields default to `None`; the first four are required by the response model. ORM-object validation is enabled with `from_attributes=True`. [mylibrary/schemas.py:32](/home/chase/Documents/Code/my-library/mylibrary/schemas.py:32)

The route has no explicit `status_code`, so successful creation returns FastAPI’s default `200`, not `201` or `202`. It is limited to `5/minute`. [mylibrary/api.py:517](/home/chase/Documents/Code/my-library/mylibrary/api.py:517)

Authentication is mandatory through the `user_id: UserId` dependency. `UserId` calls `current_user`, which verifies the Supabase bearer JWT when configured or resolves to local single-user mode; authentication failures become `401`. [mylibrary/api.py:219](/home/chase/Documents/Code/my-library/mylibrary/api.py:219) [mylibrary/api.py:238](/home/chase/Documents/Code/my-library/mylibrary/api.py:238) [mylibrary/api.py:523](/home/chase/Documents/Code/my-library/mylibrary/api.py:523)

Rate limiting is per resolved user because `current_user` stores the ID in `request.state.user_id`, and `_rate_limit_key` reads it. The fallback key for unauthenticated requests is client IP or `"unknown"`. [mylibrary/api.py:137](/home/chase/Documents/Code/my-library/mylibrary/api.py:137) [mylibrary/api.py:227](/home/chase/Documents/Code/my-library/mylibrary/api.py:227)

Execution sequence:

1. `create_enrich_job(user_id)` inserts the pending row.
2. If `request.app.state.arq_pool` exists, it enqueues `enrich_books` with `job_id`, authenticated `user_id`, `force`, and `limit`.
3. Otherwise it registers `run_enrich_job` as a FastAPI `BackgroundTask` with the same arguments.
4. It rereads the row by `job_id` and validates it into `EnrichJobOut`.

[mylibrary/api.py:531](/home/chase/Documents/Code/my-library/mylibrary/api.py:531)

Relevant status outcomes are:

- `200`: normal response.
- `401`: invalid/missing authentication in hosted auth mode.
- `422`: invalid or missing body under FastAPI/Pydantic validation.
- `429`: more than five calls in the minute window.
- `500`: unhandled database/enqueue/reread failures.

The SlowAPI exception handler is installed unchanged. [mylibrary/api.py:177](/home/chase/Documents/Code/my-library/mylibrary/api.py:177)

### `GET /enrich/status/{job_id}`

This route is also user-authenticated via `UserId`; it is not rate-limited. [mylibrary/api.py:559](/home/chase/Documents/Code/my-library/mylibrary/api.py:559)

It queries on both `job_id` and the authenticated `user_id`, deliberately making a foreign user’s job indistinguishable from a nonexistent job. A miss returns:

```json
{"detail":"Job 'the-id' not found"}
```

with status `404`. [mylibrary/api.py:565](/home/chase/Documents/Code/my-library/mylibrary/api.py:565)

Before returning, it runs `fail_if_stale(session, job)`, so a status read can mutate an old running job to `error`. The response is the same seven-field `EnrichJobOut`, with the same key order. [mylibrary/api.py:571](/home/chase/Documents/Code/my-library/mylibrary/api.py:571)

Normal status codes are `200`, `401`, `404`, and `500`.

### `create_enrich_job`

Exact signature:

```python
def create_enrich_job(user_id: str) -> str
```

It generates a string UUID using `str(uuid.uuid4())`, inserts exactly:

- `job_id = generated UUID`
- `user_id = supplied user`
- `status = "pending"`

and returns the ID after the `session_scope` commits. It does not explicitly write `progress`, `total`, timestamps, `error`, or `created_at`; their defaults apply. It performs no active-job lookup, no unique-race handling, and no concurrency guard. [mylibrary/worker.py:177](/home/chase/Documents/Code/my-library/mylibrary/worker.py:177) [mylibrary/worker.py:182](/home/chase/Documents/Code/my-library/mylibrary/worker.py:182)

### `run_enrich_job`

Exact signature:

```python
def run_enrich_job(
    job_id: str,
    user_id: str,
    force: bool = False,
    limit: int | None = None,
) -> None
```

[mylibrary/worker.py:94](/home/chase/Documents/Code/my-library/mylibrary/worker.py:94)

Transitions and writes:

| Point | Condition | Fields written |
|---|---|---|
| Initial claim/start | Row exists | `status = "running"`, `started_at = utcnow()` |
| Initial miss | Row deleted/missing | Returns without work |
| Progress flush | `done == 0`, label is `"starting"`, `done == total`, or at least five books since prior flush | `progress = done`, `total = total` |
| Success | Row still exists after `enrich_library` | `status = "done"`, `finished_at = utcnow()`, `progress = summary["skipped_existing"] + summary["processed"]`, `total = summary["total"]` |
| Exception | Row still exists | `status = "error"`, `finished_at = utcnow()`, `error = str(exc)[:2000]`; then the exception is re-raised |

[mylibrary/worker.py:107](/home/chase/Documents/Code/my-library/mylibrary/worker.py:107) [mylibrary/worker.py:117](/home/chase/Documents/Code/my-library/mylibrary/worker.py:117) [mylibrary/worker.py:127](/home/chase/Documents/Code/my-library/mylibrary/worker.py:127) [mylibrary/worker.py:134](/home/chase/Documents/Code/my-library/mylibrary/worker.py:134) [mylibrary/worker.py:141](/home/chase/Documents/Code/my-library/mylibrary/worker.py:141)

Notably:

- Starting does not reset `progress`, `total`, `error`, or `finished_at`.
- Success does not clear an existing `error`.
- Error preserves the last saved progress/total.
- Each state/progress write uses a separate `session_scope`, so completed progress survives later failure.
- Progress is flushed at startup/end and otherwise every five books, not every book.

Those behaviors follow directly from the isolated write blocks. [mylibrary/worker.py:108](/home/chase/Documents/Code/my-library/mylibrary/worker.py:108) [mylibrary/worker.py:121](/home/chase/Documents/Code/my-library/mylibrary/worker.py:121)

### `fail_if_stale`

Exact signature:

```python
def fail_if_stale(
    session,
    job: EnrichJob,
    *,
    now: datetime | None = None,
) -> EnrichJob
```

The threshold is `STALE_JOB_SECONDS = 1800`. [mylibrary/worker.py:62](/home/chase/Documents/Code/my-library/mylibrary/worker.py:62)

It is a no-op if either:

- `status != "running"`, or
- `started_at is None`.

It normalizes aware datetimes to naive values before subtraction. It fails a job only when age is strictly greater than 1,800 seconds—not equal to it. At failure it writes:

- `status = "error"`
- `error = "Enrichment was interrupted, please retry."`
- `finished_at = now`

It returns the same job object and relies on the caller’s session to commit. [mylibrary/worker.py:65](/home/chase/Documents/Code/my-library/mylibrary/worker.py:65)

### `recover_orphaned_jobs`

Exact signature:

```python
def recover_orphaned_jobs() -> int
```

It returns immediately with `0` when `REDIS_URL` is configured because a separate arq worker may still own the jobs. [mylibrary/worker.py:35](/home/chase/Documents/Code/my-library/mylibrary/worker.py:35)

Without Redis, it finds every row whose status is either `pending` or `running`, and writes on each:

- `status = "error"`
- `error = "Enrichment was interrupted, please retry."`
- `finished_at = utcnow()`

It leaves `progress`, `total`, `started_at`, and `created_at` untouched and returns the number changed. [mylibrary/worker.py:48](/home/chase/Documents/Code/my-library/mylibrary/worker.py:48)

It runs during FastAPI startup immediately after `init_db()`. [mylibrary/api.py:147](/home/chase/Documents/Code/my-library/mylibrary/api.py:147)

## 2. `enrich_jobs` schema in both ORMs

### SQLAlchemy declaration

| Column | SQLAlchemy type | Nullability | Default | Index/constraint |
|---|---|---:|---|---|
| `id` | `Integer` | non-null PK | database/autoincrement PK behavior | primary key |
| `job_id` | `String` | non-null | none | `unique=True`, `index=True` |
| `user_id` | `String` | non-null | Python default and server default `LOCAL_USER_ID` (`"local"`) | non-unique index |
| `status` | `String` | inferred non-null from `Mapped[str]` | Python-side `"pending"` only | none |
| `progress` | `Integer` | inferred non-null | Python-side `0` only | none |
| `total` | `Integer` | inferred non-null | Python-side `0` only | none |
| `started_at` | `DateTime` | nullable | `None` | none |
| `finished_at` | `DateTime` | nullable | `None` | none |
| `error` | `Text` | nullable | `None` | none |
| `created_at` | `DateTime` | inferred non-null | server `now()` | none |

[mylibrary/db.py:250](/home/chase/Documents/Code/my-library/mylibrary/db.py:250)

The creating migration makes the database defaults explicit for `status`, `progress`, and `total`: `"pending"`, `0`, and `0`. It also declares nullable timestamps/error and a non-null `created_at` using `now()`. [alembic/versions/0003_add_enrich_jobs.py:35](/home/chase/Documents/Code/my-library/alembic/versions/0003_add_enrich_jobs.py:35)

### Drizzle declaration

| Column/property | Drizzle type | Nullability | Default | Index/constraint |
|---|---|---:|---|---|
| `id` | `serial` | non-null | serial sequence | primary key |
| `jobId` / `job_id` | `varchar` | non-null | none | unique btree index `ix_enrich_jobs_job_id` using `text_ops` |
| `userId` / `user_id` | `varchar` | non-null | `'local'` | btree index `ix_enrich_jobs_user_id` using `text_ops` |
| `status` | `varchar` | non-null | `'pending'` | none |
| `progress` | `integer` | non-null | `0` | none |
| `total` | `integer` | non-null | `0` | none |
| `startedAt` / `started_at` | timestamp, string mode | nullable | none | none |
| `finishedAt` / `finished_at` | timestamp, string mode | nullable | none | none |
| `error` | `text` | nullable | none | none |
| `createdAt` / `created_at` | timestamp, string mode | non-null | `defaultNow()` | none |

[frontend/lib/server/schema.ts:153](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:153)

### Drift

There is no material database-shape drift between the current Alembic-created table and Drizzle.

There is ORM-metadata drift: SQLAlchemy records `status`, `progress`, and `total` as Python/client defaults, whereas Drizzle records the server defaults that Alembic installed. [mylibrary/db.py:270](/home/chase/Documents/Code/my-library/mylibrary/db.py:270) [alembic/versions/0003_add_enrich_jobs.py:46](/home/chase/Documents/Code/my-library/alembic/versions/0003_add_enrich_jobs.py:46) [frontend/lib/server/schema.ts:157](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:157)

Neither declaration currently contains:

- `lease_expires_at`
- `attempts`
- a partial unique active-job index

Those are explicitly required by the approved design. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:159](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:159)

## 3. Alembic conventions and Drizzle synchronization

Migrations live in `alembic/versions/`; `alembic.ini` points `script_location` at `alembic` and sets generated filenames to `%(rev)s_%(slug)s`. [alembic.ini:3](/home/chase/Documents/Code/my-library/alembic.ini:3)

The revision chain primarily uses readable sequence IDs such as `0017_user_directive` and `0018_node_wave0_tables`. One historical autogenerated hash, `fbc5292134c4`, sits between `0012` and `0013`. [alembic/versions/fbc5292134c4_add_enrichment_language.py:15](/home/chase/Documents/Code/my-library/alembic/versions/fbc5292134c4_add_enrichment_language.py:15) [alembic/versions/0018_node_wave0_tables.py:14](/home/chase/Documents/Code/my-library/alembic/versions/0018_node_wave0_tables.py:14)

The current head is `0018_node_wave0_tables`, revising `0017_user_directive`. Its structure is:

- module docstring explaining ownership;
- `revision`, `down_revision`, `branch_labels`, and `depends_on`;
- `upgrade()` inspects existing tables and conditionally creates each;
- `downgrade()` drops the three tables in reverse order.

[alembic/versions/0018_node_wave0_tables.py:1](/home/chase/Documents/Code/my-library/alembic/versions/0018_node_wave0_tables.py:1)

That idempotent inspection pattern is intentional because the baseline uses live SQLAlchemy metadata; later migrations must guard against already-present objects. [docs/hosting.md:75](/home/chase/Documents/Code/my-library/docs/hosting.md:75)

`alembic/env.py` points `target_metadata` at `Base.metadata`, supports autogeneration, obtains the URL from `mylibrary.config`, and enables batch mode for SQLite-compatible alterations. [alembic/env.py:1](/home/chase/Documents/Code/my-library/alembic/env.py:1) [alembic/env.py:23](/home/chase/Documents/Code/my-library/alembic/env.py:23)

The repository does not preserve the literal shell invocation that created each historical revision. The supported generation form implied by the configured autogeneration environment is:

```bash
python -m alembic revision --autogenerate -m "<message>"
```

The exact checked-in deployment/apply command is:

```bash
python -m alembic upgrade head
```

[start.sh:9](/home/chase/Documents/Code/my-library/start.sh:9)

Python/Alembic remains the sole migration authority. Drizzle is refreshed by database introspection, not Drizzle migrations:

```bash
cd frontend
npx drizzle-kit pull
```

The generated `lib/server/drizzle-pull/schema.ts` is copied to `lib/server/schema.ts`, and the generated migration-shaped directory is then removed. [frontend/drizzle.config.ts:5](/home/chase/Documents/Code/my-library/frontend/drizzle.config.ts:5) [docs/superpowers/plans/2026-08-03-node-backend-wave-0.md:708](/home/chase/Documents/Code/my-library/docs/superpowers/plans/2026-08-03-node-backend-wave-0.md:708)

## 4. Node rate limiter

Module: `frontend/lib/server/ratelimit.ts`.

Exports:

```ts
export const RATE_LIMITS = { ... } as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimitExceededResponse(
  limit: number,
  windowSeconds: number
): Response;

export async function checkRateLimit(
  db: Db,
  opts: {
    key: string;
    limit: number;
    windowSeconds: number;
    nowMs?: number;
  }
): Promise<RateLimitResult>;
```

[frontend/lib/server/ratelimit.ts:13](/home/chase/Documents/Code/my-library/frontend/lib/server/ratelimit.ts:13) [frontend/lib/server/ratelimit.ts:21](/home/chase/Documents/Code/my-library/frontend/lib/server/ratelimit.ts:21) [frontend/lib/server/ratelimit.ts:43](/home/chase/Documents/Code/my-library/frontend/lib/server/ratelimit.ts:43) [frontend/lib/server/ratelimit.ts:52](/home/chase/Documents/Code/my-library/frontend/lib/server/ratelimit.ts:52)

Current entries are:

```ts
catalogSearch: { limit: 30, windowSeconds: 60 }
enrichStart:   { limit: 5,  windowSeconds: 60 }
directiveDraft:{ limit: 30, windowSeconds: 60 }
booksSimilar:  { limit: 15, windowSeconds: 60 }
discover:      { limit: 30, windowSeconds: 60 }
```

[frontend/lib/server/ratelimit.ts:13](/home/chase/Documents/Code/my-library/frontend/lib/server/ratelimit.ts:13)

Storage is the `rate_limits` table:

- `bucket_key varchar NOT NULL`
- `window_start integer NOT NULL`
- `count integer NOT NULL DEFAULT 0`
- composite primary key `(bucket_key, window_start)`

[frontend/lib/server/schema.ts:268](/home/chase/Documents/Code/my-library/frontend/lib/server/schema.ts:268) [alembic/versions/0018_node_wave0_tables.py:44](/home/chase/Documents/Code/my-library/alembic/versions/0018_node_wave0_tables.py:44)

The limiter performs one atomic `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count`, then deletes expired windows for that bucket. [frontend/lib/server/ratelimit.ts:59](/home/chase/Documents/Code/my-library/frontend/lib/server/ratelimit.ts:59)

A real route call site is:

```ts
const rl = await checkRateLimit(db, {
  key: `discover:${ctx.user.userId}`,
  ...RATE_LIMITS.discover,
});
if (!rl.allowed) {
  return rateLimitExceededResponse(
    RATE_LIMITS.discover.limit,
    RATE_LIMITS.discover.windowSeconds
  );
}
```

[frontend/app/api/discover/route.ts:45](/home/chase/Documents/Code/my-library/frontend/app/api/discover/route.ts:45)

The 429 response is deliberately:

```json
{"error":"Rate limit exceeded: N per 1 minute"}
```

with `content-type: application/json`, status `429`, and no rate-limit headers. [frontend/lib/server/ratelimit.ts:27](/home/chase/Documents/Code/my-library/frontend/lib/server/ratelimit.ts:27)

## 5. `withApi`, authentication, and internal secrets

A route opts out of user authentication by passing:

```ts
{ requireAuth: false }
```

as the third `withApi` argument. Authentication defaults to required because `opts.requireAuth ?? true` is used. [frontend/lib/server/http.ts:22](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:22) [frontend/lib/server/http.ts:35](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:35)

With `requireAuth: false` and no `requireAdmin`, `verifyRequestUser` is not called. The handler receives this synthetic context user:

```ts
{ userId: 'anonymous', email: null, isAdmin: false }
```

[frontend/lib/server/http.ts:51](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:51) [frontend/lib/server/http.ts:59](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:59)

The existing unauthenticated route is `/api/healthz`:

```ts
export const GET = withApi(
  '/api/healthz',
  async () => Response.json({ status: 'ok', backend: 'node' }),
  { requireAuth: false }
);
```

[frontend/app/api/healthz/route.ts:1](/home/chase/Documents/Code/my-library/frontend/app/api/healthz/route.ts:1)

Admin routes use `{ requireAdmin: true }`; this forces ordinary authentication and then tests `user.isAdmin`, returning `403` when false. [frontend/lib/server/http.ts:52](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:52) [frontend/app/api/admin/config/route.ts:8](/home/chase/Documents/Code/my-library/frontend/app/api/admin/config/route.ts:8)

There is no existing secret-authenticated route and no shared-secret/internal-call authentication helper anywhere under `frontend/`. The only route authentication mechanism is bearer-user authentication through `verifyRequestUser`; the only opt-out is the anonymous health check. [frontend/lib/server/http.ts:6](/home/chase/Documents/Code/my-library/frontend/lib/server/http.ts:6) [frontend/lib/server/auth.ts:51](/home/chase/Documents/Code/my-library/frontend/lib/server/auth.ts:51)

Therefore the tick/janitor secret check has no existing pattern to reuse.

## 6. Configured Next.js/Vercel capabilities

The frontend declares Next `^16.2.9`. [frontend/package.json:17](/home/chase/Documents/Code/my-library/frontend/package.json:17)

`next/server` does not export a standalone route-handler `waitUntil` function in this installed version. It exports `NextFetchEvent`, whose instance type has a `waitUntil(promise)` method, and it separately exports `after`. Route handlers in this repository receive standard `Request` plus route params, not a `NextFetchEvent`. [frontend/node_modules/next/server.d.ts:7](/home/chase/Documents/Code/my-library/frontend/node_modules/next/server.d.ts:7) [frontend/node_modules/next/server.d.ts:21](/home/chase/Documents/Code/my-library/frontend/node_modules/next/server.d.ts:21) [frontend/node_modules/next/dist/server/web/spec-extension/fetch-event.d.ts:16](/home/chase/Documents/Code/my-library/frontend/node_modules/next/dist/server/web/spec-extension/fetch-event.d.ts:16)

`@vercel/functions` is not declared in dependencies or devDependencies, so its `waitUntil` is not presently available as a direct project dependency. [frontend/package.json:17](/home/chase/Documents/Code/my-library/frontend/package.json:17)

Neither `waitUntil` nor `@vercel/functions` is imported anywhere in repository frontend source. The approved design itself confirms 4c-1 intentionally contained no `waitUntil` machinery. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:64](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:64)

There is no `vercel.json` in the repository.

Eight current routes declare duration identically:

```ts
export const maxDuration = 300;
```

They are:

- `/api/recommend`
- `/api/directive/draft`
- `/api/books/[id]/similar`
- `/api/discover`
- `/api/profile`
- `/api/profile/update`
- `/api/profile/archetype`
- `/api/profile/reveal-lines`

One concrete declaration is [frontend/app/api/discover/route.ts:8](/home/chase/Documents/Code/my-library/frontend/app/api/discover/route.ts:8).

No cron is configured today. There is no `vercel.json` cron entry or other deployed cron configuration; cron references currently occur only in planning/design documentation. The desired daily janitor is still a design requirement. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:96](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:96)

## 7. Transactions and concurrency primitives

`Db` is `PostgresJsDatabase<typeof schema>`, and transaction types are derived as:

```ts
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
```

Production uses postgres-js with `prepare: false` and `max: 1`. [frontend/lib/server/db.ts:8](/home/chase/Documents/Code/my-library/frontend/lib/server/db.ts:8) [frontend/lib/server/db.ts:24](/home/chase/Documents/Code/my-library/frontend/lib/server/db.ts:24)

Existing transaction use is callback-based:

```ts
const signal = await db.transaction(async (tx) => {
  const [signal] = await tx.insert(...).values(...).returning();
  ...
  await tx.update(...).set(...).where(...);
  return signal;
});
```

[frontend/app/api/taste-signal/route.ts:41](/home/chase/Documents/Code/my-library/frontend/app/api/taste-signal/route.ts:41)

Enrichment persistence also uses `db.transaction(async tx => ...)`, with an insert/upsert inside each transaction. [frontend/lib/server/enrichment.ts:141](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:141)

There is no existing application-source example of an atomic conditional:

```sql
UPDATE ... WHERE <claim condition> RETURNING ...
```

Existing updates have conditional `.where(...)`, including ownership predicates, but do not append `.returning()`. One example is the book-import update. [frontend/lib/server/import-books.ts:100](/home/chase/Documents/Code/my-library/frontend/lib/server/import-books.ts:100)

Drizzle’s installed PostgreSQL update builder does support both forms:

```ts
.returning()
.returning({ ...selectedFields })
```

[frontend/node_modules/drizzle-orm/pg-core/query-builders/update.d.ts](/home/chase/Documents/Code/my-library/frontend/node_modules/drizzle-orm/pg-core/query-builders/update.d.ts)

Thus the required lease claim is supported by the installed ORM, but would be a new repository usage pattern.

The code comments warn that using the root `db` while its sole connection is held by an open transaction deadlocks; transaction code must use the supplied `tx`. [frontend/lib/server/profileBuild.ts:250](/home/chase/Documents/Code/my-library/frontend/lib/server/profileBuild.ts:250)

## 8. Client API and `SetupWizard`

### Client API

`EnrichJobOut` exactly mirrors Python’s seven fields:

```ts
interface EnrichJobOut {
  job_id: string;
  status: string;
  progress: number;
  total: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}
```

[frontend/lib/api.ts:633](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:633)

`api.enrichStart` has this effective signature:

```ts
(opts?: { force?: boolean; limit?: number }) => Promise<EnrichJobOut>
```

It always posts both keys:

```json
{
  "force": false,
  "limit": null
}
```

when no options are supplied. [frontend/lib/api.ts:539](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:539)

`api.enrichStatus` has this effective signature:

```ts
(jobId: string) => Promise<EnrichJobOut>
```

and GETs `/enrich/status/${jobId}`. [frontend/lib/api.ts:549](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:549)

Both calls use the shared request helpers, which attach the Supabase access token as `Authorization: Bearer ...`, disable GET caching, and throw generic HTTP-status errors on non-2xx responses. [frontend/lib/api.ts:347](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:347) [frontend/lib/api.ts:364](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:364)

### Polling behavior

The interval is exactly `2,000 ms`. It uses recursive `setTimeout`, not `setInterval`. [frontend/components/SetupWizard.tsx:523](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:523)

On start it:

1. clears visible error;
2. resets progress and total to zero;
3. calls `api.enrichStart()` with no options;
4. reads `job.job_id` into state;
5. reads `job.status` into state;
6. schedules the first status poll after 2 seconds.

It does not initially copy `progress`, `total`, `error`, or timestamps from the start response. [frontend/components/SetupWizard.tsx:560](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:560)

Each successful poll reads exactly:

- `job.status`
- `job.progress`
- `job.total`
- `job.error` only when status is `"error"`

It does not read or render `started_at` or `finished_at`. [frontend/components/SetupWizard.tsx:541](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:541)

Terminal decisions:

- `"done"`: refreshes `stats` via SWR and calls `onDone()`.
- `"error"`: displays `job.error ?? "Enrichment failed."`.
- Any other status: schedules another poll in two seconds.
- A failed HTTP poll displays the thrown error and does not schedule another automatic poll.

[frontend/components/SetupWizard.tsx:547](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:547)

`running` UI is defined strictly as status `"pending"` or `"running"`. [frontend/components/SetupWizard.tsx:574](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:574)

Rendering:

- Pending: `Queued. Starting shortly…`
- Running: `Fetching covers and metadata from the public catalogs…`
- If `total > 0`: `progress / total books (pct%)`, a second percentage label, and a width-based progress bar.
- Percentage is `Math.round((progress / total) * 100)`.
- Before total is known, the computed label is `Starting…`, but the progress-bar block itself is hidden because it is conditional on `total > 0`.
- Errors render as danger text.
- A job-related error exposes a “Retry enrichment” button that clears job/status/error and starts a new job.

[frontend/components/SetupWizard.tsx:574](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:574) [frontend/components/SetupWizard.tsx:596](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:596) [frontend/components/SetupWizard.tsx:623](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:623)

The timeout is cleared on component unmount. [frontend/components/SetupWizard.tsx:535](/home/chase/Documents/Code/my-library/frontend/components/SetupWizard.tsx:535)

## 9. Wave 4c-1 enrichment exports

`frontend/lib/server/enrichment.ts` exports the following callable functions:

```ts
searchTitle(title: string | null): string

scoreCandidates(
  book: Pick<BookRow, 'title' | 'author'>,
  candidates: Candidate[]
): ScoredCandidate

resolveOne(
  db: Db,
  book: Pick<BookRow, 'title' | 'author' | 'isbn13'>,
  catalog?: EnrichmentCatalog
): Promise<ResolutionResult>

persistResolution(
  db: Db,
  bookId: number,
  result: ResolutionResult
): Promise<void>

enrichLibrary(
  db: Db,
  options: EnrichLibraryOptions
): Promise<EnrichmentSummary>
```

[frontend/lib/server/enrichment.ts:59](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:59) [frontend/lib/server/enrichment.ts:67](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:67) [frontend/lib/server/enrichment.ts:96](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:96) [frontend/lib/server/enrichment.ts:142](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:142) [frontend/lib/server/enrichment.ts:235](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:235)

The orchestration entry point is:

```ts
export async function enrichLibrary(
  db: Db,
  options: EnrichLibraryOptions
): Promise<EnrichmentSummary>
```

Its options are:

```ts
interface EnrichLibraryOptions {
  userId: string;
  force?: boolean;
  limit?: number | null;
  includeUnrated?: boolean;
  retryUnresolved?: boolean;
  requestsPerSecond?: number | null;
  progress?: EnrichmentProgress;
  resolver?: (
    db: Db,
    book: Pick<BookRow, 'id' | 'title' | 'author' | 'isbn13'>
  ) => Promise<ResolutionResult>;
}
```

[frontend/lib/server/enrichment.ts:210](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:210)

The progress callback signature is exactly:

```ts
type EnrichmentProgress = (
  completed: number,
  total: number,
  title: string,
  label: string
) => void;
```

It is synchronous—return type `void`, not `Promise<void>`. [frontend/lib/server/enrichment.ts:203](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:203)

It is called once at startup as:

```ts
progress(skipped, fullTotal, '', 'starting')
```

and once after every persisted book as:

```ts
progress(skipped + index + 1, fullTotal, book.title, progressLabel)
```

[frontend/lib/server/enrichment.ts:275](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:275) [frontend/lib/server/enrichment.ts:279](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:279)

Return shape:

```ts
interface EnrichmentSummary {
  total: number;
  processed: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  unresolved: number;
  skipped_existing: number;
  http: ReturnType<typeof getCatalogStats>;
}
```

[frontend/lib/server/enrichment.ts:224](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:224)

`http` contains catalog request, rate-limit, server-error, network-error, retry, and per-host counters. [frontend/lib/server/catalog.ts:21](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:21)

The synchronous Node route validates `force`, nullable `limit`, and `include_unrated`, supplies the authenticated user ID, calls `enrichLibrary`, and directly returns the summary. [frontend/app/api/enrich/route.ts:6](/home/chase/Documents/Code/my-library/frontend/app/api/enrich/route.ts:6) [frontend/app/api/enrich/route.ts:27](/home/chase/Documents/Code/my-library/frontend/app/api/enrich/route.ts:27)

## 10. Existing Node ports relevant to enrichment/jobs/scheduling

There is no Node port of any `mylibrary/worker.py` function: no `create_enrich_job`, `make_job_id`, `run_enrich_job`, `enrich_books`, `fail_if_stale`, `recover_orphaned_jobs`, worker settings, lease claim, tick, chaining, or janitor exists under `frontend/lib/server/`.

Existing related ports are:

| Python function/concept | Node module/export |
|---|---|
| `enrich._normalize_title` | `frontend/lib/server/dedup.ts` — `normalizeTitle` |
| `enrich._surname` | `frontend/lib/server/dedup.ts` — `surname` |
| `enrich._normalize_full_title` | `frontend/lib/server/dedup.ts` — `normalizeFullTitle` |
| `enrich._same_work` | `frontend/lib/server/dedup.ts` — `sameWork` |
| `enrich._title_sim` | `frontend/lib/server/similarity.ts` — `titleSim` |
| `enrich._search_title` | `frontend/lib/server/enrichment.ts` — `searchTitle` |
| `enrich._score_candidates` | `frontend/lib/server/enrichment.ts` — `scoreCandidates` |
| `enrich._resolve_one` | `frontend/lib/server/enrichment.ts` — `resolveOne` |
| `enrich._apply` plus unresolved persistence | `frontend/lib/server/enrichment.ts` — `persistResolution` |
| `enrich.enrich_library` | `frontend/lib/server/enrichment.ts` — `enrichLibrary` |
| `catalog.set_rate` | `frontend/lib/server/catalog.ts` — `setRate` |
| `catalog.reset_stats` | `frontend/lib/server/catalog.ts` — `resetCatalogStats` |
| `catalog.get_stats` | `frontend/lib/server/catalog.ts` — `getCatalogStats` |
| `catalog._get_json` and its retry/throttle orchestration | `frontend/lib/server/catalog.ts` — `getJson`; private `currentThrottle` and `throttle` |
| `catalog.openlibrary_by_isbn` | `frontend/lib/server/catalog.ts` — `openlibraryByIsbn` |
| enrichment-specific OL title/author search | `frontend/lib/server/catalog.ts` — `openlibraryEnrichmentSearch` |
| `catalog.openlibrary_work_description` | `frontend/lib/server/catalog.ts` — `openlibraryWorkDescription` |
| `catalog.googlebooks_by_isbn` | `frontend/lib/server/catalog.ts` — `googleBooksByIsbn` |
| enrichment-specific Google title/author search | `frontend/lib/server/catalog.ts` — `googleBooksEnrichmentSearch` |

The enrichment mappings are explicit in the Node module comments and exports. [frontend/lib/server/enrichment.ts:58](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:58) [frontend/lib/server/enrichment.ts:66](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:66) [frontend/lib/server/enrichment.ts:95](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:95) [frontend/lib/server/enrichment.ts:235](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:235)

The catalog pacing/stat exports are at [frontend/lib/server/catalog.ts:37](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:37), [frontend/lib/server/catalog.ts:48](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:48), [frontend/lib/server/catalog.ts:63](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:63), and [frontend/lib/server/catalog.ts:76](/home/chase/Documents/Code/my-library/frontend/lib/server/catalog.ts:76).

Catalog calls used by `resolveOne` and `persistResolution` are imported at [frontend/lib/server/enrichment.ts:1](/home/chase/Documents/Code/my-library/frontend/lib/server/enrichment.ts:1).

## 11. Existing tests and concurrency harness

### `tests/test_jobs.py`

- `test_recover_marks_running_and_pending_as_error`: creates running, pending, and done rows; asserts recovery returns `2`, changes running/pending to error with the interruption message and a finish time, and leaves done unchanged. [tests/test_jobs.py:13](/home/chase/Documents/Code/my-library/tests/test_jobs.py:13)
- `test_recover_is_noop_when_redis_configured`: sets `REDIS_URL`, asserts recovery returns `0`, and leaves the running row untouched. [tests/test_jobs.py:31](/home/chase/Documents/Code/my-library/tests/test_jobs.py:31)
- `test_fail_if_stale_errors_an_old_running_job`: makes a running job older than the threshold by 60 seconds and asserts error status, interruption text, and a finish time. [tests/test_jobs.py:48](/home/chase/Documents/Code/my-library/tests/test_jobs.py:48)
- `test_fail_if_stale_leaves_a_fresh_running_job`: asserts a newly started running job stays running. [tests/test_jobs.py:59](/home/chase/Documents/Code/my-library/tests/test_jobs.py:59)
- `test_fail_if_stale_ignores_non_running_jobs`: gives an old start time to a done job and asserts it remains done. [tests/test_jobs.py:67](/home/chase/Documents/Code/my-library/tests/test_jobs.py:67)

There are no tests there for job creation, route response contracts, progress writes, successful completion, exception transitions, rate limiting, authentication, arq enqueueing, or competing jobs.

### Node concurrency today

No existing Node test races two transactions or two route calls against one row.

The closest concurrency-labeled test simulates an intervening write sequentially inside a fake Claude client before persistence resumes; it does not overlap transactions. [frontend/lib/server/__tests__/parity-claude-flows.test.ts:642](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/parity-claude-flows.test.ts:642)

One `Promise.all` occurrence runs independent count queries, not overlapping transactional writers. [frontend/lib/server/__tests__/purge-routes.test.ts:110](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/purge-routes.test.ts:110)

The PGlite harness creates one `PGlite` instance and wraps that single instance with Drizzle. [frontend/lib/server/__tests__/helpers/pglite.ts:14](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/pglite.ts:14) [frontend/lib/server/__tests__/helpers/pglite.ts:218](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/pglite.ts:218)

Accordingly, the current harness is not set up to run two genuinely overlapping database transactions on separate connections. It can exercise transaction semantics and queued async calls, but it cannot prove the two-session race required by the design. Production is also configured with a one-connection postgres-js pool per module instance. [frontend/lib/server/db.ts:27](/home/chase/Documents/Code/my-library/frontend/lib/server/db.ts:27)

The test copy of `enrich_jobs` also lacks the proposed lease and attempts columns and active-job partial index. [frontend/lib/server/__tests__/helpers/pglite.ts:174](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/pglite.ts:174)

## 12. Design requirements with no current equivalent

The following approved 4c-2 requirements are absent today.

### Schema/migration work

- `lease_expires_at TIMESTAMP NULL`
- `attempts INTEGER NOT NULL DEFAULT 0`
- partial unique index on `user_id` for statuses `pending` and `running`
- synchronized Drizzle declarations
- synchronized PGlite test DDL

[docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:159](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:159) [frontend/lib/server/__tests__/helpers/pglite.ts:174](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/pglite.ts:174)

### Job implementation

There is no Node module for:

- idempotent job creation and lost-race recovery;
- active-job lookup;
- atomic lease claim;
- lease expiration/heartbeat;
- attempts increment/cap;
- time-budgeted chunk execution;
- derived progress recounting;
- no-progress stall detection;
- stale-job failure;
- orphan lookup/re-arm;
- terminal job transitions.

The design requires all of these through the lease, progress, and guard rules. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:84](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:84) [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:117](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:117)

### Routes and authentication

Missing routes:

- `POST /api/enrich/start`
- `GET /api/enrich/status/[job_id]`
- `/api/enrich/tick`
- `/api/enrich/janitor`

The start/status routes are still routed to Python by the client-facing backend switch. [frontend/lib/api.ts:543](/home/chase/Documents/Code/my-library/frontend/lib/api.ts:543)

There is no shared-secret authentication helper. `CRON_SECRET` is absent from `.env.example` and is the one explicitly approved new environment variable. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:172](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:172) [.env.example:1](/home/chase/Documents/Code/my-library/.env.example:1)

### Background continuation and Vercel configuration

There is no route-handler continuation mechanism currently used. A direct `@vercel/functions` `waitUntil` implementation would require adding that dependency; alternatively, the installed Next version exposes `after`, but the repository has not adopted it. [frontend/package.json:17](/home/chase/Documents/Code/my-library/frontend/package.json:17) [frontend/node_modules/next/server.d.ts:21](/home/chase/Documents/Code/my-library/frontend/node_modules/next/server.d.ts:21)

There is no `vercel.json`; adding the daily janitor cron therefore requires a new Vercel configuration file. The approved architecture requires that cron as the last-resort repair layer. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:96](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:96)

### Test infrastructure

The design explicitly requires real races for simultaneous claims and simultaneous starts. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:203](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:203)

The current one-instance PGlite harness cannot establish two independent overlapping transactions, so proving those races requires new test infrastructure or a separate real-Postgres integration-test path. [frontend/lib/server/__tests__/helpers/pglite.ts:14](/home/chase/Documents/Code/my-library/frontend/lib/server/__tests__/helpers/pglite.ts:14)

No new external queue vendor is required by the approved design; QStash remains explicitly out of scope. [docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:223](/home/chase/Documents/Code/my-library/docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:223)
