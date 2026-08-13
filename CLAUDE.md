# CLAUDE.md — ShelfSprite

Project context for AI assistants. Read this file first, then load sub-docs as needed.

## What this is

ShelfSprite is a personal, AI-powered book-analysis engine built on a Goodreads CSV export.
Pipeline: `ingest -> enrich -> taste profile -> recommend`. Exposed as a FastAPI service + Next.js frontend.

The product is **ShelfSprite**, live at `shelfsprite.app`. It was built under the working name
"MyLibrary" (the original "BetterReads" was taken); the rebrand landed 2026-08-13. The Python
package, its env var prefix (`MYLIBRARY_*`), the `mylibrary.backend` localStorage key, and the
`docs/superpowers/` plan archive all still say `mylibrary` — the first three are deleted or renamed
in the Python-retirement cleanup, and the archive is a historical record that is deliberately
left alone.

**Current state:** Phase 6 live — Vercel frontend → Railway web → Supabase Postgres/auth.
Invite-only / free launch. Admin console (invite/revoke users) shipped. Frontend redesign + mobile optimization deployed.
Per-user Anthropic spend tracking (soft-warn only, never blocks) shipped: `usage_events` table,
`/settings` usage panel, `UsageWarningBanner`. `/catalog/search` rate limiting was already
satisfied by the existing 30/min per-user SlowAPI limit — closed with no code change. Wave 1
(`todo.md`) is done. Admin console gained read-only usage/feedback browsing (Wave 4b):
`GET /admin/usage` and `GET /admin/feedback`, paginated, joined against `invites` for
email display, surfaced as new tabs on `/admin`. Next priority is Wave 2 (onboarding
friction / custom imports).
The Wrapped-style profile reveal (Wave 4a) shipped: a nine-beat, full-screen onboarding
sequence (`components/reveal/RevealSequence.tsx`) backed by `highlights.py`, `reveal.py`,
and `archetype.ARCHETYPE_HOOKS` — replayable from `/profile` and wired into the
`SetupWizard` "done" step.
Custom instructions (natural-language taste directive) shipped: `UserDirective` table +
`directive.py`; steers Stage-1 constraints + Stage-2 rerank + profile build; authored
directly or via a bounded Haiku distill chat; surfaced on `/profile` (`CustomInstructions`)
and as a reveal beat.
Node backend migration underway. Wave 0 shipped the foundations: drizzle/Postgres client,
Supabase-JWT + local-mode auth, AES-256-GCM crypto, a Postgres fixed-window rate limiter
(SlowAPI parity), an admin debug-mode toggle, and a method-aware backend switcher
(python/node/auto). Wave 1 ported 8 read-only route groups (stats, books, profile
traits/status/subjects/highlights/archetype, recommendations, settings, directive) to
Next.js route handlers, backed by a fixture-replay parity test harness that proves
field-for-field equality against real recorded FastAPI responses; the frontend's `auto`
mode now serves those GETs from Node by default.
Wave 2 flipped the write routes on those same prefixes (books, settings, directive,
feedback, taste-signal, recommendations), each handler wrapped in a transaction.
Wave 3 ports the Claude-calling flows and is split in three. Wave 3a shipped the catalog
layer (search + a Postgres-backed response cache), per-user Anthropic key resolution with
an injectable client, and `POST /directive/draft`, `/profile/archetype`,
`/profile/reveal-lines`. Wave 3b shipped `POST /profile` and `POST /profile/update`.
Wave 3c is split in three. Wave 3c-1 shipped the shared deterministic retrieval core
(`similarity.ts`'s `difflib.SequenceMatcher` port, `recFilters.ts`, `recSignal.ts`,
`recAssemble.ts`) plus `POST /recommend`. Its parity test replays catalog HTTP recorded
from the Python run, so the byte-identical rerank prompt also proves the retrieval
pipeline — pool order, dedup, language/series/fuzzy/learner filters, author caps and cap
ordering. `scripts/gen_claude_fixtures.py` now feeds canned responses to earlier Claude
calls so a multi-call flow's later prompt can be captured.

Wave 3c-1's retrieval core is signed off. `recommend-http.json` was re-recorded with a
real `GOOGLE_BOOKS_API_KEY` (16/16 googleapis + 8/8 openlibrary returned data), closing
the earlier keyless recording in which every Google Books URL 429'd off the shared
anonymous quota and the fixture proved only the Open Library half. The re-record
exercises the three Google Books fetchers' response parsing, the `seedPool` path, and
the `claude_seed` retrieval-pool value; the pool reaching `capPool` is 138 against a cap
of 60, so the seed-reserve trim really runs instead of hitting the `len <= cap` early
return. The `both` retrieval-pool value and `assemble`'s second-sighting backfill are
still not fixture-driven (no dedup key landed in both pools) — they are covered by
hand-written unit tests in `rec-assemble.test.ts`.

