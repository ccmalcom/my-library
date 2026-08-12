# Node Backend Wave 5a — Admin Surface Port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Move the seven Python-only `/admin/*` routes onto Node so wave 5b can delete
`mylibrary/api.py` and decommission Railway without losing functionality.

**Architecture:** Two new server modules — `supabaseAdmin.ts` (a GoTrue admin client with an
injectable transport) and `invites.ts` (the invite lifecycle) — plus seven thin route handlers over
gating that wave 0 already built. Parity is proven by extending the existing fixture-replay harness
with a synthetic roster; the three GoTrue-touching writes are additionally verified live, once,
against the real Supabase project.

**Tech Stack:** Next.js 16 route handlers, Drizzle + postgres-js, PGlite (test), Vitest, Zod,
FastAPI/SQLAlchemy (Python side, fixture recording only).

**Design doc:** `docs/superpowers/specs/2026-08-12-node-backend-wave-5a-admin-port-design.md`.
Read it before Task 1 — it carries the reasoning this plan only asserts.

---

## Global Constraints

1. **Do not change Python** except `scripts/gen_parity_fixtures.py` (Task 2), which only records.
   `mylibrary/` is read-only for this entire wave.
2. **No new runtime dependencies.** `npm install` must not run.
3. **Parity means matching Python's observable behavior**, including behavior a reasonable person
   would call wrong. Where Node cannot match, record the divergence in this plan and in a code
   comment — never silently "improve" on Python.
4. **`revokeUser` must NOT be wrapped in a single transaction.** See Task 8. This is the one place
   the plan deliberately breaks the house one-transaction-per-request convention, and the reason is
   load-bearing.
5. **Gates for every Node task:** `npm run test:server`, `npm test -- --runInBand`,
   `npm run type-check`, `npx eslint <touched files>`, `npx prettier --check <touched files>`.
   Run every one. `.venv/bin/pytest` is run by the **driving session**, not by Codex — Codex's
   sandbox hangs on it (see Executor Notes).
6. **Never run `npx prettier --write` over a glob.** Name each file explicitly. A glob in
   `lib/server/__tests__/` reformats a dozen unrelated committed files.
7. **No email address that belongs to a real person may enter a checked-in fixture.** The repo is
   public. Synthetic roster only: `@example.com`.
8. **Do not commit, merge, push, or deploy.** Chase commits by hand.

## Executor Notes (Sonnet driving Codex)

- **Codex cannot run pytest at all.** `tests/conftest.py` imports FastAPI's `TestClient`, which
  hangs its sandbox. It also cannot `npm install` (no network) and cannot run the fixture recorders.
  The driving session owns `scripts/gen_parity_fixtures.py` and `.venv/bin/pytest`. Listing an
  unrunnable command in a Codex prompt silently burns minutes of that task's budget.
- **Task 2 is Claude/Sonnet-owned, not Codex-owned.** It runs Python and the recorder.
- **Budget ~10 minutes per Codex dispatch**, including its own exploration. Prefer several narrow
  dispatches to one broad one. Run `git status` after any killed run — applied file changes are
  **not** rolled back.
- **Do not explore the repo before delegating.** Hand Codex the task text verbatim; it explores on
  OpenAI's quota.
- **Prefer `--background`.** Pull results with `/codex:result <id>`.
- Always pass `GIT_PAGER=cat` or `git --no-pager`; a paged git command hangs the shell.
- **Never hand Codex a task whose text names `.env`** — the pre-bash hook does not screen Codex's
  shell.
- **Cite symbols, not line ranges**, in any proof-of-fix check. Use `grep -n '<exact code>'`.

## Verified Facts

Each confirmed by running it on 2026-08-12. Line numbers are hints to the right region, never
assertions to check literally.

| Fact | Evidence |
| --- | --- |
| `withApi(route, handler, opts)` supports `requireAuth` and `requireAdmin`; `requireAdmin` implies auth | `lib/server/http.ts` |
| With `requireAuth: false` the handler receives `ctx.user = { userId: 'anonymous', email: null, isAdmin: false }` — it cannot learn the real caller | `lib/server/http.ts` |
| `verifyRequestUser(authHeader)` is exported from `lib/server/auth.ts` and returns `isAdmin: true` in local mode | `lib/server/auth.ts` |
| `GET /admin/me` has **no** `AdminId` dependency in Python — it is ungated | `admin_me` in `mylibrary/api.py` |
| Error mapping: invite `InviteError`→422 / `SupabaseAdminError`→502 / success **201**; backfill `SupabaseAdminError`→502; revoke `InviteError`→**404** / `SupabaseAdminError`→502 | `admin_invite`, `admin_backfill`, `admin_revoke` in `mylibrary/api.py` |
| `invited_by` is the admin's `sub`; in local mode `require_admin` returns `LOCAL_USER_ID` = `"local"` | `require_admin` in `mylibrary/admin.py` |
| `admin_list_usage` rounds only the total: `round(float(total_cost), 4)`. Per-event `cost_usd` is unrounded `float(row.cost_usd or 0.0)` | `admin_list_usage` in `mylibrary/usage.py` |
| `mylibrary/invites.py` uses `from .supabase_admin import ...`, so monkeypatching must target `mylibrary.invites.<name>`, **not** `mylibrary.supabase_admin.<name>` | read from source; standard Python from-import binding |
| The recorder runs against isolated SQLite with auth disabled, so `is_admin()` returns `True` and admin routes are reachable without a JWT | assertions at the top of `scripts/gen_parity_fixtures.py` |
| `Invite` is **not** imported in the recorder, not in `_MODELS`, and not in `reset_db` | `scripts/gen_parity_fixtures.py` |
| `invites` is **not** in the `Seed` interface or `loadSeed`'s `order` array | `lib/server/__tests__/helpers/pglite.ts` |
| `invites` already exists in `schema.ts`, the PGlite DDL, and `fixtures/schema-contract.json` | all three files |
| `checkParity(stage, requestKey, handler, normalize?)` builds `new Request('http://test/api' + pathAndQuery)` | `lib/server/__tests__/helpers/parity.ts` |
| `tsToIso`, `round4`, `parseIdParam`, `utcnowTs` are exported from `lib/server/serialize.ts` | `lib/server/serialize.ts` |
| `api.health()` exists in `frontend/lib/api.ts` and is called from nowhere | `grep -rn "\.health()" frontend --include=*.ts --include=*.tsx` |
| Node's production write surface is 12 tables; `WRITTEN_TABLES` guards 5 | see the design doc's command Ⓑ |

## File Structure

| File | Responsibility |
| --- | --- |
| `frontend/lib/server/__tests__/schema-contract.test.ts` | Modify: widen `WRITTEN_TABLES` to Node's full write surface + `invites` |
| `frontend/lib/server/__tests__/helpers/pglite.ts` | Modify: add `invites` to `Seed` and `loadSeed`'s order |
| `scripts/gen_parity_fixtures.py` | Modify: synthetic roster, admin read requests, admin write scenarios |
| `frontend/lib/server/__tests__/fixtures/parity/*.json` | Regenerate |
| `frontend/lib/server/invites.ts` | Create: `listRoster`, `createInvite`, `backfillFromSupabase`, `revokeUser` |
| `frontend/lib/server/supabaseAdmin.ts` | Create: `inviteUser`, `deleteUser`, `listUsers`, `SupabaseAdminError` |
| `frontend/app/api/admin/{me,users,usage,feedback,invite,revoke,backfill}/route.ts` | Create: seven handlers |
| `frontend/lib/backend.ts` | Modify: switcher rules for `/admin/*` |
| `frontend/lib/api.ts` | Modify: delete the unused `health()` method |

---

## Task 0: Baseline gate

**Owner: the driving session (Sonnet/Claude), not Codex** — the last command is pytest, which
hangs Codex's sandbox. Do not dispatch this task.

**Files:** none — this task changes nothing.

- [ ] **Step 1: Confirm the tree is clean and green before touching anything**

```bash
cd /home/chase/Documents/Code/my-library
git --no-pager status --short
cd frontend && npm run test:server 2>&1 | tail -5
cd .. && .venv/bin/pytest -p no:warnings 2>&1 | tail -3
```

Expected: working tree clean at `b23dfbe` or later; vitest **73 files / 509 tests passed**;
pytest **360 passed**. If any of those three differ, stop and report — every "expected" count in
this plan is stated relative to this baseline.

---

## Task 1: Widen wave 4d's schema guard to Node's real write surface

**Files:**
- Modify: `frontend/lib/server/__tests__/schema-contract.test.ts` (`WRITTEN_TABLES`)
- Modify (only if the guard finds drift): `frontend/lib/server/__tests__/helpers/pglite.ts`,
  `frontend/lib/server/schema.ts`

**Interfaces:**
- Consumes: `fixtures/schema-contract.json` (already generated and checked in).
- Produces: nothing importable. Widens an existing test's coverage.

**Why first:** any drift this finds changes the DDL that Task 2's fixtures are recorded against.
Finding it after the fixtures are recorded means recording twice.

- [ ] **Step 1: Widen the list**

In `frontend/lib/server/__tests__/schema-contract.test.ts`, replace the `WRITTEN_TABLES` constant
with the full production write surface. `invites` is included because Task 6 makes Node write it;
`usage_events` stays because wave 5b gives Node the INSERT.

