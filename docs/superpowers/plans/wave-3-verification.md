# Wave 3 verification record (wave-level closeout)

Date: 2026-08-10
Branch: `feat/node-backend` (109 commits ahead of `main` at `8b04e6c`)
Head at closeout: `4abe5bc feat(node): POST /discover and flip it to Node in auto mode`

Wave 3 ported every Claude-calling flow from FastAPI to Next.js route handlers. It ran as five
sub-waves:

| Sub-wave | Plan                                   | Shipped                                                                                                                          |
| -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 3a       | `2026-08-05-node-backend-wave-3a.md`   | catalog layer + cache, per-user key resolution, `POST /directive/draft`, `POST /profile/archetype`, `POST /profile/reveal-lines` |
| 3b       | `2026-08-06-node-backend-wave-3b.md`   | `POST /profile`, `POST /profile/update`                                                                                          |
| 3c-1     | `2026-08-07-node-backend-wave-3c-1.md` | shared deterministic retrieval core + `POST /recommend`                                                                          |
| 3c-2     | `2026-08-10-node-backend-wave-3c-2.md` | `POST /books/{id}/similar`                                                                                                       |
| 3c-3     | `2026-08-10-node-backend-wave-3c-3.md` | `POST /discover`                                                                                                                 |

3a has its own detailed record in `wave-3a-verification.md`. This document is the wave-level
closeout: what was re-run and confirmed at the end of wave 3, what is proven by which mechanism,
where the per-sub-wave record is thinner than the process asked for, and what is still open.

## Suites, re-run by the controller at closeout

Not trusted from task or plan reports — every command below was run fresh in this session.

```
cd frontend && npx vitest run     # 56 files, 334 tests, all passing (114s)
cd frontend && npx jest           # 5 suites, 38 tests, all passing  (after the fix below)
cd frontend && npx tsc --noEmit   # clean, exit 0
cd frontend && npx eslint .       # clean, exit 0
.venv/bin/python -m pytest        # 360 passed, 83 warnings
```

### `npx jest` was red when this closeout started

`lib/__tests__/backend.test.ts`'s `wave-2/3a/3c-1 flip list is exactly as designed` assertion
still described the routing table as of wave 3c-1. Two later waves changed the table and did not
update it:

- **3c-2** dropped `exact: true` from the `POST /books` rule (so `POST /books/{id}/similar`
  follows it to Node).
- **3c-3** appended the `POST /discover` rule.

This is a stale expectation, not a behavior defect. The _behavior_ assertions in the same
file — `baseFor('/books/12/similar', 'POST')`, `baseFor('/discover', 'POST')` — were correctly
added by those waves and passed. `NODE_DEFAULT_ROUTES` itself is right; only the whole-list
snapshot beside it was left behind.

**Why nobody caught it:** `jest.config.js` sets
`testPathIgnorePatterns: ['<rootDir>/lib/server/', '<rootDir>/app/api/']`, so `lib/__tests__/` is
jest-only territory while everything wave 3c actually built lives under vitest. Both 3c-2's and
3c-3's "Done when" checklists specify `npx vitest run` and `npx tsc --noEmit` — and nothing else.
Running exactly what the plan asked for was sufficient to leave the repo with a failing suite.

Fixed in this session (updated the expected list, renamed the test to
`wave-2/3a/3b/3c flip list is exactly as designed`, and left a comment on the `POST /books` entry
explaining the dropped `exact`).

**Carry into wave 4:** its verification step must run all four frontend commands plus pytest, not
vitest alone. Wave 3b's plan got this right (Task 10 Step 1 lists jest, test:server, type-check,
lint and pytest); the 3c plans regressed it.

## Coverage proof: no Claude-calling Python path is left unported

Wave 3's completion claim rests on this. Python has exactly 11 `tracked_create(` call sites, and
`prompts.json` has exactly 11 recorded scenarios, one per site:

| Python call site    | Fixture scenario     | Node route                        |
| ------------------- | -------------------- | --------------------------------- |
| `archetype.py:250`  | `archetype`          | `POST /profile/archetype` (3a)    |
| `directive.py:246`  | `directive_distill`  | `POST /directive/draft` (3a)      |
| `reveal.py:129`     | `reveal_lines`       | `POST /profile/reveal-lines` (3a) |
| `profile.py:524`    | `profile_full`       | `POST /profile` (3b)              |
| `profile.py:793`    | `profile_update`     | `POST /profile/update` (3b)       |
| `recommend.py:637`  | `recommend_seed`     | `POST /recommend` (3c-1)          |
| `recommend.py:709`  | `recommend_rerank`   | `POST /recommend` (3c-1)          |
| `recommend.py:907`  | `similar_seed`       | `POST /books/{id}/similar` (3c-2) |
| `recommend.py:1235` | `similar_rerank`     | `POST /books/{id}/similar` (3c-2) |
| `recommend.py:1375` | `discover_interpret` | `POST /discover` (3c-3)           |
| `recommend.py:1514` | `discover_rerank`    | `POST /discover` (3c-3)           |

Verified by grep at closeout, not inherited from a plan. Every remaining Python route
(`/enrich*`, `/ingest*`, `/import*`, `/admin/*`, the deletes, `/export`, `/health`) reaches no
Claude call.

`NODE_DEFAULT_ROUTES` carries all seven wave-3 flips, ending with
`{ prefix: '/discover', methods: ['POST'], exact: true }`. Two `exact` flags in that table are
load-bearing and tested as such: `/recommend` (else it swallows `/recommendations`) and
`/profile` POST (else it swallows `/profile/*`).

## What is proven how

"Parity" here means the **request** is byte-identical, never the response — Claude output is
nondeterministic. `scripts/gen_claude_fixtures.py` monkeypatches `tracked_create` to record real
Python `create()` kwargs, and the parity tests assert Node's prompt, system blocks, tool schema,
model and max_tokens match exactly.

| Route                        | Prompt parity | Route-level test | Exercised live                                        |
| ---------------------------- | ------------- | ---------------- | ----------------------------------------------------- |
| `POST /directive/draft`      | yes           | yes              | yes — 3a record, real Claude call                     |
| `POST /profile/archetype`    | yes           | yes              | yes — 3a record, real Claude call                     |
| `POST /profile/reveal-lines` | yes           | yes              | yes — 3a record, real Claude call + idempotency       |
| `POST /profile`              | yes           | yes              | **unrecorded** (see below)                            |
| `POST /profile/update`       | yes           | yes              | **unrecorded** (see below)                            |
| `POST /recommend`            | yes           | yes              | yes — signed off by Chase after the fixture re-record |
| `POST /books/{id}/similar`   | yes           | yes              | **unrecorded** (see below)                            |
| `POST /discover`             | yes           | yes              | yes — 3c-3 record, browser at `/discover`             |

The retrieval core underneath the last three is proven harder than prompt parity alone: the
parity tests replay `recommend-http.json`, real catalog HTTP recorded during the Python run, so a
byte-identical rerank prompt also proves pool order, dedup, the language/series/fuzzy/learner
filters, author caps and cap ordering — any divergence upstream changes the candidate list baked
into the prompt.

### Sub-wave record quality is uneven

- **3a** — full `wave-3a-verification.md`: isolated Docker Postgres, both backends side by side,
  proven pre-write isolation, the 429 shape fired for real on both, all three routes' real
  success paths against a live key, a whole-branch review with 4 Important findings fixed.
- **3b** — the SDD ledger (`.superpowers/sdd/2026-08-06-node-backend-wave-3b/progress.md`) shows
  all 10 tasks complete, the whole-branch review closed and its fix wave landed (`4e1c6b4`). Its
  last line reads _"Next: Task 10 (full verification …, write wave-3b-verification.md, push)"_.
  **That document does not exist and was never committed** (confirmed against git history for
  `docs/superpowers/plans/*verification*`). The `mylib-w3b-verify` container recipe is referenced
  by later work, so some of Task 10 likely ran — but nothing recorded it, so wave 3b's live
  side-by-side must be treated as unverified rather than assumed done.
