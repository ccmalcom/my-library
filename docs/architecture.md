# Architecture — ShelfSprite

## Runtime shape

ShelfSprite is one TypeScript/Next.js application in `frontend/`, deployed on Vercel. Browser code
uses the typed client in `frontend/lib/api.ts`, which sends same-origin requests to `/api` route
handlers under `frontend/app/api/`. Those handlers call the application modules in
`frontend/lib/server/`; there is no separate backend service or worker process.

Supabase supplies authentication and the Postgres database. `lib/server/auth.ts` verifies
Supabase bearer tokens and derives the tenant key from the JWT subject. `lib/server/http.ts` wraps
API handlers with authentication, admin checks, error mapping, request logging, and optional
timing headers. Page session middleware lives in `frontend/proxy.ts` and excludes `/api`, because
API routes enforce their own authentication.

`lib/server/db.ts#getDb` creates the drizzle/postgres-js client, and
`lib/server/schema.ts` declares the checked-in database shape. Connections use
`prepare: false` for the Supabase transaction-mode pooler. Schema changes are generated and
applied with drizzle-kit from `frontend/drizzle/`.

## Server module map

### API, identity, and persistence

- `db.ts` / `schema.ts` — database client and drizzle tables, indexes, constraints, and inferred
  row types.
- `auth.ts` — Supabase ES256 JWT verification, local single-user mode, and admin-email
  classification (`verifyRequestUser`, `authEnabled`, `isAdminEmail`).
- `http.ts`, `errors.ts`, `log.ts` — the `withApi` route wrapper, stable API errors, request IDs,
  structured request logs, and `Server-Timing` support.
- `ratelimit.ts` — Postgres fixed-window limits used by catalog, enrichment, recommendation,
  discovery, and other protected routes (`checkRateLimit`, `RATE_LIMITS`).
- `config.ts`, `settings.ts`, `crypto.ts` — application configuration, per-user settings, and
  encryption/decryption of stored user secrets.
- `claude.ts`, `anthropic.ts`, `claudeErrors.ts` — per-user Anthropic key resolution, injectable
  Claude clients/tool-input extraction, usage-cost recording through `trackedCreate`, and shared
  user-facing failures.
- `serialize.ts` and `rating.ts` — stable response/prompt serialization and the dependency-free
  half-star domain rules. These are behavior modules, not generic formatting conveniences.

### Import, library, and export

- `import-csv.ts` — CSV parsing, format detection, field normalization, canonical output, and
  preview construction (`parseImport`, `buildImportPreview`, `stringifyCanonical`).
- `import-upload.ts` — in-memory upload validation, strict decoding, and the 10 MiB upload bound
  (`readCsvUpload`, `MAX_IMPORT_BYTES`).
- `import-books.ts#importRows` — user-scoped insert/update matching by external ID, ISBN, or
  normalized title/author. Its update allowlist excludes `appRating`, `appReview`, and
  `feedbackUpdatedAt`, so an import does not clobber in-app feedback.
- `books.ts` — book and enrichment response shaping (`bookOut`, `bookSummary`) plus the canonical
  shelf vocabulary. Book mutations themselves live in the corresponding `app/api/books/**`
  route handlers and are scoped by `userId`.
- `export.ts` — user-scoped CSV and JSON backup generation (`buildExport`, `exportJsonText`).
- `purge.ts` — transactional row-deletion primitives for profile, library, and account resets.
  It deletes enrichments before books for foreign-key safety.
- `recs.ts` — recommendation response shaping, the rejection-reason vocabulary, and creation or
  matching of library books from accepted recommendations.

### Catalog and enrichment

- `catalogCache.ts` — Postgres-backed catalog response cache keyed by request URL.
- `catalog.ts` — Open Library and Google Books HTTP clients, throttling/statistics, normalization,
  manual search/ranking, ISBN lookup, subject/author/query expansion, and Work-description lookup.
  Its exported `Candidate` is the common catalog record used downstream.
- `dedup.ts` and `similarity.ts` — shared title/author normalization, same-work checks, and
  deterministic title similarity (`normalizeTitle`, `sameWork`, `titleSim`, `STRONG_SIM`).
- `enrichment.ts` — selects eligible books, resolves ISBN before title/author search, scores
  candidates, persists a result per book, and reports `HIGH`/`MEDIUM`/`LOW` or unresolved
  outcomes (`resolveOne`, `scoreCandidates`, `persistResolution`, `enrichLibrary`).
- `enrichmentJobs.ts` — durable background-job records, one-active-job handling, conditional lease
  claims, stale-job repair, time-bounded chunks, persisted-progress recounts, and continuation
  decisions (`createOrGetActiveJob`, `claimJob`, `runClaimedChunk`, `repairActiveJobs`).
- `enrichmentDispatch.ts` — `CRON_SECRET` validation and post-response dispatch of only a job ID
  to `/api/enrich/tick` through Next's `after()`.

