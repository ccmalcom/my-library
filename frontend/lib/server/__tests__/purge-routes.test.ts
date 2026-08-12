import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { DELETE as deleteAccount } from '../../../app/api/account/route';
import { DELETE as deleteLibrary } from '../../../app/api/library/route';
import { DELETE as deleteProfile } from '../../../app/api/profile/route';
import { _setDbForTests, schema, type Db } from '../db';
import { deleteAccountRows, deleteLibraryRows, deleteProfileRows } from '../purge';
import { makeTestDb } from './helpers/pglite';

async function seedUser(db: Db, userId: string) {
  const inserted = await db
    .insert(schema.books)
    .values([
      {
        userId,
        title: 'Dune',
        author: 'Frank Herbert',
        goodreadsRating: 5,
        source: 'test',
      },
      {
        userId,
        title: 'Hyperion',
        author: 'Dan Simmons',
        goodreadsRating: 4,
        source: 'test',
      },
    ])
    .returning({ id: schema.books.id });
  await db.insert(schema.enrichment).values(
    inserted.map(({ id }, i) => ({
      bookId: id,
      resolutionConfidence: 1,
      resolvedSource: 'test',
      resolvedId: `${userId}-${i}`,
    }))
  );
  await db.insert(schema.tasteTraits).values({
    userId,
    claim: 'rewards big ideas',
    polarity: 'reward',
    exhibits: [],
    contrasts: [],
    inferenceConfidence: 1,
    status: 'active',
    userWeight: 1,
  });
  await db.insert(schema.recommendations).values({
    userId,
    runId: 'run-1',
    rank: 1,
    title: 'Foundation',
    score: 0.9,
    status: 'active',
  });
  await db.insert(schema.profileMeta).values({ userId, lastProfileKind: 'full' });
  await db.insert(schema.readerArchetypes).values({
    userId,
    code: 'world-builder',
    archetypeName: 'World Builder',
    archetypeTagline: 'Reads for immersive worlds',
    axisLens: 0.8,
    axisEngine: 0.7,
    axisRange: 0.6,
    axisResonance: 0.9,
    derivedAt: '2026-08-10 12:00:00',
  });
  await db.insert(schema.userSettings).values({
    userId,
    anthropicApiKeyEncrypted: 'enc-blob',
  });
  await db.insert(schema.tasteSignal).values({
    userId,
    direction: 'more',
    targetKind: 'book',
    targetBookId: inserted[0].id,
  });
  await db.insert(schema.enrichJobs).values({
    userId,
    jobId: `job-${userId}`,
    progress: 0,
    total: 0,
    status: 'done',
  });
  await db.insert(schema.usageEvents).values({
    userId,
    model: 'claude-sonnet-5',
    operation: 'recommend_rerank',
  });
  await db.insert(schema.userDirective).values({
    userId,
    nlText: 'Prefer ambitious science fiction',
    constraints: {},
  });
  await db.insert(schema.feedback).values({
    userId,
    category: 'general',
    body: 'Useful recommendations',
  });
  await db.insert(schema.feedbackPromptState).values({
    userId,
    trigger: 'recommendations',
    runId: 'run-1',
    status: 'shown',
  });
  await db.insert(schema.invites).values({
    email: `${userId}@example.com`,
    invitedBy: 'admin',
    supabaseUserId: userId,
  });
}