```ts
/**
 * Every table Node writes in production, plus `invites` (Task 6 adds the first
 * Node write) and `usage_events` (wave 5b's cutover gives Node the INSERT).
 * Derived from: grep -rnoE "\.(insert|update)\(([a-zA-Z]+\.)?[a-zA-Z]+\)" \
 *   frontend/lib frontend/app --include=*.ts | grep -v "__tests__"
 * Keep filenames in that grep -- `grep -h` strips them, which silently lets
 * test-only writes count as production ones.
 */
const WRITTEN_TABLES = [
  'books',
  'enrichment',
  'enrich_jobs',
  'feedback',
  'feedback_prompt_state',
  'invites',
  'profile_meta',
  'reader_archetypes',
  'recommendations',
  'taste_signal',
  'taste_traits',
  'usage_events',
  'user_directive',
  'user_settings',
] as const;
```

- [ ] **Step 2: Run the guard and record what it finds**

Run: `cd frontend && npx vitest run lib/server/__tests__/schema-contract.test.ts`

This run is a **survey, not a pass/fail gate**. Both outcomes are fine:

- **All 28 pass** (14 tables × 2 describe blocks) — the mirrors were already correct. Say so.
- **Some fail** — each failure names a real divergence between a Node mirror and the
  model-declared contract. Wave 4d found six in the first table it examined; none of these nine new
  tables has ever been checked.

- [ ] **Step 3: Fix each drift in the mirrors, never in the snapshot**

For each failure, edit `helpers/pglite.ts` (drop an invented `default`, add a missing `not null`)
and/or `schema.ts` (drop a phantom `.default()`, add a missing `.notNull()`). **Never** edit
`fixtures/schema-contract.json` — it is generated from the SQLAlchemy models, which are the oracle.
**Never** add a default back to a mirror to make a fixture pass.

An ORM-level `mapped_column(Integer, default=0)` in `mylibrary/db.py` emits **no** DDL clause. It
must become `.notNull()` with **no** `.default()` on the Node side. That distinction is the entire
reason this guard exists.

- [ ] **Step 4: Re-run the guard, then the whole suite**

```bash
cd frontend
npx vitest run lib/server/__tests__/schema-contract.test.ts   # expect: all pass
npm run test:server
```

Tightening a mirror will expose fixtures that relied on the old defaults, exactly as it did for
`enrich_jobs` in wave 4d. For each newly-failing fixture, supply the missing column explicitly **in
the test file**.

- [ ] **Step 5: Prove the widened guard is load-bearing**

Temporarily add `.default(0)` to any one newly-covered column in `schema.ts` — for example
`userSettings`'s first `notNull()` integer column — and confirm the guard turns red naming that
exact table and column. Restore it and confirm green. A guard that has never been seen to fail is
not evidence.

- [ ] **Step 6: Full gate set**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint lib/server/__tests__/schema-contract.test.ts lib/server/__tests__/helpers/pglite.ts lib/server/schema.ts
npx prettier --check lib/server/__tests__/schema-contract.test.ts lib/server/__tests__/helpers/pglite.ts lib/server/schema.ts
```

Driving session then runs: `cd .. && .venv/bin/pytest -p no:warnings` — expect **360 passed**
(Python is untouched; this only proves the tree is still coherent).

- [ ] **Step 7: Report the drift list**

The list of divergences found — including the ones you fixed — is this task's actual deliverable.
Report it even if it is empty.

---

## Task 2: Record admin parity fixtures from a synthetic roster

**Owner: the driving session (Sonnet/Claude), not Codex.** This task runs Python and the recorder.

**Files:**
- Modify: `scripts/gen_parity_fixtures.py`
- Modify: `frontend/lib/server/__tests__/helpers/pglite.ts` (`Seed`, `loadSeed`)
- Regenerate: `frontend/lib/server/__tests__/fixtures/parity/{seed,python-responses,write-scenarios}.json`

**Interfaces:**
- Produces: fixture entries keyed `GET /admin/me`, `GET /admin/users`, `GET /admin/usage`,
  `GET /admin/feedback`, `GET /admin/usage?limit=2&offset=1`, `GET /admin/feedback?category=bug`
  under both `empty` and `seeded`; and write scenarios `admin_invite`, `admin_backfill`,
  `admin_revoke`, `admin_revoke_unknown`.

- [ ] **Step 1: Teach the recorder about `Invite`**

In `scripts/gen_parity_fixtures.py`, add `Invite` to the `from mylibrary.db import (...)` list
(alphabetically, after `FeedbackPromptState`). Then add it to `_MODELS`:

```python
_MODELS = {
    "books": Book, "enrichment": Enrichment, "taste_traits": TasteTrait,
    "recommendations": Recommendation, "profile_meta": ProfileMeta,
    "user_settings": UserSettings, "reader_archetypes": ReaderArchetype,
    "user_directive": UserDirective, "usage_events": UsageEvent,
    "invites": Invite,
}
```

and to `reset_db`'s delete tuple, so each write scenario starts from a known roster:

```python
        for model in (Enrichment, TasteTrait, Recommendation, ProfileMeta,
                      UserSettings, ReaderArchetype, UserDirective, UsageEvent,
                      TasteSignal, Feedback, FeedbackPromptState, Invite, Book):
```

- [ ] **Step 2: Add the synthetic roster to `SEED`**

In the `SEED` dict, add an `"invites"` key. The `supabase_user_id` values are deliberately `local`
and `other` — the same user ids the seeded books, usage events, and feedback rows already use — so
the `book_count` aggregation and the email joins in `/admin/usage` and `/admin/feedback` actually
resolve to something. A third row is `revoked` so the roster covers both statuses.

```python
    "invites": [
        {"id": 1, "email": "reader1@example.com", "status": "active",
         "supabase_user_id": "local", "invited_by": "admin@example.com",
         "created_at": "2026-07-02T12:00:00", "revoked_at": None, "accepted_at": None},
        {"id": 2, "email": "reader2@example.com", "status": "active",
         "supabase_user_id": "other", "invited_by": "admin@example.com",
         "created_at": "2026-07-01T12:00:00", "revoked_at": None, "accepted_at": None},
        {"id": 3, "email": "former.reader@example.com", "status": "revoked",
         "supabase_user_id": "sb-former", "invited_by": "admin@example.com",
         "created_at": "2026-06-01T12:00:00", "revoked_at": "2026-06-15T12:00:00",
         "accepted_at": None},
    ],
```

**Every address is `@example.com`. The repo is public — no real address may enter this file.**

- [ ] **Step 3: Add the admin read requests**

Append to `REQUESTS`:

```python
    "GET /admin/me",
    "GET /admin/users",
    "GET /admin/usage",
    "GET /admin/usage?limit=2&offset=1",
    "GET /admin/feedback",
    "GET /admin/feedback?category=bug",
```

- [ ] **Step 4: Fake GoTrue for the write scenarios**

Add this block **after** the `from mylibrary.api import app` import. The patch targets
`mylibrary.invites`, **not** `mylibrary.supabase_admin`: `invites.py` uses
`from .supabase_admin import delete_user, invite_user, list_users`, which binds those names into
the `invites` module at import time, so patching the source module has no effect.

```python
# --- fake GoTrue -------------------------------------------------------------- #
# invites.py did `from .supabase_admin import ...`, which binds these names into
# mylibrary.invites at import time. Patching mylibrary.supabase_admin would be a
# no-op -- the patch MUST land on mylibrary.invites.
from mylibrary import invites as _invites  # noqa: E402

_FAKE_SB_USERS = [
    {"id": "local", "email": "reader1@example.com"},
    {"id": "other", "email": "reader2@example.com"},
    {"id": "sb-dashboard", "email": "dashboard.created@example.com"},
]


def _fake_invite_user(email, *, client=None):
    return {"id": f"sb-{email.split('@')[0]}", "email": email}


def _fake_delete_user(supabase_user_id, *, client=None):
    return None


def _fake_list_users(*, client=None):
    return list(_FAKE_SB_USERS)


_invites.invite_user = _fake_invite_user
_invites.delete_user = _fake_delete_user
_invites.list_users = _fake_list_users
```

- [ ] **Step 5: Add the admin write scenarios**

Append to `WRITE_SCENARIOS`. Each scenario re-seeds first, so they are independent.

```python
    "admin_invite": [
        # Mixed case + trailing space: create_invite lowercases and strips.
        {"req": "POST /admin/invite", "json": {"email": "  New.Reader@Example.COM  "}},
        {"req": "GET /admin/users"},
        # Idempotent on email: same address again updates the existing row.
        {"req": "POST /admin/invite", "json": {"email": "new.reader@example.com"}},
        {"req": "GET /admin/users"},
        {"req": "POST /admin/invite", "json": {"email": "   "}, "maskDetail": False},
    ],
    "admin_backfill": [
        {"req": "POST /admin/backfill", "json": {}},
        {"req": "GET /admin/users"},
        # Second run is a no-op: every Supabase user now has a row.
        {"req": "POST /admin/backfill", "json": {}},
    ],
    "admin_revoke": [
        # 'other' owns seeded books, so the purge has something to destroy.
        {"req": "POST /admin/revoke", "json": {"supabase_user_id": "other"}},
        {"req": "GET /admin/users"},
        # Idempotent: the row is already revoked, so delete_user is skipped.
        {"req": "POST /admin/revoke", "json": {"supabase_user_id": "other"}},
        # 'local' must be untouched by revoking 'other'.
        {"req": "GET /stats"},
    ],
    "admin_revoke_unknown": [
        {"req": "POST /admin/revoke", "json": {"supabase_user_id": "sb-nobody"}},
    ],
