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
  await db.insert(schema.invites).values({
    email: 'one@example.com',
    invitedBy: 'admin@example.com',
    supabaseUserId: 'u1',
    status: 'active',
  });
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