Synchronous enrichment is exposed at `POST /api/enrich`. The serverless background flow uses
`POST /api/enrich/start`, `GET /api/enrich/status/{job_id}`, internal
`POST /api/enrich/tick`, and the janitor route. It does not rely on a resident queue worker.

### Taste profile and reveal

- `profileTiers.ts` — groups effective ratings into ordered tier payloads enriched with catalog
  metadata (`buildTiers`, `tierFor`, `bookPayload`).
- `profileFeedback.ts` — gathers confirmed, edited, rejected, and downweighted traits plus
  more/less-like signals, favorites, and the user directive; it turns them into profile prompt
  guidance and prevents rejected claims from returning as close paraphrases.
- `profileBuild.ts` — builds the full metadata-driven profile prompt, calls Claude with a
  structured trait tool, validates cited IDs, and transactionally replaces the proposed trait set
  (`extractTasteProfile`, `persistProposedTraits`).
- `profileUpdate.ts` — detects changed books and feedback, assembles a bounded incremental prompt,
  performs a minimal trait revision, or falls back to a full rebuild when correction/exclusion
  semantics require one (`booksChangedSince`, `collectUpdateInputs`, `updateTasteProfile`).
- `profileMeta.ts` and `traits.ts` — profile dirty-state row creation and trait response shaping.
- `archetype.ts` / `archetypeDerive.ts` — the four-axis, 16-code reader-archetype definition and
  Claude-assisted derivation persisted per user (`scoresToCode`, `deriveArchetype`).
- `revealLines.ts` — idempotent generation and persistence of short reveal lines only for traits
  that do not already have one (`generateRevealLines`). Profile highlights are computed directly
  by `app/api/profile/highlights/route.ts` from the user's rated, enriched books.

### Recommendation and discovery

- `recSignal.ts` — the single assembled recommendation signal: loved/rated books, subjects,
  authors, languages, existing-library dedup sets, traits, feedback, rejection history, and the
  user directive (`buildSignal`, `isColdStart`). `buildBookSignal` creates the book-anchored form
  used by “more like this.”
- `recAssemble.ts` — deterministic Stage 1 retrieval. `metadataPool`, `seedPool`, and
  `discoveryPool` query real catalog sources; `assemble` removes owned/duplicate/ineligible
  editions, applies language/series/author rules, tracks provenance, and caps the pool before any
  rerank.
- `recFilters.ts` — reusable language, series, fuzzy-duplicate, learner-edition, author-cap,
  directive, and discovery constraints.
- `recPrompts.ts` / `recommendRun.ts` — query-seed and rerank prompt construction plus the main
  two-stage orchestration. `runRecommend` persists only validated catalog candidates returned by
  the rerank tool.
- `recSimilarPrompts.ts` / `recSimilarRun.ts` — ephemeral, book-anchored retrieval and reranking
  for `POST /api/books/{id}/similar`.
- `recDiscoverPrompts.ts` / `recDiscoverRun.ts` — interprets a natural-language request into
  catalog queries and supported constraints, retrieves from both catalog sources, then returns an
  ephemeral reranked result for `POST /api/discover`.

Claude may propose search queries and rank the bounded candidate pool, but it cannot introduce a
book that Stage 1 did not retrieve. Candidate IDs cited by tool output are validated before results
are returned or stored.

### Directives, feedback, and administration

- `directive.ts` / `directiveDistill.ts` — normalization of persisted directive constraints and
  an ephemeral Claude-assisted authoring flow. The persisted directive steers profile prompts and
  supported recommendation filters.
- `feedbackPrompts.ts` — eligibility and state for one-time and repeatable in-product feedback
  prompts. Feedback and taste-signal writes are implemented in their `app/api/**` handlers and
  update profile dirty-state timestamps.
- `invites.ts` — invite creation, Supabase-user backfill, revocation/purge sequencing, and roster
  reads (`createInvite`, `backfillFromSupabase`, `revokeUser`, `listRoster`). Its transaction
  boundaries intentionally differ by operation.
- `supabaseAdmin.ts` — server-only GoTrue admin transport for inviting, listing, and deleting
  users. It uses the Supabase `apikey` header and exposes an injectable fetch seam for tests.

## Locked product decisions

1. **Goodreads CSV export is the only ingest path, with import-once semantics.** Never scrape
   Goodreads or call its API. Import seeds the library and must never overwrite in-app
   `app_rating` or `app_review` values.
2. **The recommender is two-stage.** Deterministic retrieval produces real catalog candidates;
   Claude then reranks and explains that bounded set. The LLM is never the recommender itself and
   cannot invent titles into the result.
3. **Enrichment is the foundation.** Every book receives a `resolution_confidence` of
   `HIGH`, `MEDIUM`, or `LOW`; ambiguous matches deliberately remain `LOW` for later correction.
4. **Taste profiles are metadata-driven.** Cold-start signal comes from ratings plus enriched
   metadata grouped by tier; written in-app reviews become higher-weight direct evidence.
5. **Evals are a later-phase differentiator.** Evaluation work is product strategy, not a reason
   to weaken deterministic retrieval or enrichment guarantees now.