```

- [ ] **Step 6: Teach the Node seed loader about `invites`**

In `frontend/lib/server/__tests__/helpers/pglite.ts`, make **four** changes:

1. Add `invites?: Record<string, unknown>[];` to the `Seed` interface.
2. Add `'invites'` to `loadSeed`'s `order` array. Position matters only insofar as `invites` has no
   foreign keys — put it directly after `'books'`.
3. Add `'revoked_at'` and `'accepted_at'` to `TS_COLS` so they are normalized like every other
   timestamp column.
4. **Add `'invites'` to `SEQ_TABLES`.** This one is load-bearing and easy to miss. The seed inserts
   rows with explicit `id` values 1-3, which does not advance the serial sequence; without a
   `setval`, the first `INSERT` from Task 6's `createInvite` gets `id=1` and fails on the primary
   key. Every other seeded table is already in this list for exactly this reason.

- [ ] **Step 6b: Prove the sequence reset is in place**

There is no point discovering this in Task 6. After Step 7 regenerates the fixtures, run:

```bash
cd frontend && npx vitest run lib/server/__tests__/parity-admin-reads.test.ts 2>/dev/null || true
grep -n "'invites'" lib/server/__tests__/helpers/pglite.ts
```

Expected: `'invites'` appears **three** times — in `order`, in `SEQ_TABLES`, and nowhere else it
shouldn't. (The `Seed` interface entry is `invites?:`, without quotes, so it will not match.)

- [ ] **Step 7: Regenerate and inspect**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/python scripts/gen_parity_fixtures.py
git --no-pager diff --stat frontend/lib/server/__tests__/fixtures/parity/
```

Then confirm by reading the regenerated `python-responses.json`:

- `empty` → `GET /admin/users` is `[]` with status 200, and `GET /admin/me` is
  `{"is_admin": true}` (the recorder runs with auth disabled).
- `seeded` → `GET /admin/users` has **3** rows, newest `created_at` first, so the order is
  `reader1@example.com` (2026-07-02), `reader2@example.com` (2026-07-01),
  `former.reader@example.com` (2026-06-01).
- `seeded` → `GET /admin/usage` events carry a non-null `email` for `local` / `other`.

**Confirm no real email address entered any fixture:**

```bash
grep -rlE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' frontend/lib/server/__tests__/fixtures/ \
  | xargs -r grep -ohE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' | sort -u
```

Expected: only `@example.com` addresses. Anything else is a stop-and-report.

- [ ] **Step 8: Confirm the existing suite still passes**

```bash
cd frontend && npm run test:server
```

Expected: still green. Adding fixture keys and a seed table must not move any existing assertion.
If an existing parity test fails here, the seed change altered a recorded response — stop and
report which.

- [ ] **Step 9: Gates**

```bash
cd frontend
npm run type-check
npx eslint lib/server/__tests__/helpers/pglite.ts
npx prettier --check lib/server/__tests__/helpers/pglite.ts
cd ..
.venv/bin/ruff check scripts/gen_parity_fixtures.py
.venv/bin/pytest -p no:warnings
```

Note the single `cd ..`. Wave 4d's plan wrote this block as two consecutive `cd .. && ...` lines,
which lands the second command in `/home/chase/Documents` where `.venv/bin/pytest` does not exist.
Run these from the repo root, not by chaining another `cd ..`.

---

## Task 3: `GET /admin/me` and `GET /admin/users`

**Files:**
- Create: `frontend/lib/server/invites.ts`
- Create: `frontend/app/api/admin/me/route.ts`
- Create: `frontend/app/api/admin/users/route.ts`
- Test: `frontend/lib/server/__tests__/parity-admin-reads.test.ts` (create)

**Interfaces:**
- Consumes: `getDb`, `schema` from `lib/server/db`; `verifyRequestUser` from `lib/server/auth`;
  `tsToIso` from `lib/server/serialize`.
- Produces: `listRoster(db: Db): Promise<AdminUser[]>` where
  `AdminUser = { id: number; email: string; status: string; supabase_user_id: string | null;
  invited_by: string | null; created_at: string | null; revoked_at: string | null;
  book_count: number }`. Tasks 6, 7 and 8 add more exports to this same module.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/parity-admin-reads.test.ts`:

```ts
import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET as adminMe } from '../../../app/api/admin/me/route';
import { GET as adminUsers } from '../../../app/api/admin/users/route';

describe('GET /api/admin/me parity', () => {
  setupParityEnv();
  // Local mode (no SUPABASE_URL) makes every caller an admin, exactly as
  // Python's is_admin() short-circuits when auth_enabled is false.
  test('empty library', () => checkParity('empty', 'GET /admin/me', adminMe));
  test('seeded library', () => checkParity('seeded', 'GET /admin/me', adminMe));
});

describe('GET /api/admin/users parity', () => {
  setupParityEnv();
  test('empty roster', () => checkParity('empty', 'GET /admin/users', adminUsers));
  test('seeded roster', () => checkParity('seeded', 'GET /admin/users', adminUsers));
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-admin-reads.test.ts`

Expected: FAIL — the route modules do not exist yet, so this fails at import resolution, not at an
assertion. Expected-red tests by name: `empty library`, `seeded library`, `empty roster`,
`seeded roster`.

- [ ] **Step 3: Create `lib/server/invites.ts` with `listRoster`**

```ts
/**
 * Port of mylibrary/invites.py — the invite lifecycle behind the /admin API.
 * Tasks 6-8 add createInvite, backfillFromSupabase and revokeUser here.
 */
import { count, desc } from 'drizzle-orm';
import { getDb, schema, type Db } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';

export interface AdminUser {
  id: number;
  email: string;
  status: string;
  supabase_user_id: string | null;
  invited_by: string | null;
  created_at: string | null;
  revoked_at: string | null;
  book_count: number;
}

/**
 * Port of invites.py::list_roster — every invite, newest first, annotated with
 * the user's current book count. Python orders by (created_at desc, id desc)
 * and defaults a missing count to 0 via counts.get(..., 0).
 */
export async function listRoster(db: Db = getDb()): Promise<AdminUser[]> {
  const rows = await db
    .select()
    .from(schema.invites)
    .orderBy(desc(schema.invites.createdAt), desc(schema.invites.id));

  const counts = await db
    .select({ userId: schema.books.userId, n: count(schema.books.id) })
    .from(schema.books)
    .groupBy(schema.books.userId);

  const byUser = new Map(counts.map((c) => [c.userId, Number(c.n)]));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status,
    supabase_user_id: row.supabaseUserId,
    invited_by: row.invitedBy,
    created_at: tsToIso(row.createdAt),
    revoked_at: tsToIso(row.revokedAt),
    book_count: row.supabaseUserId ? (byUser.get(row.supabaseUserId) ?? 0) : 0,
  }));
}
```

Tasks 6-8 will add `eq` and `utcnowTs` to these imports. Do not import them now — eslint flags
unused imports, and an unused-import disable comment is not an acceptable way around a gate.

- [ ] **Step 4: Create the two route handlers**

`frontend/app/api/admin/me/route.ts` — **not** admin-gated, and not even auth-gated. Python's
`admin_me` takes a raw header and returns a bool; gating it would 403 every non-admin and break the
nav, which calls this unconditionally.

```ts
import { withApi } from '@/lib/server/http';
import { verifyRequestUser } from '@/lib/server/auth';

/**
 * Port of api.py::admin_me. Deliberately ungated: this route IS the admin
 * check, so it must answer for non-admins too. requireAuth is false because
 * withApi would otherwise 401 before the handler runs; the handler resolves the
 * caller itself and mirrors Python's is_admin(), which returns False on any
 * AuthError rather than raising.
 */
export const GET = withApi(
  '/api/admin/me',
  async (req) => {
    let isAdmin = false;
    try {
      const user = await verifyRequestUser(req.headers.get('authorization'));
      isAdmin = user.isAdmin;
    } catch {
      isAdmin = false;
    }
    return Response.json({ is_admin: isAdmin });
  },
  { requireAuth: false }
);
```

`frontend/app/api/admin/users/route.ts`:

```ts
import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { listRoster } from '@/lib/server/invites';

/** Port of api.py::admin_users. */
export const GET = withApi(
  '/api/admin/users',
  async (_req, ctx) => {
    const rows = await listRoster(getDb());
    ctx.timer.mark('db');
    return Response.json(rows);
  },
  { requireAdmin: true }
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-admin-reads.test.ts`
Expected: PASS, 4/4.

If `seeded roster` fails on `created_at` formatting, the mismatch is `tsToIso` versus what FastAPI
serialized — report the exact expected/received strings rather than reshaping the assertion.

- [ ] **Step 6: Gates**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint lib/server/invites.ts app/api/admin/me/route.ts app/api/admin/users/route.ts lib/server/__tests__/parity-admin-reads.test.ts
npx prettier --check lib/server/invites.ts app/api/admin/me/route.ts app/api/admin/users/route.ts lib/server/__tests__/parity-admin-reads.test.ts
```

Driving session: `.venv/bin/pytest -p no:warnings` → 360 passed.

---

## Task 4: `GET /admin/usage` and `GET /admin/feedback`

**Files:**
- Create: `frontend/app/api/admin/usage/route.ts`
- Create: `frontend/app/api/admin/feedback/route.ts`
- Test: `frontend/lib/server/__tests__/parity-admin-lists.test.ts` (create)

**Interfaces:**
- Consumes: `getDb`, `schema`; `round4`, `tsToIso` from `lib/server/serialize`.
- Produces: no new module exports — both handlers keep their query logic inline, matching how
  `app/api/settings/usage/route.ts` is written.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/parity-admin-lists.test.ts`:

```ts
import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET as adminUsage } from '../../../app/api/admin/usage/route';
import { GET as adminFeedback } from '../../../app/api/admin/feedback/route';

