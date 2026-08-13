# TODO

## BUGS

- **Enrichment job dispatch is not fault-tolerant.** `runClaimedChunk` nulls `leaseExpiresAt` and
  *then* awaits `deps.dispatch(...)` with no `try`/`catch` (`frontend/lib/server/enrichmentJobs.ts:449`,
  and the same shape at `:190` in `repairActiveJobs`). Any dispatch failure — network blip, cold
  start, or a missing `CRON_SECRET` — leaves the job `running` with its lease already released and
  no continuation queued, which `uq_enrich_jobs_active_user` turns into a permanent block on that
  user until someone edits the row by hand. Fix by dispatching before releasing the lease, or by
  catching the failure and leaving the lease intact so the janitor reclaims it. Found in wave 5b;
  see `docs/hosting.md` for the full failure trace.
  **Priority raised by the 2026-08-13 production smoke.** A forced re-enrich of Chase's library
  (159 rated books) took **221s against the 240s `CHUNK_BUDGET_MS`** — an 18-second margin — and
  Vercel logs confirmed `/api/enrich/start` × 1, `/api/enrich/tick` × 0. So the continuation path
  has *never* run in production, and the first library that crosses 240s (a slightly larger rated
  shelf, or one slow catalog day) is the one that discovers this bug by getting permanently wedged.
  Fix this BEFORE deleting Railway — deletion removes the fallback. Continuation can be proven on a
  *preview* deploy with a temporarily lowered `CHUNK_BUDGET_MS`: crons don't run on preview, but the
  tick dispatch is a plain `fetch` from `after()`, so it exercises fine there provided `CRON_SECRET`
  is also set in the Preview environment.

- **Add-book search ranking scores correct matches 0 (deferred to after the Python delete).**
  Root cause is `matchScore` (`frontend/lib/server/catalog.ts:424`, mirror of `_match_score`,
  `mylibrary/catalog.py:449`) — NOT retrieval. Instrumenting all four source fetches showed the
  target book present in every candidate pool for every failing query; it scores 0, ties with
  noise, and the year-DESC tiebreaker floats recent junk above it. Two defects:
  1. `normFull` maps non-alphanumerics to a *space*, so `"The Android's Dream"` becomes
     `the android s dream` with a stray `s` token. Query `the androids dream` then fails all five
     bands → score 0. Typing the apostrophe scores 100. Fix: strip `['’ʼ]` to empty *before* the
     `[^a-z0-9 ]`→space pass.
  2. Query tokens can never span title AND author — the scorer checks query-vs-title or
     query-vs-author, never both. `lock in scalzi` scores 0 against *Lock In* by John Scalzi while
     `"Trivia-On-Books Lock in by John Scalzi"` scores 60 (all tokens in its *title*), so adding the
     author makes results strictly worse. Fix: peel author-matching tokens off the query, score the
     remainder against the title in a band above the title-only bands.
  Prototype verified against live catalogs: `The Androids Dream`, `Lock In Scalzi` and
  `scalzi lock in` all go from absent-in-top-8 to #1; `Lock In`, `dune`, `the fault in our stars`
  unchanged. **Deferred deliberately**: `catalog-search.test.ts` asserts Node's output byte-matches
  recorded Python output, so fixing this before the Python delete means fixing both runtimes and
  re-recording the fixture. Chase's call (2026-08-13) — do it once Python is gone and there is no
  parity constraint. Scope is these two defects only.
- **Search tiebreakers favor recency over canonicity** (separate, pre-existing, lower priority).
  `rankKey`'s year-DESC tiebreaker floats reissues and study guides above canonical works — plain
  `dune` returns a graphic novel and a Kevin J. Anderson title above Frank Herbert's.

## enhancements

- Social — add friends, see each other's activity, etc.
- ui/ux full review
- Invite email setup on external service

## Done

## Wave 1 — Launch blockers - COMPLETE

- Cost guardrails + rate limiting (paired; spend/abuse control under multi-user BYO-key) — **done**
  - Per-user Anthropic spend visibility/limits so big libraries don't cause a surprise bill — **done**: soft-warn spend tracking shipped (`usage_events` table, `/settings` usage panel, `UsageWarningBanner`; never blocks a call)
  - `/catalog/search` per-user rate limiting (hits OL + Google Books live per keystroke) — **already satisfied**, no code change: the existing 30/min per-user SlowAPI limit on `/catalog/search` already covers this

## Wave 2 — Onboarding friction - COMPLETE

- Custom imports — biggest adoption lever (Goodreads is import-once)
  - StoryGraph, Google Play Books, Apple Books, generic CSV / other library managers
  - Manual single-book add is a slog; reduce friction
- Backup / export of in-app ratings & reviews (trust feature, adjacent to import work)

- Cost guardrails + rate limiting — soft-warn per-user spend tracking shipped (`usage_events`, `/settings` usage panel, `UsageWarningBanner`); `/catalog/search` rate limiting was already satisfied by the existing 30/min SlowAPI limit, closed with no code change
- Invite flow / account management — admin console shipped; invite + revoke users + view roster
- BUGS — cleared
- No-Anthropic-key error UX — shows error + prompts for key on profile/recommend
- Onboarding empty state — setup/onboarding wizard shows on home / swipe / my library

## Wave 3 — Recommender depth - COMPLETE

- "More books like this" from a selected library book (smallest, highest-visibility win, specific recommendations based only on selected book)
- NL discovery — natural-language "find me a book like X" search (builds on the above)
- Full feedback / labeling surface — surface LOW-confidence enrichment matches for correction

## Wave 4 — Delight & growth

- Spotify Wrapped-style profile reveal on onboarding
  - in general, I want to spice up the onboarding flow by immediately surfacing the profile to the user (possibly each trait individually) and the user approving/denying/modifying. Also maybe we should add some more metadata to the profile like favorite genres, authors, types (short story, novella, novel, seires, etc.)
- Admin console — users, token usage, API usage, feedback (overlaps Wave 1 cost visibility)

## Shelves & data model

## openrouter instead of only claude