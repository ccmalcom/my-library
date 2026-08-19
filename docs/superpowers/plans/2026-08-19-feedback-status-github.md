# Feedback Status Tracking + GitHub Issue Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin console's Feedback tab a four-state triage status, one-click GitHub issue creation from a feedback row, and a signature-verified webhook that advances status as the issue is worked.

**Architecture:** Three columns on `feedback` (`status`, `github_issue_number`, `github_issue_url`) back a shared status vocabulary module that both server routes and client components import. Two new admin routes (status PATCH, issue POST) and one public webhook route sit on a single `lib/server/github.ts` that owns every outbound GitHub call and every `GITHUB_*` environment read. The Feedback tab gains a status filter, an inline per-row status select, and a modal that prefills an editable issue title and body.

**Tech Stack:** TypeScript, Next.js App Router route handlers, drizzle-orm + drizzle-kit (Postgres), Zod 4, SWR, Tailwind, Vitest (`lib/server/**`, `app/api/**`), Jest + Testing Library (everything else), `node:crypto` for HMAC.

**Spec:** `docs/superpowers/specs/2026-08-19-feedback-status-github-design.md`

## Global Constraints

- **Never commit.** Chase commits manually. Every task ends by stopping for review with a *suggested* commit message — do not run `git commit` or `git push` unless Chase explicitly asks in that moment.
- **Never read local environment secret files.** Key names only. Verify presence with existence checks, never by printing values.
- **Never apply a migration to a live database.** Generate the SQL, inspect it, hand it to Chase.
- Run every command from `frontend/`.
- Two runners with disjoint ownership: `npm run test:server` (Vitest) owns `lib/server/**` and `app/api/**`; `npm test` (Jest) owns everything else. Running one is not a pass.
- `npm run build` is required — it is the only gate that catches Next segment-config and prerender failures.
- `lib/server/feedbackStatus.ts` must stay **dependency-free**. Client code imports it; adding Zod or any server dependency there grows every affected browser bundle. Same rule as `lib/server/rating.ts`.
- `frontend/proxy.ts` keeps `api` in its matcher's negative lookahead. The webhook route needs **no** proxy change, and the matcher must not be touched.
- Environment fallbacks use `||`, never `??`, so an empty-string value falls through to the default — the rule already recorded for `supabaseAdmin.ts`.
- Status values, verbatim: `open`, `reported`, `in_progress`, `resolved`.
- GitHub env key names, verbatim: `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_IN_PROGRESS_LABEL`.
- Default repo, verbatim: `ccmalcom/shelfsprite`. Default in-progress label, verbatim: `in progress`.
- Symbols, not line numbers. Line references locate a region; find code by `grep -n '<exact code>'`.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `frontend/lib/server/feedbackStatus.ts` | The status vocabulary. Dependency-free; shared by server and client. |
| `frontend/lib/server/github.ts` | Every outbound GitHub call and every `GITHUB_*` env read. |
| `frontend/lib/server/adminFeedback.ts` | The admin feedback wire shape: row serializer + email lookup, shared by all three admin routes. |
| `frontend/app/api/admin/feedback/[id]/route.ts` | `PATCH` status. |
| `frontend/app/api/admin/feedback/[id]/github-issue/route.ts` | `POST` create issue. |
| `frontend/app/api/github/webhook/route.ts` | Public, signature-verified issue-event sink. |
| `frontend/components/admin/FeedbackIssueModal.tsx` | The prefilled, editable issue form. |
| `frontend/lib/server/__tests__/feedback-status.test.ts` | Vocabulary unit tests. |
| `frontend/lib/server/__tests__/github.test.ts` | `createIssue` + signature unit tests. |
| `frontend/lib/server/__tests__/admin-feedback-routes.test.ts` | GET / PATCH / issue-creation route tests. |
| `frontend/lib/server/__tests__/github-webhook-route.test.ts` | Webhook route tests. |
| `frontend/components/admin/__tests__/FeedbackTab.test.tsx` | Filter + status-select + button-visibility tests. |

**Modified:**

| Path | Change |
|---|---|
| `frontend/lib/server/schema.ts` | Three columns on `feedback`. |
| `frontend/drizzle/` | One generated migration. |
| `frontend/lib/server/__tests__/helpers/pglite.ts` | Same three columns on the hand-written `create table feedback`. |
| `frontend/lib/server/__tests__/helpers/testEnv.ts` | Four `GITHUB_*` keys added to `ENV_KEYS`. |
| `frontend/app/api/admin/feedback/route.ts` | Status filter, new item fields, `github_configured`, uses the shared serializer. |
| `frontend/lib/api.ts` | Extended types + two new functions. |
| `frontend/components/admin/FeedbackTab.tsx` | Status filter, badge, inline select, issue link, create button. |
| `docs/hosting.md` | GitHub env keys + webhook setup. |
| `docs/architecture.md` | New server modules in the module map. |

---

## Task 1: Status vocabulary, schema columns, migration

**Files:**
- Create: `frontend/lib/server/feedbackStatus.ts`
- Create: `frontend/lib/server/__tests__/feedback-status.test.ts`
- Modify: `frontend/lib/server/schema.ts` (the `feedback` table, near `appVersion`)
- Modify: `frontend/lib/server/__tests__/helpers/pglite.ts` (the `create table feedback` block)
- Modify: `frontend/lib/server/__tests__/helpers/testEnv.ts` (`ENV_KEYS`)
- Generated: one file under `frontend/drizzle/` plus its `meta/` snapshot

**Interfaces:**
- Consumes: nothing.
- Produces: `FEEDBACK_STATUSES`, `type FeedbackStatus`, `DEFAULT_FEEDBACK_STATUS`, `ACTIVE_FEEDBACK_STATUSES`, `isFeedbackStatus(v: unknown): v is FeedbackStatus`; and the drizzle columns `schema.feedback.status` (`string`), `schema.feedback.githubIssueNumber` (`number | null`), `schema.feedback.githubIssueUrl` (`string | null`).

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/feedback-status.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  ACTIVE_FEEDBACK_STATUSES,
  DEFAULT_FEEDBACK_STATUS,
  FEEDBACK_STATUSES,
  isFeedbackStatus,
} from '../feedbackStatus';
import { schema } from '../db';
import { makeTestDb } from './helpers/pglite';

describe('feedback status vocabulary', () => {
  test('lists the four statuses in triage order', () => {
    expect(FEEDBACK_STATUSES).toEqual(['open', 'reported', 'in_progress', 'resolved']);
  });

  test('defaults to open', () => {
    expect(DEFAULT_FEEDBACK_STATUS).toBe('open');
  });

  test('active statuses are everything except resolved', () => {
    expect(ACTIVE_FEEDBACK_STATUSES).toEqual(['open', 'reported', 'in_progress']);
  });

  test('accepts every known status', () => {
    for (const s of FEEDBACK_STATUSES) expect(isFeedbackStatus(s)).toBe(true);
  });

  test('rejects unknown values, near-misses, and non-strings', () => {
    for (const v of ['', 'Open', 'in progress', 'done', 0, null, undefined, {}]) {
      expect(isFeedbackStatus(v)).toBe(false);
    }
  });
});