describe('GET /api/admin/usage parity', () => {
  setupParityEnv();
  test('empty', () => checkParity('empty', 'GET /admin/usage', adminUsage));
  test('seeded', () => checkParity('seeded', 'GET /admin/usage', adminUsage));
  test('paginated', () =>
    checkParity('seeded', 'GET /admin/usage?limit=2&offset=1', adminUsage));
});

describe('GET /api/admin/feedback parity', () => {
  setupParityEnv();
  test('empty', () => checkParity('empty', 'GET /admin/feedback', adminFeedback));
  test('seeded', () => checkParity('seeded', 'GET /admin/feedback', adminFeedback));
  test('filtered by category', () =>
    checkParity('seeded', 'GET /admin/feedback?category=bug', adminFeedback));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-admin-lists.test.ts`
Expected: FAIL at import resolution. Expected-red by name: `empty`, `seeded`, `paginated`,
`filtered by category`.

- [ ] **Step 3: Implement `GET /admin/usage`**

`frontend/app/api/admin/usage/route.ts`:

```ts
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { round4, tsToIso } from '@/lib/server/serialize';

/** Python: Query(50, ge=1, le=200) and Query(0, ge=0) -> 422 outside the range. */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(422, 'validation error: query parameter out of range');
  }
  return n;
}

/** Port of usage.py::admin_list_usage — all users, newest first, paginated. */
export const GET = withApi(
  '/api/admin/usage',
  async (req, ctx) => {
    const url = new URL(req.url);
    const limit = intParam(url.searchParams.get('limit'), 50, 1, 200);
    const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const userId = url.searchParams.get('user_id');
    const operation = url.searchParams.get('operation');

    const filters: SQL[] = [];
    if (userId) filters.push(eq(schema.usageEvents.userId, userId));
    if (operation) filters.push(eq(schema.usageEvents.operation, operation));
    const where = filters.length ? and(...filters) : undefined;

    const db = getDb();
    const [agg] = await db
      .select({
        total: sql<number>`count(*)`,
        totalCost: sql<number>`coalesce(sum(${schema.usageEvents.costUsd}), 0.0)`,
      })
      .from(schema.usageEvents)
      .where(where);

    const rows = await db
      .select()
      .from(schema.usageEvents)
      .where(where)
      .orderBy(desc(schema.usageEvents.createdAt), desc(schema.usageEvents.id))
      .limit(limit)
      .offset(offset);
    ctx.timer.mark('db');

    const rowUserIds = [...new Set(rows.map((r) => r.userId))];
    const emails = new Map<string, string>();
    if (rowUserIds.length) {
      const invites = await db
        .select({ sid: schema.invites.supabaseUserId, email: schema.invites.email })
        .from(schema.invites)
        .where(inArray(schema.invites.supabaseUserId, rowUserIds));
      for (const i of invites) if (i.sid) emails.set(i.sid, i.email);
    }

    return Response.json({
      events: rows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        // Python: emails.get(row.user_id) -> None when absent, not omitted.
        email: emails.get(row.userId) ?? null,
        model: row.model,
        operation: row.operation,
        input_tokens: row.inputTokens ?? 0,
        output_tokens: row.outputTokens ?? 0,
        cache_creation_input_tokens: row.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: row.cacheReadInputTokens ?? 0,
        // NOT rounded -- Python emits float(row.cost_usd or 0.0) per event and
        // rounds only the aggregate below.
        cost_usd: row.costUsd ?? 0.0,
        created_at: tsToIso(row.createdAt),
      })),
      total: Number(agg?.total ?? 0),
      // round(x, 4) in CPython is banker's rounding on the exact binary value.
      // round4 routes through pyRound; Math.round(x*1e4)/1e4 disagrees on ties.
      total_cost_usd: round4(Number(agg?.totalCost ?? 0)),
      limit,
      offset,
    });
  },
  { requireAdmin: true }
);
```

- [ ] **Step 4: Implement `GET /admin/feedback`**

`frontend/app/api/admin/feedback/route.ts`:

```ts
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(422, 'validation error: query parameter out of range');
  }
  return n;
}

/** Port of feedback.py::admin_list_feedback — all users, newest first, paginated. */
export const GET = withApi(
  '/api/admin/feedback',
  async (req, ctx) => {
    const url = new URL(req.url);
    const limit = intParam(url.searchParams.get('limit'), 50, 1, 200);
    const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const userId = url.searchParams.get('user_id');
    const category = url.searchParams.get('category');

    const filters: SQL[] = [];
    if (userId) filters.push(eq(schema.feedback.userId, userId));
    if (category) filters.push(eq(schema.feedback.category, category));
    const where = filters.length ? and(...filters) : undefined;

    const db = getDb();
    const [agg] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.feedback)
      .where(where);

    const rows = await db
      .select()
      .from(schema.feedback)
      .where(where)
      .orderBy(desc(schema.feedback.createdAt), desc(schema.feedback.id))
      .limit(limit)
      .offset(offset);
    ctx.timer.mark('db');

    const rowUserIds = [...new Set(rows.map((r) => r.userId))];
    const emails = new Map<string, string>();
    if (rowUserIds.length) {
      const invites = await db
        .select({ sid: schema.invites.supabaseUserId, email: schema.invites.email })
        .from(schema.invites)
        .where(inArray(schema.invites.supabaseUserId, rowUserIds));
      for (const i of invites) if (i.sid) emails.set(i.sid, i.email);
    }

    return Response.json({
      items: rows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        email: emails.get(row.userId) ?? null,
        category: row.category,
        body: row.body,
        trigger: row.trigger,
        run_id: row.runId,
        page: row.page,
        app_version: row.appVersion,
        created_at: tsToIso(row.createdAt),
      })),
      total: Number(agg?.total ?? 0),
      limit,
      offset,
    });
  },
  { requireAdmin: true }
);
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-admin-lists.test.ts`
Expected: PASS, 6/6.

If the column names on `schema.feedback` differ from `trigger` / `runId` / `page` / `appVersion`,
use the real ones from `lib/server/schema.ts` — the response **keys** above are fixed by Python and
must not change.

- [ ] **Step 6: Gates**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint app/api/admin/usage/route.ts app/api/admin/feedback/route.ts lib/server/__tests__/parity-admin-lists.test.ts
npx prettier --check app/api/admin/usage/route.ts app/api/admin/feedback/route.ts lib/server/__tests__/parity-admin-lists.test.ts
```

Driving session: `.venv/bin/pytest -p no:warnings` → 360 passed.

---

## Task 5: The GoTrue admin client

**Files:**
- Create: `frontend/lib/server/supabaseAdmin.ts`
- Test: `frontend/lib/server/__tests__/supabase-admin.test.ts` (create)

**Interfaces:**
- Produces:
  - `class SupabaseAdminError extends Error`
  - `type GoTrueFetch = (url: string, init: RequestInit) => Promise<Response>`
  - `inviteUser(email: string, fetchImpl?: GoTrueFetch): Promise<{ id: string | null; email: string }>`
  - `deleteUser(supabaseUserId: string, fetchImpl?: GoTrueFetch): Promise<void>`
  - `listUsers(fetchImpl?: GoTrueFetch): Promise<Array<{ id: string | null; email: string | null }>>`
- Tasks 6-8 consume these.

**No route touches this task.** It is a standalone module with injected transport.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/supabase-admin.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SupabaseAdminError,
  deleteUser,
  inviteUser,
  listUsers,
} from '../supabaseAdmin';

/**
 * Port checks for mylibrary/supabase_admin.py. The transport is injected, so
 * nothing here touches the network. The security assertions (no key, no raw
 * body in error text) are the point of this module, not incidental.
 */
