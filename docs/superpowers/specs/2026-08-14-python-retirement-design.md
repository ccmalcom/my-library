# Python retirement — design

**Date:** 2026-08-14
**Status:** approved, ready for implementation planning
**Branch:** `python-cleanup`

Wave 5b cut production over to the Node backend. This spec removes the Python implementation,
its tooling, and the migration-era scaffolding that existed only to prove the two backends
agreed. The end state is a single Next.js application.

---

## 1. Preconditions (verified 2026-08-14, not assumed)

Every claim below was checked against the live system or the source, not read off prior docs.
Prior CLAUDE.md prose asserted several of these; they were re-verified because a stale
precondition propagates cleanly into wrong work.

| Precondition | Status | How it was verified |
|---|---|---|
| Node backend is live on `main` | ✅ | `git show main:frontend/lib/backend.ts` contains `NODE_DEFAULT_ROUTES` |
| `FRONTEND_URL` set on Vercel **and** deployed | ✅ | Env var saved `12:50:04 EDT`; production build `dpl_CJhrUr…` created `12:50:14 EDT`, ● Ready, aliased to `shelfsprite.app`. Ordering matters — a build started before the save would not carry it. |
| `CRON_SECRET` set on Vercel | ✅ | `vercel env ls production` — present on Preview + Production, created 2 days prior |
| No frontend call site still routes to Python | ✅ | Extracted all 47 distinct call sites from `lib/api.ts` and ran each through the **real** `baseFor()` in `auto` mode (in Node, `getBackendChoice()` returns `'auto'`). Result: 47 → Node, 0 → Python. |
| No backend traffic bypasses `lib/api.ts` | ✅ | No `fetch(` outside `lib/api.ts` references `baseFor`/`pythonBase`/`API_URL`/`/api` |
| Nothing in CI runs pytest | ✅ | `.github/` contains only `copilot-instructions.md`; no workflows exist |
| No npm script invokes Python | ✅ | `frontend/package.json` scripts are all `next`/`tsc`/`jest`/`vitest`/`drizzle-kit`/`eslint`/`prettier` |
| Railway is paused, not serving | ✅ | Recorded in `todo.md` as paused 2026-08-13 |
| drizzle baseline already matches production | ✅ (re-confirm during execution) | `0000_baseline.sql` contains the `alembic_version` table and declares `enrich_jobs.progress`/`total` as `integer DEFAULT 0 NOT NULL` — production's "0003 lineage" shape, not what a fresh `alembic upgrade head` produces. `stamp-baseline.ts` already adopted drizzle on the Alembic-built production DB. |

**Symbols, not line numbers.** Line references in this document are hints to the right region.
Locate code by symbol name (`grep -n '<exact code>'`); line numbers drift between authoring and
execution.

---

## 2. Scope

**In scope.** Delete the Python implementation, its packaging and deploy tooling, and the
Python-comparison test apparatus. Strip the backend switcher. Repair the tooling and docs that
reference any of it.

**Out of scope.**

- **Deleting the Railway service.** Chase's manual step, on or after 2026-08-20. Two facts must
  be captured from the paused service *before* it is deleted, because both die with it:
  the value of `FEEDBACK_PROMPTS_ENABLED` (set on Railway, masked when names were recorded; Node
  defaults it to `true`, so if Railway held `false` the cutover silently re-enabled targeted
  feedback prompts), and the 7-day request log for the zero-traffic re-confirm.
- **Re-baselining drizzle.** Appears already satisfied (§1). Execution re-confirms against
  `information_schema.columns` rather than trusting `schema.ts` or this document.
- **The search-canonicity tiebreaker.** Unblocked by this work; its own task afterward.
- **`docs/superpowers/` plan archive.** A historical record, deliberately left alone.

**One-way door, accepted.** Once deletion lands on `main`, Railway cannot be resumed as a
fallback even while paused — the build would fail. Chase explicitly accepted this.

---

## 3. Deletions

### 3.1 Python tree and tooling