describe('feedback status column', () => {
  test('defaults to open and leaves the github columns null', async () => {
    const { db, close } = await makeTestDb();
    try {
      const [row] = await db
        .insert(schema.feedback)
        .values({ userId: 'u1', category: 'bug', body: 'it broke' })
        .returning();
      expect(row!.status).toBe('open');
      expect(row!.githubIssueNumber).toBeNull();
      expect(row!.githubIssueUrl).toBeNull();

      const [updated] = await db
        .update(schema.feedback)
        .set({ status: 'reported', githubIssueNumber: 42, githubIssueUrl: 'https://x/42' })
        .where(eq(schema.feedback.id, row!.id))
        .returning();
      expect(updated!.status).toBe('reported');
      expect(updated!.githubIssueNumber).toBe(42);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- feedback-status`
Expected: FAIL — cannot resolve `../feedbackStatus`.

- [ ] **Step 3: Write the vocabulary module**

Create `frontend/lib/server/feedbackStatus.ts`:

```ts
/**
 * Feedback triage vocabulary.
 *
 * Imported by `components/admin/FeedbackTab.tsx` as well as by route handlers, so
 * this module must stay dependency-free: anything imported here (Zod, drizzle,
 * node builtins) lands in the browser bundle. Same constraint, same reason, as
 * `lib/server/rating.ts`.
 */
export const FEEDBACK_STATUSES = ['open', 'reported', 'in_progress', 'resolved'] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Every row starts here, including rows that predate the column. */
export const DEFAULT_FEEDBACK_STATUS: FeedbackStatus = 'open';

/** What the admin tab's default "Open & active" filter selects. */
export const ACTIVE_FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  'open',
  'reported',
  'in_progress',
];

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Add the columns to the drizzle schema**

In `frontend/lib/server/schema.ts`, inside `export const feedback = pgTable(`, insert three columns immediately after `appVersion` and before `createdAt`:

```ts
    appVersion: varchar('app_version'),
    status: varchar().default('open').notNull(),
    githubIssueNumber: integer('github_issue_number'),
    githubIssueUrl: varchar('github_issue_url'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
```

`integer` and `varchar` are already imported at the top of the file — do not add imports. The header comment says the file is introspection-generated; adding columns by hand here is correct and is how the migration gets generated, but do not reformat anything else in the file.

- [ ] **Step 5: Mirror the columns in the pglite test helper**

`frontend/lib/server/__tests__/helpers/pglite.ts` hand-writes the tables; it does not read `schema.ts`. Find `create table feedback (` and make the block read:

```sql
    create table feedback (
      id serial primary key,
      user_id text not null default 'local',
      category text not null,
      body text not null,
      trigger text,
      run_id text,
      page text,
      app_version text,
      status text not null default 'open',
      github_issue_number integer,
      github_issue_url text,
      created_at timestamp not null default current_timestamp
    );
```

Skipping this makes every test that seeds a feedback row fail with a missing-column error.

- [ ] **Step 6: Add the GitHub keys to the test env allowlist**

In `frontend/lib/server/__tests__/helpers/testEnv.ts`, add four entries to the end of the `ENV_KEYS` array:

```ts
  'GOOGLE_BOOKS_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_REPO',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_IN_PROGRESS_LABEL',
```

Then, inside the `beforeEach` in `setupTestEnv`, delete all four alongside the existing deletions:

```ts
    // A developer with real GitHub credentials exported would otherwise flip
    // `github_configured` and change route behavior under test — the same hazard
    // already documented above for MYLIBRARY_MODEL and GOOGLE_BOOKS_API_KEY.
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_IN_PROGRESS_LABEL;
```

The existing `afterEach` restores everything in `ENV_KEYS`, so no change is needed there.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:server -- feedback-status`
Expected: PASS, 6 tests.

- [ ] **Step 8: Generate the migration and inspect it**

Run: `npm run db:generate`

Then read the newest file in `frontend/drizzle/` (it will be `0003_*.sql`). It must contain exactly three `ALTER TABLE "feedback" ADD COLUMN` statements and nothing else:

```sql
ALTER TABLE "feedback" ADD COLUMN "status" varchar DEFAULT 'open' NOT NULL;
ALTER TABLE "feedback" ADD COLUMN "github_issue_number" integer;
ALTER TABLE "feedback" ADD COLUMN "github_issue_url" varchar;
```

If it contains a `DROP`, a `CREATE TABLE`, or touches any table other than `feedback`, **stop and report** — that means the checked-in snapshot has drifted, and applying it would be destructive. `books` in particular is never dropped or recreated by a migration.

- [ ] **Step 9: Do NOT apply the migration**

`drizzle-kit generate` never reads a live database, so a clean generate proves nothing about production's shape. Applying is Chase's step. Report the generated filename and its SQL, and note that production columns should be confirmed against `information_schema.columns` before and after.

- [ ] **Step 10: Stop for review**

Do not commit. Suggested message for when Chase asks:
`feat(feedback): add status and github issue columns`

---

## Task 2: `lib/server/github.ts`

**Files:**
- Create: `frontend/lib/server/github.ts`
- Create: `frontend/lib/server/__tests__/github.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `githubConfig(): GithubConfig`, `isGithubConfigured(): boolean`, `createIssue(input: { title: string; body: string }): Promise<CreatedIssue>`, `verifyWebhookSignature(rawBody: string, header: string | null): boolean`, `class GitHubError extends Error` with `readonly status?: number`. `GithubConfig = { repo: string; token: string | null; webhookSecret: string | null; inProgressLabel: string }`. `CreatedIssue = { number: number; url: string }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/github.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  GitHubError,
  createIssue,
  githubConfig,
  isGithubConfigured,
  verifyWebhookSignature,
} from '../github';

const saved: Record<string, string | undefined> = {};
const KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_IN_PROGRESS_LABEL'];

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('githubConfig', () => {
  test('falls back to the shelfsprite repo and the default label', () => {
    const cfg = githubConfig();
    expect(cfg.repo).toBe('ccmalcom/shelfsprite');
    expect(cfg.inProgressLabel).toBe('in progress');
    expect(cfg.token).toBeNull();
    expect(cfg.webhookSecret).toBeNull();
  });

  test('an empty string falls through to the default, like supabaseAdmin', () => {
    process.env.GITHUB_REPO = '';
    expect(githubConfig().repo).toBe('ccmalcom/shelfsprite');
  });

  test('reads the environment on every call, not at import time', () => {
    expect(isGithubConfigured()).toBe(false);
    process.env.GITHUB_TOKEN = 'ghp_test';
    expect(isGithubConfigured()).toBe(true);
  });
});

describe('createIssue', () => {
  test('posts to the configured repo with the pinned api version', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    process.env.GITHUB_REPO = 'owner/name';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ number: 7, html_url: 'https://github.com/owner/name/issues/7' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const issue = await createIssue({ title: 'T', body: 'B' });

    expect(issue).toEqual({ number: 7, url: 'https://github.com/owner/name/issues/7' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/owner/name/issues');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer ghp_test');
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(JSON.parse(init.body)).toEqual({ title: 'T', body: 'B' });
  });

  test('throws GitHubError carrying githubs message on a non-2xx', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 })
    );
    await expect(createIssue({ title: 'T', body: 'B' })).rejects.toMatchObject({
      name: 'GitHubError',
      message: 'Validation Failed',
      status: 422,
    });
  });

  test('throws GitHubError when fetch itself rejects', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(createIssue({ title: 'T', body: 'B' })).rejects.toBeInstanceOf(GitHubError);
  });

  test('throws when called without a token', async () => {
    await expect(createIssue({ title: 'T', body: 'B' })).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 's3cret';
  const body = '{"action":"closed"}';
  const good = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  test('accepts a correct digest', () => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    expect(verifyWebhookSignature(body, good)).toBe(true);
  });

  test('rejects a wrong digest, a wrong body, a missing header, and a missing secret', () => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    expect(verifyWebhookSignature(body, `sha256=${'0'.repeat(64)}`)).toBe(false);
    expect(verifyWebhookSignature('{"action":"opened"}', good)).toBe(false);
    expect(verifyWebhookSignature(body, null)).toBe(false);
    expect(verifyWebhookSignature(body, 'garbage')).toBe(false);
    delete process.env.GITHUB_WEBHOOK_SECRET;
    expect(verifyWebhookSignature(body, good)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- github.test`
Expected: FAIL — cannot resolve `../github`.

- [ ] **Step 3: Write the module**

Create `frontend/lib/server/github.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_REPO = 'ccmalcom/shelfsprite';
const DEFAULT_IN_PROGRESS_LABEL = 'in progress';

export class GitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GithubConfig {
  repo: string;
  token: string | null;
  webhookSecret: string | null;
  inProgressLabel: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

/**
 * Read on every call rather than captured in a module-level constant: a constant
 * is frozen at import time and invisible to the per-test environment mutation the
 * `setupTestEnv` pattern relies on. `||` rather than `??` so an empty-string value
 * falls through to the default — the rule already recorded for supabaseAdmin.ts.
 */
export function githubConfig(): GithubConfig {
  return {
    repo: process.env.GITHUB_REPO || DEFAULT_REPO,
    token: process.env.GITHUB_TOKEN || null,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || null,
    inProgressLabel: process.env.GITHUB_IN_PROGRESS_LABEL || DEFAULT_IN_PROGRESS_LABEL,
  };
}

/** `repo` always resolves through its default, so the token is the only real question. */
export function isGithubConfigured(): boolean {
  return githubConfig().token !== null;
}

export async function createIssue(input: { title: string; body: string }): Promise<CreatedIssue> {
  const { repo, token } = githubConfig();
  if (!token) throw new GitHubError('GitHub is not configured');

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: input.title, body: input.body }),
    });
  } catch (err) {
    throw new GitHubError(`GitHub request failed: ${(err as Error).message}`);
  }

  const data = (await res.json().catch(() => null)) as {
    number?: number;
    html_url?: string;
    message?: string;
  } | null;

  if (!res.ok) {
    throw new GitHubError(data?.message || `GitHub returned ${res.status}`, res.status);
  }
  if (typeof data?.number !== 'number' || typeof data.html_url !== 'string') {
    throw new GitHubError('GitHub response is missing the issue number or url', res.status);
  }
  return { number: data.number, url: data.html_url };
}

/**
 * `rawBody` must be the exact bytes GitHub signed. Re-serializing parsed JSON
 * produces a different digest and a permanently failing webhook.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null): boolean {
  const { webhookSecret } = githubConfig();
  if (!webhookSecret || !header) return false;
  const expected = `sha256=${createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  // timingSafeEqual throws on a length mismatch, so lengths are compared first.
  // Length is not a secret; the digest is.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- github.test`
Expected: PASS, 9 tests.

- [ ] **Step 5: Stop for review**

Do not commit. Suggested message: `feat(github): add issue creation and webhook signature verification`

---

## Task 3: Shared serializer + status filter on `GET /api/admin/feedback`

**Files:**
- Create: `frontend/lib/server/adminFeedback.ts`
- Modify: `frontend/app/api/admin/feedback/route.ts`
- Create: `frontend/lib/server/__tests__/admin-feedback-routes.test.ts`

**Interfaces:**
- Consumes: `isFeedbackStatus`, `FeedbackStatus` (Task 1); `isGithubConfigured` (Task 2).
- Produces: `serializeFeedbackRow(row, email): AdminFeedbackItem` and `emailsForUserIds(db, userIds): Promise<Map<string, string>>` from `lib/server/adminFeedback.ts`, plus the extended `GET` wire shape that Tasks 4, 5, and 7 all match.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/admin-feedback-routes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { GET as listFeedback } from '../../../app/api/admin/feedback/route';
import { _setDbForTests, schema, type Db } from '../db';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';

setupTestEnv();

async function seed(db: Db) {
  await db.insert(schema.feedback).values([
    { userId: 'u1', category: 'bug', body: 'crash on import', status: 'open' },
    { userId: 'u1', category: 'idea', body: 'dark mode', status: 'in_progress' },
    { userId: 'u2', category: 'bug', body: 'slow search', status: 'resolved' },
  ]);
  await db
    .insert(schema.invites)
    .values({ email: 'one@example.com', supabaseUserId: 'u1', status: 'active' });
}

function req(qs = ''): Request {
  return new Request(`http://localhost/api/admin/feedback${qs}`);
}

describe('GET /api/admin/feedback', () => {
  test('returns status and github fields on every item', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      const body = await (await listFeedback(req())).json();
      expect(body.total).toBe(3);
      expect(body.items[0]).toMatchObject({
        status: expect.any(String),
        github_issue_number: null,
        github_issue_url: null,
      });
    } finally {
      await close();
    }
  });

  test('filters by a single status', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      const body = await (await listFeedback(req('?status=resolved'))).json();
      expect(body.total).toBe(1);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].body).toBe('slow search');
    } finally {
      await close();
    }
  });

  test('filters by a comma-separated status list', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      const body = await (await listFeedback(req('?status=open,in_progress'))).json();
      expect(body.total).toBe(2);
      expect(body.items.map((i: { status: string }) => i.status).sort()).toEqual([
        'in_progress',
        'open',
      ]);
    } finally {
      await close();
    }
  });

  test('combines the status filter with the category filter', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      const body = await (await listFeedback(req('?status=open,in_progress&category=bug'))).json();
      expect(body.total).toBe(1);
      expect(body.items[0].body).toBe('crash on import');
    } finally {
      await close();
    }
  });

  test('rejects an unknown status with 422', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      expect((await listFeedback(req('?status=done'))).status).toBe(422);
      expect((await listFeedback(req('?status=open,done'))).status).toBe(422);
    } finally {
      await close();
    }
  });

  test('reports github_configured from the environment', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      expect((await (await listFeedback(req())).json()).github_configured).toBe(false);
      process.env.GITHUB_TOKEN = 'ghp_test';
      expect((await (await listFeedback(req())).json()).github_configured).toBe(true);
    } finally {
      await close();
    }
  });

  test('still resolves the submitter email from invites', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      const body = await (await listFeedback(req('?status=open'))).json();
      expect(body.items[0].email).toBe('one@example.com');
    } finally {
      await close();
    }
  });
});
```

If `schema.invites` requires columns beyond `email`, `supabaseUserId`, and `status`, read the table definition in `schema.ts` and supply them — do not weaken the assertion instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- admin-feedback-routes`
Expected: FAIL — items have no `status` field; the `?status=` cases return unfiltered totals.