const SERVICE_KEY = 'service-role-secret-value';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('supabaseAdmin', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      FRONTEND_URL: process.env.FRONTEND_URL,
    };
    process.env.SUPABASE_URL = 'https://proj.supabase.co/';
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    delete process.env.FRONTEND_URL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('throws when not configured, naming both variables', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(inviteUser('a@example.com', async () => jsonResponse(200, {}))).rejects.toThrow(
      /Supabase admin not configured/
    );
  });

  it('sends the service-role key as both Authorization and apikey', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    await inviteUser('reader@example.com', async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(200, { id: 'sb-1', email: 'reader@example.com' });
    });
    // trailing slash on SUPABASE_URL is stripped, /auth/v1 appended
    expect(seenUrl).toBe('https://proj.supabase.co/auth/v1/invite');
    expect(seenInit.method).toBe('POST');
    const headers = seenInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect(headers.apikey).toBe(SERVICE_KEY);
    expect(JSON.parse(String(seenInit.body))).toEqual({ email: 'reader@example.com' });
  });

  it('appends a percent-encoded redirect_to when FRONTEND_URL is set', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    let seenUrl = '';
    await inviteUser('reader@example.com', async (url) => {
      seenUrl = url;
      return jsonResponse(200, { id: 'sb-1', email: 'reader@example.com' });
    });
    expect(seenUrl).toBe(
      'https://proj.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback'
    );
  });

  it('falls back to the requested email when GoTrue omits one', async () => {
    const out = await inviteUser('reader@example.com', async () =>
      jsonResponse(200, { id: 'sb-1' })
    );
    expect(out).toEqual({ id: 'sb-1', email: 'reader@example.com' });
  });

  it('surfaces GoTrue msg but never the key or the raw body', async () => {
    const err = await inviteUser('reader@example.com', async () =>
      jsonResponse(422, { msg: 'User already registered', secret_field: SERVICE_KEY })
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseAdminError);
    const text = String((err as Error).message);
    expect(text).toContain('422');
    expect(text).toContain('User already registered');
    expect(text).not.toContain(SERVICE_KEY);
    expect(text).not.toContain('secret_field');
  });

  it('reports a network failure by error type only', async () => {
    const err = await deleteUser('sb-1', async () => {
      throw new TypeError('fetch failed: 10.0.0.1 refused');
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseAdminError);
    expect(String((err as Error).message)).toContain('TypeError');
    expect(String((err as Error).message)).not.toContain('10.0.0.1');
  });

  it('deletes by id against the admin path', async () => {
    let seenUrl = '';
    let seenMethod = '';
    await deleteUser('sb-abc', async (url, init) => {
      seenUrl = url;
      seenMethod = String(init.method);
      return new Response(null, { status: 204 });
    });
    expect(seenUrl).toBe('https://proj.supabase.co/auth/v1/admin/users/sb-abc');
    expect(seenMethod).toBe('DELETE');
  });

  it('pages listUsers until a short page arrives', async () => {
    const seen: string[] = [];
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `sb-${i}`,
      email: `u${i}@example.com`,
    }));
    const out = await listUsers(async (url) => {
      seen.push(url);
      return jsonResponse(200, { users: seen.length === 1 ? page1 : [{ id: 'sb-last', email: 'last@example.com' }] });
    });
    expect(seen).toEqual([
      'https://proj.supabase.co/auth/v1/admin/users?page=1&per_page=200',
      'https://proj.supabase.co/auth/v1/admin/users?page=2&per_page=200',
    ]);
    expect(out).toHaveLength(201);
    expect(out[200]).toEqual({ id: 'sb-last', email: 'last@example.com' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/supabase-admin.test.ts`
Expected: FAIL at import resolution — `../supabaseAdmin` does not exist.

- [ ] **Step 3: Implement the module**

Create `frontend/lib/server/supabaseAdmin.ts`:

```ts
/**
 * Port of mylibrary/supabase_admin.py — the GoTrue admin client.
 *
 * Uses the SERVICE-ROLE key, which must never reach the browser and is only
 * present in Vercel's Production environment. Network failures and non-2xx
 * responses raise SupabaseAdminError; the secret never appears in error text,
 * and arbitrary response bodies are never echoed (they may contain PII).
 *
 * The transport is injected so tests never touch the network.
 */

export class SupabaseAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseAdminError';
  }
}

export type GoTrueFetch = (url: string, init: RequestInit) => Promise<Response>;

interface BaseAndHeaders {
  base: string;
  headers: Record<string, string>;
}

function baseAndHeaders(): BaseAndHeaders {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new SupabaseAdminError(
      'Supabase admin not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).'
    );
  }
  return {
    base: `${url.replace(/\/+$/, '')}/auth/v1`,
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
    },
  };
}

async function request(
  method: string,
  path: string,
  body: unknown,
  fetchImpl: GoTrueFetch
): Promise<Response> {
  const { base, headers } = baseAndHeaders();
  const url = base + path;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Type name only -- the message can carry hostnames and request detail.
    const name = err instanceof Error ? err.constructor.name : 'Error';
    throw new SupabaseAdminError(`Supabase admin request failed: ${name}`);
  }
  if (resp.status >= 300) {
    let msg: string | null = null;
    try {
      const data = (await resp.json()) as Record<string, unknown>;
      const m = data.msg ?? data.message;
      msg = typeof m === 'string' ? m : null;
    } catch {
      msg = null;
    }
    const detail = msg ? `: ${msg}` : '';
    throw new SupabaseAdminError(`Supabase admin ${method} ${path} -> ${resp.status}${detail}`);
  }
  return resp;
}

/**
 * Port of invite_user. Points the invite link at our own /auth/callback rather
 * than the project's dashboard-configured Site URL, so an invited user lands
 * somewhere that establishes a session and prompts for a password.
 */
export async function inviteUser(
  email: string,
  fetchImpl: GoTrueFetch = fetch
): Promise<{ id: string | null; email: string }> {
  let path = '/invite';
  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl) {
    // Python uses quote(..., safe='') -- encodeURIComponent matches it for this input.
    path += `?redirect_to=${encodeURIComponent(`${frontendUrl}/auth/callback`)}`;
  }
  const resp = await request('POST', path, { email }, fetchImpl);
  const data = (await resp.json()) as { id?: string | null; email?: string };
  return { id: data.id ?? null, email: data.email ?? email };
}

/** Port of delete_user — permanently deletes a GoTrue user. Irreversible. */
export async function deleteUser(
  supabaseUserId: string,
  fetchImpl: GoTrueFetch = fetch
): Promise<void> {
  await request('DELETE', `/admin/users/${supabaseUserId}`, null, fetchImpl);
}

/** Port of list_users — every GoTrue user, paged 200 at a time. */
export async function listUsers(
  fetchImpl: GoTrueFetch = fetch
): Promise<Array<{ id: string | null; email: string | null }>> {
  const users: Array<{ id: string | null; email: string | null }> = [];
  const perPage = 200;
  let page = 1;
  for (;;) {
    const resp = await request(
      'GET',
      `/admin/users?page=${page}&per_page=${perPage}`,
      null,
      fetchImpl
    );
    const data = (await resp.json()) as { users?: Array<{ id?: string; email?: string }> };
    const batch = data.users ?? [];
    for (const u of batch) users.push({ id: u.id ?? null, email: u.email ?? null });
    if (batch.length < perPage) break;
    page += 1;
  }
  return users;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run lib/server/__tests__/supabase-admin.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Gates**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint lib/server/supabaseAdmin.ts lib/server/__tests__/supabase-admin.test.ts
npx prettier --check lib/server/supabaseAdmin.ts lib/server/__tests__/supabase-admin.test.ts
```

Driving session: `.venv/bin/pytest -p no:warnings` → 360 passed.

---

## Task 6: `POST /admin/invite`

**Files:**
- Modify: `frontend/lib/server/invites.ts` (add `createInvite`)
- Create: `frontend/app/api/admin/invite/route.ts`
- Test: `frontend/lib/server/__tests__/parity-writes-admin.test.ts` (create)

**Interfaces:**
- Consumes: `inviteUser`, `SupabaseAdminError` from `lib/server/supabaseAdmin`; the existing
  user-settings writers; `listRoster` from Task 3.
- Produces: `createInvite(opts: { email: string; invitedBy: string; displayName?: string | null;
  anthropicApiKey?: string | null; deps?: { inviteUser: typeof inviteUser } }): Promise<AdminUser>`
  and `class InviteError extends Error`.

**Critical:** `createInvite` must **not** run inside one transaction. Python calls GoTrue first,
then writes the display name, the encrypted key, and the invite row in **separate** sessions. The
GoTrue call cannot be rolled back, so a single enclosing transaction would misrepresent a
partially-applied invite as fully failed.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/parity-writes-admin.test.ts`. It replays the
`admin_invite` scenario recorded in Task 2. Check the actual recorded shape in
`fixtures/parity/write-scenarios.json` before asserting — the scenario steps are fixed by the
recorder, and this test must follow them, not the other way round.

```ts
import { describe, expect, it } from 'vitest';
import scenarios from './fixtures/parity/write-scenarios.json';
import seedJson from './fixtures/parity/seed.json';
import { setupParityEnv } from './helpers/parity';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import { _setDbForTests } from '../db';
import { POST as adminInvite } from '../../../app/api/admin/invite/route';
import { GET as adminUsers } from '../../../app/api/admin/users/route';

type Step = { req: string; json: unknown; status: number; body: unknown };

/**
 * Replays the admin_invite scenario recorded from Python. The GoTrue call is
 * faked on both sides: the recorder patched mylibrary.invites.invite_user, and
 * here the route's injected dependency stands in. What is being proven is the
 * database effect and the response shape, not the network call.
 */
const FAKE_INVITE = async (email: string) => ({
  id: `sb-${email.split('@')[0]}`,
  email,
});

describe('POST /api/admin/invite parity', () => {
  setupParityEnv();

  it('replays the recorded admin_invite scenario', async () => {
    const steps = (scenarios as Record<string, Step[]>).admin_invite;
    expect(steps.length).toBeGreaterThan(0);

    const { db, close } = await makeTestDb();
    // Module-level seam, mirroring _setDbForTests. withApi's signature is
    // (req, routeCtx?) with routeCtx = { params? } -- there is no way to thread
    // a dependency object through the handler, so injection lives in the module.
    _setInviteUserForTests(FAKE_INVITE);
    try {
      await loadSeed(db, seedJson as unknown as Seed);
      _setDbForTests(db);

      for (const step of steps) {
        const [method, path] = step.req.split(' ');
        const url = `http://test/api${path}`;
        const res =
          path === '/admin/users'
            ? await adminUsers(new Request(url, { method }))
            : await adminInvite(
                new Request(url, {
                  method,
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(step.json),
                })
              );
        expect(res.status, `${step.req} status`).toBe(step.status);
        const body = res.status === 204 ? null : await res.json();
        expect(body, `${step.req} body`).toEqual(step.body);
      }
    } finally {
      _setInviteUserForTests(null);
      _setDbForTests(null);
      await close();
    }
  });
});
```

Imports for this file: `_setInviteUserForTests` from `../invites`, `POST as adminInvite` from
`../../../app/api/admin/invite/route`, and `GET as adminUsers` from
`../../../app/api/admin/users/route`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-writes-admin.test.ts`
Expected: FAIL at import resolution. Expected-red by name:
`replays the recorded admin_invite scenario`.

