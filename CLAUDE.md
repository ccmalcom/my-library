# CLAUDE.md — ShelfSprite

Project context for AI assistants. Read this file first, then load the relevant sub-document or
source file before changing behavior.

## What this is

ShelfSprite is a personal, AI-assisted book-analysis and recommendation app at
`shelfsprite.app`. It starts from a Goodreads CSV export, enriches each book with catalog
metadata, derives a taste profile, and recommends real books from the catalog.

The application is a TypeScript/Next.js app in `frontend/`, deployed only on Vercel. Next route
handlers under `frontend/app/api/` are the backend, and `frontend/lib/api.ts` calls them at the
same-origin `/api` prefix. Supabase provides authentication and user identity. User-owned
application data is tenant-scoped in Supabase Postgres, accessed through drizzle-orm using the
schema in `frontend/lib/server/schema.ts`; drizzle-kit owns schema migrations. There is no
separate web service or worker deployment.

The product is invite-only. Supabase JWT `sub` values are the tenant keys, and every data access
path must preserve its `user_id` boundary. Local mode uses the `local` user only when Supabase is
not configured.

## Code map

- `frontend/app/` — pages and same-origin API route handlers.
- `frontend/components/` — application and design-system components.
- `frontend/lib/api.ts` — typed browser client for `/api`.
- `frontend/lib/server/` — database, auth, catalog, enrichment, profile, recommender, import,
  export, administration, and wire-format domain code.
- `frontend/drizzle/` — generated migration SQL and drizzle metadata snapshots.
- `frontend/proxy.ts` — page-session middleware; API authentication stays in route handlers.

See `docs/architecture.md` for the server module map, `docs/frontend.md` for UI and client
patterns, `docs/hosting.md` for deployment and operational history, and `docs/conventions.md` for
repository conventions. `docs/superpowers/` is a historical planning archive; do not rewrite it
to match the current implementation.

## Load-bearing invariants

### Ratings

Ratings use a 0.5 grid from 0.5 through 5.0. `books.app_rating` and
`books.goodreads_rating` are `numeric(2,1)` columns and must keep drizzle
`mode: 'number'`; otherwise Postgres values arrive as strings and numeric comparisons silently
misbehave. Keep `frontend/lib/server/rating.ts` dependency-free: client code imports it, so adding
Zod or another server dependency there increases every affected browser bundle.

`0` is a sentinel, never a rating. `app_rating IS NULL` means there is no in-app override,
`goodreads_rating = 0` means unrated, and `0` on an API mutation means “clear this rating.” The
Zod schemas for `POST /books` and `PATCH /books/{id}/feedback` deliberately accept a permissive
`z.number()`; each route then special-cases `0` and applies the manual `isValidRating` guard. Do
not move the grid/range rule into the Zod object, because the manual guard owns the API's stable
422 message. Whole ratings serialize as integers (`4`, not `4.0`), while half ratings serialize
as decimals (`4.5`).

### API wire-format primitives

`frontend/lib/server/serialize.ts` defines the API and prompt wire format. Client behavior and
stored prompt inputs depend on these exact representations even though the helpers retain their
`py*` names:

