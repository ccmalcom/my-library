# Wave 2 verification record

Plan: `docs/superpowers/plans/2026-08-04-node-backend-wave-2.md`
Branch: `feat/node-backend` (45 commits total: wave 0's 13 + wave 1's 15 + wave 2's 17, pushed to origin)
Executed via: superpowers:subagent-driven-development — one implementer + one task reviewer per
task, fix loops where findings surfaced. Ledger: `.superpowers/sdd/2026-08-04-node-backend-wave-2/progress.md`.

## Prerequisite

PR #39/#40 (`fix/add-dedup-subtitle-collision`, the `_same_work` edition-variant-vs-sibling-subtitle
fix) confirmed merged into both `origin/main` and `feat/node-backend` before Task 4's fixture
generator ran — verified via `git merge-base --is-ancestor` and a direct read of
`mylibrary/enrich.py`. The `add-book-sibling-subtitle` fixture scenario recorded 201 on both
steps (not 409), independently re-verified by the controller directly against the generated
`write-scenarios.json` bytes, not just agent claims.

## Tasks 1–13: implementation (done, all reviewed clean)

All 13 implementation tasks (withApi route params + serialize helpers, PGlite wave-2 tables +
sequence sync, dedup module, write-scenario fixture generator, write-parity runner + `POST
/books`, book feedback/shelf writes, enrichment correction + book delete, recommendation swipe
feedback, settings writes, directive set/clear, taste-trait editing, feedback prompts +
taste-signal writes, backend switcher flip) passed their individual task reviews. Real findings
surfaced and were fixed in-loop:

- Task 3: `sameWork`'s surname-only guard produces an intentional but easy-to-miss false-positive
  surface (different authors sharing a surname) — was correct code, inherited from Python, but
  untested; added a locking test.
- Task 6: none of the recorded scenarios proved the review-without-rating guard reads
  post-mutation state for rating+review supplied *together* on a book with a genuinely null
  effective rating beforehand — added a covering fixture step + assertion (fixture/test-only, no
  route code changed).
- Task 11: the extracted `traitOut`/PATCH route's "`status` overrides a claim-triggered `'edited'`
  status" behavior was correct in code but unproven by any test, including the same-request
  combined-payload case — added both proofs (test-only, no route code changed).
- Task 13: the report's self-review reasoning mischaracterized `/books`'s `exact: true` flag as
  "belt-and-braces" (decorative) when it is actually load-bearing (removing it would incorrectly
  flip `POST /books/{id}/similar`, a wave-3 route, to Node) — corrected the report and added a
  clarifying code comment; the shipped routing logic itself was already correct.

