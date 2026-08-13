# TODO

## BUGS

- **Enrichment continuation has never actually run in production.** (The un-guarded dispatch that
  made this dangerous is **fixed** — commit `ef28810`; both call sites now catch, `runClaimedChunk`
  returns `rearmed: false` instead of throwing, `repairActiveJobs` survives a mid-sweep failure and
  counts it in `dispatchFailed`. Both guards are mutation-tested. See `docs/hosting.md`.)
  **Root cause found 2026-08-13, and it was never `CRON_SECRET`.** `proxy.ts`'s matcher covered
  `/api/*`, so `updateSession` 307-redirected the cookieless internal `/api/enrich/tick` fetch to
  `/login` before the handler ran — and did the same to the cron-invoked `/api/enrich/janitor`, so
  the janitor had never run either. Fixed by adding `api` to the matcher's negative lookahead, plus
  a `response.ok` check in `rearmAfterResponse` so a non-2xx tick is logged instead of silently
  counted as success. Both mutation-tested. **Not yet merged or deployed.**
  Remaining verification, in this order:
  1. Merge the matcher + visibility fixes **with** `CHUNK_BUDGET_MS` still at the temporary
     `100_000`. Reverting the budget first puts you back to a 221s run that fits in one chunk and
     proves nothing.
  2. Re-run the forced enrich on production and require BOTH `/api/enrich/tick` **≥ 2** AND progress
     advancing past 65/159. **Tick count alone is not evidence** — 21 ticks coexisted with frozen
     progress, every one a 307, each triggered by a status poll's poll-repair redispatch.
  3. Confirm the janitor fires at 03:17 UTC (it never has).
  4. Revert `CHUNK_BUDGET_MS` to `240_000`.
  Do NOT test any of this on a preview deployment: Vercel SSO is enabled
  (`all_except_custom_domains`), so a preview tick is intercepted by the protection layer too — a
  second, independent cause with the same symptom.
  Residual: the only automatic recovery is `failIfStale`, which fires on a *user-initiated status
  poll*, not a timer. Verified live 2026-08-13 — a job abandoned at 15:29:06 was marked `error`
  with `Enrichment was interrupted, please retry.` at 16:00:12 (1866s, past the strict 1800s
  threshold), preserving `progress` at 65/159.

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