Re-record with `python scripts/gen_claude_fixtures.py`; offline mode makes no real
Claude calls, so it costs nothing in Anthropic spend. The generator strips the key from
every recorded URL rather than disabling it, and refuses to write a fixture in which any
host had zero successful responses. Expect small churn on each re-record — the fixture
snapshots live catalog data, and Google Books re-ranking moves roughly one candidate in
sixty. That is fine: the parity test proves Node reproduces whatever was recorded, not
one specific candidate list.

Wave 3c-2 shipped `POST /books/{id}/similar`: a book-anchored signal
(`recSignal.buildBookSignal`), two new prompts (`recSimilarPrompts.ts`), the
`recommend_similar` orchestrator (`recSimilarRun.ts`) and the route, with Python's
15/minute SlowAPI limit reproduced via `RATE_LIMITS.booksSimilar`. Its parity test
replays the same `recommend-http.json`, which the generator now also records along
the similar path — that recording is where `fillOlDescriptions` and `capPool`'s
`length <= cap` early return are finally fixture-proven, since `/recommend`'s
138-candidate pool trims description-less Open Library candidates before they get
there. Three Python quirks are reproduced deliberately on this path: the series and
fuzzy-duplicate filters are inert (`_build_book_signal` returns no `library_series`
or `library_titles`), rejected recommendations are not excluded, and custom
instructions do not steer it. Wave 3c-3 shipped `POST /discover` and completes
wave 3c: `cleanConstraints` + `applyDiscoveryConstraints` (a pool-level filter
applied BEFORE assembly, with no `exclude_authors` branch — deliberately not
`applyDirectiveConstraints`), `discoveryPool` (both catalog sources per query,
Google then Open Library), `recDiscoverPrompts.ts` and `recDiscoverRun.ts`, with
Python's 30/minute SlowAPI limit reproduced via `RATE_LIMITS.discover`. Discovery
is the odd one out in the recommender family: it hands `assemble` an EMPTY
metadata pool (so every candidate is tagged `claude_seed`), a stated language
constraint replaces the reader's library languages for the run, and the standing
custom-instructions directive does not steer it at all. Its two prompts share
`recPrompts.tasteAndLoved` but prefix it with two headers that differ by one
substring — an asserted parity detail, not a typo.
Wave 4a shipped the three purge routes (`DELETE /library`, `/profile`, `/account`), using one
transaction per request while preserving enrichment-before-books FK ordering and Python's
survivor quirks. Wave 4b shipped exactly `POST /import/preview`, `POST /import`, and `GET /export`
on Node; the dead `POST /ingest` and `POST /ingest/upload` HTTP routes were deleted rather than
ported, while the `ingest_csv` CLI remains. Uploads stay in memory with a new serverless-specific
10 MiB/413 bound (`MAX_IMPORT_BYTES`), case-insensitive `.csv` validation, BOM stripping, and fatal
UTF-8 decoding; the size limit has no Python counterpart and must not be removed for parity.
`import-csv.ts` pins Python's `excel` dialect with `csv-parse`/`csv-stringify`, including
`quoted_match: /[\r\n]/` because either newline character forces `QUOTE_MINIMAL` quoting. Import
stars use half-up `roundRatingHalfUp`, not `pyRound` banker's rounding; Goodreads alone tolerantly
parses `int(float(s))`, so `4.9` becomes 4 there and 5 in other formats. Decode, parse, and validation
finish before the request's single transaction; `importRows` opens none, and updates never write
`app_rating`, `app_review`, or `feedback_updated_at`. JSON backup bytes use `pyJsonDumpsIndented`
to reproduce Python `json.dumps(..., indent=2, ensure_ascii=True)`: lowercase escapes for every
code unit from U+007F upward, UTF-16 surrogate pairs, and no trailing newline; the existing compact,
Unicode-preserving `pyJsonDumps` is not interchangeable. Wave 4c was split to unblock it. Wave 4c-1
shipped the **synchronous enrichment core only**: `enrichment.ts` (selection, `resolveOne`,
`scoreCandidates`, `persistResolution`, `enrichLibrary`), enrichment wrappers plus per-run HTTP
statistics in `catalog.ts`, `serializeResolutionConfidence` in `serialize.ts`, and authenticated
blocking `POST /enrich`, flipped to Node with `{ prefix: '/enrich', methods: ['POST'], exact: true }`.
The `exact` flag is load-bearing: it keeps the synchronous rule from capturing the separately
method-scoped background-job routes. Enrichment reuses `similarity.ts`'s
`titleSim`/`STRONG_SIM` and `dedup.ts`'s `normalizeTitle`/`surname` rather than re-porting them,
and `effectiveRating` comes from `serialize.ts`; only `searchTitle` (`_search_title`) was new.
Four Python quirks are reproduced deliberately: any nonempty ISBN result is HIGH with no title,
author, or ISBN verification; the `0.60` weak threshold is inert (both its branch and the
fallthrough return LOW); an Open Library LOW beats a numerically better Google LOW because scores
are never compared across catalogs; and a resolved upsert is replacement, not fill-blanks — no
candidate carries `series`/`series_position`, so both are always overwritten with NULL. Internal
`NONE` is never stored: unresolved persists `LOW`/`0.0`/`unresolved` and touches only those fields
plus the timestamp, leaving stale resolved metadata in place. Per-book `db.transaction` is
required (Python commits per book so an interrupted run keeps its work); progress fires only after
that commit. One URL is NOT `URLSearchParams`-encodable: Python builds the Open Library ISBN
lookup with an f-string, so the colon stays raw (`bibkeys=ISBN:978…`) while the other three
enrichment URLs go through `httpx.QueryParams` and do percent-encode. Two accepted divergences:
Zod rejects Pydantic's lax coercions (`limit: "3"`, `force: "yes"` are 422 on Node, coerced on
Python), and unknown body keys are ignored on both because `EnrichRequest.model_config` is empty.
`gen_catalog_fixtures.py` now records a real seven-book `enrich_library()` run covering all five
match methods plus a skip; its seeds were chosen by probing live catalogs, because popular titles
resolve on Open Library first (never reaching `isbn:googlebooks`) and Google's near-duplicate
editions trip the ambiguity rule (never reaching `search:googlebooks`). The parity test compares
recorded URLs as sorted multisets, not sequences — neither runtime specifies book order, since
there is no `ORDER BY`.
Wave 4c-2 implements `POST /enrich/start` and `GET /enrich/status/{job_id}` on Node. Internal
`POST /api/enrich/tick` and `GET /api/enrich/janitor` are `CRON_SECRET`-authenticated same-origin
routes, never client-switcher routes. Jobs use atomic conditional leases, poll repair, and a daily
janitor; continuation uses Next's `after()` to dispatch only a job ID to a separate tick, never
`waitUntil`, and `after()` never contains chunk work. Chunks are bounded by time, not count:
`CHUNK_BUDGET_MS = 240_000` reserves headroom under the assumed
`FUNCTION_CEILING_SECONDS = 300`, with no chunk-size knob. **The `maxDuration` segment export on
`enrich/start` and `enrich/tick` must stay the literal `300` — never `= FUNCTION_CEILING_SECONDS`.**
Next reads route segment config with a static analyzer, so an imported binding fails `next build`
during "Collecting page data" with `Invalid segment configuration export detected`, naming no file.
Shipping that binding kept every Vercel preview red from wave 4c-2 to wave 5b-1 while all five
gates stayed green; `enrich-max-duration.test.ts` guards it by asserting on route source text
(importing the route still observes `300`, so only a source check catches it). Progress is derived by recounting
enrichment rows, never accumulated, and is relative to the run (`resolved_at >= started_at`),
because counting books that merely hold enrichment rows would report 100% immediately under
`force`. The four guards are `RATE_LIMITS.enrichStart` at 5/60s, the partial unique index
`uq_enrich_jobs_active_user`, atomic conditional lease claim, and the attempts cap plus no-progress
failure. One active job per user is a deliberate divergence from Python, whose unguarded inserts
let five clicks create five jobs.
Revision `0019_add_enrich_job_leases` adds `lease_expires_at`, `attempts`, `force`, and `run_limit`;
it has not been applied and must be applied in the same release window as the switcher flip.
Python's `fail_if_stale` semantics are exact: running only, non-null `started_at`, age strictly
greater than 1,800 seconds, and `Enrichment was interrupted, please retry.` The one sanctioned
wave-4c-1 edit is additive optional `bookIds?: number[]` on `EnrichLibraryOptions`: chunked
`force: true` otherwise recomputes `work`, repeatedly selects the same first book, and trips the
no-progress guard on tick 2. Omitting it preserves prior behavior and the 4c-1 parity test.
Still out of scope or unverified are Redis, arq, QStash, every queue port, and global cross-user
catalog rate coordination. Python cutover/deletion is wave 5b (admin routes shipped in 5a).
**Wave 5b confirmed the platform assumptions this wave was carrying: Fluid compute is ON and the
project's max function duration is 300s** (up to 800s available if chunks ever need it — raising it
means moving `FUNCTION_CEILING_SECONDS` and both `maxDuration` literals together). `CRON_SECRET`
was still unset as of the 5b cutover; see below for why that is destructive rather than merely
disabling. The cron config lives at `frontend/vercel.json`,
**not** the repository root: the Vercel project's Root Directory is `frontend` (its build logs clone
and then run `next build` directly, and there is no root `package.json`), so a repo-root
`vercel.json` is silently ignored. Cron jobs also only run on **production** deployments, so the
janitor stays dormant on preview builds; `vercel crons ls` proves what Vercel actually registered.
Wave 4c-2 was then **live-verified** against a throwaway Docker Postgres (see the plan's Live
verification record): the browser onboarding→enrich flow, real catalog resolution, `after()`
continuation, the one-active-job guard under genuine concurrency, poll repair, the janitor, the
strictly-`>`-1800s stale threshold, `CRON_SECRET` 401s, and the 5/60s limit all behave. It found one
blocker: `POST /enrich/start` 500'd because `enrich_jobs.progress`/`total` are `NOT NULL` with **no
server default** (Python supplies them from ORM-level `default=0`), so drizzle's emitted SQL
`default` was rejected. It passed 493 tests only because the hand-written PGlite mirror invented
those defaults. Fixed by passing `progress: 0, total: 0` explicitly, dropping the phantom
`.default()`s from `schema.ts`, and tightening the mirror — which turned 24 fixtures red and is
exactly the point. `tsc` cannot catch this class: drizzle's `$inferInsert` leaves a `notNull()`
column without `.default()` optional.
**Goodreads import quoting (fixed in wave 4d, keep it that way).** Goodreads Excel-escapes ISBNs
as `="9780441172719"`. Python's `csv` accepts a quote that is not at field start; `csv-parse`
throws `Invalid Opening Quote`, which meant `POST /import` and `/import/preview` could not parse a
real export on Node. The repo's own `tests/sample_goodreads.csv` has this shape on every row. The
fix is `relax_quotes: true` in `PY_DICT_READER_OPTIONS`, which matches Python on 6 of 8 quote
shapes (up from 3); the two residual divergences are documented and accepted.