- [ ] **Step 3: Add `createInvite` to `lib/server/invites.ts`**

Extend the imports first:

```ts
import { count, desc, eq } from 'drizzle-orm';
import { getDb, schema, type Db } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';
import { inviteUser } from '@/lib/server/supabaseAdmin';
import { upsertUserSettings } from '@/lib/server/settings';
import { encrypt } from '@/lib/server/crypto';
```

**There is no `setDisplayName` or `setAnthropicKey` on the Node side.** Wave 2 exposes a single
generic writer, and the key must be encrypted before it is stored:

```ts
upsertUserSettings(
  db: Db,
  userId: string,
  patch: Partial<{ anthropicApiKeyEncrypted: string | null; displayName: string }>
): Promise<void>

encrypt(plaintext: string, key?: Buffer): string
```

```ts
export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteError';
  }
}

/** Test seam, mirroring _setDbForTests. Production always uses the real client. */
let inviteUserImpl: typeof inviteUser = inviteUser;
export function _setInviteUserForTests(fn: typeof inviteUser | null): void {
  inviteUserImpl = fn ?? inviteUser;
}

/**
 * Port of invites.py::create_invite. Idempotent on the lowercased, stripped email.
 *
 * NOT wrapped in a transaction, deliberately: Python calls GoTrue first and then
 * writes the display name, the encrypted key, and the invite row in three
 * separate sessions. The GoTrue call cannot be rolled back, so one enclosing
 * transaction would report a partially-applied invite as a clean failure.
 */
export async function createInvite(opts: {
  email: string;
  invitedBy: string;
  displayName?: string | null;
  anthropicApiKey?: string | null;
}): Promise<AdminUser> {
  const email = (opts.email ?? '').trim().toLowerCase();
  if (!email) throw new InviteError('email must not be empty');

  const result = await inviteUserImpl(email); // may throw SupabaseAdminError
  const sbId = result.id;

  const db = getDb();
  if (sbId) {
    // Python guards on the untrimmed value but STORES the trimmed one:
    // user_settings.py does `name = (name or "").strip()` and
    // `raw_key = (raw_key or "").strip()`. Trim on the way in, not just in the guard.
    const displayName = opts.displayName?.trim();
    if (displayName) {
      await upsertUserSettings(db, sbId, { displayName });
    }
    const apiKey = opts.anthropicApiKey?.trim();
    if (apiKey) {
      await upsertUserSettings(db, sbId, { anthropicApiKeyEncrypted: encrypt(apiKey) });
    }
  }

  const existing = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.email, email))
    .limit(1);

  if (existing.length) {
    await db
      .update(schema.invites)
      .set({
        invitedBy: opts.invitedBy,
        supabaseUserId: sbId,
        status: 'active',
        revokedAt: null,
      })
      .where(eq(schema.invites.id, existing[0].id));
  } else {
    await db.insert(schema.invites).values({
      email,
      invitedBy: opts.invitedBy,
      supabaseUserId: sbId,
      status: 'active',
      revokedAt: null,
    });
  }

  const [row] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.email, email))
    .limit(1);

  // Python returns _invite_dict(row) with NO book_count key; FastAPI's
  // AdminUserOut then supplies the default of 0. Match the serialized result.
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    supabase_user_id: row.supabaseUserId,
    invited_by: row.invitedBy,
    created_at: tsToIso(row.createdAt),
    revoked_at: tsToIso(row.revokedAt),
    book_count: 0,
  };
}
```

**Verify the `book_count: 0` claim against the recorded fixture before trusting this comment.**
`create_invite` returns `_invite_dict(row)` without a `book_count`, and `AdminUserOut` declares
`book_count: int = 0`, so the serialized 201 body should carry `0` even for a user with books. If
the recorded fixture disagrees, the fixture wins — report the discrepancy.

Do not re-port encryption — `lib/server/crypto.ts` already provides `encrypt`.

Python calls `set_display_name` and `set_anthropic_key`, which are two functions; Node has one
`upsertUserSettings` taking a partial patch. Two sequential calls (as above) match Python's two
sequential writes. Do **not** merge them into a single patch object: Python writes the display name
before the key, and if the key write raises, the display name must already be committed.

- [ ] **Step 4: Create the route**

`frontend/app/api/admin/invite/route.ts`:

```ts
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { createInvite, InviteError } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

const Body = z.object({
  email: z.string(),
  display_name: z.string().nullable().optional(),
  anthropic_api_key: z.string().nullable().optional(),
});

/** Port of api.py::admin_invite. 201 on success. */
export const POST = withApi(
  '/api/admin/invite',
  async (req, ctx) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError(422, 'request body must be JSON');
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }
    try {
      const out = await createInvite({
        email: parsed.data.email,
        invitedBy: ctx.user.userId,
        displayName: parsed.data.display_name ?? null,
        anthropicApiKey: parsed.data.anthropic_api_key ?? null,
      });
      return Response.json(out, { status: 201 });
    } catch (err) {
      if (err instanceof InviteError) throw new ApiError(422, err.message);
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
  },
  { requireAdmin: true }
);
```

- [ ] **Step 5: Run the test**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-writes-admin.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint lib/server/invites.ts app/api/admin/invite/route.ts lib/server/__tests__/parity-writes-admin.test.ts
npx prettier --check lib/server/invites.ts app/api/admin/invite/route.ts lib/server/__tests__/parity-writes-admin.test.ts
```

Driving session: `.venv/bin/pytest -p no:warnings` → 360 passed.

---

## Task 7: `POST /admin/backfill`

**Files:**
- Modify: `frontend/lib/server/invites.ts` (add `backfillFromSupabase`, `_setListUsersForTests`)
- Create: `frontend/app/api/admin/backfill/route.ts`
- Modify: `frontend/lib/server/__tests__/parity-writes-admin.test.ts` (add the scenario)

**Interfaces:**
- Produces: `backfillFromSupabase(opts: { invitedBy: string }): Promise<{ added: number;
  total_supabase_users: number }>`.

- [ ] **Step 1: Add the failing test**

Append to `parity-writes-admin.test.ts`, replaying the recorded `admin_backfill` scenario. Use the
same `_setListUsersForTests` seam and the same three fake users the recorder used:

```ts
const FAKE_SB_USERS = [
  { id: 'local', email: 'reader1@example.com' },
  { id: 'other', email: 'reader2@example.com' },
  { id: 'sb-dashboard', email: 'dashboard.created@example.com' },
];

describe('POST /api/admin/backfill parity', () => {
  setupParityEnv();

  it('replays the recorded admin_backfill scenario', async () => {
    const steps = (scenarios as Record<string, Step[]>).admin_backfill;
    expect(steps.length).toBeGreaterThan(0);

    const { db, close } = await makeTestDb();
    _setListUsersForTests(async () => FAKE_SB_USERS);
    try {
      await loadSeed(db, seedJson as unknown as Seed);
      _setDbForTests(db);
      for (const step of steps) {
        const [method, path] = step.req.split(' ');
        const url = `http://test/api${path}`;
        const res =
          path === '/admin/users'
            ? await adminUsers(new Request(url, { method }))
            : await adminBackfill(
                new Request(url, {
                  method,
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(step.json ?? {}),
                })
              );
        expect(res.status, `${step.req} status`).toBe(step.status);
        expect(await res.json(), `${step.req} body`).toEqual(step.body);
      }
    } finally {
      _setListUsersForTests(null);
      _setDbForTests(null);
      await close();
    }
  });
});
```

Add the matching imports at the top of the file: `_setListUsersForTests` from `../invites` and
`POST as adminBackfill` from `../../../app/api/admin/backfill/route`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-writes-admin.test.ts`
Expected-red by name: `replays the recorded admin_backfill scenario`. The invite test from Task 6
must still pass.

- [ ] **Step 3: Implement `backfillFromSupabase`**

```ts
let listUsersImpl: typeof listUsers = listUsers;
export function _setListUsersForTests(fn: typeof listUsers | null): void {
  listUsersImpl = fn ?? listUsers;
}

/**
 * Port of invites.py::backfill_from_supabase. Creates an "active" invite row for
 * every Supabase user with no local row (e.g. added in the dashboard). Matches
 * by supabase_user_id; existing rows are left untouched.
 */
export async function backfillFromSupabase(opts: {
  invitedBy: string;
}): Promise<{ added: number; total_supabase_users: number }> {
  const sbUsers = await listUsersImpl(); // may throw SupabaseAdminError

  const db = getDb();
  const existing = await db
    .select({ sid: schema.invites.supabaseUserId })
    .from(schema.invites);
  const known = new Set(existing.map((r) => r.sid).filter((s): s is string => s !== null));

  let added = 0;
  for (const u of sbUsers) {
    const sbId = u.id;
    if (!sbId || known.has(sbId)) continue;
    await db.insert(schema.invites).values({
      email: (u.email ?? '').trim().toLowerCase(),
      invitedBy: opts.invitedBy,
      supabaseUserId: sbId,
      status: 'active',
    });
    known.add(sbId);
    added += 1;
  }
  return { added, total_supabase_users: sbUsers.length };
}
```

