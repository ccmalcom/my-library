# CLAUDE.md — MyLibrary

Project context for AI assistants. Read this file first, then load sub-docs as needed.

## What this is

MyLibrary is a personal, AI-powered book-analysis engine built on a Goodreads CSV export.
Pipeline: `ingest -> enrich -> taste profile -> recommend`. Exposed as a FastAPI service + Next.js frontend.

Working name is "MyLibrary" (the original "BetterReads" is taken).

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
Wave 4 is next and is split in three, on evidence from
`docs/superpowers/plans/2026-08-10-node-backend-wave-4-inventory.md`. Wave 4a is purge
(`DELETE /library`, `/profile`, `/account`) — self-contained, DB-only, no new infrastructure;
planned in `2026-08-10-node-backend-wave-4a-purge.md`. Wave 4b is ingest/import/export (five
routes) — a parser/serializer port, also no new infrastructure. Wave 4c is enrichment jobs, and
it is **blocked on an architecture decision**: Python gets detached work two ways (in-process
FastAPI `BackgroundTasks` and Redis/arq), and Vercel has neither. `/discover` is not a precedent —
it completes inside one HTTP request. The options are `waitUntil`, a cron-driven poller, Redis
plus an external worker, or leaving enrichment on Python through cutover. Note that the earlier
plans assigned purge to wave 4 while `wave-3-verification.md:172` recommended deferring it to
wave 5 as the risky piece; the inventory showed the opposite — purge is the easiest part and
enrichment jobs are the hard one. Wave 5 remains admin + cutover.
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

## Sub-documents (load when relevant)

- **`docs/architecture.md`** — stack, pipeline modules (`ingest`, `catalog`, `enrich`, `profile`, `library`, `purge`, `archetype`, `recommend`, `directive`, `stats`, `worker`)
- **`docs/hosting.md`** — Supabase auth, multi-tenancy, per-user API keys, background jobs, env vars, Alembic migrations, Railway/Vercel deploy
- **`docs/frontend.md`** — Next.js routes, components, design system, auth boundaries, mobile/tablet, SWR patterns
- **`docs/conventions.md`** — gotchas: TSX parser quirks, git rules, Python/CLI, data invariants, recommender, profile, SWR cache

## Claude / Codex split

This repo delegates implementation to Codex (OpenAI) via the `codex` plugin, keeping Claude
on planning and judgement. Fresh execution sessions must follow this split.

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
- **Review gate is off by default.** At the start of a wave-execution session run
  `/codex:setup --enable-review-gate`, and `/codex:setup --disable-review-gate` when the wave is
  done. It adds a Codex design review (up to 900s, can BLOCK) on every edit-producing turn —
  worth it for unattended runs, too slow for planning or Q&A sessions. It stacks on top of
  `.claude/hooks/on_stop.py`, which is the mechanical gate (tsc, ruff, eslint, prettier, pytest);
  the two are complementary, not redundant.

## Locked decisions (do not relitigate)

1. **Goodreads API is dead.** CSV export is the only ingest path. Never scrape Goodreads or call its API.
2. **Goodreads is import-once.** The CSV is a cold-start seed; MyLibrary owns ratings and feedback going forward. Import must never clobber in-app `app_rating` or `app_review`.
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