**Wave 5a (admin surface port) invariants.** Wave 5a is complete and live-verified: all four read
routes plus invite, backfill and revoke were exercised against the real Supabase project, so all
three GoTrue operations are proven under the apikey-only header. `invites.ts` holds `listRoster`,
`createInvite`, `backfillFromSupabase`, `revokeUser`; `supabaseAdmin.ts` is the GoTrue client with
an injectable `GoTrueFetch` so no test touches the network. It sends the key on `apikey` ONLY and
never on `Authorization` — Supabase parses an `Authorization` value as a JWT, so an opaque
`sb_secret_*` key there yields `Invalid JWT`; Python still sends both and would 502 on a new-style
key, deliberately unfixed because wave 5b deletes it. `baseAndHeaders` reads
`SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL`, matching `auth.ts::jwksUrl`; without that fallback auth
works while every admin write 502s. What must not be "cleaned up":

- **Transaction boundaries differ per function on purpose, and harmonising them is a bug.**
  `backfillFromSupabase` IS transactional (its only remote call is a read that completes first).
  `createInvite` is NOT (its GoTrue call cannot be rolled back). `revokeUser` is NOT — the one
  sanctioned break from the house one-transaction-per-request rule: the invite row must stay
  marked revoked when the purge fails, so a retry skips the already-done GoTrue delete. The
  hand-written purge-failure case in `parity-writes-admin.test.ts` is the ONLY thing that catches
  a regression here; **never convert it to a `runScenario` call.**
