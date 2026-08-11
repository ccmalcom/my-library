# Node Backend Wave 4a — Purge Routes Implementation Plan

> **For agentic workers:** REQUIRED EXECUTION PATH: follow the `CLAUDE.md:114-148` Claude / Codex split. Claude owns planning and judgement; send each implementation task verbatim to `/codex:rescue --background <task text>`, review the resulting diff, and let Chase commit and merge by hand. Enable the review gate at the start of execution. Task 0 is a human-operated production gate, not part of this migration.

**Goal:** Port the three destructive purge endpoints — `DELETE /library`, `DELETE /profile`, and `DELETE /account` — from FastAPI to authenticated Next.js route handlers while reproducing Python's exact counts, delete ordering, transaction boundaries, durability quirks, and tenant isolation.

**Architecture:** Put the composable delete primitives in one server-only `purge.ts`, accepting a Drizzle transaction exactly where wave 3's convention puts the transaction wrapper: the public route handler calls `db.transaction(...)` once, and every helper uses only that `tx`. `deleteProfileRows` removes derived profile rows; `deleteLibraryRows` first resolves the authenticated user's book IDs, deletes their enrichments, then deletes their books. The three route handlers compose those helpers without nesting transactions. PGlite route tests seed two tenants and assert both what disappears and what deliberately survives.

**Tech Stack:** Next.js 15 route handlers, drizzle-orm over postgres-js, vitest + PGlite, Jest backend-switcher tests, pytest for the Python source of truth.

---

## Global Constraints

These apply to **every** task. Read them before starting any task.

1. **Task 0 is a hard production gate.** Commit `2c231f8` fixes an existing production `POST /profile` 500 and exists only on `feat/node-backend`. Chase must cherry-pick it onto `main`, push/deploy it, and prove `main` contains both the one-line guard and regression test. **No wave 4a implementation task begins until Task 0 passes.** Task 0 is not part of the purge migration and the implementing agent must not perform it.
2. **Wave 4a is purge only.** This plan ports only `DELETE /library`, `DELETE /profile`, and `DELETE /account`. Ingest/import/export are wave 4b; enrichment jobs are wave 4c. Do not create, edit, flip, test, or opportunistically refactor any of those routes here.
3. **Python is the specification.** `mylibrary/purge.py:1-166`, `tests/test_purge.py:1-124`, and FastAPI's thin wrappers at `mylibrary/api.py:807-822` are authoritative. Reproduce quirks; do not repair them in Node.
4. **One purge request, one transaction.** Each route opens exactly one `db.transaction(async (tx) => ...)`; all reads and deletes for that purge occur through `tx`. Helpers accept the transaction and never call `getDb()`, never open their own transaction, and never use the outer `db` while a transaction is open (`frontend/lib/server/db.ts`, `max: 1`).
5. **Enrichments before books is load-bearing.** Bulk deletes do not run ORM cascades, and `enrichment.book_id` is an FK (`frontend/lib/server/schema.ts:128-151`). Resolve only the current user's book IDs, delete `enrichment` rows for those IDs, then delete the user's `books`. Never reverse or parallelize these statements.
6. **Every delete is tenant-scoped.** Tables with `user_id` must filter on `ctx.user.userId`. `enrichment` has no `user_id`, so scope it only through the authenticated user's preselected book IDs. Tests must seed a second tenant and prove it remains byte-for-byte intact after each purge route.
7. **Exact response shapes, not supersets.** `/profile` returns only `traits_removed`, `recommendations_removed`, `profile_reset: true`; `/library` returns only `books_removed`, `traits_removed`, `recommendations_removed`, `profile_reset: true`; `/account` returns only the eight count fields named by Python plus `account_deleted: true`. Do not expose counts for `profile_meta`, `reader_archetypes`, or enrichments.
8. **Durability is route-specific.** Tests must assert the rows each route keeps, not merely those it deletes. Mirror the contracts in `tests/test_purge.py:75-82`, `:88-109`, and `:124-140`, extended to cover `reader_archetypes`, `user_directive`, feedback, feedback prompt state, and invites.
9. **No schema migration.** Alembic remains the sole migration authority. All required tables already exist; only extend the PGlite test schema if a table needed by the purge tests is not currently created there.
10. **Switcher rules are method-specific.** `DELETE /profile` needs its own exact rule. The existing exact `POST /profile` and broad `GET/PATCH /profile` rules do not and must not capture DELETE. Add exact DELETE rules for all three purge paths, leaving wave 4b/4c on Python.
11. **Update both switcher behavior and the whole-list snapshot.** `frontend/lib/__tests__/backend.test.ts:76-99` asserts the complete ordered `NODE_DEFAULT_ROUTES` array. Wave 3c left that style of snapshot stale once; this task must edit it alongside the behavior assertions.
12. **Run all test runners.** Final verification is `npm test` (Jest), `npm run test:server` (Vitest), `npm run type-check`, `npm run lint`, and `.venv/bin/pytest`. Wave 3c narrowed verification to Vitest and left Jest failing; passing server tests alone is not completion.
13. Run `npx prettier --write <files touched>` from `frontend/` before handing each task to Chase. Do not run repo-wide formatting. Chase commits and merges by hand; agents must not run `git commit`, cherry-pick, merge, push, or deploy.
14. Do not run destructive live verification against shared dev or production data. Automated destructive tests use PGlite. Live checks use a dedicated disposable account seeded expressly for this verification, and require Chase's explicit confirmation before `DELETE /account`.

---

## Verified Facts

Every claim below is grounded in the checked-in source and the wave-4 read-only inventory dated 2026-08-10. Treat these as fixed inputs.

