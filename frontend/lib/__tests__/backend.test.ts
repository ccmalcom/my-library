/** @jest-environment jsdom */
import {
  baseFor,
  getBackendChoice,
  setBackendChoice,
  NODE_DEFAULT_ROUTES,
  pythonBase,
} from '../backend';

const PY = 'https://python.example';

describe('backend switcher (method-aware)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    process.env.NEXT_PUBLIC_API_URL = PY;
  });

  test('auto: wave-1 GETs go to Node', () => {
    expect(baseFor('/stats', 'GET')).toBe('/api');
    expect(baseFor('/books?shelf=read', 'GET')).toBe('/api');
    expect(baseFor('/profile/status', 'GET')).toBe('/api');
    expect(baseFor('/recommendations/rejected', 'GET')).toBe('/api');
    expect(baseFor('/settings/usage', 'GET')).toBe('/api');
    expect(baseFor('/directive', 'GET')).toBe('/api');
  });

  test('auto: wave-2 writes flip to Node', () => {
    expect(baseFor('/books', 'POST')).toBe('/api');
    expect(baseFor('/books/12/feedback', 'PATCH')).toBe('/api');
    expect(baseFor('/books/12/shelf', 'PATCH')).toBe('/api');
    expect(baseFor('/books/12/enrichment', 'PATCH')).toBe('/api');
    expect(baseFor('/books/12', 'DELETE')).toBe('/api');
    expect(baseFor('/recommendations/3/feedback', 'PATCH')).toBe('/api');
    expect(baseFor('/settings/api-key', 'PUT')).toBe('/api');
    expect(baseFor('/settings/api-key', 'DELETE')).toBe('/api');
    expect(baseFor('/settings/profile', 'PUT')).toBe('/api');
    expect(baseFor('/directive', 'PUT')).toBe('/api');
    expect(baseFor('/directive', 'DELETE')).toBe('/api');
    expect(baseFor('/profile/traits/5', 'PATCH')).toBe('/api');
    expect(baseFor('/feedback', 'POST')).toBe('/api');
    expect(baseFor('/feedback/prompt', 'GET')).toBe('/api');
    expect(baseFor('/feedback/dismiss', 'POST')).toBe('/api');
    expect(baseFor('/taste-signal', 'POST')).toBe('/api');
  });

  test('auto: wave-4b import/export routes go to Node; wave 4c stays on Python', () => {
    expect(baseFor('/library', 'DELETE')).toBe('/api');
    expect(baseFor('/profile', 'DELETE')).toBe('/api');
    expect(baseFor('/account', 'DELETE')).toBe('/api');
    expect(baseFor('/import/preview', 'POST')).toBe('/api');
    expect(baseFor('/import', 'POST')).toBe('/api');
    expect(baseFor('/export', 'GET')).toBe('/api');
    expect(baseFor('/enrich/start', 'POST')).toBe(PY);
  });

  test('wave-4b rules are exact and method-specific', () => {
    expect(baseFor('/import/preview', 'GET')).toBe(PY);
    expect(baseFor('/import/preview/child', 'POST')).toBe(PY);
    expect(baseFor('/import', 'GET')).toBe(PY);
    expect(baseFor('/import/child', 'POST')).toBe(PY);
    expect(baseFor('/export?format=json', 'GET')).toBe('/api');
    expect(baseFor('/export', 'POST')).toBe(PY);
    expect(baseFor('/export/history', 'GET')).toBe(PY);
  });

  test('auto: wave-4c-1 synchronous enrich goes to Node; background enrichment stays Python', () => {
    expect(baseFor('/enrich', 'POST')).toBe('/api');
    expect(baseFor('/enrich', 'GET')).toBe(PY);
    expect(baseFor('/enrich/child', 'POST')).toBe(PY);
    expect(baseFor('/enrich/start', 'POST')).toBe(PY);
    expect(baseFor('/enrich/status/job-1', 'GET')).toBe(PY);
  });

  test('node-only prefixes always hit Node', () => {
    expect(baseFor('/admin/config', 'GET')).toBe('/api');
    setBackendChoice('python');
    expect(baseFor('/admin/config', 'PUT')).toBe('/api');
  });

  test('forced overrides win for everything else', () => {
    setBackendChoice('python');
    expect(baseFor('/stats', 'GET')).toBe(PY);
    setBackendChoice('node');
    expect(baseFor('/import', 'POST')).toBe('/api');
    setBackendChoice('auto');
    expect(getBackendChoice()).toBe('auto');
  });

  test('default method is GET', () => {
    expect(baseFor('/stats')).toBe('/api');
  });

  test('wave-2/3a/3b/3c/4a/4b/4c-1 flip list is exactly as designed', () => {
    expect(NODE_DEFAULT_ROUTES).toEqual([
      { prefix: '/stats' },
      { prefix: '/books', methods: ['GET', 'PATCH', 'DELETE'] },
      // wave 3c-2 dropped `exact` here so POST /books/{id}/similar follows POST
      // /books to Node; the behavior assertions below guard both halves.
      { prefix: '/books', methods: ['POST'] },
      { prefix: '/catalog/search' },
      { prefix: '/profile/archetype', methods: ['POST'], exact: true },
      { prefix: '/profile/reveal-lines', methods: ['POST'], exact: true },
      { prefix: '/directive/draft', methods: ['POST'], exact: true },
      { prefix: '/profile', methods: ['POST'], exact: true },
      { prefix: '/profile/update', methods: ['POST'], exact: true },
      { prefix: '/recommend', methods: ['POST'], exact: true },
      { prefix: '/discover', methods: ['POST'], exact: true }, // wave 3c-3
      { prefix: '/profile', methods: ['GET', 'PATCH'] },
      { prefix: '/recommendations', methods: ['GET', 'PATCH'] },
      { prefix: '/settings', methods: ['GET', 'PUT', 'DELETE'] },
      { prefix: '/directive', methods: ['GET', 'PUT', 'DELETE'], exact: true },
      { prefix: '/feedback' },
      { prefix: '/taste-signal' },
      { prefix: '/library', methods: ['DELETE'], exact: true },
      { prefix: '/profile', methods: ['DELETE'], exact: true },
      { prefix: '/account', methods: ['DELETE'], exact: true },
      { prefix: '/import/preview', methods: ['POST'], exact: true },
      { prefix: '/import', methods: ['POST'], exact: true },
      { prefix: '/export', methods: ['GET'], exact: true },
      { prefix: '/enrich', methods: ['POST'], exact: true },
    ]);
  });

  test('wave-3a: catalog search and POST routes flip to Node', () => {
    // wave-3a: flipped to Node
    expect(baseFor('/catalog/search?q=dune', 'GET')).toBe('/api');
    expect(baseFor('/directive/draft', 'POST')).toBe('/api');
    expect(baseFor('/profile/archetype', 'POST')).toBe('/api');
    expect(baseFor('/profile/reveal-lines', 'POST')).toBe('/api');
    expect(baseFor('/recommend', 'POST')).toBe('/api'); // wave 3c-1
    // Guard the exact-match rule: the recommendations group must NOT follow it to Node.
    expect(baseFor('/recommendations', 'POST')).toBe(PY);
    expect(baseFor('/recommendations/12/feedback', 'POST')).toBe(PY);
    expect(baseFor('/books/12/similar', 'POST')).toBe('/api'); // wave 3c-2
    // The POST /books rule is no longer `exact`; both it and its /similar child
    // are Node, and GET/PATCH/DELETE children are unaffected.
    expect(baseFor('/books', 'POST')).toBe('/api');
    expect(baseFor('/books/12', 'DELETE')).toBe('/api');
    expect(baseFor('/discover', 'POST')).toBe('/api'); // wave 3c-3
    // still Python — waves 4/5
    expect(baseFor('/enrich/start', 'POST')).toBe(PY); // wave 4
    expect(baseFor('/admin/users', 'GET')).toBe(PY); // wave 5
    // unchanged from waves 1-2
    expect(baseFor('/directive', 'PUT')).toBe('/api');
    expect(baseFor('/profile/archetype', 'GET')).toBe('/api');
  });

  it('routes POST /profile and POST /profile/update to Node in auto mode', () => {
    expect(baseFor('/profile', 'POST')).toBe('/api');
    expect(baseFor('/profile/update', 'POST')).toBe('/api');
  });

  it('uses an exact method-specific rule for DELETE /profile', () => {
    expect(baseFor('/profile', 'DELETE')).toBe('/api');
    expect(baseFor('/profile/status', 'DELETE')).toBe(PY);
    expect(baseFor('/profile/subjects', 'DELETE')).toBe(PY);
  });

  it('does not let the exact POST /profile rule swallow sub-paths', () => {
    // /profile/subjects has no POST in Python; the point is that the exact rule
    // must not match sub-paths generically.
    expect(baseFor('/profile/subjects', 'POST')).toBe(pythonBase());
  });
});