```
mylibrary/            (30 .py + 3 importers)
tests/                (64 .py)          — see §4.1, one asset must move first
alembic/              (20 revisions + env.py)
alembic.ini
scripts/*.py          (6 fixture recorders)
requirements.txt   pytest.ini   ruff.toml
Dockerfile   .dockerignore   start.sh   railway.json
```

127 tracked `.py` files total. The only tracked `.py` files that survive are the three
`.claude/hooks/` scripts.

### 3.2 The switcher

`lib/backend.ts` collapses: `baseFor()` returns `/api` unconditionally, or is removed entirely in
favour of a literal in `lib/api.ts`. Delete `NODE_DEFAULT_ROUTES`, `NODE_ONLY_PREFIXES`,
`pythonBase()`, `getBackendChoice`/`setBackendChoice`, the `BackendChoice` type, the
`mylibrary.backend` localStorage key, and `lib/__tests__/backend.test.ts`.

`NEXT_PUBLIC_API_URL` is removed from the code, from `.env.example`, and from Vercel.

`components/admin/SystemTab.tsx` loses the backend selector and the Python `/healthz` ping. The
tab itself survives for its other content. **This is urgent, not cosmetic:** with Railway gone the
`python` override is a foot-gun that breaks every route the moment anyone toggles it.

`lib/server/catalog.ts` carries a comment referencing `helpers/httpReplay.ts`; the helper survives,
so the comment stays accurate and needs no change.

---

## 4. Tests and fixtures

The dividing line is **not** "parity vs. behavior". It is what the fixture actually records:

- **Python-comparison fixtures** — recordings of the old backend's responses and prompts. Obsolete.
- **Recorded third-party HTTP and seed data** — Google Books / Open Library traffic and database
  seed rows. These are deterministic network stubs and seed data; they have nothing to do with
  Python and stay useful indefinitely.

### 4.1 Assets that must move first

Both moves are prerequisites for §3.1. Deleting the Python tree before them breaks a surviving test.

| From | To | Why |
|---|---|---|
| `tests/sample_goodreads.csv` | `frontend/lib/server/__tests__/fixtures/sample_goodreads.csv` | `import-csv-quotes.test.ts` reads it via `readFileSync(join(process.cwd(), '..', 'tests', …))` — a surviving test reaching into the Python tree |
| `fixtures/parity/seed.json` | `fixtures/seed.json` | Consumed as database seed data by 10 surviving tests; the `parity/` path is misleading once the comparisons are gone |

### 4.2 Delete — 27 files

Python-comparison replays:

```
catalog-search              parity-directive             parity-writes-books
enrichment-parity           parity-discover-prompts      parity-writes-directive
parity-admin-lists          parity-import-export         parity-writes-feedback
parity-admin-reads          parity-profile               parity-writes-recs
parity-archetype            parity-profile-computed      parity-writes-settings
parity-books                parity-prompts               parity-writes-traits
parity-claude-flows         parity-recommend-prompts     schema-contract
parity-recommendations      parity-settings              write-parity-masking
parity-similar-prompts      parity-stats                 parity-writes-admin
```

All under `lib/server/__tests__/`, suffix `.test.ts`. 144 test cases (counted by `it(`/`test(`
occurrences, so slightly low where `it.each` is used).

Fixtures deleted with them: `parity/python-responses.json`, `parity/write-scenarios.json`,
`catalog/expected.json`, `catalog/enrichment-expected.json`, `schema-contract.json`.

Helpers deleted: `helpers/write-parity.ts` in full; `checkParity` removed from `helpers/parity.ts`.

### 4.3 Keep — 12 behavior tests

```
catalog-ranking   profile-build     rec-book-signal    recommend-run
discover-route    profile-update    rec-signal         similar-route
discover-run      ratelimit-routes  recommend-route    similar-run
```

These are ordinary behavior tests. They consume `seed.json` for database seeding and
`recommend-http.json` / `catalog/http.json` as network stubs; none of them asserts against a
recorded Python response. Together they are the **only** coverage for `/recommend`, `/discover`,
`POST /books/{id}/similar`, `POST /profile`, `/profile/update` and the per-route rate limits.