| # | Fact | Evidence |
|---|---|---|
| V1 | All three FastAPI routes are authenticated thin wrappers and return the purge helper result directly. | `mylibrary/api.py:807-822`; inventory §1 and §4 |
| V2 | All three Python public purge operations use one `session_scope()`, so each request is atomic. | `mylibrary/purge.py:93-98`, `:101-114`, `:117-166` |
| V3 | Profile purge deletes `taste_traits`, `recommendations`, `profile_meta`, and `reader_archetypes`, but reports counts only for the first two. | `mylibrary/purge.py:48-74` |
| V4 | Library purge performs the complete profile purge, then deletes enrichments for the user's selected book IDs, then books. | `mylibrary/purge.py:77-90`, `:101-114` |
| V5 | Enrichment-before-books ordering is required because Core-level bulk deletes do not cascade and `enrichment.book_id` is a foreign key. | `mylibrary/purge.py:21-25`; `frontend/lib/server/schema.ts:128-151` |
| V6 | Account purge composes the profile and library purges, then deletes `user_settings`, `taste_signal`, `enrich_jobs`, `usage_events`, and `user_directive`. | `mylibrary/purge.py:117-166` |
| V7 | Exact profile response: `{traits_removed, recommendations_removed, profile_reset: true}`. Exact library response: `{books_removed, traits_removed, recommendations_removed, profile_reset: true}`. | `mylibrary/purge.py:93-114` |
| V8 | Exact account response: `{books_removed, traits_removed, recommendations_removed, settings_removed, signals_removed, jobs_removed, usage_events_removed, directive_removed, account_deleted: true}`. | `mylibrary/purge.py:152-165` |
| V9 | `clear_profile` keeps books, enrichments, settings, signals, jobs, usage, directive, feedback/prompt state, invites, and auth identity. | inventory §4; `tests/test_purge.py:75-82` |
| V10 | `clear_library` keeps settings (including encrypted Anthropic key), signals, jobs, usage, directive, feedback/prompt state, invites, and auth identity. | inventory §4; `tests/test_purge.py:88-109` |
| V11 | Account purge does not in fact remove every row: feedback, feedback prompt state, invites, and Supabase auth identity survive. | inventory §4; absence from imports/deletes in `mylibrary/purge.py:31-45`, `:117-166` |
| V12 | Python locks multi-tenant isolation by seeding `local` and `other-user`, deleting only `local`, and asserting the other tenant's complete count map survives. | `tests/test_purge.py:124-140` |
| V13 | Drizzle exposes all production tables required by the port, including `readerArchetypes`, `feedback`, `feedbackPromptState`, `invites`, and `userDirective`. | `frontend/lib/server/schema.ts:19-253` |
| V14 | Auto mode currently leaves `DELETE /library`, `DELETE /account`, and `DELETE /profile` on Python. The list snapshot currently ends without purge rules. | `frontend/lib/__tests__/backend.test.ts:45-50`, `:76-99`, `:128-130` |

### Python quirks to reproduce, not fix

- **Account deletion is app-data-only.** Despite `delete_account()` claiming the user owns “no rows anywhere” (`mylibrary/purge.py:117-121`), it does **not** delete the Supabase authentication identity, `feedback`, `feedback_prompt_state`, or `invites`. Leave them intact and assert that explicitly.
- `profile_meta` and `reader_archetypes` are deleted but their counts are discarded. Enrichments are deleted but their count is also discarded. Do not add helpful-looking response fields.
- Profile rows are deleted before library rows (`mylibrary/purge.py:107-109`, `:124-126`). Preserve this statement order even though recommendations have no book FK.
- Empty purges succeed with HTTP 200 and zero counts; there is no 404 and no confirmation body.
- Invites are not fundamentally tenant-owned in the same way as purge tables; the purge implementation never queries them at all. Do not invent a `supabase_user_id` cleanup.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `frontend/lib/server/purge.ts` | Transaction-only composable purge primitives and exact result types |
| `frontend/app/api/library/route.ts` | Authenticated `DELETE /api/library`; one transaction |
| `frontend/app/api/account/route.ts` | Authenticated `DELETE /api/account`; highest-blast-radius composition in one transaction |
| `frontend/lib/server/__tests__/purge-routes.test.ts` | PGlite route contract, durability, ordering/atomicity, empty-state, and tenant-isolation tests |

**Modified files**

| File | Change |
|---|---|
| `frontend/lib/server/db.ts` | Export a new `DbTx` type so purge helpers can share one transaction (see Task 1 Step 5) |
| `frontend/app/api/profile/route.ts` | Add `DELETE /api/profile` alongside existing GET/POST |
| `frontend/lib/server/__tests__/helpers/pglite.ts` | Create/seed any purge-contract tables absent from the test database |
| `frontend/lib/backend.ts` | Add exact method-specific DELETE rules for `/library`, `/profile`, `/account`; update wave comment |
| `frontend/lib/__tests__/backend.test.ts` | Flip behavior assertions and update the complete ordered route-list snapshot |
| `CLAUDE.md` | Mark wave 4a purge routes shipped; retain 4b/4c boundary |

**Dependency order:** Task 0 (human hotfix/deploy gate) → Task 1 (shared primitives + test fixture) → Task 2 (profile/library routes) → Task 3 (account route, isolated because of blast radius) → Task 4 (switcher + docs) → Task 5 (complete verification).

---

## Task 0: Cherry-pick and deploy the production `POST /profile` hotfix — HARD GATE

This is **not** part of wave 4a's migration. It is overdue production remediation from wave 3b. Chase performs every command and deployment action by hand. An agent may read the output, but must not cherry-pick, push, merge, or deploy.

**Files already contained in commit `2c231f8`:**
- Modify: `mylibrary/profile.py:547` — add `if "id" in b` to the `valid_ids` comprehension
- Modify: `tests/test_profile_feedback.py` — regression for a rejected recommendation tier entry carrying a note but no book ID

