# Wave 1 verification record

Plan: `docs/superpowers/plans/2026-08-04-node-backend-wave-1.md`
Branch: `feat/node-backend` (28 commits total: wave 0's 13 + wave 1's 15, pushed to origin)
Executed via: superpowers:subagent-driven-development — one implementer + one task reviewer per
task, fix loops where findings surfaced. Ledger: `.superpowers/sdd/2026-08-04-node-backend-wave-1/progress.md`.

## Tasks 1–13: implementation (done, all reviewed clean)

All 13 implementation tasks (DB test seam + serialize helpers, PGlite wave-1 tables + seed
loader, Python parity-fixture generator, parity harness + `/api/stats`, `/api/books`, settings
reads, `/api/directive`, profile traits + status, profile subjects + highlights, recommendations
reads, profile archetype, method-aware backend switcher + flip, benchmark harness) passed their
individual task reviews. Two real findings surfaced and were fixed in-loop:

- Task 2: `user_directive.created_at` test-DDL column was nullable where the real
  `mylibrary/db.py` model is NOT NULL — fixed, re-reviewed, addressed.
- Task 9: `by_tier` key creation in `/api/profile/subjects` was eager where Python's
  `defaultdict(Counter)` access is lazy (narrow edge case: whitespace-only subject strings) —
  fixed, re-reviewed, addressed.

One out-of-band infra fix was needed between Tasks 6 and 7: the vitest suite started flaking
under full-suite parallel load (many concurrent in-memory PGlite instances exceeding the default
5000ms per-test timeout; 100% reliable in isolation). Fixed via `testTimeout: 30000` +
`maxWorkers: 4` in `frontend/vitest.config.ts`; verified with 4 consecutive clean full-suite runs
before continuing.

Deferred minor findings (logged in the ledger, none load-bearing): a `withApi` route-label
naming convention difference from wave-0, a missing `RecRow` type export, client-side usage-cost
summation instead of SQL aggregation, a duplicated `userSettings` query in two settings routes,
and two documentation/precedent notes on Task 11's timestamp-parsing idiom and `scoreToLetter`'s
type signature. None affect correctness.

## Task 14: full verification

### Step 1 — all suites (done)

```
cd frontend && npx jest              # 5 suites, 33/33 passed
cd frontend && npm run test:server   # 19 files, 85/85 passed
cd frontend && npm run type-check    # clean
cd frontend && npm run lint          # clean
python -m pytest                     # 355 passed (same count as wave-0 — Python untouched)
```

### Step 2 — local isolated side-by-side (done)

Followed `.claude/skills/isolated-local-env/SKILL.md`: isolated Python backend on `:8010`
(throwaway SQLite, 3 seeded books, isolation verified via the `get_settings()` one-liner before
touching anything). Next dev server on `:3000` pointed at the real dev Supabase `DATABASE_URL`
for the Node side only (server-side Supabase auth vars — `SUPABASE_URL`, `SUPABASE_JWKS_URL`,
`ADMIN_EMAILS` — stripped so Node also runs in local-admin mode, matching Python), reproducing
wave-0's verification setup exactly. `DATABASE_URL`/`ENCRYPTION_KEY` were added to
`frontend/.env.local` by Chase directly — never read or seen by the assistant, per the
never-read-`.env` rule.

All 13 wave-1 routes checked on both backends (`curl` status + JSON shape comparison — values
differ intentionally, different DBs; exact-value parity is already proven by the fixture-replay
suite in Tasks 4–11 against identical seed data):

| route | python | node | match |
|---|---|---|---|
| `/stats` | 200 | 200 | ✅ shape |
| `/books` | 200 | 200 | ✅ shape |
| `/profile` | 200 | 200 | ✅ shape |
| `/profile/status` | 200 | 200 | ✅ identical key set |
| `/profile/subjects` | 200 | 200 | ✅ identical key set |
| `/profile/highlights` | 200 | 200 | ✅ identical key set |
| `/profile/archetype` | 404 | 404 | ✅ exact `{"detail":"No archetype derived yet"}` on both |
| `/recommendations` | 200 | 200 | ✅ shape |
| `/recommendations/rejected` | 200 | 200 | ✅ shape |
| `/settings/api-key/status` | 200 | 200 | ✅ identical key set |
| `/settings/profile` | 200 | 200 | ✅ identical key set |
| `/settings/usage` | 200 | 200 | ✅ identical key set |
| `/directive` | 200 | 200 | ✅ identical key set |

