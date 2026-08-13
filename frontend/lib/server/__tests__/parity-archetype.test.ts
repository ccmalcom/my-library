import { describe, test, expect } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { _setDbForTests } from '../db';
import { deriveArchetype } from '../archetypeDerive';
import responses from './fixtures/claude/responses.json';
import seedJson from './fixtures/parity/seed.json';
import { GET } from '../../../app/api/profile/archetype/route';

describe('GET /api/profile/archetype parity', () => {
  setupParityEnv();
  test('empty → 404', () => checkParity('empty', 'GET /profile/archetype', GET));
  test('seeded → stored archetype', () => checkParity('seeded', 'GET /profile/archetype', GET));
});

describe('GET /api/profile/archetype after a derive', () => {
  setupParityEnv();
  // Proves the route.ts refactor (extracting a shared archetypeOut helper for GET and
  // POST) didn't change GET's response shape: after deriveArchetype writes a fresh row
  // (the same DB side effect POST triggers), GET must still return the full ArchetypeOut
  // shape built from that row.
  test('reflects a freshly-derived row with the same shape GET always returns', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      const fixture = (responses as any).archetype;
      await deriveArchetype(db, fakeClaude([fixture]), 'local');

      const res = await GET(new Request('http://test/api/profile/archetype'));
      expect(res.status).toBe(200);
      const body = await res.json();
      const expected = fixture.content[0].input;
      expect(body.code).toBe('RCBH');
      expect(body.name).toBe('The Literary Wanderer');
      expect(body.tagline).toBe('Voice and feeling, across every genre.');
      expect(body.hook).toBeTruthy();
      expect(body.lens).toEqual({
        score: expected.lens,
        letter: 'R',
        rationale: expected.lens_rationale,
      });
      expect(body.engine).toEqual({
        score: expected.engine,
        letter: 'C',
        rationale: expected.engine_rationale,
      });
      expect(body.range).toEqual({
        score: expected.range,
        letter: 'B',
        rationale: expected.range_rationale,
      });
      expect(body.resonance).toEqual({
        score: expected.resonance,
        letter: 'H',
        rationale: expected.resonance_rationale,
      });
      expect(typeof body.derived_at).toBe('string');
      expect(typeof body.is_stale).toBe('boolean');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});