- [ ] **Step 1: Start from a clean, current local `main`**

```bash
cd /home/chase/Documents/Code/my-library
git status --short
git switch main
git pull --ff-only origin main
```

If `git status --short` is non-empty, stop and preserve/stash the work intentionally before switching. Do not discard it.

- [ ] **Step 2: Confirm the commit exists and main does not already contain it**

```bash
cd /home/chase/Documents/Code/my-library
git show --stat --oneline 2c231f8
git merge-base --is-ancestor 2c231f8 main; test $? -eq 1
```

Expected: the first command names `fix(profile): skip non-book tier entries when building valid_ids`; the second exits 0 because the inner ancestry check exits 1. If it is already an ancestor, do not cherry-pick it twice; proceed to Step 4.

- [ ] **Step 3: Chase cherry-picks the exact fix and runs its regression test**

```bash
cd /home/chase/Documents/Code/my-library
git cherry-pick 2c231f8
.venv/bin/pytest tests/test_profile_feedback.py -q
```

Expected: cherry-pick succeeds and the regression file passes.

- [ ] **Step 4: Produce proof that the fix is on local `main`**

```bash
cd /home/chase/Documents/Code/my-library
git branch --show-current
git show main:mylibrary/profile.py | sed -n '542,551p'
git log -1 --oneline main
git diff --exit-code main -- mylibrary/profile.py tests/test_profile_feedback.py
```

Expected: branch is `main`; the displayed comprehension contains `if "id" in b`; the log names the hotfix; diff exits 0.

- [ ] **Step 5: Chase pushes `main`, gets the normal production deployment green, and proves remote main contains the fix**

```bash
cd /home/chase/Documents/Code/my-library
git push origin main
git fetch origin main
git show origin/main:mylibrary/profile.py | sed -n '542,551p'
git merge-base --is-ancestor HEAD origin/main
```

Expected: the remote file contains `if "id" in b`, and the final command exits 0. In the normal deployment UI, wait for the deployment sourced from this pushed commit to report healthy. Then exercise `POST /profile` with the production regression case (a rejected recommendation carrying a note) and record HTTP 200. Do not print credentials or tokens.

**HARD STOP:** do not begin Task 1 until the remote-source proof, healthy deployment, and production HTTP 200 are all recorded.

---

## Task 1: Add transaction-only purge primitives and a complete PGlite fixture

**Files:**
- Create: `frontend/lib/server/purge.ts`
- Modify: `frontend/lib/server/__tests__/helpers/pglite.ts`
- Create: `frontend/lib/server/__tests__/purge-routes.test.ts` (initial helper-level coverage; route sections are added in Tasks 2-3)

**Interfaces:**
- Consumes: `DbTx`, `schema` (`frontend/lib/server/db.ts`), Drizzle `eq`, `inArray`.
- Produces: `deleteProfileRows(tx, userId)`, `deleteLibraryRows(tx, userId)`, `deleteAccountRows(tx, userId)` and exact result types. None opens a transaction.

- [ ] **Step 1: Extend PGlite only for missing purge-contract tables**

Inspect the remainder of `makeTestDb()` first. Add only absent tables using production column names and enough non-null/default columns to seed them. At minimum the purge tests need `taste_signal`, `enrich_jobs`, `reader_archetypes`, `invites`, `usage_events`, `feedback`, `feedback_prompt_state`, and `user_directive`. Example definitions (do not duplicate tables already present):

```sql
create table feedback (
  id serial primary key,
  user_id text not null default 'local',
  category text not null,
  body text not null,
  created_at timestamp not null default current_timestamp
);
create table feedback_prompt_state (
  id serial primary key,
  user_id text not null default 'local',
  trigger text not null,
  run_id text not null default '',
  status text not null,
  updated_at timestamp not null default current_timestamp,
  unique (user_id, trigger, run_id)
);
create table invites (
  id serial primary key,
  email text not null,
  invited_by text not null,
  supabase_user_id text,
  status text not null default 'pending',
  created_at timestamp default current_timestamp
);
```

Keep the PGlite `enrichment(book_id ... references books(id))` FK intact: the test must fail if delete ordering regresses.

- [ ] **Step 2: Write a two-tenant seed/count harness before implementation**

Start `purge-routes.test.ts` with reusable helpers. Seed two books and enrichments plus one row in every relevant user-scoped table. Seed feedback/prompt-state for both users and an invite whose `supabase_user_id` is the purged user.

