import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { cleanConstraints, applyDiscoveryConstraints } from '../recFilters';
import { discoveryPool } from '../recAssemble';

describe('cleanConstraints', () => {
  test('normalizes the supported keys and drops everything else', () => {
    expect(
      cleanConstraints({
        languages: ['ENG', ' fr ', ''],
        min_year: '1990',
        max_year: 2020,
        exclude_subjects: [' War ', 'grief', ''],
        page_count_max: 400,
        standalone: true,
      })
    ).toEqual({
      // Truncated to 2 chars AFTER strip + lowercase.
      languages: ['en', 'fr'],
      min_year: 1990,
      max_year: 2020,
      exclude_subjects: ['war', 'grief'],
    });
  });

  test('empty in, empty out — and empty lists never create a key', () => {
    expect(cleanConstraints({})).toEqual({});
    expect(cleanConstraints({ languages: [], exclude_subjects: [] })).toEqual({});
    expect(cleanConstraints({ languages: ['  '], exclude_subjects: [''] })).toEqual({});
  });

  test('years: int and all-digit string accepted; bool, float and non-digit rejected', () => {
    expect(cleanConstraints({ min_year: 1990 })).toEqual({ min_year: 1990 });
    expect(cleanConstraints({ min_year: ' 1990 ' })).toEqual({ min_year: 1990 });
    // Python: isinstance(True, int) is True, so bools are skipped EXPLICITLY first.
    expect(cleanConstraints({ min_year: true })).toEqual({});
    expect(cleanConstraints({ min_year: 1990.5 })).toEqual({});
    expect(cleanConstraints({ max_year: ' 20x0 ' })).toEqual({});
    expect(cleanConstraints({ max_year: '-1990' })).toEqual({}); // isdigit() is False for '-'
    expect(cleanConstraints({ max_year: null })).toEqual({});
  });
});

describe('applyDiscoveryConstraints', () => {
  const entry = (over: Record<string, unknown> = {}): [any, string] => [
    { title: 't', author: 'A', year: 2000, subjects: ['Fantasy'], ...over },
    'query:x',
  ];

  test('an empty constraints object is a no-op (Python: {} is falsy)', () => {
    const pool = [entry()];
    expect(applyDiscoveryConstraints(pool, {})).toBe(pool);
  });

  test('filters on year range, but only for integer years', () => {
    expect(applyDiscoveryConstraints([entry({ year: 1980 })], { min_year: 1990 })).toEqual([]);
    expect(applyDiscoveryConstraints([entry({ year: 2025 })], { max_year: 2020 })).toEqual([]);
    expect(applyDiscoveryConstraints([entry({ year: null })], { min_year: 1990 })).toHaveLength(1);
    // Python's isinstance(year, int) is False for a float -> the candidate passes.
    expect(applyDiscoveryConstraints([entry({ year: 1980.5 })], { min_year: 1990 })).toHaveLength(
      1
    );
  });

  test('drops candidates whose subjects hit an excluded term, whole-word only', () => {
    expect(
      applyDiscoveryConstraints([entry({ subjects: ['War Fiction'] })], {
        exclude_subjects: ['war'],
      })
    ).toEqual([]);
    expect(
      applyDiscoveryConstraints([entry({ subjects: ['Warmth'] })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
    expect(
      applyDiscoveryConstraints([entry({ subjects: null })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
  });

  test('has NO exclude_authors branch, unlike applyDirectiveConstraints', () => {
    // recommend._apply_discovery_constraints simply does not implement it. An
    // exclude_authors key is inert here. Reproduced deliberately.
    expect(
      applyDiscoveryConstraints([entry({ author: 'Herbert' })], { exclude_authors: ['herbert'] })
    ).toHaveLength(1);
  });

  test('preserves the (candidate, reason) pairing', () => {
    const out = applyDiscoveryConstraints([entry({ year: 2000 })], { min_year: 1990 });
    expect(out[0][1]).toBe('query:x');
  });
});

describe('discoveryPool', () => {
  test('runs BOTH sources per query, Google first, and tags each with its query', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay(
      {
        'https://www.googleapis.com/books/v1/volumes?q=cozy+fantasy&maxResults=2': {
          status: 200,
          body: { items: [{ id: 'g1', volumeInfo: { title: 'G' } }] },
        },
        'https://openlibrary.org/search.json?q=cozy+fantasy&limit=2&fields=key%2Ctitle%2Cauthor_name%2Cfirst_publish_year%2Ccover_i%2Cisbn%2Csubject%2Clanguage':
          { status: 200, body: { docs: [{ key: '/works/OL1W', title: 'O' }] } },
      },
      (u) => seen.push(u)
    );
    try {
      const pool = await discoveryPool(db, ['cozy fantasy'], 2);
      expect(pool.map(([c, r]) => [c.source, r])).toEqual([
        ['googlebooks', 'query:cozy fantasy'],
        ['openlibrary', 'query:cozy fantasy'],
      ]);
      // Order is load-bearing: it is what the recorded fixture replays.
      expect(seen[0]).toContain('googleapis.com');
      expect(seen[1]).toContain('openlibrary.org');
    } finally {
      restore();
      await close();
    }
  });

  test('an empty query list makes no requests', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      expect(await discoveryPool(db, [], 8)).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });
});
