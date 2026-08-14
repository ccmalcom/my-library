# TODO

## BUGS

- **Enrichment continuation: FIXED and verified in production 2026-08-13.** One item still open —
  see "remaining" below.
  **Root cause, and it was never `CRON_SECRET`.** `proxy.ts`'s matcher covered `/api/*`, so
  `updateSession` 307-redirected the cookieless internal `/api/enrich/tick` fetch to `/login`
  before the handler ran — and did the same to the cron-invoked `/api/enrich/janitor`, so the
  janitor had never run either. Fixed by adding `api` to the matcher's negative lookahead, plus a
  `response.ok` check in `rearmAfterResponse` so a non-2xx tick is logged instead of silently
  counted as success. Both mutation-tested. Merged as `e2c373e` (PR #43).
  The un-guarded dispatch that made this dangerous was fixed separately in `ef28810`: both call
  sites now catch, `runClaimedChunk` returns `rearmed: false` instead of throwing,
  `repairActiveJobs` survives a mid-sweep failure and counts it in `dispatchFailed`. Both guards
  are mutation-tested. See `docs/hosting.md`.
  **Verified on `shelfsprite.app`** under a temporary 100s budget: a forced 159-book run spanned
  two chunks and reached `done` at 159/159. `CHUNK_BUDGET_MS` reverted to `240_000` in `2b4686c`.
  **Remaining: confirm the janitor fires at `17 3 * * *` UTC — it never has.** First real
  opportunity is the night of 2026-08-13, now that the matcher fix is deployed.
  Two criteria corrections worth keeping:
  - **"≥ 2 ticks, never `done`" was the wrong bar** — it was extrapolated from a 221s run, and the
    149s verification run legitimately produced exactly 1 tick. The real bar is a tick invocation
    **and** progress advancing across the chunk boundary.
  - **Tick count alone is never evidence** — 21 ticks once coexisted with progress frozen at
    65/159, every one a 307 triggered by a status poll's poll-repair redispatch.
  **`tick→tick` chaining is still unproven**: the verification job finished inside its first tick,
  so no tick ever had to re-arm another. At `240_000` this library completes in one chunk and
  cannot test it — needs a ~`40_000` budget or a much larger library.
  Do NOT test any of this on a preview deployment: Vercel SSO is enabled
  (`all_except_custom_domains`), so a preview tick is intercepted by the protection layer too — a
  second, independent cause with the same symptom.
  Residual: the only automatic recovery is `failIfStale`, which fires on a *user-initiated status
  poll*, not a timer. Verified live 2026-08-13 — a job abandoned at 15:29:06 was marked `error`
  with `Enrichment was interrupted, please retry.` at 16:00:12 (1866s, past the strict 1800s
  threshold), preserving `progress` at 65/159.

- ~~**Add-book search ranking scores correct matches 0.**~~ **FIXED 2026-08-13, Node only.**
  Root cause was `matchScore` (`frontend/lib/server/catalog.ts`, mirror of `_match_score`,
  `mylibrary/catalog.py:449`) — NOT retrieval. Both defects are fixed:
  1. `normFull` mapped non-alphanumerics to a *space*, so `"The Android's Dream"` became
     `the android s dream` with a stray `s` token and the query `the androids dream` failed all
     five bands → score 0. Apostrophes (`['’ʼ‘]`) now elide to empty *before* the
     `[^a-z0-9 ]`→space pass.
  2. Query tokens could never span title AND author. `matchScore` now peels author-matching
     tokens off the query and scores the remainder against the title, in bands above the
     title-only ones. **Graded 95 (remainder == title) / 92 (title starts with remainder) / 90
     (remainder ⊆ title tokens)** — this grading was NOT in the original write-up and is
     load-bearing: a single flat band leaves *The Lock In Series* tied with *Lock In*, which
     then wins on the year tiebreaker.
  **Python's `_match_score` was deliberately NOT fixed** (Chase's call 2026-08-13) — it serves
  zero traffic and is deleted with the rest of `mylibrary/`. Parity survived anyway:
  `catalog-search.test.ts` still passes untouched, because neither fix moves `dune`,
  `ancillary justice`, or the ISBN query, so `expected.json` needed no regeneration.
  Covered by `catalog-ranking.test.ts` — behavioral, not parity, tests against real pools
  recorded by `scripts/gen_search_ranking_fixtures.py`. That recorder **merges into
  `http.json` additively on purpose**: a full `gen_catalog_fixtures.py` re-record also
  regenerates `enrichment-expected.json`, whose seven seeds were hand-picked by probing live
  catalogs to hit five specific match branches, and can flip one for reasons unrelated to search.
  Live-verified against real catalogs on an isolated Postgres: `the androids dream`,
  `lock in scalzi` and `scalzi lock in` all went from absent-in-top-8 to #1; `lock in`,
  `the fault in our stars` and `ancillary justice` unaffected.