```ts
async function seedUser(db: Db, userId: string) {
  const inserted = await db.insert(schema.books).values([
    { userId, title: 'Dune', author: 'Frank Herbert', goodreadsRating: 5, source: 'test' },
    { userId, title: 'Hyperion', author: 'Dan Simmons', goodreadsRating: 4, source: 'test' },
  ]).returning({ id: schema.books.id });
  await db.insert(schema.enrichment).values(inserted.map(({ id }, i) => ({
    bookId: id,
    resolutionConfidence: 1,
    resolvedSource: 'test',
    resolvedId: `${userId}-${i}`,
  })));
  await db.insert(schema.tasteTraits).values({
    userId, claim: 'rewards big ideas', polarity: 'reward', exhibits: [], contrasts: [],
    inferenceConfidence: 1, status: 'active', userWeight: 1,
  });
  await db.insert(schema.recommendations).values({
    userId, runId: 'run-1', rank: 1, title: 'Foundation', score: 0.9, status: 'active',
  });
  await db.insert(schema.profileMeta).values({ userId, lastProfileKind: 'full' });
  await db.insert(schema.readerArchetypes).values({
    userId, code: 'world-builder', archetypeName: 'World Builder',
    archetypeTagline: 'Reads for immersive worlds', axisLens: 0.8, axisEngine: 0.7,
    axisRange: 0.6, axisResonance: 0.9, derivedAt: '2026-08-10 12:00:00',
  });
  await db.insert(schema.userSettings).values({
    userId, anthropicApiKeyEncrypted: 'enc-blob',
  });
  await db.insert(schema.tasteSignal).values({
    userId, direction: 'more', targetKind: 'book', targetBookId: inserted[0].id,
  });
  await db.insert(schema.enrichJobs).values({
    userId, jobId: `job-${userId}`, status: 'done',
  });
  await db.insert(schema.usageEvents).values({
    userId, model: 'claude-sonnet-5', operation: 'recommend_rerank',
  });
  await db.insert(schema.userDirective).values({
    userId, nlText: 'Prefer ambitious science fiction', constraints: {},
  });
  await db.insert(schema.feedback).values({
    userId, category: 'general', body: 'Useful recommendations',
  });
  await db.insert(schema.feedbackPromptState).values({
    userId, trigger: 'recommendations', runId: 'run-1', status: 'shown',
  });
  await db.insert(schema.invites).values({
    email: `${userId}@example.com`, invitedBy: 'admin', supabaseUserId: userId,
  });
}

async function countFor(db: Db, userId: string) {
  const [books, enrichment, tasteTraits, recommendations, profileMeta,
    readerArchetypes, userSettings, tasteSignal, enrichJobs, usageEvents,
    userDirective, feedback, feedbackPromptState, invites] = await Promise.all([
    db.select({ id: schema.books.id }).from(schema.books)
      .where(eq(schema.books.userId, userId)),
    db.select({ id: schema.enrichment.id }).from(schema.enrichment)
      .innerJoin(schema.books, eq(schema.enrichment.bookId, schema.books.id))
      .where(eq(schema.books.userId, userId)),
    db.select({ id: schema.tasteTraits.id }).from(schema.tasteTraits)
      .where(eq(schema.tasteTraits.userId, userId)),
    db.select({ id: schema.recommendations.id }).from(schema.recommendations)
      .where(eq(schema.recommendations.userId, userId)),
    db.select({ id: schema.profileMeta.id }).from(schema.profileMeta)
      .where(eq(schema.profileMeta.userId, userId)),
    db.select({ id: schema.readerArchetypes.id }).from(schema.readerArchetypes)
      .where(eq(schema.readerArchetypes.userId, userId)),
    db.select({ id: schema.userSettings.id }).from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId)),
    db.select({ id: schema.tasteSignal.id }).from(schema.tasteSignal)
      .where(eq(schema.tasteSignal.userId, userId)),
    db.select({ id: schema.enrichJobs.id }).from(schema.enrichJobs)
      .where(eq(schema.enrichJobs.userId, userId)),
    db.select({ id: schema.usageEvents.id }).from(schema.usageEvents)
      .where(eq(schema.usageEvents.userId, userId)),
    db.select({ id: schema.userDirective.id }).from(schema.userDirective)
      .where(eq(schema.userDirective.userId, userId)),
    db.select({ id: schema.feedback.id }).from(schema.feedback)
      .where(eq(schema.feedback.userId, userId)),
    db.select({ id: schema.feedbackPromptState.id }).from(schema.feedbackPromptState)
      .where(eq(schema.feedbackPromptState.userId, userId)),
    db.select({ id: schema.invites.id }).from(schema.invites)
      .where(eq(schema.invites.supabaseUserId, userId)),
  ]);
  return {
    books: books.length,
    enrichment: enrichment.length,
    tasteTraits: tasteTraits.length,
    recommendations: recommendations.length,
    profileMeta: profileMeta.length,
    readerArchetypes: readerArchetypes.length,
    userSettings: userSettings.length,
    tasteSignal: tasteSignal.length,
    enrichJobs: enrichJobs.length,
    usageEvents: usageEvents.length,
    userDirective: userDirective.length,
    feedback: feedback.length,
    feedbackPromptState: feedbackPromptState.length,
    invites: invites.length,
  };
}

async function snapshotFor(db: Db, userId: string) {
  return countFor(db, userId);
}
```

Add `snapshotFor(db, userId)` returning the full count map. Tests use it to assert that `other-user` is unchanged, not merely that its books remain.

- [ ] **Step 3: Write failing helper tests for exact counts, keeps, and FK ordering**