- **`supabaseAdmin.ts` uses `||`, not `??`, where it ports a Python `or` chain.** `or` falls
  through on ANY falsy value, `??` only on null/undefined — "modernising" it to `??` silently
  swallows a GoTrue error message. Same family as `pyRound`/`pyRepr`.
- Write parity goes through `write-parity.ts::runScenario` plus a `REGISTRY` row per route, never
  a hand-rolled step loop — the helper is what applies `maskVolatile` and compares response
  headers. Read parity masks volatile values via `checkParity`'s 4th `normalize` argument; any
  route returning per-event usage rows needs it, because `usage_events.created_at` comes from the
  `{"$hoursAgo": N}` sentinel and resolves against the run clock.
- `admin_me` is ungated by design (`requireAuth: false`): the route IS the admin check, so it must
  answer for non-admins too. Error mapping differs between siblings — invite `InviteError`→422,
  revoke `InviteError`→**404**, both `SupabaseAdminError`→502.
- Two divergences are adjudicated "keep the code, write the comment" (Global Constraint 3 requires
  recording, not reverting): `inviteUser` returns the requested email where Python's
  `.get("email", email)` returns `None` for a present-but-null key, and a non-string GoTrue `msg`
  is dropped rather than rendered. One gap is deliberately deferred: `createInvite` does not wrap a
  crypto `RuntimeError` into `InviteError`, so a missing encryption key gives 500 on Node, 422 on
  Python.

