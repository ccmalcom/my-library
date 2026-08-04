/** @jest-environment jsdom */
import {
  baseFor,
  getBackendChoice,
  setBackendChoice,
  NODE_DEFAULT_ROUTES,
} from '../backend';

describe('backend switcher (method-aware)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    process.env.NEXT_PUBLIC_API_URL = 'https://python.example';
  });

  test('auto: wave-1 GETs go to Node', () => {
    expect(baseFor('/stats', 'GET')).toBe('/api');
    expect(baseFor('/books?shelf=read', 'GET')).toBe('/api');
    expect(baseFor('/profile/status', 'GET')).toBe('/api');
    expect(baseFor('/recommendations/rejected', 'GET')).toBe('/api');
    expect(baseFor('/settings/usage', 'GET')).toBe('/api');
    expect(baseFor('/directive', 'GET')).toBe('/api');
  });

  test('auto: writes on flipped prefixes stay on Python', () => {
    expect(baseFor('/books', 'POST')).toBe('https://python.example');
    expect(baseFor('/profile/traits/3', 'PATCH')).toBe('https://python.example');
    expect(baseFor('/recommendations/9/feedback', 'PATCH')).toBe('https://python.example');
    expect(baseFor('/settings/api-key', 'PUT')).toBe('https://python.example');
    expect(baseFor('/directive', 'DELETE')).toBe('https://python.example');
    expect(baseFor('/profile/archetype', 'POST')).toBe('https://python.example');
  });

  test('auto: unflipped paths stay on Python', () => {
    expect(baseFor('/catalog/search?q=x', 'GET')).toBe('https://python.example');
    expect(baseFor('/export', 'GET')).toBe('https://python.example');
  });

  test('node-only prefixes always hit Node', () => {
    expect(baseFor('/admin/config', 'GET')).toBe('/api');
    setBackendChoice('python');
    expect(baseFor('/admin/config', 'PUT')).toBe('/api');
  });

  test('forced overrides win for everything else', () => {
    setBackendChoice('python');
    expect(baseFor('/stats', 'GET')).toBe('https://python.example');
    setBackendChoice('node');
    expect(baseFor('/import', 'POST')).toBe('/api');
    setBackendChoice('auto');
    expect(getBackendChoice()).toBe('auto');
  });

  test('default method is GET', () => {
    expect(baseFor('/stats')).toBe('/api');
  });

  test('wave-1 flip list is exactly as designed', () => {
    expect(NODE_DEFAULT_ROUTES).toEqual([
      { prefix: '/stats' },
      { prefix: '/books', methods: ['GET'] },
      { prefix: '/profile', methods: ['GET'] },
      { prefix: '/recommendations', methods: ['GET'] },
      { prefix: '/settings', methods: ['GET'] },
      { prefix: '/directive', methods: ['GET'] },
    ]);
  });
});
