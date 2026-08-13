import { describe, it, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';

describe('wave-2 seed loading', () => {
  it('creates new tables and continues ids past the seeded max', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, {
        books: [
          { id: 1, user_id: 'local', title: 'A', goodreads_rating: 0, source: 'manual' },
          { id: 101, user_id: 'other', title: 'B', goodreads_rating: 0, source: 'manual' },
        ],
        feedback_prompt_state: [
          { id: 1, user_id: 'local', trigger: 'post-setup', run_id: '', status: 'submitted' },
        ],
      });
      const r = await (db as any).$client.query(
        `insert into books (user_id, title, goodreads_rating, source) values ('local','C',0,'manual') returning id`
      );
      expect(r.rows[0].id).toBe(102); // max(1, 101) + 1 — global max incl. other tenant
      const f = await (db as any).$client.query(`select count(*)::int as n from taste_signal`);
      expect(f.rows[0].n).toBe(0);
    } finally {
      await close();
    }
  });
});