Fixture-layer rules for the admin surface: **every address in a fixture must be `@example.com`;
the repo is public.** The recorder fakes GoTrue by patching
`mylibrary.invites.{invite_user,delete_user,list_users}`, never `mylibrary.supabase_admin` —
`invites.py` from-imports those names, so patching the source module is a no-op. `Invite` seeds
carry `supabase_user_id` of `local`/`other` to match the seeded books/usage rows, so `book_count`
and the `/admin/usage` email joins resolve instead of returning nulls. `invites` must stay in
`pglite.ts`'s `SEQ_TABLES` (the seed inserts explicit ids without advancing the serial, so the
first `createInvite` collides on id=1) and `revoked_at` in `write-parity.ts`'s `VOLATILE_KEYS`
(revoke sets it to `now()`). No seeded `feedback` row may use `trigger='post-recs'` —
`feedback.py::_post_recs_eligible` is the table's only reader outside the admin route and filters
on exactly that value, so any other trigger keeps the recorded `feedback-flow` /
`feedback-invalid` scenarios byte-identical.
Because Claude output is nondeterministic, "parity" for these flows means the _request_ is
byte-identical: `scripts/gen_claude_fixtures.py` monkeypatches `tracked_create` to record
real Python `create()` kwargs into `fixtures/claude/prompts.json`, and
`parity-prompts.test.ts` asserts the Node-built prompt/system/tool-schema/model matches
exactly. That makes Python-vs-JS serialization differences load-bearing — see
`lib/server/serialize.ts` for the `pyRepr`/`pyFloatStr`/`pyJsonDumps` primitives and why
ordered mappings bound for a prompt must be a `Map` (V8 reorders integer-like object keys).
Rounding lives there too: Python's `round(x, d)` is banker's rounding on the exact binary
value, so `round2`/`round4` both route through one `pyRound` helper. Never reimplement
either as `Math.round(x * 10 ** d) / 10 ** d` — that disagrees with CPython on every exact
tie (an odd 8th at d=2, an odd 32nd at d=4), which reaches real API responses via
`/stats`, `/settings/usage` and `/profile/highlights`.