### 4.4 `recommend-run.test.ts` — the one hybrid

It imports `prompts.json` (Python-recorded) *and* exercises the retrieval pipeline end to end. The
byte-identical prompt assertion is the mechanism by which pool order, dedup, language/series/fuzzy
filters, author caps and cap ordering are proven.

**Decision: keep the file and `prompts.json`, reframed as a snapshot.** Relabel the assertion and
its comments from "matches Python" to "matches the recorded cutover snapshot", and note in the file
that the snapshot is now regenerated by hand if the prompt legitimately changes — the recorder is
gone. This preserves the only end-to-end proof of the deterministic core at no cost. The unit-level
pieces (`rec-assemble`, `rec-filters`, `similarity`, `rec-signal`) survive independently regardless.

### 4.5 Helpers — all five survive

`pglite.ts` (imported by 47 files), `fakeClaude.ts`, `httpReplay.ts` are untouched.
`parity.ts` is trimmed to `setupParityEnv` — which every keeper uses and no keeper uses
`checkParity` — and should be renamed `setupTestEnv` in a file renamed `helpers/testEnv.ts`.

### 4.6 Expected result

**366 of 510** server test cases remain across 53 files, down from 80 files. The 12 keepers
contribute 81 of those. Treat these as approximate — they are a `it(`/`test(` count and miss
`it.each` expansions. State expectations by test **name**, never by count.

---

## 5. Tooling

`.claude/hooks/on_stop.py` runs `ruff check` and `pytest -q` whenever tracked `.py` files change.
After deletion the only tracked `.py` files are the hooks themselves, and **`pytest -q` with no
tests collected exits 5**, which the hook reports as a failure. Remove both the ruff and pytest
gates; keep the JS/TS gates.

`.env.example` loses `MYLIBRARY_*`, `CORS_ORIGINS`, `MYLIBRARY_DATA_DIR` and `NEXT_PUBLIC_API_URL`.
Variable **names only** — no values are read or written at any point.

`frontend/.gitignore` already gained `.vercel` and `.env*` (added by `vercel link` during
verification). Both are correct; no tracked frontend file matches either pattern.

`data/` holds the Goodreads CSV that fed the retired CLI. Decide during planning whether it goes;
it is not referenced by any surviving code.

---

## 6. Documentation

`CLAUDE.md` gets the rewrite `todo.md` already calls for: present tense, no wave numbering, no
Python or parity sections, commands reduced to the frontend set. The invariants that are still
load-bearing must survive the rewrite — the half-star rules, the `pyRound`/`pyRepr`/`pyJsonDumps`
serialization primitives (these stay: they define the wire format now, and changing them changes
real API responses), the `maxDuration` literal guard, the enrichment lease rules, and the admin
transaction-boundary rules.

| File | Change |
|---|---|
| `CLAUDE.md` | Full rewrite per above |
| `docs/architecture.md` | Largest job — currently a Python module map; becomes the Node architecture |
| `docs/hosting.md` | Drop Railway/Alembic as live systems; keep the drizzle workflow; retain the recorded Railway env table as history |
| `docs/frontend.md` | Remove switcher and `NEXT_PUBLIC_API_URL` references |
| `docs/conventions.md` | Remove Python/CLI gotchas |
| `README.md` | Python install/run instructions removed |
| `.github/copilot-instructions.md` | Remove the Railway-vars framing |
| `todo.md` | Tick the completed items; keep the pre-Railway-delete capture list |

---

## 7. Execution shape

Seven tasks. Each Codex dispatch is **fresh** — write access does not reliably survive a resume,
and every task here produces edits.

