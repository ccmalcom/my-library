# Wave 3a verification record

Plan: `docs/superpowers/plans/2026-08-05-node-backend-wave-3a.md`
Branch: `feat/node-backend` (89 commits total: waves 0-2's 74 + wave 3a's 15, pushed to origin)
Executed via: superpowers:subagent-driven-development — one implementer + one task reviewer per
task, fix loops where findings surfaced. Ledger: `.superpowers/sdd/2026-08-05-node-backend-wave-3a/progress.md`.
Commit mode: Chase explicitly authorized commit-as-you-go for this session (2026-08-05), matching
how waves 0-2 landed.

## Tasks 1-9: implementation (done, all reviewed clean)

All 9 implementation tasks (catalog Postgres cache, catalog fetch layer, `search_books` port +
`GET /catalog/search`, Anthropic key resolution + client factory, prompt-parity fixture
generator, `POST /directive/draft`, `POST /profile/archetype`, `POST /profile/reveal-lines`,
backend switcher flip) passed their individual task reviews. Real findings surfaced and were
fixed in-loop:

- **Task 3**: the plan's own sample 429 response body was wrong. Verified directly against the
  installed `slowapi` package and `mylibrary/api.py:148,182`: the real Python 429 for a
  rate-limited route is `{"error": "Rate limit exceeded: N per M minute(s)"}` (key `"error"`, not
  `"detail"`) with **no** extra headers (`headers_enabled=False`, never overridden) — not the
  `{"detail": ...}` + `Retry-After` shape the plan sketched. Corrected before implementation, not
  after; the implementer also caught and fixed a second, unflagged issue: the plan's fixture
  generator as given would have baked a real Google Books API key into a committed fixture file.
- **Task 3, one review finding**: `GET /catalog/search` requires auth in Node though Python's
  `search_catalog` has none at all (confirmed via a passing Python test with no Authorization
  header). Escalated to Chase per the SDD process (a genuine plan-vs-parity conflict, not
  resolvable by the reviewer). **Decision: keep Node's auth requirement — deliberate, permanent
  divergence** (invite-only app, no public search proxy desired), documented in `route.ts`.
- **Task 4**: `claudeErrors.ts` shipped empty despite the plan mandating `NO_KEY_MESSAGE`
  constants; the decrypt-failure-fallthrough design choice was undocumented and untested. Both
  fixed in one round.
- **Task 6**: the plan's own sample code for `buildDistillPrompt` omitted Python's `.strip()` on
  the reader message, and the plan's "Known risks" section incorrectly claimed `directive.py`
  doesn't pass `ensure_ascii=False` to `json.dumps` (it does, confirmed by reading the line
  directly) — both corrected before dispatch. Review found 2 gaps: the trim behavior had no
  executable proof, and `existingSignals`' book-resolution/direction-split logic was entirely
  untested (the shared seed has zero `taste_signal` rows). Both fixed with new tests.