**Wave 5b (production cutover) — in progress; scope collapsed.** 5b-1 (deploy alongside Python and
soak) and 5b-2 (delete Python) were merged into a single retirement after Chase's call on
2026-08-12. Justified by measurement, not impatience: **every one of the 54 frontend-facing routes
in `mylibrary/api.py` is already covered by `NODE_DEFAULT_ROUTES`** in `frontend/lib/backend.ts`,
leaving only `/health` and `/healthz` (Railway's own probes), so the soak was protecting a fallback
that nothing routes to. The arq worker is not load-bearing either — `worker.py`'s docstring states
arq is opt-in behind `REDIS_URL` and the no-Redis BackgroundTask path is the supported production
mode. The agreed order is: set `CRON_SECRET` → merge the branch to `main` → smoke production →
delete Railway. **The ordering is forced, not ceremonial:** the Node code and the entire switcher
route table live on `feat/node-backend`, while production Vercel deploys from `main`, so until that
merge lands production serves 100% Python and deleting Railway is an outage. Merging also repairs
Railway's healthcheck for free, so a real fallback exists during the smoke test.

Six durable facts from 5b, all recorded in `docs/hosting.md` with full detail:

- **The proxy matcher ate every internal tick — this, not `CRON_SECRET`, is why enrichment
  continuation had never run in production.** `proxy.ts` matched `/api/*`, and `updateSession`
  307-redirects any cookieless request to `/login`; the internal `/api/enrich/tick` fetch carries a
  `CRON_SECRET` bearer and no cookies. The janitor was dead for the same reason. Fixed by adding
  `api` to the matcher's negative lookahead — the middleware gates **pages only**, and API routes do
  their own bearer auth via `withApi`. Two reasons it hid for four waves: **a 307 is a successful
  fetch**, so nothing threw and nothing logged; and **`rearmed: true` means "a tick was scheduled",
  not "a tick succeeded"**, because `after()` runs the fetch post-response where
  `runClaimedChunk`'s `try`/`catch` can never see it. **Tick count alone is not evidence of
  continuation** — 21 ticks coexisted with progress frozen at 65/159. Require the tick count AND
  progress advancing.

- **`CRON_SECRET` unset used to be destructive, not merely disabling** — `rearmAfterResponse` throws
  rather than returning falsy, and `deps.dispatch` was awaited un-guarded at `enrichmentJobs.ts:449`
  and `:190`, after the lease had already been nulled, permanently orphaning any enrichment needing
  a second chunk. **Guarded as of commit `ef28810`** (2026-08-13): both sites catch,
  `runClaimedChunk` returns `rearmed: false`, `repairActiveJobs` survives a mid-sweep failure and
  counts it in `dispatchFailed`. A dispatch failure is now recoverable — but *not* self-healing,
  since a missing secret also 401s the janitor that would reclaim the job. Still invisible to a
  small-library smoke test — **always test enrichment with a library big enough to need a second
  chunk.**
- **The enrichment continuation path can only be tested on the production custom domain.** Vercel
  SSO protection is on, scoped `all_except_custom_domains`, and `rearmAfterResponse` self-fetches
  `request.url`'s origin (`enrichmentDispatch.ts:39`) carrying only the `CRON_SECRET` bearer. On a
  **preview** deploy that self-fetch is intercepted by the protection layer before the function
  runs, and the failure is **indistinguishable from a broken `CRON_SECRET`** — so a preview test
  returns a confident wrong answer. Production is exempt only via `shelfsprite.app`.
  **Verified working 2026-08-13** on `shelfsprite.app` under a temporary 100s budget: a forced
  159-book run spanned two chunks and reached `done` at 159/159 (`start` 18:05:42, one
  `/api/enrich/tick` at 18:07:24 running 47.4s). Budget reverted to `240_000` the same day. Two
  corrections to the bar this line used to state: **"≥ 2 ticks, never `done`" is the wrong
  criterion** — it was extrapolated from a 221s run, and the 149s verification run legitimately
  produced exactly 1 tick; the real bar is a tick invocation **and** progress advancing across the
  chunk boundary. And **tick→tick chaining is still unproven** — the job finished inside the first
  tick, so no tick ever had to re-arm another. At `240_000` this library completes in one chunk and
  cannot test it again; that needs a ~`40_000` budget or a much larger library.
- **Never apply a migration to production from a branch the deployment does not track.** `start.sh`
  runs `alembic upgrade head` before uvicorn under `set -euo pipefail`, so if the DB's
  `alembic_version` names a revision absent from the deployed image, the container cannot boot and
  the healthcheck can never pass. `0018` was applied by hand from the Node branch while Railway
  deploys `main` (head `0017`); it stayed invisible until the next deploy, and **a restart alone
  would have tripped it.**
- **`enrich_jobs.progress`/`total` have two legitimate shapes** depending on database age —
  `create_all` lineage (no server default) vs `0003` lineage (server default `0`). Node supplies
  both values explicitly so either works. **The 5b-2 drizzle baseline must come from a `pg_dump` of
  production, never a fresh `alembic upgrade head`.**
- **`/healthz` is the unauthenticated probe; `/health` requires a token.** Already correct in
  `docs/hosting.md`; the wave 5b-1 plan document got it wrong.

## Sub-documents (load when relevant)

- **`docs/architecture.md`** — stack, pipeline modules (`ingest`, `catalog`, `enrich`, `profile`, `library`, `purge`, `archetype`, `recommend`, `directive`, `stats`, `worker`)
- **`docs/hosting.md`** — Supabase auth, multi-tenancy, per-user API keys, background jobs, env vars, Alembic migrations, Railway/Vercel deploy
- **`docs/frontend.md`** — Next.js routes, components, design system, auth boundaries, mobile/tablet, SWR patterns
- **`docs/conventions.md`** — gotchas: TSX parser quirks, git rules, Python/CLI, data invariants, recommender, profile, SWR cache

## Claude / Codex split

This repo delegates implementation to Codex (OpenAI) via the `codex` plugin, keeping Claude
on planning and judgement. Fresh execution sessions must follow this split.

**Use the prompt templates.** `docs/superpowers/codex-prompt-templates.md` has tested prompts for
the three Codex roles (inventory, plan-drafting, task execution), a standing-rules block to paste
into every prompt, Claude's review checklist for returned work, and verified helper commands. Do
not re-derive these per wave. Running findings live in `docs/superpowers/codex-workflow-notes.md`;
append to it as you learn things.

| Work | Runs on |
| --- | --- |
| Brainstorm, spec, wave plan docs | Claude (Opus) |
| Implementing a plan task | `/codex:rescue --background <task text>` |
| Pre-PR review of a wave | `/codex:review`, then `/codex:adversarial-review` |
| Triaging review findings | Claude, via `superpowers:receiving-code-review` |
| Confirming it actually runs | Chase or Claude driving the app — never a model's self-report |

Rules:

- **Do not explore the repo before delegating.** The `codex:codex-rescue` subagent is a thin
  forwarder and is forbidden from reading files; Codex does its own exploration on OpenAI's
  quota. Hand it the plan-task text verbatim. Claude reading files first defeats the purpose.
- **Prefer `--background`.** Pull results later with `/codex:result <id>`; `/codex:status` lists
  jobs. A foreground run parks the whole Codex transcript in Claude's context.
- `/codex:transfer` converts this session into a resumable Codex thread — prefer it over
  `/compact` when the remaining work is mechanical.
- `--model spark` (`gpt-5.3-codex-spark`) and `--effort low` for mechanical ports; leave both
  unset for anything requiring parity reasoning.
- **Codex is not covered by `.claude/hooks/pre_bash.py`.** That hook only screens Claude's own
  Bash calls, so the `.env` block does not apply to Codex's shell. Never hand Codex a task whose
  text names `.env` or asks it to inspect secrets; use `.env.example` for variable names.
- `codex:codex-rescue` defaults to `--write`. Say "investigate, do not edit" for diagnosis-only
  runs. Chase still commits by hand — expect to review diffs you did not watch being made.
- **Cite symbols, not line ranges, in any proof-of-fix check.** Use `grep -n '<exact code>'`, never
  `sed -n 'N,Mp'`. Line numbers drift between plan-authoring and plan-execution — wave 4a's Task 0
  gate printed a window ten lines short of the guard it was checking for, and a literal reading
  would have failed a gate that had actually passed. Treat the line ranges in any plan's "Verified
  Facts" table as hints to the right region, never as assertions to check literally.
- **"My grep found nothing" ≠ "the fact is not there."** Before contradicting a plan's citation,
  open the cited range. A single-form grep is not proof of absence for any API with more than one
  spelling: wave 4a produced a false "the plan is wrong" finding because `grep -c 'references('`
  returned 0, while this schema declares its only foreign key via Drizzle's table-level
  `foreignKey({...})` form at `schema.ts:146-151`. And never propagate an unverified review finding
  into later task prompts — propagation is efficient when right and contaminating when wrong.
- **Budget every Codex task to ~10 minutes**, including its own exploration. `--background` is a
  Claude-side flag that never reaches `task`, so the job runs foreground under a hard cap. Prefer
  several narrow dispatches to one broad one, and run `git status` after any killed run — applied
  file changes are **not** rolled back.
- **Codex cannot run the pytest suite at all.** `tests/conftest.py` imports FastAPI's `TestClient`,
  which hangs its sandbox, so the whole suite is off-limits — not just the API tests. It also cannot
  `npm install` (no network) or run the fixture recorders. Claude does those. Say so in the prompt:
  an unrunnable command silently eats minutes of the budget. Always pass `GIT_PAGER=cat` or
  `git --no-pager`; a paged git command hangs the shell.
- **Name every gate in every task prompt.** Codex runs the commands you list and no others — an
  unlisted gate is out of scope, not forgotten. Add `npm run type-check` and `npx eslint <touched>`
  to each dispatch regardless of what the plan's step says; wave 4b's Task 1 shipped green tests and
  a broken `tsc` twice because they only appeared in the final task. State expected-red by test
  **name**, never by count. Add **`npm run build`** for any wave touching `frontend/`: tsc, eslint,
  vitest and jest together do not prove the app deploys. Wave 5b-1 found eight consecutive red
  Vercel previews, spanning four waves, sitting behind five green gates — the whole class of
  Next build-time errors (segment config, font fetching, prerender) is invisible without it.
  Check the deploy dashboard in a release wave's baseline task, too, not at its verification task.
- **Codex's observations are reliable; its attributions need checking.** When a run reports "X is
  broken / too slow", verify X directly before believing it. A job blamed a fixture generator for a
  ten-minute timeout; the generator runs in 1.8 seconds and a paged `git diff` had hung the shell.
- **A green suite proves the specified cases work, not that a port is faithful.** Prefer
  differential testing — run the port and the Python original over a shared input matrix and diff.
  That found four `import-csv.ts` divergences 11 passing hand-written tests had missed. When a live
  original exists, diff both against one shared database; it beats any fixture.
- **Ask for test bodies explicitly** when commissioning a plan. Codex reliably writes complete
  implementation code and reduces test code to prose-in-comments. It is a second-prompt problem,
  not a capability limit — asking directly fixes it entirely.
- **Review gate is off by default.** At the start of a wave-execution session run
  `/codex:setup --enable-review-gate`, and `/codex:setup --disable-review-gate` when the wave is
  done. It adds a Codex design review (up to 900s, can BLOCK) on every edit-producing turn —
  worth it for unattended runs, too slow for planning or Q&A sessions. It stacks on top of
  `.claude/hooks/on_stop.py`, which is the mechanical gate (tsc, ruff, eslint, prettier, pytest);
  the two are complementary, not redundant.

### Controller cost rules (measured 2026-08-12)

A controller turn costs about `context_size × 0.1`. Across wave 5a's three controllers, 63-72% of
spend was re-reading context and 13-16% was generating output. So the **context floor is the only
cost number that matters** — the nine Codex dispatches were 11% of the wave (690k of 6.23M units),
and the controllers were the other 89%. Do not optimize the dispatch; optimize the floor.

- **Restart the controller when the context floor passes ~120k tokens, or every ~40 turns,
  whichever comes first.** Not "between task groups" — that phrasing was measured and it does not
  fire: wave 5a's third controller read eight tasks as one group, ran 159 turns, and climbed to a
  263k floor, landing back at the pre-change per-turn cost. The one session that did restart cost
  13.5k/turn against 22.6k for the two that didn't. The `.superpowers/sdd/` ledger is the state of
  record, so a restart costs one re-establishment turn (~40k units) and buys back far more. Hand
  the new session the kickoff prompt plus "resume from task N".
- **Never park a loaded controller, full stop.** Do not assume the 1-hour cache TTL — it degrades
  to 5 minutes as session usage accumulates, and it degraded *within* wave 5a (baseline 100% 1h →
  third controller 66% 5m). A 33-minute gap that would have been safe under the 1h TTL cost
  288,771 units when the cache re-entered at 1.25× instead of 0.1×. Between tasks, finish the
  review or end the session.
- **Read one task's text per dispatch, not the whole plan doc.** A 20.5k-token plan held resident
  costs ~2k units every turn; re-reading one task costs ~2.5k once.
- Full measurements, plus two cost hypotheses that were confidently wrong, are in
  `docs/superpowers/codex-workflow-notes.md`.

## Locked decisions (do not relitigate)

1. **Goodreads API is dead.** CSV export is the only ingest path. Never scrape Goodreads or call its API.
2. **Goodreads is import-once.** The CSV is a cold-start seed; ShelfSprite owns ratings and feedback going forward. Import must never clobber in-app `app_rating` or `app_review`.
3. **The recommender is two-stage** (retrieval of real catalog candidates, then Claude reranks/explains). The LLM is NOT the recommender. Stage-1 is hybrid (deterministic metadata expansion + Claude-seeded search queries, all resolved against the live catalog so no invented titles survive).
4. **Taste profile is metadata-driven** — cold-start signal comes from ratings + enriched metadata grouped by tier. In-app `app_review` values ARE fed in as direct signal and weighted above metadata inference once written.
5. **Enrichment is the foundation.** Every book gets a `resolution_confidence` (HIGH/MEDIUM/LOW); ambiguous matches are scored LOW on purpose so a later feedback step surfaces them.
6. **Evals are the differentiator** (later phase).

## Commands

```bash
pip install -r requirements.txt
python -m mylibrary.cli ingest          # data/goodreads_library_export.csv
python -m mylibrary.cli enrich          # --rps N, --limit N, --force, --retry-unresolved
python -m mylibrary.cli profile         # full taste profile build; needs ANTHROPIC_API_KEY
python -m mylibrary.cli traits          # print the saved taste profile + evidence
python -m mylibrary.cli add "Title"     # manually add a book (--author, --rating, --review, --shelf)
python -m mylibrary.cli rate ID 1-5     # re-rate a book in-app (0 clears the override)
python -m mylibrary.cli review ID "..." # write/clear (--clear) an in-app review
python -m mylibrary.cli directive "..." # show/set (--clear) natural-language custom instructions
python -m mylibrary.cli remove-book ID  # permanently delete a single book
python -m mylibrary.cli backfill-descriptions  # repair rec-accepted books missing a description (--all-users for deployed DB)
python -m mylibrary.cli clear-profile   # drop traits + recs; keep books (-y to skip confirm)
python -m mylibrary.cli clear-library   # drop books + enrichments + profile (clean reset)
python -m mylibrary.cli delete-account  # drop ALL data incl. stored API key
python -m mylibrary.cli profile-status  # is the profile stale vs. recent edits?
python -m mylibrary.cli reprofile       # incremental re-profile (--full to rebuild)
python -m mylibrary.cli recommend       # --n N; two-stage recs, needs ANTHROPIC_API_KEY
python -m mylibrary.cli recs            # reprint the latest recommend run
python -m mylibrary.cli stats
python -m mylibrary.cli serve           # FastAPI at http://127.0.0.1:8000/docs
python -m pytest                        # ingest + matching + catalog + recommender + feedback + admin
cd frontend && npm install && npm run dev  # Next.js dev server at http://localhost:3000
```

## Recommender behavior

`recommend()` now returns a `cold_start: bool` key (True on thin libraries < 8 loved / < 12 rated books).
Language filtering, same-author caps, and cold-start gating are behavior-shaping additions that refine Stage 1 retrieval without changing the two-stage locked decision — the LLM is still not the recommender.