```ts
describe('purge primitives', () => {
  test('profile removes only derived profile rows and reports only two counts', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedUser(db, 'local');
      const result = await db.transaction((tx) => deleteProfileRows(tx, 'local'));
      expect(result).toEqual({ traits_removed: 1, recommendations_removed: 1 });
      expect(await countFor(db, 'local')).toEqual({
        books: 2, enrichment: 2, tasteTraits: 0, recommendations: 0,
        profileMeta: 0, readerArchetypes: 0, userSettings: 1, tasteSignal: 1,
        enrichJobs: 1, usageEvents: 1, userDirective: 1, feedback: 1,
        feedbackPromptState: 1, invites: 1,
      });
    } finally {
      await close();
    }
  });

  test('library deletes enrichments before books and keeps durable rows', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedUser(db, 'local');
      const result = await db.transaction(async (tx) => {
        const profile = await deleteProfileRows(tx, 'local');
        const books_removed = await deleteLibraryRows(tx, 'local');
        return { books_removed, ...profile, profile_reset: true as const };
      });
      expect(result).toEqual({
        books_removed: 2, traits_removed: 1, recommendations_removed: 1,
        profile_reset: true,
      });
      expect(await countFor(db, 'local')).toEqual({
        books: 0, enrichment: 0, tasteTraits: 0, recommendations: 0,
        profileMeta: 0, readerArchetypes: 0, userSettings: 1, tasteSignal: 1,
        enrichJobs: 1, usageEvents: 1, userDirective: 1, feedback: 1,
        feedbackPromptState: 1, invites: 1,
      });
    } finally {
      await close();
    }
  });

  test('account keeps feedback, prompt state, and invite despite the Python docstring', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedUser(db, 'local');
      const result = await db.transaction((tx) => deleteAccountRows(tx, 'local'));
      expect(result).toEqual({
        books_removed: 2, traits_removed: 1, recommendations_removed: 1,
        settings_removed: 1, signals_removed: 1, jobs_removed: 1,
        usage_events_removed: 1, directive_removed: 1, account_deleted: true,
      });
      expect(await countFor(db, 'local')).toEqual({
        books: 0, enrichment: 0, tasteTraits: 0, recommendations: 0,
        profileMeta: 0, readerArchetypes: 0, userSettings: 0, tasteSignal: 0,
        enrichJobs: 0, usageEvents: 0, userDirective: 0, feedback: 1,
        feedbackPromptState: 1, invites: 1,
      });
    } finally {
      await close();
    }
  });

  test.each(['profile', 'library', 'account'])('%s purge leaves the other tenant unchanged', async (kind) => {
    const { db, close } = await makeTestDb();
    try {
      await seedUser(db, 'local');
      await seedUser(db, 'other-user');
      const before = await snapshotFor(db, 'other-user');
      await db.transaction(async (tx) => {
        if (kind === 'profile') await deleteProfileRows(tx, 'local');
        if (kind === 'library') {
          await deleteProfileRows(tx, 'local');
          await deleteLibraryRows(tx, 'local');
        }
        if (kind === 'account') await deleteAccountRows(tx, 'local');
      });
      expect(await snapshotFor(db, 'other-user')).toEqual(before);
    } finally {
      await close();
    }
  });

  test('an empty account purge returns every count as zero and succeeds', async () => {
    const { db, close } = await makeTestDb();
    try {
      const result = await db.transaction((tx) => deleteAccountRows(tx, 'local'));
      expect(result).toEqual({
        books_removed: 0, traits_removed: 0, recommendations_removed: 0,
        settings_removed: 0, signals_removed: 0, jobs_removed: 0,
        usage_events_removed: 0, directive_removed: 0, account_deleted: true,
      });
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 4: Run the focused test and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/purge-routes.test.ts
```

Expected: FAIL because `../purge` does not exist.

- [ ] **Step 5: Implement profile and library primitives with sequential, user-scoped deletes**

```ts
// frontend/lib/server/purge.ts
import { eq, inArray } from 'drizzle-orm';
import { schema, type DbTx } from './db';

export type ProfilePurgeResult = {
  traits_removed: number;
  recommendations_removed: number;
};

export async function deleteProfileRows(tx: DbTx, userId: string): Promise<ProfilePurgeResult> {
  const traits = await tx.delete(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId)).returning({ id: schema.tasteTraits.id });
  const recs = await tx.delete(schema.recommendations)
    .where(eq(schema.recommendations.userId, userId)).returning({ id: schema.recommendations.id });
  await tx.delete(schema.profileMeta).where(eq(schema.profileMeta.userId, userId));
  await tx.delete(schema.readerArchetypes).where(eq(schema.readerArchetypes.userId, userId));
  return { traits_removed: traits.length, recommendations_removed: recs.length };
}

export async function deleteLibraryRows(tx: DbTx, userId: string): Promise<number> {
  const owned = await tx.select({ id: schema.books.id }).from(schema.books)
    .where(eq(schema.books.userId, userId));
  const bookIds = owned.map(({ id }) => id);
  // LOAD-BEARING: Core bulk deletes do not cascade; enrichment.book_id is an FK.
  if (bookIds.length) {
    await tx.delete(schema.enrichment).where(inArray(schema.enrichment.bookId, bookIds));
  }
  const books = await tx.delete(schema.books)
    .where(eq(schema.books.userId, userId)).returning({ id: schema.books.id });
  return books.length;
}
```

**Corrected 2026-08-10 during plan review — `DbTx` does not exist yet.** `frontend/lib/server/db.ts`
exports only `Db` (`db.ts:13`), and every existing caller imports `{ schema, type Db } from './db'`.
The repo's established pattern is `db.transaction(async (tx) => { ... })` with `tx` inferred inline
(`profileBuild.ts:264`, `archetypeDerive.ts:246`, `recommendRun.ts:140`, `revealLines.ts:203`,
`app/api/feedback/route.ts:23`) — no helper currently accepts a transaction as a parameter, so no
such type was ever needed. Wave 4a is the first case that genuinely requires one, because
`deleteAccountRows` must compose `deleteProfileRows` and `deleteLibraryRows` inside a *single*
transaction. Add the type to `db.ts` as its first step:

```ts
// frontend/lib/server/db.ts — add alongside the existing `Db` export at :13
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
```

Derive it from `Db` rather than importing a Drizzle internal, so it tracks the schema
automatically. Do not substitute `any`.

- [ ] **Step 6: Implement account composition without a nested transaction**

```ts
export async function deleteAccountRows(tx: DbTx, userId: string) {
  const profile = await deleteProfileRows(tx, userId);
  const books_removed = await deleteLibraryRows(tx, userId);
  const settings = await tx.delete(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId)).returning({ id: schema.userSettings.id });
  const signals = await tx.delete(schema.tasteSignal)
    .where(eq(schema.tasteSignal.userId, userId)).returning({ id: schema.tasteSignal.id });
  const jobs = await tx.delete(schema.enrichJobs)
    .where(eq(schema.enrichJobs.userId, userId)).returning({ id: schema.enrichJobs.id });
  const usage = await tx.delete(schema.usageEvents)
    .where(eq(schema.usageEvents.userId, userId)).returning({ id: schema.usageEvents.id });
  const directive = await tx.delete(schema.userDirective)
    .where(eq(schema.userDirective.userId, userId)).returning({ id: schema.userDirective.id });
  return {
    books_removed,
    ...profile,
    settings_removed: settings.length,
    signals_removed: signals.length,
    jobs_removed: jobs.length,
    usage_events_removed: usage.length,
    directive_removed: directive.length,
    account_deleted: true as const,
  };
}
```