- **Task 7**: the brief was unusually thin (29 lines vs. 100+ for other tasks) and had real
  errors — a wrong `_clamp_axis` error message, only 2 of 4 actual `RuntimeError` conditions
  named, no mention that Node needed a previously-nonexistent 16-entry `ARCHETYPES`
  code→{name,tagline} table, and no mention that GET and POST needed to share response-building
  logic (mirroring Python's `_archetype_out`). All discovered by reading `mylibrary/archetype.py`
  and `api.py` directly before dispatch; all verified correctly applied by the reviewer,
  including a line-by-line check that the resulting GET refactor is provably behavior-preserving.
- **Task 8**: same pattern — the brief omitted that Python's `generate_reveal_lines` checks for
  pending work *before* resolving an API key (so an idempotent no-op call must never require a
  configured key), and omitted an unordered-query parity risk (Python's pending-traits query has
  no `ORDER BY`, which matters because row order feeds the byte-exact prompt). Both resolved
  correctly (a nullable-`client` design for the first; `ORDER BY id ASC`, empirically verified
  against the real captured Python fixture, for the second) and confirmed by the reviewer.
- **Task 9**: mechanical routing-table flip, clean on the first pass; reviewer noted a couple of
  now-stale doc comments (deferred, see below).

Deferred minor findings (logged in the ledger, none load-bearing): a Google-publishedDate
partial-parse edge case, an unused test import, an undocumented flat-vs-phased HTTP timeout, a
non-atomic throttle under future concurrent catalog fetches, an orphaned fixture-generator
tempdir, an unreachable degenerate-input error-message mismatch, two routes' POST handlers not
directly end-to-end tested (later fixed — see Final review below), and a couple of imprecise/stale
routing-table comments.

## Task 10: full verification

### Step 1 — all suites (done)

```
cd frontend && npx jest              # 5 suites, 35/35 passed
cd frontend && npm run test:server   # 37 files, 194/194 passed
cd frontend && npm run type-check    # clean
cd frontend && npm run lint          # clean
.venv/bin/python -m pytest           # 359 passed (unchanged from wave 2 — wave 3a only adds scripts/)
```

All commands independently re-run by the controller, not just trusted from task/reviewer reports.

### Step 2 — local isolated side-by-side: DONE (unlike waves 1-2, which skipped/deferred this)

Wave 3a's plan specified a genuinely throwaway Docker Postgres for **both** backends (not
wave 1-2's approach of pointing Node at `.env.local`'s real `DATABASE_URL`), which sidesteps the
real-dev-data risk that caused waves 1-2 to narrow or defer this step. Stood up:

```
docker run -d --name mylib-w3a-verify -e POSTGRES_PASSWORD=throwaway \
  -e POSTGRES_DB=mylibrary_verify -p 55432:5432 public.ecr.aws/supabase/postgres:17.6.1.143
# granted schema perms, ran `alembic upgrade head`, seeded 2 books via the CLI
# Python: mylibrary.cli serve --port 8010 (DATABASE_URL -> throwaway Postgres)
# Node:   npm run dev --port 3000 (same DATABASE_URL; fresh throwaway ENCRYPTION_KEY;
#         SUPABASE_URL/JWKS/JWT_SECRET + NEXT_PUBLIC_SUPABASE_* all empty -> local auth mode)
```

**Isolation proven before any write**: `curl .../api/books` and `curl .../books` both returned
exactly the 2 seeded books (ids 1, 2) on both backends — not real dev data.

**Live comparisons, both backends, same throwaway DB:**
- `GET /catalog/search?q=dune`: top-ranked candidate identical on both backends
  (`OL20832265W | Dune | Kevin J. Anderson | 2004`); full cross-source comparison was limited by
  this sandbox having no `GOOGLE_BOOKS_API_KEY` available to the Node process (a session
  constraint, not a code issue — Task 3's fixture-replay tests already prove the full multi-source
  dedup/rank/merge algorithm byte-exact using real recorded Google Books data).
- `GET /catalog/search?q=` → 422 on both, same documented flat-string-vs-structured-array
  `detail` shape difference that's held since wave 1.
