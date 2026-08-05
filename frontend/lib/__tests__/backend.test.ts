/** @jest-environment jsdom */
import {
  baseFor,
  getBackendChoice,
  setBackendChoice,
  NODE_DEFAULT_ROUTES,
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

  test('auto: wave-3/wave-4 paths (and books/directive siblings) stay on Python', () => {
    expect(baseFor('/books/12/similar', 'POST')).toBe(PY); // wave-3 Claude flow
    expect(baseFor('/catalog/search?q=x', 'GET')).toBe(PY); // wave-3 catalog cache
    expect(baseFor('/directive/draft', 'POST')).toBe(PY); // wave-3 distill
    expect(baseFor('/profile', 'POST')).toBe(PY); // profile build
    expect(baseFor('/profile/archetype', 'POST')).toBe(PY); // profile build (sub-path)
    expect(baseFor('/library', 'DELETE')).toBe(PY); // wave-4 purge
    expect(baseFor('/account', 'DELETE')).toBe(PY);
  });

  test('auto: unflipped paths stay on Python', () => {
    expect(baseFor('/catalog/search?q=x', 'GET')).toBe(PY);
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

  test('wave-2 flip list is exactly as designed', () => {
    expect(NODE_DEFAULT_ROUTES).toEqual([
      { prefix: '/stats' },
      { prefix: '/books', methods: ['GET', 'PATCH', 'DELETE'] },
      { prefix: '/books', methods: ['POST'], exact: true },
      { prefix: '/profile', methods: ['GET', 'PATCH'] },
      { prefix: '/recommendations', methods: ['GET', 'PATCH'] },
      { prefix: '/settings', methods: ['GET', 'PUT', 'DELETE'] },
      { prefix: '/directive', methods: ['GET', 'PUT', 'DELETE'], exact: true },
      { prefix: '/feedback' },
      { prefix: '/taste-signal' },
    ]);
  });
});