One out-of-band cross-task fix, parked with a controller ruling rather than looped further:
during Task 12, the implementer found the plan's own Task-2-prescribed workaround for a PGlite
`setval` off-by-one on wholly-empty-at-seed tables ("seed one row") was provably infeasible
(2-arg `setval` can never yield next-id `1`; Postgres rejects `setval(seq, 0)`), and instead
fixed the shared `helpers/pglite.ts` sequence-sync formula globally (2-arg → 3-arg `setval`).
The reviewer independently verified the fix is technically correct per real Postgres semantics
AND provably a no-op for every table with existing seeded rows — meaning no prior task's id
assertions (e.g. Task 5's `id: 103`) were put at risk. The real gap is procedural: this should
have been surfaced to the controller before being applied to previously-approved shared test
infrastructure, rather than fixed-and-disclosed after the fact. Noted for future task-dispatch
wording; not a code defect.

Deferred minor findings (logged in the ledger, none load-bearing): fixture-coverage gaps around
cross-tenant scenarios and zod schema-shape 422s that pre-date wave 2, a few missing doc
comments/test cases on already-correct code, and a trivial per-call recomputation in
`backend.ts`'s matcher. None affect correctness.

## Task 14: full verification

### Step 1 — all suites (done)

```
cd frontend && npx jest              # 5 suites, 34/34 passed
cd frontend && npm run test:server   # 29 files, 126/126 passed
cd frontend && npm run type-check    # clean
cd frontend && npm run lint          # clean
python -m pytest                     # exit 0, all-pass (same shape as wave-1 — Python
                                      # untouched except scripts/gen_parity_fixtures.py)
```

All four commands were re-run independently by the controller (not just trusted from
implementer/reviewer reports).

### Step 2 — local isolated side-by-side: SKIPPED, by Chase's explicit choice

The plan's prescribed approach for this step reuses wave-1's env shape verbatim: Python
isolated on an ephemeral SQLite seed, but Node's `DATABASE_URL`/`ENCRYPTION_KEY` come from
`frontend/.env.local` as-is ("never read them"). Wave 1 only exercised GETs this way, which is
inert against real data. Wave 2 is *writes* — the same approach would run real `POST`/`PATCH`/
`DELETE` calls (add a book, delete a book, rate/review, swipe a rec, clear a directive, etc.)
against whatever `.env.local`'s `DATABASE_URL` actually points to, which is very likely Chase's
real dev Supabase Postgres, not a throwaway.

Flagged this to Chase before running anything destructive. He chose to skip the manual
curl-based write comparison and rely instead on the 126 automated parity tests, which already
prove exact request/response equality (status, body shape, error strings) against real recorded
FastAPI responses for every one of these exact scenarios (`add-book-basic`,
`add-book-duplicate`, `add-book-sibling-subtitle`, `add-book-invalid`, `book-feedback`,
`book-feedback-invalid`, `book-shelf`, `enrichment-correction`, `delete-book`,
`rec-feedback-accept`, `rec-feedback-already-read`, `rec-feedback-note-on-accepted`,
`rec-feedback-reject-reasons`, `rec-feedback-invalid`, `api-key`, `display-name`, `directive`,
`trait-patch`, `feedback-flow`, `feedback-invalid`, `taste-signal`) — a stronger evidence bar
than a handful of ad hoc curl calls would have provided anyway, without the real-data risk.

### Step 3 — browser walk: DEFERRED TO CHASE

Same real-dev-database-mutation concern as Step 2 applies to the plan's full destructive
click-through (add/delete/rate a book, swipe a rec, edit settings/directive, submit feedback, in
the actual running app). Chase and the controller agreed on a narrower read-only-only version
first (load `/admin`, force each backend mode, confirm zero console errors and correct
`/api/*`-vs-Railway network routing without clicking anything mutating) — but launching the
local Next.js dev server in the background hit a sustained `claude-sonnet-5[1m]` safety-classifier
outage specific to that action category (simple foreground commands worked throughout; ~7
retries across multiple command shapes over several minutes all failed identically). Rather than
keep burning turns retrying, Chase chose to defer the entire Step 3 browser walk — both the
read-only version and the plan's original full version — to himself, to run post-push.

Routing correctness for every wave-2 write path is still independently verified without a live
browser: Task 13's `baseFor` unit tests cover all 23 plan-mandated cases (both directions of
both `exact`-flag sibling-prefix scenarios, `/books` and `/directive`), and an adversarial task
reviewer independently hand-traced every one of those 23 cases against the shipped matching
logic and confirmed each resolves correctly. The browser walk would have been additional
real-app confirmation layered on top of that — not the only evidence for routing correctness —
but it is still the one piece of "did I actually click through the UI" verification the global
verification rule (tests alone don't count) asks for, and it did not happen in this session.

**Outstanding for Chase, before calling wave 2 fully done:**
- Start the dev server locally (`NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
  npm run dev -- --port 3000` from `frontend/`, per `.claude/skills/isolated-local-env/SKILL.md`'s
  local-admin-mode pattern) and walk `/admin` → System tab across `node`/`python`/`auto`,
  confirming zero console errors and that wave-2 writes route to `/api/*` in `auto` mode.
- Optionally go further and click through the plan's full list (add a book + duplicate check,
  rate/review, shelf move, enrichment correction, delete, rec swipe accept/reject, api key
  set/clear, display name, directive set/clear, trait confirm, feedback submit, prompt dismiss,
  taste signal) if he's comfortable with those writes landing in his real dev data (or wants to
  clean up afterward) — this is the fuller signal the plan originally asked for.

### Step 4 — push + preview deploy (done)

Pushed `feat/node-backend` (17 new commits) — pre-authorized in the plan's Task 14 Step 4 text
("push is authorized as part of this plan"); announced clearly before pushing.