- **30/minute rate limit, fired for real on both backends independently** (33 concurrent
  requests each): 30×200, 3×429, body `{"error":"Rate limit exceeded: 30 per 1 minute"}` on
  both, **no** `Retry-After`/`X-RateLimit-*` headers on either — confirming the corrected 429
  shape found in Task 3 against a live server, not just the installed `slowapi` package's source.
  (An initial *sequential* 10-request test appeared to under-count the limiter — root-caused to
  each real catalog search taking ~3s of genuine throttled upstream network time, so a sequential
  loop spans multiple 60s rate-limit windows and the cleanup query correctly drops the stale
  window's row. Not a bug; a testing-method artifact, resolved by firing requests concurrently.)
- **All three Claude routes' safe (no-spend) paths, live**: confirmed via
  `GET /settings/api-key/status` that Node's dev-server process had no live key
  (`configured:false`) before touching any of them, so these are genuinely risk-free —
  `POST /directive/draft` → 400 with the exact `DISTILL_NO_KEY_MESSAGE`;
  `POST /profile/archetype` → 400 with the exact `ARCHETYPE_NO_KEY_MESSAGE`;
  `POST /profile/reveal-lines` → **200 with `[]`, no key required** (zero taste traits exist, so
  the idempotent no-op path fires) — live-proving Task 8's nullable-client design end to end.
- `POST /api/books` add-flow: a real duplicate-title add correctly 409'd
  (`"Dune" is already in your library.`); `GET /profile/archetype` correctly 404'd
  (`"No archetype derived yet"`) identically on both backends.

Torn down at the end of this session (`docker rm -f mylib-w3a-verify`, both server processes
killed, ports 3000/8010/55432 confirmed free) — rate_limits rows were cleaned between checks
along the way.

### Step 3 — real-app pass: curl-through-handlers (Chrome extension not connected)

`mcp__claude-in-chrome__tabs_context_mcp` returned "Browser extension is not connected" —
per the plan's own contingency ("drive it by curl through the same handlers and say so
explicitly"), Step 3 was done via direct curl against the real running route handlers (the same
isolated stack from Step 2), not a browser click-through. This is not a substitute for an actual
browser session — flagging explicitly per the global verification rule, not implying more than
was done. Covered: the full catalog-search → add-book → duplicate-detection flow above, all
three Claude routes' safe paths, and the GET/POST archetype 404/shape consistency check.

**Addendum — the three Claude routes' real success paths, live (done after the rest of Task 10,
once Chase pointed out a real `ANTHROPIC_API_KEY` exists in the root `.env`):** rebuilt the
isolated stack (fresh throwaway Postgres, one seeded book, two directly-seeded `taste_traits`
rows so archetype/reveal-lines had real work to do) and started the isolated Node server with the
real key loaded via `dotenv`, the same pattern `frontend/drizzle.config.ts` already uses — the
key was never read, printed, or logged by the controller (confirmed only "loaded" in the startup
log, never its value). The initial attempt to background-launch that server was blocked by
Claude Code's auto-mode safety classifier; rather than work around it, the controller asked Chase
to run the (fully-specified, pre-written) start command himself via `!`, which he did.

All three routes succeeded for real:
- **`POST /api/directive/draft`**: 200, a coherent distilled proposal
  (`"You want literary science fiction that avoids grimdark tone..."`) with correctly-extracted
  `exclude_subjects`/`exclude_authors` constraints.
- **`POST /api/profile/archetype`**: 200, a valid derived code (`RCDM`, "The Cerebral
  Architect") with real per-axis rationale text grounded in the seeded traits; a follow-up `GET`
  returned byte-identical output, confirming Task 7's GET/POST shared-response-building refactor
  holds under a real Claude response, not just the fixture-driven test.
- **`POST /api/profile/reveal-lines`**: 200, two genuine, on-spec reveal lines (≤14 words,
  second person: `"You notice every sentence. Plain prose doesn't hold your attention."` /
  `"You finish a book and close it. Series rarely pull you back."`), correct `TraitOut[]` shape
  ordered by `inference_confidence DESC` (not the internal `{generated,traits,model}` dict). A
  second call proved idempotency for real: `2.97ms` vs. the first call's `3998ms` — no second
  Claude call was made, live-confirming Task 8's design with genuine API behavior, not a stub.

Stack torn down again immediately after (container removed, server killed, temp launcher script
deleted, ports and working tree confirmed clean). Total cost: 3 small Haiku calls, well under a
cent per the plan's own estimate.

### Step 4 — Vercel function duration (done)

No `vercel.json` in the repo; confirmed the current limits directly via Vercel's docs
(fetched fresh, not from training data) and cross-checked the actual `my-library` project
(`prj_9sDWYdSVKiKChHRlLKA5mXdNs0hj`) via the Vercel MCP tools:

| Plan | Default | Maximum (GA) | Extended maximum (beta) |
|---|---|---|---|
| Hobby | 300s | 300s | — |
| Pro | 300s | 800s | 1800s |
| Enterprise | 300s | 800s | 1800s |

Raised all three Claude routes' `maxDuration` from 60s to **300s** (Hobby's ceiling — safe on any
tier without needing to confirm which one is active; commit `476230e`). The routes were already
comfortably under 60s in practice (single Haiku calls); this is pure headroom, not a fix for an
observed timeout.