- [ ] **Step 3: Extract the shared serializer**

Create `frontend/lib/server/adminFeedback.ts`:

```ts
import { inArray } from 'drizzle-orm';
import { schema, type Db } from './db';
import { tsToIso } from './serialize';

type FeedbackRow = typeof schema.feedback.$inferSelect;

/**
 * The admin feedback wire shape. All three admin feedback routes serialize
 * through here so the list, the status PATCH, and the issue POST cannot drift
 * apart — the client splices a single item straight into the cached list.
 */
export interface AdminFeedbackItem {
  id: number;
  user_id: string;
  email: string | null;
  category: string;
  body: string;
  trigger: string | null;
  run_id: string | null;
  page: string | null;
  app_version: string | null;
  status: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  created_at: string;
}

export function serializeFeedbackRow(row: FeedbackRow, email: string | null): AdminFeedbackItem {
  return {
    id: row.id,
    user_id: row.userId,
    email,
    category: row.category,
    body: row.body,
    trigger: row.trigger,
    run_id: row.runId,
    page: row.page,
    app_version: row.appVersion,
    status: row.status,
    github_issue_number: row.githubIssueNumber,
    github_issue_url: row.githubIssueUrl,
    // `created_at` is NOT NULL in the schema, so tsToIso never returns null here.
    // The client type says `string`; the assertion keeps the two in agreement
    // rather than pushing a null check into every consumer.
    created_at: tsToIso(row.createdAt)!,
  };
}

/** Supabase user id -> invite email, for whichever ids are asked about. */
export async function emailsForUserIds(db: Db, userIds: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return emails;
  const invites = await db
    .select({ sid: schema.invites.supabaseUserId, email: schema.invites.email })
    .from(schema.invites)
    .where(inArray(schema.invites.supabaseUserId, unique));
  for (const i of invites) if (i.sid) emails.set(i.sid, i.email);
  return emails;
}
```

- [ ] **Step 4: Rewrite the GET handler to use it and to accept `status`**

Replace the contents of `frontend/app/api/admin/feedback/route.ts` with:

```ts
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { emailsForUserIds, serializeFeedbackRow } from '@/lib/server/adminFeedback';
import { isFeedbackStatus, type FeedbackStatus } from '@/lib/server/feedbackStatus';
import { isGithubConfigured } from '@/lib/server/github';

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(422, 'validation error: query parameter out of range');
  }
  return n;
}

/** Comma-separated so one parameter covers both "just resolved" and "everything active". */
function statusParam(raw: string | null): FeedbackStatus[] | null {
  if (raw === null) return null;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0 || !parts.every(isFeedbackStatus)) {
    throw new ApiError(422, 'validation error: unknown feedback status');
  }
  return parts;
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
    const statuses = statusParam(url.searchParams.get('status'));

    const filters: SQL[] = [];
    if (userId) filters.push(eq(schema.feedback.userId, userId));
    if (category) filters.push(eq(schema.feedback.category, category));
    if (statuses) filters.push(inArray(schema.feedback.status, statuses));
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

    const emails = await emailsForUserIds(
      db,
      rows.map((r) => r.userId)
    );

    return Response.json({
      items: rows.map((row) => serializeFeedbackRow(row, emails.get(row.userId) ?? null)),
      total: Number(agg?.total ?? 0),
      limit,
      offset,
      github_configured: isGithubConfigured(),
    });
  },
  { requireAdmin: true }
);
```

- [ ] **Step 5: Run the test**

Run: `npm run test:server -- admin-feedback-routes`
Expected: PASS, 7 tests.

- [ ] **Step 6: Confirm nothing else regressed**

Run: `npm run test:server`
Expected: PASS, whole Vitest suite.

- [ ] **Step 7: Stop for review**

Do not commit. Suggested message: `feat(admin): filter feedback by status and report github config`

---

## Task 4: `PATCH /api/admin/feedback/[id]`

**Files:**
- Create: `frontend/app/api/admin/feedback/[id]/route.ts`
- Modify: `frontend/lib/server/__tests__/admin-feedback-routes.test.ts`

**Interfaces:**
- Consumes: `FEEDBACK_STATUSES` (Task 1); `serializeFeedbackRow`, `emailsForUserIds` (Task 3).
- Produces: `PATCH` returning a single `AdminFeedbackItem`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/lib/server/__tests__/admin-feedback-routes.test.ts`. Add `import { PATCH as patchFeedback } from '../../../app/api/admin/feedback/[id]/route';` alongside the existing imports:

```ts
function patchReq(id: number, body: unknown): [Request, { params: { id: string } }] {
  return [
    new Request(`http://localhost/api/admin/feedback/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } },
  ];
}

describe('PATCH /api/admin/feedback/[id]', () => {
  test('moves a row to each valid status and returns the full item', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      const [row] = await db.select().from(schema.feedback).limit(1);
      for (const status of ['reported', 'in_progress', 'resolved', 'open']) {
        const res = await patchFeedback(...patchReq(row!.id, { status }));
        expect(res.status).toBe(200);
        const item = await res.json();
        expect(item.status).toBe(status);
        expect(item.id).toBe(row!.id);
        expect(item.email).toBe('one@example.com');
      }
    } finally {
      await close();
    }
  });

  test('rejects an unknown status, a missing status, and a non-JSON body with 422', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      const [row] = await db.select().from(schema.feedback).limit(1);
      expect((await patchFeedback(...patchReq(row!.id, { status: 'done' }))).status).toBe(422);
      expect((await patchFeedback(...patchReq(row!.id, {}))).status).toBe(422);
      const bad = new Request(`http://localhost/api/admin/feedback/${row!.id}`, {
        method: 'PATCH',
        body: 'not json',
      });
      expect((await patchFeedback(bad, { params: { id: String(row!.id) } })).status).toBe(422);
    } finally {
      await close();
    }
  });

  test('returns 404 for an id that does not exist', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      expect((await patchFeedback(...patchReq(99999, { status: 'open' }))).status).toBe(404);
    } finally {
      await close();
    }
  });
});
```

The `seed` helper inserts rows in the order written but the list route orders by `created_at DESC`; these tests read the row back with `.limit(1)` off an unordered select, which is fine because they only need *some* row. Do not assume it is `crash on import`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- admin-feedback-routes`
Expected: FAIL — cannot resolve the `[id]/route` module.

- [ ] **Step 3: Write the route**

Create `frontend/app/api/admin/feedback/[id]/route.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { emailsForUserIds, serializeFeedbackRow } from '@/lib/server/adminFeedback';
import { FEEDBACK_STATUSES } from '@/lib/server/feedbackStatus';

// The enum is built from the shared constant so the vocabulary has exactly one
// definition; adding a status must not require editing a second list here.
const Body = z.object({ status: z.enum(FEEDBACK_STATUSES) });

export const PATCH = withApi(
  '/api/admin/feedback/[id]',
  async (req, ctx) => {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }
    const id = parseIdParam(ctx.params.id);

    const db = getDb();
    const [row] = await db
      .update(schema.feedback)
      .set({ status: parsed.data.status })
      .where(eq(schema.feedback.id, id))
      .returning();
    if (!row) throw new ApiError(404, 'feedback not found');
    ctx.timer.mark('db');

    const emails = await emailsForUserIds(db, [row.userId]);
    return Response.json(serializeFeedbackRow(row, emails.get(row.userId) ?? null));
  },
  { requireAdmin: true }
);
```

- [ ] **Step 4: Run the test**

Run: `npm run test:server -- admin-feedback-routes`
Expected: PASS, 10 tests.

- [ ] **Step 5: Stop for review**

Do not commit. Suggested message: `feat(admin): add feedback status PATCH route`

---

## Task 5: `POST /api/admin/feedback/[id]/github-issue`

**Files:**
- Create: `frontend/app/api/admin/feedback/[id]/github-issue/route.ts`
- Modify: `frontend/lib/server/__tests__/admin-feedback-routes.test.ts`

