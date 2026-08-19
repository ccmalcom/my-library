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
