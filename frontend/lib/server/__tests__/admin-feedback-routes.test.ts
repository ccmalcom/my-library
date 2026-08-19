import { afterEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { GET as listFeedback } from '../../../app/api/admin/feedback/route';
import { PATCH as patchFeedback } from '../../../app/api/admin/feedback/[id]/route';
import { POST as createIssueRoute } from '../../../app/api/admin/feedback/[id]/github-issue/route';
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
      expect(
        (await createIssueRoute(...issueReq(row!.id, { title: '  ', body: 'B' }))).status
      ).toBe(422);
    } finally {
      await close();
    }
  });
});