- **3c-1** — no evidence section in its plan; the sign-off is the commit
  `71da5d4 chore(node): sign off wave 3c-1` and CLAUDE.md's account of the fixture re-record with
  a real `GOOGLE_BOOKS_API_KEY` (16/16 googleapis + 8/8 openlibrary returning data, closing an
  earlier keyless recording where every Google Books URL 429'd off the shared anonymous quota).
- **3c-2** — no evidence section in its plan. Its Task 5 Step 9 asked for a browser run of the
  "more books like this" flow with a Network-tab check; there is no record that it happened.
- **3c-3** — a full evidence section appended to its plan: fixture regeneration counts, 334 tests,
  and a live browser run at `/discover` on a throwaway Docker Postgres showing
  `POST /api/discover → 200`, **zero** requests to the Python backend, 0 `/discover` hits in the
  Python access log, `recommendations` still at 0 rows (ephemeral confirmed), and
  `usage_events` at 5 `discover_interpret` / 3 `discover_rerank` matching the flows actually run.

## Deliberate gaps — not defects

- **`both` retrieval-pool value and `assemble`'s second-sighting backfill are not fixture-driven.**
  No dedup key landed in both the metadata and seed pools during recording. Covered by
  hand-written unit tests in `rec-assemble.test.ts` instead.
- **Three Python quirks are reproduced on the similar-books path on purpose**: the series and
  fuzzy-duplicate filters are inert (`_build_book_signal` returns no `library_series` /
  `library_titles`), rejected recommendations are not excluded, and custom instructions do not
  steer it.
- **Discovery is the odd one out**: `assemble` gets an empty metadata pool (every candidate is
  tagged `claude_seed`), a stated language constraint replaces the reader's library languages for
  the run, and the standing directive does not steer it. Its two prompts share
  `recPrompts.tasteAndLoved` behind headers that differ by one substring — asserted parity, not a
  typo.
- **`GET /catalog/search` requires auth in Node though Python's is unauthenticated** — a permanent,
  deliberate divergence decided in 3a (invite-only app, no public search proxy).
- **Fixture churn on re-record is expected.** The fixtures snapshot live catalog data; Google
  Books re-ranking moves roughly one candidate in sixty. The parity tests prove Node reproduces
  whatever was recorded, not one specific candidate list.

## Outstanding for Chase

1. **The Python `valid_ids` fix is still not on `main`.** `git branch --contains 2c231f8` returns
   only `feat/node-backend` and its remote — confirmed today. This is a live production 500 on
   Railway for any user with a rejected recommendation carrying a note (`POST /profile` raises
   `KeyError`). Flagged since wave 3b's Task 0 and still unactioned; it is the oldest open item on
   this branch and the only one affecting users right now.
2. **`MYLIBRARY_MODEL` must be set in Vercel's environment.** Five Node routes now resolve their
   model through `profileModel()` (`lib/server/profileBuild.ts:23`), directly or via
   `recPrompts.rankModel()`: `/profile`, `/profile/update`, `/recommend`, `/books/{id}/similar`,
   `/discover`. Node falls back to `claude-sonnet-5`; live `usage_events` showed Python running
   `claude-sonnet-4-6`, so it is set locally. If Vercel's is unset the two backends silently
   diverge on model, cost and output. Carried since 3b, still unconfirmed.
3. **Five Python routes have no wave assigned.** Wave 4 is jobs + imports, wave 5 is admin +
   cutover; that leaves `DELETE /account`, `DELETE /library`, `DELETE /profile`, `GET /export` and
   `GET /health` homeless. Wave 3b's plan flagged `DELETE /profile` explicitly and guessed it
   belongs with a purge/delete-account group. Recommendation: put all five in wave 5 — `DELETE
/account` is the highest-blast-radius route in the app and should not be swept in as cutover
   housekeeping.
4. **Decide what to do about the missing `wave-3b-verification.md`** — write it retroactively
   (its live checks would have to be re-run to be honest), or explicitly waive it and note that
   3b's live behavior was first confirmed indirectly by 3c's work on the same routes.
5. **Parked minor findings** from 3a's and 3b's final reviews remain in the ledgers — none
   blocking, worth reading the next time those files are touched.

## Bottom line

Wave 3 is complete and green. All five suites pass at head, every Claude-calling Python path has a
Node counterpart with byte-identical request parity, and the routing table serves all seven routes
from Node in `auto` mode. The one real defect found at closeout was a stale test expectation left
by 3c-2 and 3c-3, caused by those plans' verification checklists narrowing to `vitest` alone —
fixed here, and worth fixing in the process before wave 4.