### Step 5 — push + preview deploy (done)

Pushed `feat/node-backend` (15 new commits, `1ae68a7..b3c721f`) — pre-authorized in the plan's
Task 10 Step 5 text ("push is authorized as part of this plan"); announced before pushing.

```
git push origin feat/node-backend  ->  1ae68a7..b3c721f
```

Vercel preview build: **confirmed READY.** The Vercel MCP tools hit an upstream sign-in rate
limit (`mcp_upstream_auth_rate_limited`) immediately after the push; retried a few minutes later
(after writing this doc) and got a clean response — `dpl_8ARRs69Nqc42dck26vBchBjYobKp`,
`readyState: READY`, `githubCommitSha: b3c721f...` on `githubCommitRef: feat/node-backend`
(exactly this wave's HEAD, confirmed via `get_deployment`, not just trusted from
`latestDeployment`). Branch alias: `my-library-git-feat-node-backend-ccmalcoms-projects.vercel.app`.

## Final whole-branch review (opus, base `1ae68a7`, head `476230e`)

Per `superpowers:subagent-driven-development`, a broad final review ran on wave 3a's own diff
(not the full branch back to `main` — each wave reviews itself, matching waves 0-2's precedent)
after all 9 tasks passed individually, on the most capable model, specifically hunting for
cross-task issues no single task's review could see.

**4 Important findings, 0 Critical:**

1. **`getJson`'s catch swallowed httpReplay's "no fixture" error.** The test harness's own
   guarantee ("any unfixtured URL throws loudly") didn't hold — a fixture miss degraded into a
   silent, confusing wrong-results diff instead of a named error. Proven with a live repro.
2. **The corrected 429 body was duplicated as an untested literal in two route files.** Correct
   by copy-paste in both places, but nothing enforced or tested it.
3. **`directive/draft` and `profile/archetype`'s POST handlers had zero end-to-end route
   coverage** — only their inner service functions were tested directly. `reveal-lines`
   established the working pattern; the other two didn't adopt it.
4. **`existingSignals` omitted the `ORDER BY`** convention Tasks 7 and 8 both adopted for their
   own prompt-feeding queries, since row order is baked into the byte-exact Claude prompt.

The reviewer also flagged two **plan defects** (not implementation bugs) worth carrying into
3b/3c: the plan's Known Risk #1 (URL encoding, `%20` vs `+`) and Known Risk #3 (`ensure_ascii`)
are both factually backwards — verified directly against `httpx`/`mylibrary/directive.py` — and
a plan-following implementer who trusted that prose rather than the source would have introduced
bugs fixing problems that don't exist.

**Fix (one dispatch, per the skill's "no second fix wave" rule):** dispatched to a subagent,
which was interrupted mid-task (a tool-use rejection) before it could run its own
format/test/commit/report steps, leaving substantial uncommitted work. The controller inspected
the entire diff directly file-by-file (not a skim), judged the substantive logic complete and
correct, then ran the closing steps itself — which surfaced a real bug the interrupted agent's
own new tests had introduced: two "no key configured" route tests loaded the shared parity seed
fixture, which (contrary to an incorrect comment in the test) has a stored, decryptable Anthropic
key for user `'local'` left over from wave 2's fixtures — causing `resolveAnthropicKey` to
resolve a real key, build a real Anthropic client, and attempt a genuine network call, which
failed with a live 401 from Anthropic and surfaced as an uncaught 500 instead of the intended
400. This is exactly the class of thing the plan's Global Constraints explicitly forbid ("No live
Anthropic spend in tests, ever"). Root-caused and fixed directly (removed the unneeded `loadSeed`
call — neither route touches any table before its key check, so no seed data was ever required).
Commit `b3c721f`. Full suite re-confirmed green after the fix: 194/194 vitest, 35/35 jest, clean
tsc/lint.

**Scoped re-review (opus):** all 4 original findings plus the live-network-call bug independently
verified ADDRESSED at the mechanism level (not just "tests pass") — e.g. confirmed `getJson`'s
re-throw actually propagates out of all 3 call sites, confirmed the 429 helper is genuinely
single-sourced with a repo-wide grep, confirmed the new no-key tests' network path is now
structurally unreachable (not merely untriggered), confirmed the strengthened `existingSignals`
test's out-of-order seed data actually makes the `ORDER BY` load-bearing rather than
coincidentally passing. **3 new Minor findings**, none blocking, parked in the ledger:
`ratelimit-routes.test.ts`'s 31-request loop is wall-clock/minute-boundary dependent (no `nowMs`
pinning, theoretical flake risk); the archetype "no taste profile" test constructs a real,
unmocked Anthropic client (safe only because `deriveArchetype` throws before any Claude call —
same exposure class this wave just fixed elsewhere); `rateLimitExceededResponse`'s
minute-pluralization math would mis-render a sub-60s window (no current caller uses one).