There must be no delete against `feedback`, `feedbackPromptState`, or `invites`.

- [ ] **Step 7: Run and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/purge-routes.test.ts
npx prettier --write lib/server/purge.ts lib/server/__tests__/helpers/pglite.ts lib/server/__tests__/purge-routes.test.ts
```

Expected: helper tests PASS. Hand the diff to Chase for review/commit; do not commit it yourself.

---

## Task 2: Add `DELETE /profile` and `DELETE /library`

**Files:**
- Modify: `frontend/app/api/profile/route.ts`
- Create: `frontend/app/api/library/route.ts`
- Modify: `frontend/lib/server/__tests__/purge-routes.test.ts`

**Interfaces:**
- Consumes: `withApi`, `getDb`, `deleteProfileRows`, `deleteLibraryRows`.
- Produces: exact authenticated JSON contracts for the two lower-blast-radius purge routes.

- [ ] **Step 1: Add route-level failing tests through the exported handlers**

Import `DELETE as deleteProfile` and `DELETE as deleteLibrary`, install the PGlite DB with `_setDbForTests`, and call real `Request` objects.

```ts
test('DELETE /api/profile returns exact counts and keeps the library + durable state', async () => {
  const otherBefore = await snapshotFor(db, 'other-user');
  const res = await deleteProfile(new Request('http://test/api/profile', { method: 'DELETE' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    traits_removed: 1,
    recommendations_removed: 1,
    profile_reset: true,
  });
  expect(await countFor(db, 'local')).toEqual({
    books: 2, enrichment: 2, tasteTraits: 0, recommendations: 0,
    profileMeta: 0, readerArchetypes: 0, userSettings: 1, tasteSignal: 1,
    enrichJobs: 1, usageEvents: 1, userDirective: 1, feedback: 1,
    feedbackPromptState: 1, invites: 1,
  });
  expect(await snapshotFor(db, 'other-user')).toEqual(otherBefore);
});

test('DELETE /api/library returns exact counts, deletes enrichment before books, and keeps durable state', async () => {
  const otherBefore = await snapshotFor(db, 'other-user');
  const res = await deleteLibrary(new Request('http://test/api/library', { method: 'DELETE' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    books_removed: 2,
    traits_removed: 1,
    recommendations_removed: 1,
    profile_reset: true,
  });
  expect(await countFor(db, 'local')).toEqual({
    books: 0, enrichment: 0, tasteTraits: 0, recommendations: 0,
    profileMeta: 0, readerArchetypes: 0, userSettings: 1, tasteSignal: 1,
    enrichJobs: 1, usageEvents: 1, userDirective: 1, feedback: 1,
    feedbackPromptState: 1, invites: 1,
  });
  expect(await snapshotFor(db, 'other-user')).toEqual(otherBefore);
});
```

For both handlers, seed `other-user`, capture its full snapshot, and assert exact equality after the request. Also test an empty database returns zeros and HTTP 200.

- [ ] **Step 2: Run and watch the route tests fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/purge-routes.test.ts
```

Expected: missing `/library` module and missing profile DELETE export.

- [ ] **Step 3: Add `DELETE` to the existing profile route**

Append without changing existing GET/POST behavior:

```ts
export const DELETE = withApi('/api/profile', async (_req, ctx) => {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const removed = await deleteProfileRows(tx, ctx.user.userId);
    return { ...removed, profile_reset: true as const };
  });
  ctx.timer.mark('db');
  return Response.json(result);
});
```

The transaction wrapper belongs here, not inside `deleteProfileRows`.

- [ ] **Step 4: Create the library route with one transaction**

```ts
// frontend/app/api/library/route.ts
import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { deleteLibraryRows, deleteProfileRows } from '@/lib/server/purge';

export const DELETE = withApi('/api/library', async (_req, ctx) => {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Python order: derived profile first, then enrichment-before-books.
    const profile = await deleteProfileRows(tx, ctx.user.userId);
    const books_removed = await deleteLibraryRows(tx, ctx.user.userId);
    return { books_removed, ...profile, profile_reset: true as const };
  });
  ctx.timer.mark('db');
  return Response.json(result);
});
```

- [ ] **Step 5: Prove atomic rollback rather than only successful deletion**

Add a test seam only if necessary to induce an error after profile deletion and before book deletion. Prefer a transaction-level test that deliberately throws between the two helper calls:

```ts
await expect(db.transaction(async (tx) => {
  await deleteProfileRows(tx, 'local');
  throw new Error('rollback probe');
})).rejects.toThrow('rollback probe');
expect(await countFor(db, 'local')).toEqual(before);
```

This proves the shared transaction contract without adding production hooks.

- [ ] **Step 6: Run focused tests and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/purge-routes.test.ts
npx prettier --write app/api/profile/route.ts app/api/library/route.ts lib/server/__tests__/purge-routes.test.ts
```

Expected: all purge tests so far PASS. Hand the diff to Chase for review/commit.

---

## Task 3: Add the highest-blast-radius route, `DELETE /account`

`DELETE /account` can remove the encrypted Anthropic key, durable signals, job history, usage history, and directive in one request. Keep its implementation, tests, and live verification separately reviewable.

**Files:**
- Create: `frontend/app/api/account/route.ts`
- Modify: `frontend/lib/server/__tests__/purge-routes.test.ts`

- [ ] **Step 1: Write the exact route-contract and survivor tests first**

```ts
test('DELETE /api/account returns every Python count and the exact success flag', async () => {
  const res = await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    books_removed: 2,
    traits_removed: 1,
    recommendations_removed: 1,
    settings_removed: 1,
    signals_removed: 1,
    jobs_removed: 1,
    usage_events_removed: 1,
    directive_removed: 1,
    account_deleted: true,
  });
});