- `pyRound` applies ties-to-even (banker's) rounding to the exact binary value. `round2` and
  `round4` must
  continue to route through it; `Math.round(x * 10 ** d) / 10 ** d` is wrong on exact ties (odd
  eighths at two digits and odd 32nds at four digits). `pyRoundHalfEven` supplies the same
  ties-to-even rule for integer rounding.
- `pyFloatStr` preserves float identity: integral floats end in `.0`, negative zero is `-0.0`,
  and ordinary non-integral, exponent-form, and non-finite values retain their current shortest
  string representation. Use `pyFloat` where a value must remain visibly a float.
- `pyRepr` is not JSON. It emits single-quoted strings where possible, `None`/`True`/`False`, and
  comma-space separators for containers. Mappings that require insertion order must be `Map`
  instances.
- `pyJsonDumps` is compact only in the sense of having no indentation: it preserves Unicode and
  emits a space after every comma and colon. It is recursive so punctuation inside strings is
  never rewritten. Use an ordered `Map` for order-sensitive JSON objects because V8 reorders
  integer-like keys on plain objects. `pyJsonDumpsIndented` is a separate export format with
  two-space indentation, lowercase ASCII escapes (including UTF-16 surrogate pairs), and no
  trailing newline; it is not interchangeable with `pyJsonDumps`.

### Enrichment jobs and Vercel duration

`frontend/app/api/enrich/start/route.ts` and `frontend/app/api/enrich/tick/route.ts` must each
export the literal `maxDuration = 300`. Do not replace the literal with an imported binding,
including `FUNCTION_CEILING_SECONDS`: Next's static segment-config analyzer requires a literal,
and the imported form makes `next build` fail during “Collecting page data” without naming the
offending file.

Background enrichment uses atomic conditional lease claims. Chunks are time-bounded, never
count-bounded: `CHUNK_BUDGET_MS = 240_000` reserves time below the 300-second function ceiling.
Continuation uses Next's `after()` only to send a job ID to the separate `/api/enrich/tick`
route. Never run chunk work inside `after()`, and never replace this with `waitUntil`.

Progress is derived by recounting persisted enrichment rows, including the run-relative
`resolved_at >= started_at` rule; never accumulate an in-memory counter as job truth. Job creation
must explicitly pass `progress: 0` and `total: 0`, because those NOT NULL columns do not have a
reliable server default across database vintages. The hand-written `NewJobValues` interface in
`frontend/lib/server/enrichmentJobs.ts` is the TypeScript guard that keeps both fields required;
do not replace that insert type with drizzle's looser `$inferInsert`.

### Administration and transaction boundaries

Transaction boundaries are chosen per operation and deliberately differ. In
`frontend/lib/server/invites.ts`, `backfillFromSupabase` is transactional after its remote read;
`createInvite` is not wrapped in one transaction because its GoTrue write cannot roll back; and
`revokeUser` records revocation before its separately transactional purge so a purge failure does
not cause a retry of the irreversible GoTrue deletion. Do not “harmonize” these functions.

`frontend/lib/server/supabaseAdmin.ts` sends the Supabase secret on the `apikey` header only,
never `Authorization`; Supabase interprets an Authorization value as a JWT, while current
`sb_secret_*` keys are opaque. Its error-message fallback must remain `data.msg || data.message`,
not `??`: `||` falls through on every falsy value, including an empty string, while `??` falls
through only for null or undefined. The `admin_me` handler at `GET /api/admin/me` is intentionally
configured with `requireAuth: false`; the route itself performs the admin check and must answer
unauthenticated and non-admin callers instead of being pre-empted by the wrapper.

### Page middleware versus API authentication

`frontend/proxy.ts` must keep `api` in the matcher's negative lookahead. The proxy gates page
routes only; API handlers perform their own bearer authentication through `withApi`, and internal
enrichment routes validate `CRON_SECRET`. When the proxy once matched `/api/*`, cookieless
internal tick requests were redirected to `/login`. The bug stayed invisible for a long stretch
because a 307 redirect is a successful fetch and therefore throws no network error.

### Tests and build gate

There are two test runners with disjoint ownership. `npm test` runs Jest for everything except
`lib/server/**` and `app/api/**`. `npm run test:server` runs Vitest for exactly those two paths,
as fixed by `vitest.config.ts`'s `include`. Running only one runner is not a complete test pass.
`npm run build` is also required: it is the only gate that catches Next segment-config and
prerender failures.

### Database migrations and production shape

`drizzle-kit generate` never reads a live database. It only diffs
`frontend/lib/server/schema.ts` against `frontend/drizzle/meta/*.json`, so “generate emitted
nothing” does not prove production has no drift. Verify production columns, nullability, and defaults with
`information_schema.columns`, never with `schema.ts` comments. Generate migrations from the
checked-in schema and snapshot, inspect the SQL, then apply through the documented drizzle
workflow.

## Product decisions

1. Goodreads CSV export is the only ingest path. Never scrape Goodreads or call its API.
2. Goodreads import is import-once cold-start seeding. Later imports must never overwrite
   ShelfSprite-owned `app_rating` or `app_review` values.
3. Recommendations are two-stage: deterministic retrieval produces real catalog candidates,
   then Claude reranks and explains them. Claude is never the recommender and invented titles
   never enter the candidate set.
4. Enrichment is the foundation. Every book receives a `resolution_confidence` label of
   `HIGH`, `MEDIUM`, or `LOW`; ambiguity stays `LOW` so it can be surfaced for correction.
5. Taste profiles are metadata-driven from ratings plus enriched metadata grouped by rating tier.
   In-app reviews are direct evidence and outweigh metadata inference once present.
6. Evals are a later-phase product differentiator.

## Commands

Run every gate from `frontend/`:

```bash
cd frontend
npm run test:server  # Vitest: lib/server/** and app/api/**
npm test             # Jest: everything else
npm run type-check   # tsc --noEmit
npm run lint
npm run format:check
npm run build        # required Next segment-config/prerender gate
```