Zero 500s. Debug mode toggled on via `PUT /api/admin/config` → `Server-Timing` header confirmed
present with `auth`/`db`/`total` spans on both `/api/stats` and `/api/books`; toggled off →
header confirmed gone.

### Step 3 — browser check (done, required by verification rules — tests alone don't count)

Drove the browser directly (Chrome extension). On `/admin` → System tab:

- **Forced `node`**: browsed Library (43 books), My Profile (11 taste traits with evidence),
  Swipe/recommendations (empty state — correctly matches `recommendations: []` on this account),
  Settings (display name, API key status, usage $0.00/$5.00). All four pages rendered real data
  with zero console errors. Network tab confirmed every wave-1 read (`/api/stats`, `/api/books`,
  `/api/profile/status`, `/api/settings/usage`, `/api/settings/api-key/status`,
  `/api/settings/profile`, `/api/recommendations`, `/api/recommendations/rejected`) hit `/api/*`
  with 200s.
- **Forced `python`**: same four pages, now showing the isolated backend's 2-book seed —
  identical rendering behavior, confirming the frontend UI is backend-agnostic as designed.
- **Back to `auto`**: confirmed wave-1 GETs route to Node (43-book real dev-DB library rendered,
  cover images loaded).

One incidental finding, not a wave-1 defect: forcing `backend=node` also force-routes
`/admin/me` (the admin page's own auth check, out of wave-1's scope — admin reads are a wave-5
deferral per the plan) to Node, which doesn't implement that route yet → the Admin page itself
shows "Not authorized" while `node` is force-selected. This is expected behavior of a blunt
"force everything" override, not a wave-1 regression; recovered by setting
`localStorage['mylibrary.backend']` directly since the auth-blocked page couldn't be clicked
through.

**Process note:** while investigating an unrelated stop-hook prettier complaint on
`frontend/next-env.d.ts` (a dev-server-regenerated artifact, not a real change), a blanket
`npm run format` was run and accidentally reformatted ~30 already-committed, already-reviewed
files (pure whitespace/line-wrap diffs, verified via `git diff` — no content changes anywhere).
Caught before committing, all reverted via `git restore`, suites re-confirmed green afterward.
No wave-1 code was affected; flagging for the record since it's the kind of slip worth naming.

### Step 4 — push + preview deploy (done)

Pushed `feat/node-backend` (15 new commits) after explicit confirmation. Vercel build succeeded:

- Deployment: `dpl_3hJrCm9SpZWP8u97y8CFKfg1KtGv` → `READY`
- Preview URL: `https://my-library-64llvjeb9-ccmalcoms-projects.vercel.app`
- Branch alias: `https://my-library-git-feat-node-backend-ccmalcoms-projects.vercel.app`

### Step 5 (CHASE) — live checks on the preview: blocked, same as wave 0

Vercel Authentication (SSO) protects all non-production-domain deployments — confirmed both
direct fetch and the Vercel MCP's `web_fetch_vercel_url` (which explicitly supports SSO-bypass
when the tool owner has access) get redirected to `vercel.com/sso-api`. Same finding as wave-0's
verification record. Needs Chase's logged-in browser to:
- `curl`/visit `/api/healthz` → expect `{"status":"ok","backend":"node"}`
- Repeat the Step 3 page walk (Library/My Profile/Swipe/Settings, node → python → auto) on the
  live preview
- Confirm the usage panel and profile page match production Python for the same account

### Step 6 (CHASE-assisted) — benchmark run: blocked, needs live inputs

`scripts/benchmark.mjs` (Task 13) is built and dry-run-verified against throwaway local servers,
but a real run needs: the Railway Python base URL, this Vercel deployment URL, a real Supabase
JWT (DevTools → Application → Local Storage → `sb-…-auth-token` → `access_token`, pasted into
the command line only, never into a file), and either a Protection Bypass for Automation secret
or running against the production domain after this wave's cutover. Turn debug mode on before
running (captures `Server-Timing`), off after. Results go in `docs/benchmarks.md` under "Wave 1".

## Summary

Everything executable without Chase's live/logged-in involvement is done and green: all 4
automated suites, the full local Python-vs-Node parity spot-check (13/13 routes, zero 500s,
exact error-string match, working debug-mode timing), and a real browser walkthrough of every
page across all three backend-choice modes. The branch is pushed and the Vercel preview build is
READY. What remains is exactly what wave 0 also left for Chase: SSO-gated live preview checks
and the cross-deployment benchmark run.