- **Search tiebreakers favor recency over canonicity** (separate, pre-existing, lower priority).
  The year-DESC tiebreaker in `searchBooks`' sort comparator floats reissues and study guides
  above canonical works — plain `dune` returns Kevin J. Anderson's above Frank Herbert's.
  **Confirmed still live 2026-08-13** after the ranking fix above, which does not address it.
  Note the committed `dune` fixture pool happens to order Herbert first, so no fixture-driven
  test can currently reproduce this — a fresh recording is needed, in its OWN fixture file, so
  it does not overwrite the pool `catalog-search.test.ts`'s parity assertions depend on.
  Two candidate signals, neither free:
  - `edition_count` from Open Library is the right signal but is **not** in the `fields` param
    we request; adding it changes the request URL, and the parity test replays recorded URLs
    asserting Node issues exactly Python's. **Blocked until the Python delete.**
  - Counting dedup sightings (`mergeInto` already collapses duplicate editions across all four
    fetches; a canonical work has far more) needs no URL change and is source-neutral —
    viable now. Untried.
  Google's `ratingsCount` was evaluated and rejected: sparse and tiny (25, 5, 3, mostly absent),
  and absent entirely from Open Library, so it acts as a source preference rather than a
  tiebreaker.

## Python retirement — in flight

Production has served 100% Node since `fdc5c84`; the full smoke (sign-in, library, profile,
`POST /recommend`, multi-chunk enrichment) passed on `shelfsprite.app` 2026-08-13 with zero
Railway traffic and zero non-200s. **Railway is PAUSED as of 2026-08-13 — delete on or after
2026-08-20** (5b-2 Task 8 Step 3: a paused service costs nothing and restarts instantly).

Before the delete:

- [ ] Confirm the janitor fired (see the enrichment item under BUGS). **Vercel runtime-log
      retention does not reach `03:17 UTC`** — a 24h log query returns nothing for the janitor and
      an explicit 02:00–06:00 UTC window fails with `ExceedsBillingLimitError`, so absence of log
      lines is a false negative, not evidence. The cron IS registered (`vercel crons ls` →
      `/api/enrich/janitor`, `17 3 * * *`). Needs a different evidence source — e.g. have the
      janitor write a durable row, or catch it inside the retention window.
- [x] Record Railway's environment-variable names into the ledger — done 2026-08-14, all eleven in
      `docs/hosting.md` under "Railway's environment, recorded at retirement". Two absences were
      findings in themselves (`REDIS_URL` never set, confirming arq was never the production path;
      no `MYLIBRARY_*` tuning vars, so production ran on code defaults). It also turned up the two
      items below.
- [ ] **Set `FRONTEND_URL=https://shelfsprite.app` on Vercel.** Node's `inviteUser`
      (`supabaseAdmin.ts:123`) reads it to build the invite `redirect_to`; it was set on Railway and
      is absent from Vercel, so since cutover Supabase has been falling back to its dashboard Site
      URL. Invite-only product — this is the only way anyone joins. Needs a redeploy to take effect.
- [ ] **Confirm what `FEEDBACK_PROMPTS_ENABLED` was set to on Railway.** Node defaults it to `true`
      when unset and it is absent from Vercel, so if Railway held `false` the cutover silently
      re-enabled targeted feedback prompts. The value was masked when the names were recorded.
- [ ] Re-confirm zero traffic from Railway's own 7-day request log.

After the delete (5b-2 Tasks 1–7, no deadline):

- [ ] drizzle baseline generated from a production `pg_dump`, **never** a fresh `alembic upgrade
      head` — see CLAUDE.md on the two legitimate `enrich_jobs.progress`/`total` shapes.
- [ ] Delete `mylibrary/`, `tests/`, `alembic/`, the fixture recorders.
- [ ] Strip `NEXT_PUBLIC_API_URL` and the `python`/`auto` switcher. **Once Railway is gone the
      admin System tab's `python` override is a foot-gun that breaks every route if toggled** —
      do this promptly rather than "eventually".
- [x] Fix add-book search ranking — done early, 2026-08-13, without waiting for the delete. Node
      only; the parity fixture turned out not to be a blocker (see BUGS above).
- [ ] Fix the search canonicity tiebreaker using Open Library `edition_count` — this one really
      is blocked on the delete, because it changes the request URL the parity test replays.
      Skip if the dedup-sightings alternative (see BUGS) lands first.
- [ ] Rewrite `CLAUDE.md`'s current-state line with no wave numbering in the present tense.

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

## Wave 4 — Delight & growth - COMPLETE

- Spotify Wrapped-style profile reveal on onboarding
  - in general, I want to spice up the onboarding flow by immediately surfacing the profile to the user (possibly each trait individually) and the user approving/denying/modifying. Also maybe we should add some more metadata to the profile like favorite genres, authors, types (short story, novella, novel, seires, etc.)
- Admin console — users, token usage, API usage, feedback (overlaps Wave 1 cost visibility)

## Shelves & data model

## openrouter instead of only claude