**Interfaces:**
- Consumes: `createIssue`, `isGithubConfigured`, `GitHubError` (Task 2); `serializeFeedbackRow`, `emailsForUserIds` (Task 3).
- Produces: `POST` returning the updated `AdminFeedbackItem` with `status: 'reported'`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/lib/server/__tests__/admin-feedback-routes.test.ts`. Add `import { POST as createIssueRoute } from '../../../app/api/admin/feedback/[id]/github-issue/route';`, add `import { eq } from 'drizzle-orm';`, and extend the existing `vitest` import to `import { afterEach, describe, expect, test, vi } from 'vitest';` rather than adding a second import line:

```ts
function issueReq(id: number, body: unknown): [Request, { params: { id: string } }] {
  return [
    new Request(`http://localhost/api/admin/feedback/${id}/github-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } },
  ];
}

describe('POST /api/admin/feedback/[id]/github-issue', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('creates the issue, stores the link, and moves the row to reported', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      process.env.GITHUB_TOKEN = 'ghp_test';
      process.env.GITHUB_REPO = 'owner/name';
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            JSON.stringify({ number: 12, html_url: 'https://github.com/owner/name/issues/12' }),
            { status: 201 }
          )
      );
      const [row] = await db.select().from(schema.feedback).limit(1);

      const res = await createIssueRoute(
        ...issueReq(row!.id, { title: 'Crash on import', body: 'from feedback #1' })
      );

      expect(res.status).toBe(200);
      const item = await res.json();
      expect(item.status).toBe('reported');
      expect(item.github_issue_number).toBe(12);
      expect(item.github_issue_url).toBe('https://github.com/owner/name/issues/12');

      const [stored] = await db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.id, row!.id));
      expect(stored!.githubIssueNumber).toBe(12);
    } finally {
      await close();
    }
  });

  test('returns 409 when the row already has an issue and does not call github', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      process.env.GITHUB_TOKEN = 'ghp_test';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const [row] = await db.select().from(schema.feedback).limit(1);
      await db
        .update(schema.feedback)
        .set({ githubIssueNumber: 5, githubIssueUrl: 'https://x/5' })
        .where(eq(schema.feedback.id, row!.id));

      const res = await createIssueRoute(...issueReq(row!.id, { title: 'T', body: 'B' }));

      expect(res.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  test('returns 404 for a missing row and 503 when github is unconfigured', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      expect((await createIssueRoute(...issueReq(99999, { title: 'T', body: 'B' }))).status).toBe(
        404
      );
      const [row] = await db.select().from(schema.feedback).limit(1);
      expect((await createIssueRoute(...issueReq(row!.id, { title: 'T', body: 'B' }))).status).toBe(
        503
      );
    } finally {
      await close();
    }
  });

  test('returns 502 on a github failure and leaves the row untouched', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      process.env.GITHUB_TOKEN = 'ghp_test';
      vi.stubGlobal(
        'fetch',
        async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
      );
      const [row] = await db.select().from(schema.feedback).limit(1);

      const res = await createIssueRoute(...issueReq(row!.id, { title: 'T', body: 'B' }));

      expect(res.status).toBe(502);
      const [stored] = await db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.id, row!.id));
      expect(stored!.githubIssueNumber).toBeNull();
      expect(stored!.status).not.toBe('reported');
    } finally {
      await close();
    }
  });

  test('rejects an empty title with 422', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seed(db);
      process.env.GITHUB_TOKEN = 'ghp_test';
      const [row] = await db.select().from(schema.feedback).limit(1);
      expect((await createIssueRoute(...issueReq(row!.id, { title: '  ', body: 'B' }))).status).toBe(
        422
      );
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- admin-feedback-routes`
Expected: FAIL — cannot resolve the `github-issue/route` module.

- [ ] **Step 3: Write the route**

Create `frontend/app/api/admin/feedback/[id]/github-issue/route.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { emailsForUserIds, serializeFeedbackRow } from '@/lib/server/adminFeedback';
import { GitHubError, createIssue, isGithubConfigured } from '@/lib/server/github';

// Title and body arrive from the admin's edited modal. Deriving them server-side
// instead would silently discard those edits.
const Body = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string(),
});

export const POST = withApi(
  '/api/admin/feedback/[id]/github-issue',
  async (req, ctx) => {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }
    const id = parseIdParam(ctx.params.id);

    const db = getDb();
    const [row] = await db.select().from(schema.feedback).where(eq(schema.feedback.id, id));
    if (!row) throw new ApiError(404, 'feedback not found');
    // Checked before the configuration check so a double-click reads as a
    // duplicate rather than as a misconfiguration.
    if (row.githubIssueNumber !== null) {
      throw new ApiError(409, 'feedback already has a GitHub issue');
    }
    if (!isGithubConfigured()) throw new ApiError(503, 'GitHub is not configured');
    ctx.timer.mark('db');

    // The GitHub call is the irreversible half, so it happens before the local
    // write: a row that claims an issue which does not exist is worse than an
    // issue with no row pointing at it, and the 409 above is what a retry hits.
    // Same reasoning as createInvite in lib/server/invites.ts.
    let issue;
    try {
      issue = await createIssue({ title: parsed.data.title, body: parsed.data.body });
    } catch (err) {
      if (err instanceof GitHubError) throw new ApiError(502, err.message);
      throw err;
    }
    ctx.timer.mark('github');

    const [updated] = await db
      .update(schema.feedback)
      .set({
        githubIssueNumber: issue.number,
        githubIssueUrl: issue.url,
        status: 'reported',
      })
      .where(eq(schema.feedback.id, id))
      .returning();

    const emails = await emailsForUserIds(db, [updated!.userId]);
    return Response.json(serializeFeedbackRow(updated!, emails.get(updated!.userId) ?? null));
  },
  { requireAdmin: true }
);
```

- [ ] **Step 4: Run the test**

Run: `npm run test:server -- admin-feedback-routes`
Expected: PASS, 15 tests.

- [ ] **Step 5: Stop for review**

Do not commit. Suggested message: `feat(admin): create a github issue from a feedback row`

---

## Task 6: `POST /api/github/webhook`

**Files:**
- Create: `frontend/app/api/github/webhook/route.ts`
- Create: `frontend/lib/server/__tests__/github-webhook-route.test.ts`

**Interfaces:**
- Consumes: `githubConfig`, `verifyWebhookSignature` (Task 2); `FeedbackStatus` (Task 1).
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/server/__tests__/github-webhook-route.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { POST as webhook } from '../../../app/api/github/webhook/route';
import { _setDbForTests, schema, type Db } from '../db';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';

setupTestEnv();

const SECRET = 'hook-secret';

async function seedLinked(db: Db): Promise<number> {
  const [row] = await db
    .insert(schema.feedback)
    .values({
      userId: 'u1',
      category: 'bug',
      body: 'crash',
      status: 'reported',
      githubIssueNumber: 12,
      githubIssueUrl: 'https://github.com/ccmalcom/shelfsprite/issues/12',
    })
    .returning();
  return row!.id;
}

function hook(payload: unknown, opts?: { event?: string; secret?: string | null }): Request {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'x-github-event': opts?.event ?? 'issues',
    'Content-Type': 'application/json',
  };
  const secret = opts?.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) {
    headers['x-hub-signature-256'] =
      `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
  }
  return new Request('http://localhost/api/github/webhook', {
    method: 'POST',
    headers,
    body: raw,
  });
}

function issuesPayload(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    issue: { number: 12 },
    repository: { full_name: 'ccmalcom/shelfsprite' },
    ...extra,
  };
}

async function statusOf(db: Db, id: number): Promise<string> {
  const [row] = await db.select().from(schema.feedback).where(eq(schema.feedback.id, id));
  return row!.status;
}

describe('POST /api/github/webhook', () => {
  test('rejects a bad signature, a missing header, and an unset secret', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const id = await seedLinked(db);

      // Secret unset entirely -> 503, never "skip verification".
      expect((await webhook(hook(issuesPayload('closed')))).status).toBe(503);

      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      expect((await webhook(hook(issuesPayload('closed'), { secret: 'wrong' }))).status).toBe(401);
      expect((await webhook(hook(issuesPayload('closed'), { secret: null }))).status).toBe(401);
      expect(await statusOf(db, id)).toBe('reported');
    } finally {
      await close();
    }
  });

  test('answers ping and ignores non-issues events without touching rows', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const id = await seedLinked(db);
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;

      expect((await webhook(hook({ zen: 'hi' }, { event: 'ping' }))).status).toBe(200);
      expect((await webhook(hook(issuesPayload('closed'), { event: 'push' }))).status).toBe(200);
      expect(await statusOf(db, id)).toBe('reported');
    } finally {
      await close();
    }
  });

  test('maps closed, reopened, and assigned onto statuses', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const id = await seedLinked(db);
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;

      await webhook(hook(issuesPayload('closed')));
      expect(await statusOf(db, id)).toBe('resolved');

      await webhook(hook(issuesPayload('reopened')));
      expect(await statusOf(db, id)).toBe('in_progress');

      await webhook(hook(issuesPayload('closed')));
      await webhook(hook(issuesPayload('assigned')));
      expect(await statusOf(db, id)).toBe('in_progress');
    } finally {
      await close();
    }
  });

  test('maps only the configured label, case-insensitively', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const id = await seedLinked(db);
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;

      await webhook(hook(issuesPayload('labeled', { label: { name: 'wontfix' } })));
      expect(await statusOf(db, id)).toBe('reported');

      await webhook(hook(issuesPayload('labeled', { label: { name: 'In Progress' } })));
      expect(await statusOf(db, id)).toBe('in_progress');
    } finally {
      await close();
    }
  });

  test('ignores unmapped actions', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const id = await seedLinked(db);
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      expect((await webhook(hook(issuesPayload('edited')))).status).toBe(200);
      expect(await statusOf(db, id)).toBe('reported');
    } finally {
      await close();
    }
  });

  test('ignores a matching issue number from a different repository', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const id = await seedLinked(db);
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;

      const payload = {
        action: 'closed',
        issue: { number: 12 },
        repository: { full_name: 'someone/else' },
      };
      expect((await webhook(hook(payload))).status).toBe(200);
      expect(await statusOf(db, id)).toBe('reported');
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- github-webhook-route`
Expected: FAIL — cannot resolve the webhook route module.

- [ ] **Step 3: Write the route**

Create `frontend/app/api/github/webhook/route.ts`:

```ts
import { eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { githubConfig, verifyWebhookSignature } from '@/lib/server/github';
import type { FeedbackStatus } from '@/lib/server/feedbackStatus';

interface IssuesPayload {
  action?: string;
  issue?: { number?: number };
  label?: { name?: string };
  repository?: { full_name?: string };
}

/**
 * Deliberately small. `opened` is absent because the app just set `reported`
 * itself; `unlabeled` and `unassigned` are absent because reversing a status on
 * removal guesses at intent.
 */
function statusForAction(payload: IssuesPayload, inProgressLabel: string): FeedbackStatus | null {
  switch (payload.action) {
    case 'closed':
      return 'resolved';
    case 'reopened':
    case 'assigned':
      return 'in_progress';
    case 'labeled':
      return payload.label?.name?.toLowerCase() === inProgressLabel.toLowerCase()
        ? 'in_progress'
        : null;
    default:
      return null;
  }
}

/**
 * Public by necessity — GitHub cannot present a Supabase bearer token — so the
 * route authenticates itself, exactly as GET /api/admin/me performs its own admin
 * check rather than being pre-empted by the wrapper. proxy.ts already excludes
 * /api, so no matcher change is involved.
 */
export const POST = withApi(
  '/api/github/webhook',
  async (req, ctx) => {
    const cfg = githubConfig();
    // An unset secret is a misconfiguration, never a licence to skip verification.
    if (!cfg.webhookSecret) throw new ApiError(503, 'GitHub webhook is not configured');

    // Raw bytes, before any parsing: the HMAC covers exactly what GitHub signed.
    const rawBody = await req.text();
    if (!verifyWebhookSignature(rawBody, req.headers.get('x-hub-signature-256'))) {
      throw new ApiError(401, 'invalid webhook signature');
    }

    const event = req.headers.get('x-github-event');
    if (event === 'ping') return Response.json({ ok: true });
    // 200, not an error: GitHub retries and eventually disables endpoints that error.
    if (event !== 'issues') return Response.json({ ignored: true });

    let payload: IssuesPayload;
    try {
      payload = JSON.parse(rawBody) as IssuesPayload;
    } catch {
      throw new ApiError(422, 'webhook body must be JSON');
    }

    const number = payload.issue?.number;
    // The repository check is what stops a webhook from any other repository
    // moving rows by issue-number collision.
    if (typeof number !== 'number' || payload.repository?.full_name !== cfg.repo) {
      return Response.json({ ignored: true });
    }

    const status = statusForAction(payload, cfg.inProgressLabel);
    if (!status) return Response.json({ ignored: true });

    const db = getDb();
    const updated = await db
      .update(schema.feedback)
      .set({ status })
      .where(eq(schema.feedback.githubIssueNumber, number))
      .returning({ id: schema.feedback.id });
    ctx.timer.mark('db');

    return Response.json({ updated: updated.length, status });
  },
  { requireAuth: false }
);
```

- [ ] **Step 4: Run the test**

Run: `npm run test:server -- github-webhook-route`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the proxy still excludes the route**

Run: `npm run test:server -- proxy-matcher`
Expected: PASS. If a `proxy-matcher` assertion enumerates API paths, add `/api/github/webhook` to it; do not relax the matcher itself.

- [ ] **Step 6: Stop for review**

Do not commit. Suggested message: `feat(github): sync feedback status from issue webhooks`

---

## Task 7: Client types and functions in `lib/api.ts`

**Files:**
- Modify: `frontend/lib/api.ts` (the `AdminFeedbackItem` / `AdminFeedbackList` / `listAdminFeedback` region)

**Interfaces:**
- Consumes: the wire shapes from Tasks 3, 4, 5; `FeedbackStatus` (Task 1).
- Produces: `listAdminFeedback({ limit?, offset?, category?, status? })`, `updateAdminFeedbackStatus(id, status)`, `createFeedbackGithubIssue(id, { title, body })`, and the extended `AdminFeedbackItem` / `AdminFeedbackList` interfaces that Tasks 8 and 9 consume.

- [ ] **Step 1: Extend the types**

In `frontend/lib/api.ts`, find `export interface AdminFeedbackItem` and replace that interface, `AdminFeedbackList`, and `listAdminFeedback` with:

```ts
export interface AdminFeedbackItem {
  id: number;
  user_id: string;
  email: string | null;
  category: string;
  body: string;
  trigger: string | null;
  run_id: string | null;
  page: string | null;
  app_version: string | null;
  status: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  created_at: string;
}

export interface AdminFeedbackList {
  items: AdminFeedbackItem[];
  total: number;
  limit: number;
  offset: number;
  /** False when GITHUB_TOKEN is unset; the tab hides issue creation entirely. */
  github_configured: boolean;
}

/** Paginated feedback rows across all users (admin-only). GET /admin/feedback */
export function listAdminFeedback(opts?: {
  limit?: number;
  offset?: number;
  category?: string;
  /** Comma-separated statuses, e.g. `open,reported,in_progress`. */
  status?: string;
}): Promise<AdminFeedbackList> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.offset != null) params.set('offset', String(opts.offset));
  if (opts?.category) params.set('category', opts.category);
  if (opts?.status) params.set('status', opts.status);
  const qs = params.toString();
  return get<AdminFeedbackList>(`/admin/feedback${qs ? `?${qs}` : ''}`);
}

/** Move one feedback row to a new triage status (admin-only). PATCH /admin/feedback/{id} */
export const updateAdminFeedbackStatus = (
  id: number,
  status: FeedbackStatus
): Promise<AdminFeedbackItem> => patch<AdminFeedbackItem>(`/admin/feedback/${id}`, { status });

/**
 * Open a GitHub issue for one feedback row and link it (admin-only).
 * POST /admin/feedback/{id}/github-issue
 */
export const createFeedbackGithubIssue = (
  id: number,
  req: { title: string; body: string }
): Promise<AdminFeedbackItem> => post<AdminFeedbackItem>(`/admin/feedback/${id}/github-issue`, req);
```

- [ ] **Step 2: Add the type import**

At the top of `frontend/lib/api.ts`, with the other imports, add:

```ts
import type { FeedbackStatus } from '@/lib/server/feedbackStatus';
```

`import type` erases at compile time, and `feedbackStatus.ts` is dependency-free regardless, so this adds nothing to the bundle.

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: PASS, except for errors in `components/admin/FeedbackTab.tsx` if it does not yet know about `github_configured`. That single file is Task 9's job. Any error outside `FeedbackTab.tsx` must be fixed here.

- [ ] **Step 4: Stop for review**

Do not commit. Suggested message: `feat(api): client bindings for feedback status and issue creation`

---

## Task 8: `FeedbackIssueModal`

**Files:**
- Create: `frontend/components/admin/FeedbackIssueModal.tsx`

**Interfaces:**
- Consumes: `AdminFeedbackItem`, `createFeedbackGithubIssue` (Task 7); `Modal`, `Button`, `Input`, `Textarea`, `Field` from `@/components/ui`.
- Produces: `<FeedbackIssueModal item={item} onClose={() => void} onCreated={(item: AdminFeedbackItem) => void} />`, plus the exported helpers `defaultIssueTitle(item)` and `defaultIssueBody(item)`.

- [ ] **Step 1: Confirm the `Field` render-prop signature**

Run: `grep -n 'interface FieldProps' -A 12 components/ui/Field.tsx`

`FeedbackTab.tsx` already calls `<Field label="...">{(p) => <select {...p} .../>}</Field>`, so the render-prop form used below should be right. If `Field` requires additional props, adjust the two call sites in Step 2 to match the real signature rather than working around it.

- [ ] **Step 2: Write the component**

Create `frontend/components/admin/FeedbackIssueModal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { createFeedbackGithubIssue, type AdminFeedbackItem } from '@/lib/api';
import { Button, Field, Input, Modal, Textarea } from '@/components/ui';

const TITLE_MAX = 60;

/** `[feedback] ` plus the opening of the submission, trimmed at a word boundary. */
export function defaultIssueTitle(item: AdminFeedbackItem): string {
  const flat = item.body.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX) return `[feedback] ${flat}`;
  const cut = flat.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `[feedback] ${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function defaultIssueBody(item: AdminFeedbackItem): string {
  const meta = [
    `- **Category:** ${item.category}`,
    `- **From:** ${item.email ?? item.user_id}`,
    item.page ? `- **Page:** ${item.page}` : null,
    item.trigger ? `- **Trigger:** ${item.trigger}` : null,
    item.app_version ? `- **App version:** ${item.app_version}` : null,
    `- **ShelfSprite feedback ID:** ${item.id}`,
  ].filter(Boolean);
  const quoted = item.body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${meta.join('\n')}\n\n---\n\n${quoted}\n`;
}

interface Props {
  item: AdminFeedbackItem;
  onClose: () => void;
  onCreated: (updated: AdminFeedbackItem) => void;
}

export function FeedbackIssueModal({ item, onClose, onCreated }: Props) {
  const [title, setTitle] = useState(() => defaultIssueTitle(item));
  const [body, setBody] = useState(() => defaultIssueBody(item));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await createFeedbackGithubIssue(item.id, { title: title.trim(), body }));
      onClose();
    } catch (err) {
      // The modal stays open with the admin's edits intact: a 502 from GitHub
      // must not silently discard typed text.
      setError(err instanceof Error ? err.message : 'Could not create the issue.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal labelId="feedback-issue-title" onClose={onClose} className="w-full max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <h2 id="feedback-issue-title" className="font-display text-lg font-semibold text-text">
          Create GitHub issue
        </h2>

        <Field label="Title">
          {(p) => (
            <Input
              {...p}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={256}
              required
            />
          )}
        </Field>

        <Field label="Body">
          {(p) => (
            <Textarea
              {...p}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              className="font-mono text-xs"
            />
          )}
        </Field>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={!title.trim()}>
            Create issue
          </Button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 3: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: PASS, apart from the `FeedbackTab.tsx` error noted in Task 7 if it is still outstanding.

- [ ] **Step 4: Stop for review**

Do not commit. Suggested message: `feat(admin): add the feedback issue modal`

---

## Task 9: Feedback tab UI

**Files:**
- Modify: `frontend/components/admin/FeedbackTab.tsx`
- Create: `frontend/components/admin/__tests__/FeedbackTab.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 7 and 8; `ACTIVE_FEEDBACK_STATUSES`, `FEEDBACK_STATUSES`, `FeedbackStatus` (Task 1).
- Produces: the finished tab.

- [ ] **Step 1: Write the failing test**

Create `frontend/components/admin/__tests__/FeedbackTab.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeedbackTab } from '@/components/admin/FeedbackTab';
import { ToastProvider } from '@/components/ui';

const listAdminFeedback = jest.fn();
const updateAdminFeedbackStatus = jest.fn();

jest.mock('@/lib/api', () => ({
  listAdminFeedback: (...args: unknown[]) => listAdminFeedback(...args),
  updateAdminFeedbackStatus: (...args: unknown[]) => updateAdminFeedbackStatus(...args),
  createFeedbackGithubIssue: jest.fn(),
}));

// SWR is stubbed to call the fetcher once per key and hand back its result, which
// keeps the assertions about *what the tab requests* honest without a cache in
// the way.
jest.mock('swr', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: (key: unknown, fetcher: () => Promise<unknown>) => {
      const [data, setData] = React.useState(undefined);
      React.useEffect(() => {
        let alive = true;
        fetcher().then((d: unknown) => {
          if (alive) setData(d);
        });
        return () => {
          alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [JSON.stringify(key)]);
      return { data, isLoading: data === undefined, mutate: jest.fn() };
    },
  };
});

const ITEM = {
  id: 1,
  user_id: 'u1',
  email: 'one@example.com',
  category: 'bug',
  body: 'crash on import',
  trigger: null,
  run_id: null,
  page: null,
  app_version: null,
  status: 'open',
  github_issue_number: null,
  github_issue_url: null,
  created_at: '2026-08-19T00:00:00',
};

function renderTab(overrides: Record<string, unknown> = {}) {
  listAdminFeedback.mockResolvedValue({
    items: [ITEM],
    total: 1,
    limit: 25,
    offset: 0,
    github_configured: true,
    ...overrides,
  });
  return render(
    <ToastProvider>
      <FeedbackTab />
    </ToastProvider>
  );
}

describe('FeedbackTab', () => {
  beforeEach(() => jest.clearAllMocks());

  it('defaults to the open-and-active status filter', async () => {
    renderTab();
    await waitFor(() => expect(listAdminFeedback).toHaveBeenCalled());
    expect(listAdminFeedback.mock.calls[0][0]).toMatchObject({
      status: 'open,reported,in_progress',
    });
  });

  it('sends no status when the filter is set to all', async () => {
    renderTab();
    await screen.findByText('crash on import');
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: '' } });
    await waitFor(() => {
      const last = listAdminFeedback.mock.calls.at(-1)![0];
      expect(last.status).toBeUndefined();
    });
  });

  it('changes a row status through the inline select', async () => {
    updateAdminFeedbackStatus.mockResolvedValue({ ...ITEM, status: 'resolved' });
    renderTab();
    await screen.findByText('crash on import');
    fireEvent.change(screen.getByLabelText('Status for feedback 1'), {
      target: { value: 'resolved' },
    });
    await waitFor(() => expect(updateAdminFeedbackStatus).toHaveBeenCalledWith(1, 'resolved'));
  });

  it('offers issue creation only when github is configured', async () => {
    const { unmount } = renderTab();
    expect(await screen.findByRole('button', { name: /create github issue/i })).toBeInTheDocument();
    unmount();

    jest.clearAllMocks();
    renderTab({ github_configured: false });
    await screen.findByText('crash on import');
    expect(screen.queryByRole('button', { name: /create github issue/i })).toBeNull();
  });

  it('links to an existing issue instead of offering to create one', async () => {
    renderTab({
      items: [
        {
          ...ITEM,
          status: 'reported',
          github_issue_number: 12,
          github_issue_url: 'https://github.com/ccmalcom/shelfsprite/issues/12',
        },
      ],
    });
    const link = await screen.findByRole('link', { name: '#12' });
    expect(link).toHaveAttribute('href', 'https://github.com/ccmalcom/shelfsprite/issues/12');
    expect(screen.queryByRole('button', { name: /create github issue/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- FeedbackTab`
Expected: FAIL — no status filter, no inline select, no issue button.

- [ ] **Step 3: Rewrite the tab**

Replace the contents of `frontend/components/admin/FeedbackTab.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { listAdminFeedback, updateAdminFeedbackStatus, type AdminFeedbackItem } from '@/lib/api';
import {
  ACTIVE_FEEDBACK_STATUSES,
  FEEDBACK_STATUSES,
  type FeedbackStatus,
} from '@/lib/server/feedbackStatus';
import { Badge, Button, Card, Field, Spinner, useToast } from '@/components/ui';
import { FeedbackIssueModal } from './FeedbackIssueModal';
import { Pagination } from './Pagination';

const PAGE_SIZE = 25;

const CATEGORY_VARIANT: Record<string, 'default' | 'danger' | 'success' | 'warning' | 'accent'> = {
  bug: 'danger',
  idea: 'accent',
  confusing: 'warning',
  praise: 'success',
  targeted: 'default',
};

const STATUS_VARIANT: Record<string, 'default' | 'danger' | 'success' | 'warning' | 'accent'> = {
  open: 'warning',
  reported: 'accent',
  in_progress: 'default',
  resolved: 'success',
};

const STATUS_LABEL: Record<string, string> = {
  open: 'open',
  reported: 'reported',
  in_progress: 'in progress',
  resolved: 'resolved',
};

/** The default view is a work queue: everything except what is already done. */
const ACTIVE_FILTER = ACTIVE_FEEDBACK_STATUSES.join(',');

const selectClasses =
  'rounded-lg border border-border bg-base px-2 py-1 text-xs text-text focus:border-accent focus:outline-none';

export function FeedbackTab() {
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<string>(ACTIVE_FILTER);

  const { data, isLoading, mutate } = useSWR(
    ['admin-feedback', offset, category, status] as const,
    () =>
      listAdminFeedback({
        limit: PAGE_SIZE,
        offset,
        category: category || undefined,
        status: status || undefined,
      })
  );

  function handleCategoryChange(value: string) {
    setCategory(value);
    setOffset(0);
  }

  function handleStatusFilterChange(value: string) {
    setStatus(value);
    setOffset(0);
  }

  /** Splice one updated row back into the cached page without a refetch. */
  function applyUpdated(updated: AdminFeedbackItem) {
    void mutate(
      (current) =>
        current
          ? { ...current, items: current.items.map((i) => (i.id === updated.id ? updated : i)) }
          : current,
      { revalidate: false }
    );
  }

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Feedback</h2>
          {data ? (
            <p className="text-xs text-faint">
              {data.total} submission{data.total !== 1 ? 's' : ''}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Filter by status">
            {(p) => (
              <select
                {...p}
                value={status}
                onChange={(e) => handleStatusFilterChange(e.target.value)}
                className={selectClasses}
              >
                <option value={ACTIVE_FILTER}>Open &amp; active</option>
                <option value="">All statuses</option>
                {FEEDBACK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Filter by category">
            {(p) => (
              <select
                {...p}
                value={category}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className={selectClasses}
              >
                <option value="">All categories</option>
                <option value="bug">bug</option>
                <option value="idea">idea</option>
                <option value="confusing">confusing</option>
                <option value="praise">praise</option>
                <option value="targeted">targeted</option>
              </select>
            )}
          </Field>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner label="Loading feedback" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <p className="p-5 text-sm text-faint">No feedback yet.</p>
      ) : (
        <div className="mt-4 divide-y divide-border">
          {data.items.map((item) => (
            <FeedbackRow
              key={item.id}
              item={item}
              githubConfigured={data.github_configured}
              onUpdated={applyUpdated}
            />
          ))}
        </div>
      )}

      {data ? (
        <Pagination
          offset={offset}
          limit={PAGE_SIZE}
          total={data.total}
          onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          onNext={() => setOffset(offset + PAGE_SIZE)}
        />
      ) : null}
    </Card>
  );
}

function FeedbackRow({
  item,
  githubConfigured,
  onUpdated,
}: {
  item: AdminFeedbackItem;
  githubConfigured: boolean;
  onUpdated: (updated: AdminFeedbackItem) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const toast = useToast();

  async function handleStatusChange(next: string) {
    if (next === item.status) return;
    setSaving(true);
    try {
      onUpdated(await updateAdminFeedbackStatus(item.id, next as FeedbackStatus));
    } catch {
      // The row is left showing its real, unchanged status rather than a lie.
      toast.error('Could not update the status.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-5 py-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="truncate text-sm font-medium text-text">{item.email ?? item.user_id}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={STATUS_VARIANT[item.status] ?? 'default'}>
            {STATUS_LABEL[item.status] ?? item.status}
          </Badge>
          <Badge variant={CATEGORY_VARIANT[item.category] ?? 'default'}>{item.category}</Badge>
          <span className="font-mono text-xs text-faint">
            {new Date(item.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <p className="text-sm text-muted">{item.body}</p>

      {item.trigger ? (
        <p className="mt-1 font-mono text-xs text-faint">
          trigger: {item.trigger}
          {item.page ? ` · ${item.page}` : ''}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          id={`status-${item.id}`}
          aria-label={`Status for feedback ${item.id}`}
          value={item.status}
          disabled={saving}
          onChange={(e) => void handleStatusChange(e.target.value)}
          className={selectClasses}
        >
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        {item.github_issue_url ? (
          <a
            href={item.github_issue_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-accent hover:underline"
          >
            #{item.github_issue_number}
          </a>
        ) : githubConfigured ? (
          <Button size="sm" variant="secondary" onClick={() => setModalOpen(true)}>
            Create GitHub issue
          </Button>
        ) : null}
      </div>

      {modalOpen ? (
        <FeedbackIssueModal item={item} onClose={() => setModalOpen(false)} onCreated={onUpdated} />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- FeedbackTab`
Expected: PASS, 5 tests.

- [ ] **Step 5: Stop for review**

Do not commit. Suggested message: `feat(admin): status filter, inline status, and issue creation in the feedback tab`

---

## Task 10: Docs, full gate, live verification

**Files:**
- Modify: `docs/hosting.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Document the environment keys and webhook setup**

Add a section to `docs/hosting.md`, matching that file's existing heading style. Key **names** only — never a value:

```markdown
### GitHub issue integration

Set on Vercel (Preview + Production) and in the local environment file for local work:

| Key | Notes |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT scoped to `ccmalcom/shelfsprite` with Issues: read & write. Required — issue creation is hidden in the admin UI when it is unset. |
| `GITHUB_REPO` | `owner/name`. Defaults to `ccmalcom/shelfsprite`. |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for `x-hub-signature-256`. Required — the webhook answers 503 when unset, and never skips verification. |
| `GITHUB_IN_PROGRESS_LABEL` | The label that means "being worked". Defaults to `in progress`. |

Repository webhook (GitHub → Settings → Webhooks → Add webhook):

- Payload URL: `https://shelfsprite.app/api/github/webhook`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: "Let me select individual events" → **Issues** only

The route maps `closed` → `resolved`, `reopened` / `assigned` → `in_progress`, and `labeled` with
the configured label → `in_progress`. Everything else is a 200 no-op. A missed delivery is
redeliverable from GitHub's webhook delivery log; status is also editable by hand in the admin tab.
```

- [ ] **Step 2: Add the new modules to the architecture map**

In `docs/architecture.md`, find the server module map and add entries in its existing style:

- `lib/server/feedbackStatus.ts` — the feedback triage vocabulary; dependency-free because client components import it.
- `lib/server/github.ts` — outbound GitHub calls and every `GITHUB_*` environment read.
- `lib/server/adminFeedback.ts` — the admin feedback wire shape, shared by the three admin feedback routes.

If the file also lists API routes, add `PATCH /api/admin/feedback/[id]`, `POST /api/admin/feedback/[id]/github-issue`, and `POST /api/github/webhook` — noting that the last is public and self-authenticating via HMAC.

- [ ] **Step 3: Run the complete gate**

Run each, from `frontend/`, and report the actual output of any that fails:

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Expected: all six PASS. `format:check` failures are fixed with `npm run format`, not by editing by hand.

- [ ] **Step 4: Verify in the browser**

Tests alone do not close this out. Start the app and exercise the real flow:

1. Open `/admin`, Feedback tab. Confirm the default filter reads "Open & active" and that resolved rows are absent.
2. Switch the filter to "All statuses" and confirm resolved rows appear.
3. Change a row's status with the inline select; reload and confirm it stuck.
4. With `GITHUB_TOKEN` unset, confirm no "Create GitHub issue" button renders anywhere.
5. With it set, click the button, confirm the modal prefills a sensible title and body, edit both, submit, and confirm the row turns `reported` with a working `#N` link.
6. Confirm the created issue exists on GitHub with the edited title.

Report what was observed. If the local environment cannot reach GitHub, say so plainly rather than reporting step 5 as passing.

- [ ] **Step 5: Verify the webhook with a signed request**

Against the running dev server, with `GITHUB_WEBHOOK_SECRET` present in the environment:

```bash
BODY='{"action":"closed","issue":{"number":12},"repository":{"full_name":"ccmalcom/shelfsprite"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')"

# Valid signature -> 200 and the linked row moves to resolved
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/github/webhook \
  -H "Content-Type: application/json" -H "X-GitHub-Event: issues" \
  -H "X-Hub-Signature-256: $SIG" -d "$BODY"

# Wrong signature -> 401 and nothing changes
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/github/webhook \
  -H "Content-Type: application/json" -H "X-GitHub-Event: issues" \
  -H "X-Hub-Signature-256: sha256=deadbeef" -d "$BODY"
```

Expected: `200` then `401`. Confirm in the admin tab that the row moved on the first and not on the second. Use a feedback row whose `github_issue_number` is 12, or adjust the number to match a real linked row.

- [ ] **Step 6: Report the migration handoff**

Remind Chase that the migration from Task 1 is generated but **not applied**, name the file, and note that production column shape should be confirmed against `information_schema.columns` — not against `schema.ts` — before and after applying.

- [ ] **Step 7: Stop for review**

Do not commit. Suggested message: `docs: github issue integration setup and module map`