- `git push origin feat/node-backend` → `3369121..b6cf1ac`
- PR #41 already existed for this branch; Vercel preview build triggered automatically.
- Deployment: `C8DpLBkMGRTU4HSKYKhzwT7kq5Hr` → `READY`
- Branch alias: `https://my-library-git-feat-node-backend-ccmalcoms-projects.vercel.app`

### Final whole-branch review (done)

Per `superpowers:subagent-driven-development`, a final review runs on the whole wave's diff
(base `3369121`, head `b6cf1ac`) after all 13 tasks pass individually — on the most capable
model, looking specifically for cross-task issues no single task's diff would surface.

**2 Important findings, both fixed:**

1. **No transactions anywhere.** Every write handler issued 2–5 independently auto-committed
   statements per request (Python wraps each request in one `session_scope()`/transaction; Node
   had none). Worst case: `DELETE /books/[id]` deletes the `enrichment` row then the `books` row
   — a failure between the two would permanently orphan/lose the book's cover, subjects, and
   description with no error surfaced as data loss. ~10 handlers affected (the multi-insert ones
   plus several single-logical-operation read-modify-write sequences, for race-safety consistency).
2. **Unvalidated `[id]` path params → 500 instead of 422.** Six routes did a bare
   `Number(ctx.params.id)`; a non-numeric id reached Postgres as an uncaught driver error
   (`invalid input syntax for type integer`), surfacing as a generic 500 with a logged stack
   trace, where FastAPI's `int` path converter returns a clean 422. Structurally untested — the
   fixture-replay harness's registry patterns are all `\d+`-anchored, so no scenario could ever
   reach this path.

**Fix (one dispatch, per the skill's "no second fix wave" rule for final reviews):** commit
`bfbace2` wraps all ~10 affected handlers in `db.transaction(async (tx) => {...})`, threading
`tx` through to every helper that takes `Db` as its first parameter (`ensureProfileMeta`,
`ensureLibraryBook`, `upsertUserSettings`, `upsertPromptState`) — notably, `db.ts` opens the pool
with `max: 1`, so a stray call to the outer `db` from inside a tx callback would have deadlocked
outright, not just broken atomicity, which made this an easy class of bug to verify was fully
converted rather than partially. A new `parseIdParam()` helper in `serialize.ts` throws a 422
`ApiError` for any non-integer id, called before any query in all 6 affected routes.

**Scoped re-review (opus):** both findings independently verified ADDRESSED — line-by-line check
of every call site for tx/db mixing, broken early-return paths, changed status codes/messages,
and an explicit id-coercion table cross-checked against Python's `int()` acceptance (negative
numbers, leading `+`, leading zeros, surrounding whitespace all still valid — nothing newly
rejected that Python would have accepted). Suite: vitest 136/136 (126 pre-existing + 10 new),
jest 34/34, `tsc`/`eslint` clean. No pre-existing fixture or test assertion changed.

**One Minor test-hygiene regression** surfaced by the re-review: the new describe block in
`parity-writes-books.test.ts` didn't call `setupParityEnv()`, so its 6 new tests would spuriously
fail with 401 instead of 422 if `SUPABASE_URL` happened to be set in the ambient environment.
Since the final-review fix loop is capped at one subagent wave, and this was a one-line
mechanical addition, the controller applied and verified it directly rather than spinning up
another agent round-trip: reproduced the failure (`SUPABASE_URL=https://example.supabase.co` →
all 6 new cases fail), added `setupParityEnv();`, reproduced again to confirm the fix (16/16 pass
under the same env var), then re-ran the full suite (vitest 136/136, jest 34/34, clean
tsc/eslint) before committing (`1ae68a7`).