| # | Task | Depends on | Model |
|---|---|---|---|
| 1 | Relocate `sample_goodreads.csv` and `seed.json`; update importers | — | spark / low |
| 2 | Delete the 27 replays and 5 fixtures; trim `parity.ts` → `testEnv.ts`; delete `write-parity.ts`; reframe `recommend-run` | 1 | spark / low |
| 3 | Delete the Python tree and the 8 root tooling files | 1, 2 | spark / low |
| 4 | Strip the switcher (`backend.ts`, `api.ts`, `SystemTab.tsx`) | — | default |
| 5 | Fix `on_stop.py`; prune `.env.example` | 3 | spark / low |
| 6 | Documentation rewrite | 3, 4 | default |
| 7 | Verification | all | Claude, not Codex |

**Dispatch rules** (from `chase-workflow:codex-dispatch`):

- Keep the forwarder file-blind. Everything Codex needs goes in the brief; it does its own
  exploration on OpenAI's quota.
- Name only **fast, scoped** gates: `npm run type-check`, `npx eslint <touched files>`, and the
  specific vitest file. **Never** name `npm run test:server` — it runs ~165s against a ~10-minute
  budget that must also cover Codex's own exploration.
- `vitest.config.ts` pins `include` to `lib/server/**` and `app/api/**`. A vitest command aimed
  anywhere else matches zero tests and **exits 0**, reading as a pass. Verify any test command
  matches tests before sending it.
- List DO-NOTs explicitly. A fresh agent does not know which neighbouring code is deliberately
  inconsistent and will happily "harmonize" it.
- Never name `.env` or ask Codex to inspect secrets — Codex runs outside the `pre_bash.py` hook.
- Always `GIT_PAGER=cat`; a paged git command hangs the shell.
- Run `git status` after any killed run; applied edits are not rolled back.

---

## 8. Verification

Codex's gates do not count as verification. The controller runs, in order:

1. `npm run test:server` — the full vitest suite
2. `npm test` — jest; the two runners have disjoint scopes and neither substitutes for the other
3. `npm run type-check`, `npx eslint .`, `npx prettier --check .`
4. **`npm run build`** — the only gate that catches Next segment-config and prerender errors. Wave
   5b-1 found eight consecutive red Vercel previews sitting behind five green gates.
5. A Vercel **preview** deploy must go green.
6. Confirm the drizzle baseline against `information_schema.columns` on production, read-only.
7. After merge: browser-drive `shelfsprite.app` — load the library, run a recommendation, open
   `/admin`. Never claim it works from tests alone.

**Mutation test the load-bearing claims.** Break each deliberately and confirm something goes red:
delete `progress: 0` from the `createOrGetActiveJob` call site (tsc must fail); change the
`maxDuration` literal to an imported binding (`enrich-max-duration.test.ts` must fail). If nothing
goes red, the constraint is documentation, not engineering.

**Enrichment caveat.** Continuation can only be tested on the production custom domain —
Vercel SSO protection intercepts the `rearmAfterResponse` self-fetch on preview deploys, and that
failure is indistinguishable from a broken `CRON_SECRET`. Test with a library large enough to need
a second chunk; the bar is a tick invocation **and** progress advancing across the chunk boundary,
never tick count alone.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A surviving test reaches into the deleted Python tree | Task 1 runs first and is a hard prerequisite; `import-csv-quotes.test.ts` is the known case, and a repo-wide grep for `'..', 'tests'` during execution catches any other |
| Switcher removal changes a request URL silently | 47 call sites already verified to resolve to `/api`; the post-merge browser drive is the real check |
| Docs rewrite drops a still-load-bearing invariant | §6 enumerates what must survive; treat the rewrite as editorial, not as re-derivation |
| Deleting `checkParity` breaks a keeper | Verified: every keeper uses only `setupParityEnv` |
| Frozen `prompts.json` blocks a future prompt change | Accepted and documented in-file (§4.4); regenerate by hand |
| Railway facts lost | Capture before deletion (§2); not gated on this branch |

---

## 10. Open items for the execution thread

None blocking. Two judgment calls are deliberately left to execution, both noted above: whether
`data/` is deleted (§5), and whether `lib/backend.ts` is emptied or removed outright (§3.2).