test('DELETE /api/account deliberately keeps feedback, prompt state, invite, and auth identity', async () => {
  const otherBefore = await snapshotFor(db, 'other-user');
  const res = await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }));
  expect(res.status).toBe(200);
  expect(await countFor(db, 'local')).toEqual({
    books: 0, enrichment: 0, tasteTraits: 0, recommendations: 0,
    profileMeta: 0, readerArchetypes: 0, userSettings: 0, tasteSignal: 0,
    enrichJobs: 0, usageEvents: 0, userDirective: 0, feedback: 1,
    feedbackPromptState: 1, invites: 1,
  });
  expect(await snapshotFor(db, 'other-user')).toEqual(otherBefore);
  // Auth identity is outside this DB; this successful authenticated withApi request,
  // together with the absence of any Supabase admin dependency, proves it was untouched.
});
```

Also add:

- exact zero-count response on repeated deletion;
- complete `other-user` snapshot unchanged;
- invite associated with the deleted user's `supabase_user_id` unchanged;
- no calls or imports for Supabase admin APIs.

- [ ] **Step 2: Run and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/purge-routes.test.ts
```

Expected: missing account route.

- [ ] **Step 3: Implement one wrapper transaction around the complete account purge**

```ts
// frontend/app/api/account/route.ts
import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { deleteAccountRows } from '@/lib/server/purge';

export const DELETE = withApi('/api/account', async (_req, ctx) => {
  const db = getDb();
  const result = await db.transaction((tx) => deleteAccountRows(tx, ctx.user.userId));
  ctx.timer.mark('db');
  return Response.json(result);
});
```

Do not add request parsing, confirmation flags, auth-identity deletion, or a second transaction.

- [ ] **Step 4: Run focused tests, inspect the deletion surface, and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/purge-routes.test.ts
npx prettier --write app/api/account/route.ts lib/server/purge.ts lib/server/__tests__/purge-routes.test.ts
cd /home/chase/Documents/Code/my-library
git diff -- frontend/app/api/account/route.ts frontend/lib/server/purge.ts frontend/lib/server/__tests__/purge-routes.test.ts
```

Review checklist: every deletion is scoped; enrichment uses owned IDs; survivor tables never appear in a delete; one route transaction covers all statements; response has exactly nine keys. Hand to Chase for review/commit.

- [ ] **Step 5: Dedicated live verification on a disposable account**

Only after deployment to the chosen verification environment, create/use a disposable account that has exactly: two enriched books, a built profile, one stored API key setting, one taste signal, one enrich job, one usage event, one directive, feedback, prompt state, and an invite record. Record pre-delete counts without exposing the encrypted key.

In browser DevTools, with backend mode `auto`, issue the app's normal account-deletion action and verify:

```text
DELETE <same-origin>/api/account -> 200
response keys exactly:
books_removed, traits_removed, recommendations_removed, settings_removed,
signals_removed, jobs_removed, usage_events_removed, directive_removed,
account_deleted
```

Before clicking the final destructive confirmation, Chase must explicitly confirm that the account is disposable. Afterward verify the eight reported counts match pre-state; purge-owned rows are zero; feedback, prompt-state, invite, and auth identity still exist; another tenant's sampled counts are unchanged; and re-authentication succeeds as the same Supabase identity. Record evidence. Never perform this step against a real user's account.

---

## Task 4: Flip only the three purge methods and update project state

**Files:**
- Modify: `frontend/lib/backend.ts`
- Modify: `frontend/lib/__tests__/backend.test.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update behavior assertions before the implementation list**

Change the stale wave-4 test so purge routes expect Node, while `/export`, `/import`, and `/enrich/start` remain Python. Replace the old DELETE-profile assertion.

```ts
test('auto: wave-4a purge routes go to Node; wave 4b/4c stay on Python', () => {
  expect(baseFor('/library', 'DELETE')).toBe('/api');
  expect(baseFor('/profile', 'DELETE')).toBe('/api');
  expect(baseFor('/account', 'DELETE')).toBe('/api');
  expect(baseFor('/export', 'GET')).toBe(PY); // wave 4b
  expect(baseFor('/import', 'POST')).toBe(PY); // wave 4b
  expect(baseFor('/enrich/start', 'POST')).toBe(PY); // wave 4c
});

it('uses an exact method-specific rule for DELETE /profile', () => {
  expect(baseFor('/profile', 'DELETE')).toBe('/api');
  expect(baseFor('/profile/status', 'DELETE')).toBe(PY);
  expect(baseFor('/profile/subjects', 'DELETE')).toBe(PY);
});
```

- [ ] **Step 2: Update the whole-list snapshot in the same edit**

Add these entries to the expected `NODE_DEFAULT_ROUTES` array at the same position chosen in production:

```ts
{ prefix: '/library', methods: ['DELETE'], exact: true },
{ prefix: '/profile', methods: ['DELETE'], exact: true },
{ prefix: '/account', methods: ['DELETE'], exact: true },
```

Do not weaken the expected array to `arrayContaining`; its purpose is to catch stale or accidental route flips.

