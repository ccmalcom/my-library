/** @jest-environment jsdom */
import { baseFor, getBackendChoice, setBackendChoice, NODE_DEFAULT_ROUTES, pythonBase } from '../backend';

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

  test('auto: wave-3/wave-4 paths (and books/directive siblings) stay on Python', () => {
    expect(baseFor('/books/12/similar', 'POST')).toBe(PY); // wave-3 Claude flow (wave-3c)
    expect(baseFor('/library', 'DELETE')).toBe(PY); // wave-4 purge
    expect(baseFor('/account', 'DELETE')).toBe(PY);
  });

  test('auto: unflipped paths stay on Python', () => {
    expect(baseFor('/export', 'GET')).toBe(PY);
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

  test('wave-2/3a flip list is exactly as designed', () => {
    expect(NODE_DEFAULT_ROUTES).toEqual([
      { prefix: '/stats' },
      { prefix: '/books', methods: ['GET', 'PATCH', 'DELETE'] },
      { prefix: '/books', methods: ['POST'], exact: true },
      { prefix: '/catalog/search' },
      { prefix: '/profile/archetype', methods: ['POST'], exact: true },
      { prefix: '/profile/reveal-lines', methods: ['POST'], exact: true },
      { prefix: '/directive/draft', methods: ['POST'], exact: true },
      { prefix: '/profile', methods: ['POST'], exact: true },
      { prefix: '/profile/update', methods: ['POST'], exact: true },
      { prefix: '/profile', methods: ['GET', 'PATCH'] },
      { prefix: '/recommendations', methods: ['GET', 'PATCH'] },
      { prefix: '/settings', methods: ['GET', 'PUT', 'DELETE'] },
      { prefix: '/directive', methods: ['GET', 'PUT', 'DELETE'], exact: true },
      { prefix: '/feedback' },
      { prefix: '/taste-signal' },
    ]);
  });

  test('wave-3a: catalog search and POST routes flip to Node', () => {
    // wave-3a: flipped to Node
    expect(baseFor('/catalog/search?q=dune', 'GET')).toBe('/api');
    expect(baseFor('/directive/draft', 'POST')).toBe('/api');
    expect(baseFor('/profile/archetype', 'POST')).toBe('/api');
    expect(baseFor('/profile/reveal-lines', 'POST')).toBe('/api');
    // still Python — 3c/4/5
    expect(baseFor('/recommend', 'POST')).toBe(PY); // 3c
    expect(baseFor('/books/12/similar', 'POST')).toBe(PY); // 3c
    expect(baseFor('/discover', 'POST')).toBe(PY); // 3c
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

  it('leaves DELETE /profile on Python (not ported in wave 3b)', () => {
    expect(baseFor('/profile', 'DELETE')).toBe(pythonBase());
  });

  it('does not let the exact POST /profile rule swallow sub-paths', () => {
    // /profile/subjects has no POST in Python; the point is that the exact rule
    // must not match sub-paths generically.
    expect(baseFor('/profile/subjects', 'POST')).toBe(pythonBase());
  });
});