- [ ] **Step 4: Create the route**

`frontend/app/api/admin/backfill/route.ts`:

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { backfillFromSupabase } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

/**
 * Port of api.py::admin_backfill. The body is ignored on both sides -- Python
 * declares no request model for this route.
 */
export const POST = withApi(
  '/api/admin/backfill',
  async (_req, ctx) => {
    try {
      return Response.json(await backfillFromSupabase({ invitedBy: ctx.user.userId }));
    } catch (err) {
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
  },
  { requireAdmin: true }
);
```

- [ ] **Step 5: Run the test**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-writes-admin.test.ts`
Expected: PASS, both scenarios.

- [ ] **Step 6: Gates** — same six commands as Task 6, with
`app/api/admin/backfill/route.ts` in the eslint and prettier lists.

---

## Task 8: `POST /admin/revoke` — the irreversible one

**Files:**
- Modify: `frontend/lib/server/invites.ts` (add `revokeUser`, `_setDeleteUserForTests`)
- Create: `frontend/app/api/admin/revoke/route.ts`
- Modify: `frontend/lib/server/__tests__/parity-writes-admin.test.ts`

**Interfaces:**
- Consumes: `deleteUser` from `lib/server/supabaseAdmin`; **`deleteAccountRows(tx: DbTx, userId:
  string): Promise<AccountPurgeResult>`** from `lib/server/purge` (wave 4a). Note the name — there
  is no `deleteAccount` export — and note that it takes a **transaction**, not a `Db`. Call it the
  way `app/api/account/route.ts` already does:
  `await db.transaction((tx) => deleteAccountRows(tx, userId))`.
- Produces: `revokeUser(opts: { supabaseUserId: string }): Promise<{ supabase_user_id: string;
  status: string }>`.

### Read this before writing any code

**`revokeUser` must NOT be wrapped in a single transaction.** Python runs four phases:

1. read the invite row (own session)
2. call GoTrue `DELETE` — **irreversible, un-rollbackable, outside any transaction**
3. commit `status='revoked'` + `revoked_at` in its **own** transaction
4. call `deleteAccount` to purge app data

Phase 3 exists precisely so that if phase 4 throws, the row still reads `revoked` and a retry
**skips** the GoTrue delete instead of 404ing against an account that no longer exists. A single
enclosing transaction would roll that flag back on a purge failure and strand the user in a state
where every retry fails.

Every other Node write route in this codebase wraps its work in `db.transaction`. **This one must
not.** Do not "fix" it. Do not let a review finding "fix" it.

**"Not transactional" means no single transaction spanning phases 2-4 — it does not mean no
transactions at all.** Phase 4 is itself transactional, because `deleteAccountRows` takes a `DbTx`
and must be called as `db.transaction((tx) => deleteAccountRows(tx, userId))`. That is correct and
matches Python, where `delete_account` opens its own `session_scope`. The purge is atomic within
itself; what must **not** happen is the revoked-flag commit and the purge sharing one transaction.

- [ ] **Step 1: Add the failing tests**

Append to `parity-writes-admin.test.ts` — two scenarios, plus one behavioral test that no fixture
can express:

```ts
describe('POST /api/admin/revoke parity', () => {
  setupParityEnv();

  for (const name of ['admin_revoke', 'admin_revoke_unknown'] as const) {
    it(`replays the recorded ${name} scenario`, async () => {
      const steps = (scenarios as Record<string, Step[]>)[name];
      expect(steps.length).toBeGreaterThan(0);

      const { db, close } = await makeTestDb();
      _setDeleteUserForTests(async () => undefined);
      try {
        await loadSeed(db, seedJson as unknown as Seed);
        _setDbForTests(db);
        for (const step of steps) {
          const [method, path] = step.req.split(' ');
          const url = `http://test/api${path}`;
          let res: Response;
          if (path === '/admin/users') res = await adminUsers(new Request(url, { method }));
          else if (path === '/stats') res = await statsGet(new Request(url, { method }));
          else
            res = await adminRevoke(
              new Request(url, {
                method,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(step.json),
              })
            );
          expect(res.status, `${step.req} status`).toBe(step.status);
          expect(await res.json(), `${step.req} body`).toEqual(step.body);
        }
      } finally {
        _setDeleteUserForTests(null);
        _setDbForTests(null);
        await close();
      }
    });
  }

  it('leaves the row revoked when the purge fails, so a retry skips the GoTrue delete', async () => {
    // This is the reason revokeUser is not transactional. No fixture can show
    // it: Python's recorded run never has delete_account throw.
    const { db, close } = await makeTestDb();
    let deleteUserCalls = 0;
    _setDeleteUserForTests(async () => {
      deleteUserCalls += 1;
    });
    try {
      await loadSeed(db, seedJson as unknown as Seed);
      _setDbForTests(db);

      // Force the purge to fail on the first attempt only.
      let failPurge = true;
      _setDeleteAccountForTests(async () => {
        if (failPurge) throw new Error('purge exploded');
        return undefined;
      });

      await expect(revokeUser({ supabaseUserId: 'other' })).rejects.toThrow('purge exploded');
      expect(deleteUserCalls).toBe(1);

      // The row must already read 'revoked' despite the purge failing.
      const roster = await listRoster(db);
      const row = roster.find((r) => r.supabase_user_id === 'other');
      expect(row?.status).toBe('revoked');
      expect(row?.revoked_at).not.toBeNull();

      // Retry: GoTrue must NOT be called a second time.
      failPurge = false;
      await revokeUser({ supabaseUserId: 'other' });
      expect(deleteUserCalls).toBe(1);
    } finally {
      _setDeleteAccountForTests(null);
      _setDeleteUserForTests(null);
      _setDbForTests(null);
      await close();
    }
  });
});
```

Add imports: `_setDeleteUserForTests`, `_setDeleteAccountForTests`, `revokeUser`, `listRoster` from
`../invites`; `POST as adminRevoke` from the new route; `GET as statsGet` from
`../../../app/api/stats/route`.

- [ ] **Step 2: Run and confirm failure**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-writes-admin.test.ts`
Expected-red by name: `replays the recorded admin_revoke scenario`,
`replays the recorded admin_revoke_unknown scenario`,
`leaves the row revoked when the purge fails, so a retry skips the GoTrue delete`.

- [ ] **Step 3: Implement `revokeUser`**

Extend `invites.ts`'s imports first: add `utcnowTs` to the `@/lib/server/serialize` import, add
`deleteUser` from `@/lib/server/supabaseAdmin`, and add `deleteAccountRows` from
`@/lib/server/purge`.

The purge seam wraps the transaction rather than `deleteAccountRows` itself, so a test can replace
the whole phase without needing a `DbTx`:

```ts
let deleteUserImpl: typeof deleteUser = deleteUser;
export function _setDeleteUserForTests(fn: typeof deleteUser | null): void {
  deleteUserImpl = fn ?? deleteUser;
}

/** Phase 4 of revokeUser, as one unit. Transactional inside; see the note above. */
type PurgeFn = (userId: string) => Promise<unknown>;
const realPurge: PurgeFn = (userId) =>
  getDb().transaction((tx) => deleteAccountRows(tx, userId));

let purgeImpl: PurgeFn = realPurge;
export function _setDeleteAccountForTests(fn: PurgeFn | null): void {
  purgeImpl = fn ?? realPurge;
}

/**
 * Port of invites.py::revoke_user. Delete the Supabase user, purge their app
 * data, mark the invite revoked.
 *
 * DELIBERATELY NOT TRANSACTIONAL -- do not "fix" this. Phase order is:
 *   1. read the row          2. GoTrue DELETE (irreversible)
 *   3. commit status=revoked 4. purge app data
 * Step 3 lands in its own transaction BEFORE step 4 so that a purge failure
 * still leaves the row readable as 'revoked'. The Supabase account is already
 * gone at that point, so a retry must skip deleteUser -- calling it again 404s.
 * A single enclosing transaction would roll the flag back and make every retry
 * fail permanently.
 */
export async function revokeUser(opts: {
  supabaseUserId: string;
}): Promise<{ supabase_user_id: string; status: string }> {
  const supabaseUserId = opts.supabaseUserId;
  if (!supabaseUserId) throw new InviteError('supabase_user_id is required');

  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.supabaseUserId, supabaseUserId))
    .limit(1);
  if (!row) throw new InviteError('invite not found for supabase_user_id');

  const alreadyRevoked = row.status === 'revoked';

  if (!alreadyRevoked) {
    await deleteUserImpl(supabaseUserId); // may throw SupabaseAdminError

    // Own transaction, before the purge. See the comment above.
    await db
      .update(schema.invites)
      .set({ status: 'revoked', revokedAt: utcnowTs() })
      .where(eq(schema.invites.supabaseUserId, supabaseUserId));
  }

  // Phase 4. Transactional in itself, but NOT sharing a transaction with the
  // revoked-flag commit above -- that separation is the whole point.
  await purgeImpl(supabaseUserId);

  return { supabase_user_id: supabaseUserId, status: 'revoked' };
}
```

Do not modify `purge.ts`. `deleteAccountRows` is shared with `DELETE /account` (wave 4a) and
changing its signature would break that route's parity.

- [ ] **Step 4: Create the route**

`frontend/app/api/admin/revoke/route.ts`:

```ts
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { revokeUser, InviteError } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

const Body = z.object({ supabase_user_id: z.string() });

/** Port of api.py::admin_revoke. InviteError -> 404 (not 422, unlike invite). */
export const POST = withApi(
  '/api/admin/revoke',
  async (req) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError(422, 'request body must be JSON');
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }
    try {
      return Response.json(await revokeUser({ supabaseUserId: parsed.data.supabase_user_id }));
    } catch (err) {
      if (err instanceof InviteError) throw new ApiError(404, err.message);
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
  },
  { requireAdmin: true }
);
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run lib/server/__tests__/parity-writes-admin.test.ts`
Expected: PASS, all four scenarios plus the retry-safety test.

- [ ] **Step 6: Prove the non-transactional property is actually load-bearing**

Temporarily wrap `revokeUser`'s phases 2-4 in `db.transaction(async (tx) => { ... })` and re-run.
The retry-safety test **must** fail. Revert immediately and confirm green. If it passes wrapped,
the test is not testing what it claims and must be fixed before this task is complete.

- [ ] **Step 7: Gates** — same six commands, with `app/api/admin/revoke/route.ts` added.

---

## Task 9: Flip the switcher and remove dead code

**Files:**
- Modify: `frontend/lib/backend.ts`
- Modify: `frontend/lib/api.ts` (delete the unused `health()` method)
- Test: `frontend/lib/__tests__/backend.test.ts`

- [ ] **Step 1: Add the failing switcher tests**

Append to `frontend/lib/__tests__/backend.test.ts`, following the file's existing style:

```ts
  it('routes the admin surface to Node in auto mode', () => {
    expect(baseFor('/admin/me', 'GET')).toBe('/api');
    expect(baseFor('/admin/users', 'GET')).toBe('/api');
    expect(baseFor('/admin/usage', 'GET')).toBe('/api');
    expect(baseFor('/admin/feedback', 'GET')).toBe('/api');
    expect(baseFor('/admin/invite', 'POST')).toBe('/api');
    expect(baseFor('/admin/revoke', 'POST')).toBe('/api');
    expect(baseFor('/admin/backfill', 'POST')).toBe('/api');
  });

  it('keeps /admin/config on the Node-only path', () => {
    expect(baseFor('/admin/config', 'GET')).toBe('/api');
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd frontend && npx vitest run lib/__tests__/backend.test.ts`
Expected-red by name: `routes the admin surface to Node in auto mode`.

- [ ] **Step 3: Add the rules**

In `NODE_DEFAULT_ROUTES` in `frontend/lib/backend.ts`, append:

```ts
  // Wave 5a: the admin surface. Every route is `exact` because /admin is a
  // prefix of /admin/config (Node-only, handled by NODE_ONLY_PREFIXES) and a
  // future /admin/* route should be an explicit decision, not an inherited one.
  { prefix: '/admin/me', methods: ['GET'], exact: true },
  { prefix: '/admin/users', methods: ['GET'], exact: true },
  { prefix: '/admin/usage', methods: ['GET'], exact: true },
  { prefix: '/admin/feedback', methods: ['GET'], exact: true },
  { prefix: '/admin/invite', methods: ['POST'], exact: true },
  { prefix: '/admin/revoke', methods: ['POST'], exact: true },
  { prefix: '/admin/backfill', methods: ['POST'], exact: true },
```

Also extend the wave comment block above `NODE_DEFAULT_ROUTES` with a `Wave 5a:` line, matching how
every previous wave documented its flip.

- [ ] **Step 4: Delete the dead `health()` client method**

In `frontend/lib/api.ts`, remove the `health:` entry. It is called from nowhere
(`grep -rn "\.health()" frontend --include=*.ts --include=*.tsx` returns no call sites), and
Python's `GET /health` reads `settings.db_path.name`, a SQLite-era vestige. Wave 4b set the
precedent by deleting the dead `POST /ingest` routes rather than porting them. **Do not touch
`mylibrary/api.py`** — wave 5b deletes the Python route with the rest of the HTTP layer.

- [ ] **Step 5: Confirm nothing else referenced it**

```bash
cd frontend && npx tsc --noEmit
grep -rn "\.health()\|api\.health" . --include=*.ts --include=*.tsx | grep -v node_modules
```

Expected: `tsc` clean, grep returns nothing.

- [ ] **Step 6: Gates**

```bash
cd frontend
npm run test:server
npm test -- --runInBand
npm run type-check
npx eslint lib/backend.ts lib/api.ts lib/__tests__/backend.test.ts
npx prettier --check lib/backend.ts lib/api.ts lib/__tests__/backend.test.ts
```

Driving session: `.venv/bin/pytest -p no:warnings` → 360 passed.

- [ ] **Step 7: Report the final suite counts**

State the vitest file/test totals and the jest total. Compare against Task 0's baseline of
73 files / 509 tests and 39 jest tests, and account for the difference.

---

## Task 10: Live verification against the real Supabase project

**Owner: Chase, or Claude driving the browser. Never accepted from a model's self-report.**
**Codex must not be dispatched for this task.**

This is the task that would have caught wave 4d's two defects. Tests are what let those ship.

### Why the usual rig cannot do this

Every prior wave's live verification used a throwaway Postgres with `SUPABASE_*` forced to `""`.
That puts the app in local single-user mode, where `is_admin()` returns `True` unconditionally and
no GoTrue call is ever made. **It structurally cannot exercise the admin surface.** Hence the real
project, with guardrails.

- [ ] **Step 1: Preconditions**

- `SUPABASE_SERVICE_ROLE_KEY` present in the environment used for this run, and in Vercel
  **Production only** — never Preview, never Development.
- Confirm the throwaway address for this run is exactly `chasecmalcom+wave5a@gmail.com`.

- [ ] **Step 2: Snapshot before anything destructive**

Record the current roster and GoTrue user list to a scratch file outside the repo. Do this first;
it is the only way to prove afterwards that nothing else changed.

```sql
select id, email, status, supabase_user_id, created_at, revoked_at from invites order by id;
```

- [ ] **Step 3: Invite through the real UI**

`/admin` → Invite form → `chasecmalcom+wave5a@gmail.com`. Expect a 201 and a new roster row.
Confirm the invite email actually arrives. Confirm the link's `redirect_to` points at
`/auth/callback` and not the project's dashboard Site URL.

Compare the response body against Python's for the same shape — invite one *other* throwaway
address (`chasecmalcom+wave5a-py@gmail.com`) with the backend switcher forced to `python` from the
System tab, and diff the two 201 bodies field by field.

- [ ] **Step 4: Give the invited user something to lose**

Sign in as the invited user (or insert directly) so it owns at least one book. A revoke that purges
nothing proves nothing about the purge.

- [ ] **Step 5: Revoke — the only irreversible step**

**Before issuing the revoke, assert the target row's email is exactly
`chasecmalcom+wave5a@gmail.com`.** Read it back from the roster by `supabase_user_id` and compare
the string. If it does not match, stop.

Then revoke through the UI. Confirm:
- the row reads `status='revoked'` with a non-null `revoked_at`
- the user's books, enrichment, profile, settings and key are gone
- the GoTrue user no longer exists
- clicking revoke a second time is a clean no-op rather than a 502 from a 404'd GoTrue delete

- [ ] **Step 6: Backfill**

Run backfill. On a fully reconciled roster it must report `added: 0`. Then delete one invite row
directly (leaving the GoTrue user in place), re-run, and confirm it reports `added: 1` and
recreates the row. Non-destructive in both directions.

- [ ] **Step 7: Confirm the snapshot is otherwise unchanged**

Re-run Step 2's query and diff against the snapshot. The only differences may be the throwaway
rows. **Any change to a real user's row is a stop-and-report.**

- [ ] **Step 8: Record the result**

Add a `## Verification Record — <date>` section to this file with the exact commands and their
output. A failure is the finding; report it rather than retrying until it passes. If any step is
skipped, say so explicitly under a "Not verified" heading — wave 4d's record did this and it was
the most useful part of it.

---

## Done when

- [ ] All seven `/admin/*` routes serve from Node and are flipped in `backend.ts`.
- [ ] `parity-admin-reads`, `parity-admin-lists`, `parity-writes-admin` and `supabase-admin` suites
      pass, replaying fixtures recorded from Python.
- [ ] No checked-in fixture contains an email address outside `@example.com`.
- [ ] `WRITTEN_TABLES` covers Node's full write surface, every drift it found is listed in the
      handoff, and the widened guard was seen to fail before being trusted.
- [ ] `revokeUser` is non-transactional, and a test proves a purge failure leaves the row revoked
      and a retry skips the GoTrue delete.
- [ ] The dead `api.health()` method is gone; `mylibrary/` is unmodified except the recorder.
- [ ] All five Node gates green plus pytest 360; live verification recorded, including anything
      skipped.

## Explicitly out of scope

- Python cutover, `api.py` deletion, `worker.py` deletion, Railway teardown, switcher removal —
  wave 5b.
- Porting `GET /health`. Decided against; see Task 9 Step 4.
- The ShelfSprite rename, still deferred to the cutover.
- Redis, arq, QStash, queue ports, cross-user catalog rate coordination.
- Wave 4c-2's outstanding deployment items, which are Chase's and unchanged: apply `0019` in the
  same release window as the switcher flip, supply `CRON_SECRET`, confirm Fluid compute and the
  ~300s ceiling, confirm the Hobby cron cadence with `vercel crons ls`.
- Importing a genuine large Goodreads export (carried from wave 4d, still open).