## Summary

Everything executable without Chase's live/logged-in involvement is done and green: all 4
automated Node suites plus the unchanged-count Python suite, independently re-run by the
controller — plus, unlike waves 1-2, a genuinely isolated live dual-backend verification (Docker
Postgres, both backends, proven pre-write isolation) that exercised catalog search, the corrected
429 shape (fired for real on both backends), and all three Claude routes' safe paths end to end.
A final whole-branch review caught 4 real cross-task gaps (all test/observability debt, no
runtime-behavior bugs) and, during its own fix wave's verification, an actual live-network-call
bug in a brand-new test — caught before it ever reached CI. The branch is pushed
(`1ae68a7..b3c721f`, 15 commits).

Two things distinguish this wave from waves 1-2's verification record: (1) the plan itself was
unusually error-prone — three separate corrections were needed before implementation even started
(the 429 shape, Task 6's missing `.strip()`, Task 7's wrong clamp message and missing
`ARCHETYPES` table), all caught by reading the actual Python source rather than trusting the
plan's prose, and two more plan-prose errors were caught by the final review; (2) the isolated
local side-by-side that waves 1-2 had to skip or narrow (real-dev-data risk) was fully executable
here because wave 3a's plan specified a genuinely throwaway backing store for both backends.

## Outstanding for Chase

- **Live checks on the preview** (build already confirmed READY above): same SSO-gated constraint as every prior
  wave (Vercel Authentication protects all non-production-domain deployments) — needs Chase's
  logged-in browser. The three Claude flows' real success paths were already live-verified
  against the isolated stack (see the Step 3 addendum above), so this is about confirming the
  same behavior holds on the actual Vercel deployment, not first-time verification: draft a
  directive, derive an archetype, view the reveal — confirm 200s, correct bodies, no 500s.
- **A genuine browser click-through** (Chrome extension wasn't connected this session) — confirm
  the add-a-book picker's catalog search actually renders in the UI and the network tab shows
  `/api/catalog/search`/`/api/directive/draft`/`/api/profile/archetype`/`/api/profile/reveal-lines`
  hitting Node in `auto` mode, matching Task 9's routing-table flip.
- **3 parked Minor findings** (ledger has full detail) worth a look next time these specific
  files are touched, not urgent enough to block this wave: `ratelimit-routes.test.ts`'s
  window-boundary flake risk, the archetype no-profile test's unmocked Anthropic client
  construction, and `rateLimitExceededResponse`'s sub-60s pluralization gap.
- **Plan defects for whoever writes 3b/3c**: Known Risks #1 and #3 in the wave-3a plan are both
  backwards from the real Python behavior — don't "fix" `pyJsonDumps`'s lack of ASCII-escaping or
  add manual `%20` URL-encoding based on that prose; the current (correct) implementations already
  contradict it deliberately. Also: neither Task 6 nor 7's brief flagged the missing `ORDER BY`
  on prompt-feeding queries (only Task 8's did, and only via the controller catching it) — 3b/3c
  are dense with unordered prompt-feeding queries, worth a standing rule.