**Parked, not fixed (real but non-blocking, per the re-review's Out-of-Scope Observations):**
- `POST /feedback/dismiss`'s `upsertPromptState` call has the same read-modify-write shape as
  finding 1 but wasn't in its named list — worst case is a lost update; the table's
  `uq_feedback_prompt_state` unique constraint rules out a duplicate.
- `parseIdParam` accepts out-of-int32-range numeric strings (e.g. a 20-digit id), which then
  500 from Postgres instead of 404 — the residual tail of finding 2's class, unchanged by the
  fix since it implements the finding's spec verbatim; wrong-status-on-garbage-input, not a
  data risk.
- `db.ts`'s `max: 1` pool means the now-longer transaction spans (especially
  `recommendations/[id]/feedback`, which includes `ensureLibraryBook`'s full-library scan)
  serialize concurrent requests onto one connection — pre-existing pool configuration,
  correctness-neutral, just worth knowing under real concurrent load.

Both fix commits pushed to origin (`b6cf1ac..1ae68a7`); Vercel rebuilt and confirmed `READY`
again post-fix.

### Step 5 (CHASE) — live checks on the preview: blocked, same as waves 0–1

Vercel Authentication (SSO) protects all non-production-domain deployments, per waves 0–1's
precedent (`docs/superpowers/plans/wave-0-verification.md`, `wave-1-verification.md`) — same
constraint applies here unless `shelfsprite.app` has been attached to bypass it by the time this
is read (see the rebrand section of the spec / `[[shelfsprite-rebrand]]` memory). Needs Chase's
logged-in browser to:
- Repeat Step 3's browser walk (deferred above) on the live preview instead of/in addition to
  local, across `node`/`python`/`auto`.
- Exercise the actual wave-2 write flows for real: add a book (+ duplicate → 409), rate/review,
  move shelf, correct an enrichment, delete it, swipe a rec (accept + reject with reasons),
  set/clear api key, set display name, set/clear directive, confirm a trait, submit feedback,
  dismiss a prompt, post a taste signal — zero 500s, identical error strings to Python on the
  deterministic 422/404/409s.
- Confirm the network tab shows wave-2 writes on `/api/*` and wave-3+ calls (recommend, profile
  build, catalog search) still hitting Railway, in `auto` mode.

### Step 6 (CHASE-assisted) — benchmark run: blocked, needs live inputs

Per the plan: writes are excluded from the benchmark harness by design (they mutate state) —
only the wave-1 read set gets re-benchmarked post-flip, to confirm no regression from anything
this wave touched. `scripts/benchmark.mjs` (built in wave 1) needs: the Railway Python base URL,
this Vercel deployment URL, a real Supabase JWT, and either a Protection Bypass secret or running
against the production domain post-cutover. Same blockers as wave 1 — not run this session.

## Summary

Everything executable without Chase's live/logged-in involvement or without risking his real dev
data is done and green: all 4 automated suites (jest, vitest parity, type-check, lint, pytest),
independently re-run by the controller — plus Task 13's exhaustive, adversarially-reviewed
`baseFor` routing-logic verification covering every wave-2 write path in both directions, plus a
final whole-branch review that caught and fixed two real cross-task correctness bugs (no
transaction wrapping, and a 500-instead-of-422 gap on malformed `[id]` params) invisible to any
single task's own review. The branch is pushed (19 commits total: 17 from the 13 tasks + 2 from
the final-review fix wave) and the Vercel preview build is READY, confirmed twice — once after
the task work, once after the final-review fixes.

Two verification steps were deliberately narrowed or deferred, both for the same reason: the
plan's prescribed approach for wave-2 *writes* (unlike wave-1's read-only checks) would mutate
Chase's real dev Supabase data, and he was asked and chose not to risk that from an automated
session. What remains for Chase: the local/live browser walk (Step 3, deferred entirely after a
sustained tool outage blocked launching a local dev server) and the SSO-gated live preview checks
+ benchmark (Steps 5–6, same as every prior wave). The 136 automated parity/unit tests already
prove byte-for-byte request/response equality against real recorded Python responses for every
wave-2 scenario the manual steps would have spot-checked — the deferred steps are additional
real-app confirmation on top of that, not the only evidence this wave works.

Two process notes worth Chase's attention, neither blocking: (1) during Task 12, an implementer
fixed a bug in Task 2's already-approved shared test infrastructure (a PGlite `setval` off-by-one)
instead of surfacing the plan's own prescribed workaround as infeasible and asking first — the
fix itself was independently verified correct and safe, but the process gap is worth remembering
for future waves' task-dispatch wording; (2) a background subagent ran `git stash` on the shared
in-place working tree at some point, sweeping up an unrelated pre-existing uncommitted doc change
— it was recovered intact via `git stash pop` with no data loss, but is a reminder that dispatching
implementers into a shared (non-worktree) checkout carries this class of risk.