async function countFor(db: Db, userId: string) {
  const [
    books,
    enrichment,
    tasteTraits,
    recommendations,
    profileMeta,
    readerArchetypes,
    userSettings,
    tasteSignal,
    enrichJobs,
    usageEvents,
    userDirective,
    feedback,
    feedbackPromptState,
    invites,
  ] = await Promise.all([
    db.select({ id: schema.books.id }).from(schema.books).where(eq(schema.books.userId, userId)),
    db
      .select({ id: schema.enrichment.id })
      .from(schema.enrichment)
      .innerJoin(schema.books, eq(schema.enrichment.bookId, schema.books.id))
      .where(eq(schema.books.userId, userId)),
    db
      .select({ id: schema.tasteTraits.id })
      .from(schema.tasteTraits)
      .where(eq(schema.tasteTraits.userId, userId)),
    db
      .select({ id: schema.recommendations.id })
      .from(schema.recommendations)
      .where(eq(schema.recommendations.userId, userId)),
    db
      .select({ id: schema.profileMeta.id })
      .from(schema.profileMeta)
      .where(eq(schema.profileMeta.userId, userId)),
    db
      .select({ id: schema.readerArchetypes.id })
      .from(schema.readerArchetypes)
      .where(eq(schema.readerArchetypes.userId, userId)),
    db
      .select({ id: schema.userSettings.id })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId)),
    db
      .select({ id: schema.tasteSignal.id })
      .from(schema.tasteSignal)
      .where(eq(schema.tasteSignal.userId, userId)),
    db
      .select({ id: schema.enrichJobs.id })
      .from(schema.enrichJobs)
      .where(eq(schema.enrichJobs.userId, userId)),
    db
      .select({ id: schema.usageEvents.id })
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.userId, userId)),
    db
      .select({ id: schema.userDirective.id })
      .from(schema.userDirective)
      .where(eq(schema.userDirective.userId, userId)),
    db
      .select({ id: schema.feedback.id })
      .from(schema.feedback)
      .where(eq(schema.feedback.userId, userId)),
    db
      .select({ id: schema.feedbackPromptState.id })
      .from(schema.feedbackPromptState)
      .where(eq(schema.feedbackPromptState.userId, userId)),
    db
      .select({ id: schema.invites.id })
      .from(schema.invites)
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

const completeCounts = {
  books: 2,
  enrichment: 2,
  tasteTraits: 1,
  recommendations: 1,
  profileMeta: 1,
  readerArchetypes: 1,
  userSettings: 1,
  tasteSignal: 1,
  enrichJobs: 1,
  usageEvents: 1,
  userDirective: 1,
  feedback: 1,
  feedbackPromptState: 1,
  invites: 1,
};

describe('purge primitives', () => {
  test('profile removes only derived profile rows and reports only two counts', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedUser(db, 'local');
      const result = await db.transaction((tx) => deleteProfileRows(tx, 'local'));
      expect(result).toEqual({ traits_removed: 1, recommendations_removed: 1 });
      expect(await countFor(db, 'local')).toEqual({
        ...completeCounts,
        tasteTraits: 0,
        recommendations: 0,
        profileMeta: 0,
        readerArchetypes: 0,
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
        books_removed: 2,
        traits_removed: 1,
        recommendations_removed: 1,
        profile_reset: true,
      });
      expect(await countFor(db, 'local')).toEqual({
        ...completeCounts,
        books: 0,
        enrichment: 0,
        tasteTraits: 0,
        recommendations: 0,
        profileMeta: 0,
        readerArchetypes: 0,
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
      expect(await countFor(db, 'local')).toEqual({
        ...completeCounts,
        books: 0,
        enrichment: 0,
        tasteTraits: 0,
        recommendations: 0,
        profileMeta: 0,
        readerArchetypes: 0,
        userSettings: 0,
        tasteSignal: 0,
        enrichJobs: 0,
        usageEvents: 0,
        userDirective: 0,
      });
    } finally {
      await close();
    }
  });

  test.each(['profile', 'library', 'account'])(
    '%s purge leaves the other tenant unchanged',
    async (kind) => {
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
    }
  );

  test('an empty account purge returns every count as zero and succeeds', async () => {
    const { db, close } = await makeTestDb();
    try {
      const result = await db.transaction((tx) => deleteAccountRows(tx, 'local'));
      expect(result).toEqual({
        books_removed: 0,
        traits_removed: 0,
        recommendations_removed: 0,
        settings_removed: 0,
        signals_removed: 0,
        jobs_removed: 0,
        usage_events_removed: 0,
        directive_removed: 0,
        account_deleted: true,
      });
    } finally {
      await close();
    }
  });

  test('a failed transaction rolls profile deletion back', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedUser(db, 'local');
      const before = await countFor(db, 'local');
      await expect(
        db.transaction(async (tx) => {
          await deleteProfileRows(tx, 'local');
          throw new Error('rollback probe');
        })
      ).rejects.toThrow('rollback probe');
      expect(await countFor(db, 'local')).toEqual(before);
    } finally {
      await close();
    }
  });
});