- [ ] **Step 3: Run Jest and confirm the test fails before changing the switcher**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
```

Expected: FAIL because auto mode still routes these deletes to Python and the list is missing entries.

- [ ] **Step 4: Add exact purge rules to `NODE_DEFAULT_ROUTES`**

In `frontend/lib/backend.ts`, update the wave comment and add:

```ts
// Wave 4a: destructive purges. Exact + method-specific so existing profile
// GET/PATCH/POST rules and any future sibling routes cannot broaden the flip.
{ prefix: '/library', methods: ['DELETE'], exact: true },
{ prefix: '/profile', methods: ['DELETE'], exact: true },
{ prefix: '/account', methods: ['DELETE'], exact: true },
```

Ordering is part of the Jest snapshot. Keep wave 4b/4c absent.

- [ ] **Step 5: Update `CLAUDE.md` without collapsing the wave boundary**

At `CLAUDE.md:92-93`, replace “Wave 4 ... is next” with a concise shipped-state paragraph: wave 4a ports the three purge routes, uses one transaction per request, preserves enrichment-before-books FK ordering and Python's survivor quirks; wave 4b ingest/import/export and wave 4c enrichment jobs remain next. Do not rewrite unrelated project history.

- [ ] **Step 6: Run switcher tests and format**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
npx prettier --write lib/backend.ts lib/__tests__/backend.test.ts
```

Expected: Jest PASS, including the complete route-list snapshot. Hand to Chase for review/commit.

---

## Task 5: Full verification and handoff

No narrowed Vitest-only signoff is allowed. Wave 3c demonstrated why: the server suite passed while the Jest suite was stale.

- [ ] **Step 1: Run all four frontend commands, separately, from `frontend/`**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand
npm run test:server
npm run type-check
npm run lint
```

All four must exit 0. `npm test` is Jest (including `backend.test.ts`); `npm run test:server` is the complete Vitest suite. Do not substitute one for the other.

- [ ] **Step 2: Run the complete Python suite from repo root**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/pytest
```

Expected: PASS, including `tests/test_purge.py` and the Task 0 regression in `tests/test_profile_feedback.py`.

- [ ] **Step 3: Verify formatting only on touched frontend files**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --check lib/server/purge.ts lib/server/__tests__/helpers/pglite.ts \
  lib/server/__tests__/purge-routes.test.ts app/api/profile/route.ts \
  app/api/library/route.ts app/api/account/route.ts lib/backend.ts \
  lib/__tests__/backend.test.ts
```

- [ ] **Step 4: Inspect the final migration boundary and deletion surface**

```bash
cd /home/chase/Documents/Code/my-library
git diff --stat
git diff -- frontend/lib/server/purge.ts frontend/app/api/profile/route.ts \
  frontend/app/api/library/route.ts frontend/app/api/account/route.ts \
  frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts
rg -n "delete\(schema\.(feedback|feedbackPromptState|invites)" frontend/lib/server/purge.ts
```

Expected: the final `rg` prints nothing. Confirm no ingest/import/export/enrichment route files changed and no migration was added.

- [ ] **Step 5: Complete live route verification**

On the approved disposable environment/account:

1. `DELETE /profile`: verify same-origin `/api/profile` 200, exact three-field response, books/enrichments and all durable rows remain, other tenant unchanged.
2. Re-seed/build the disposable profile, then `DELETE /library`: verify `/api/library` 200, exact four-field response, books/enrichments/profile rows gone, settings/signals/jobs/usage/directive and survivor rows remain, other tenant unchanged.
3. Re-seed the disposable account completely, obtain Chase's explicit final confirmation, then perform Task 3 Step 5's dedicated `/api/account` verification.
4. Confirm Network shows no purge request to the Python base URL in auto mode. Confirm `/export`, `/import`, and `/enrich/start` still resolve to Python.

- [ ] **Step 6: Chase reviews, commits, merges, and deploys by hand**

The agent reports the exact diff, command results, and live-verification evidence. Chase chooses commit boundaries, commits, merges, and deploys. After deployment, repeat the three switcher/network routing checks; use only disposable data for destructive calls.

---

## Done when

- Task 0's hotfix is on `origin/main`, its deployment is healthy, and the production regression case returns 200 before any wave 4a implementation began.
- `DELETE /profile`, `DELETE /library`, and `DELETE /account` reach same-origin `/api` in auto mode; wave 4b ingest/import/export and wave 4c enrichment remain on Python.
- Each purge uses exactly one route-owned transaction, every delete is tenant-scoped, and enrichments are deleted before books.
- All three responses match Python exactly, including zero-count repeats, `profile_reset: true`, and `account_deleted: true`.
- Route-specific durability assertions pass: profile and library preserve their durable rows; account deliberately preserves auth identity, feedback, feedback prompt state, and invites.
- The complete `NODE_DEFAULT_ROUTES` snapshot is updated and passing.
- `npm test -- --runInBand`, `npm run test:server`, `npm run type-check`, `npm run lint`, `.venv/bin/pytest`, and targeted Prettier check all pass.
- Dedicated disposable-account live verification for `DELETE /account` is recorded, including Chase's pre-delete confirmation and cross-tenant evidence.

---

## Verification record — to be filled in at execution time

### Task 0 production gate

```text
local main proof:
origin/main proof:
deployment URL/status:
POST /profile regression result:
```

### Automated suite

```text
npm test -- --runInBand:
npm run test:server:
npm run type-check:
npm run lint:
.venv/bin/pytest:
npx prettier --check ...:
```

### Live purge verification

```text
environment + disposable account identifier:
DELETE /api/profile response + survivor/tenant evidence:
DELETE /api/library response + survivor/tenant evidence:
Chase confirmation before DELETE /api/account:
DELETE /api/account response + survivor/tenant/auth evidence:
auto-mode Network evidence (Node purge routes; Python wave 4b/4c):
```

### Shipped as

```text
commits:
merge:
deployment:
```