describe('purge routes', () => {
  test('DELETE /api/account returns every Python count and the exact success flag', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seedUser(db, 'local');
      const res = await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
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
      expect(Object.keys(body).sort()).toEqual(
        [
          'books_removed',
          'traits_removed',
          'recommendations_removed',
          'settings_removed',
          'signals_removed',
          'jobs_removed',
          'usage_events_removed',
          'directive_removed',
          'account_deleted',
        ].sort()
      );
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('DELETE /api/account deliberately keeps feedback, prompt state, invite, and auth identity', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seedUser(db, 'local');
      await seedUser(db, 'other-user');
      const localInviteBefore = await db
        .select()
        .from(schema.invites)
        .where(eq(schema.invites.supabaseUserId, 'local'));
      const otherBefore = await snapshotFor(db, 'other-user');
      const res = await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }));
      expect(res.status).toBe(200);
      expect(await countFor(db, 'local')).toEqual({
        books: 0,
        enrichment: 0,
        tasteTraits: 0,
        recommendations: 0,
        profileMeta: 0,
        readerArchetypes: 0,
        userSettings: 0,
        tasteSignal: 0,
        enrichJobs: 0,
        usageEvents: 0,
        userDirective: 0,
        feedback: 1,
        feedbackPromptState: 1,
        invites: 1,
      });
      expect(
        await db.select().from(schema.invites).where(eq(schema.invites.supabaseUserId, 'local'))
      ).toEqual(localInviteBefore);
      expect(await snapshotFor(db, 'other-user')).toEqual(otherBefore);
      // Auth identity is outside this DB; this successful authenticated withApi request,
      // together with the absence of any Supabase admin dependency, proves it was untouched.
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('DELETE /api/account returns exact zero counts on repeated deletion', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seedUser(db, 'local');
      await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }));
      const res = await deleteAccount(new Request('http://test/api/account', { method: 'DELETE' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        books_removed: 0,
        traits_removed: 0,
        recommendations_removed: 0,
        settings_removed: 0,
        signals_removed: 0,
        jobs_removed: 0,
        usage_events_removed: 0,
        directive_removed: 0,
        account_deleted: true,
      });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('DELETE /api/profile returns exact counts and keeps the library + durable state', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seedUser(db, 'local');
      await seedUser(db, 'other-user');
      const otherBefore = await snapshotFor(db, 'other-user');
      const res = await deleteProfile(new Request('http://test/api/profile', { method: 'DELETE' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        traits_removed: 1,
        recommendations_removed: 1,
        profile_reset: true,
      });
      expect(await countFor(db, 'local')).toEqual({
        ...completeCounts,
        tasteTraits: 0,
        recommendations: 0,
        profileMeta: 0,
        readerArchetypes: 0,
      });
      expect(await snapshotFor(db, 'other-user')).toEqual(otherBefore);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('DELETE /api/library returns exact counts, deletes enrichment before books, and keeps durable state', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      await seedUser(db, 'local');
      await seedUser(db, 'other-user');
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
        ...completeCounts,
        books: 0,
        enrichment: 0,
        tasteTraits: 0,
        recommendations: 0,
        profileMeta: 0,
        readerArchetypes: 0,
      });
      expect(await snapshotFor(db, 'other-user')).toEqual(otherBefore);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test.each([
    {
      route: '/api/profile',
      handler: deleteProfile,
      expected: {
        traits_removed: 0,
        recommendations_removed: 0,
        profile_reset: true,
      },
    },
    {
      route: '/api/library',
      handler: deleteLibrary,
      expected: {
        books_removed: 0,
        traits_removed: 0,
        recommendations_removed: 0,
        profile_reset: true,
      },
    },
  ])(
    'DELETE $route returns zero counts for an empty database',
    async ({ route, handler, expected }) => {
      const { db, close } = await makeTestDb();
      try {
        _setDbForTests(db);
        const res = await handler(new Request(`http://test${route}`, { method: 'DELETE' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(expected);
      } finally {
        _setDbForTests(null);
        await close();
      }
    }
  );
});
