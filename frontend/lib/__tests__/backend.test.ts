/** @jest-environment jsdom */
import {
  baseFor,
  getBackendChoice,
  setBackendChoice,
  NODE_DEFAULT_PREFIXES,
  NODE_ONLY_PREFIXES,
} from '../backend';

const PYTHON_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

beforeEach(() => {
  window.localStorage.clear();
  NODE_DEFAULT_PREFIXES.length = 0;
});

describe('backend switcher', () => {
  it('defaults to auto', () => {
    expect(getBackendChoice()).toBe('auto');
  });

  it('auto mode routes everything to Python while no prefixes are flipped', () => {
    expect(baseFor('/stats')).toBe(PYTHON_BASE);
    expect(baseFor('/books')).toBe(PYTHON_BASE);
  });

  it('auto mode routes flipped prefixes to Node', () => {
    NODE_DEFAULT_PREFIXES.push('/stats');
    expect(baseFor('/stats')).toBe('/api');
    expect(baseFor('/books')).toBe(PYTHON_BASE);
  });

  it('node choice routes everything to Node; python choice everything to Python', () => {
    setBackendChoice('node');
    expect(getBackendChoice()).toBe('node');
    expect(baseFor('/stats')).toBe('/api');
    setBackendChoice('python');
    expect(baseFor('/stats')).toBe(PYTHON_BASE);
  });

  it('node-only routes always go to Node, even under python choice', () => {
    setBackendChoice('python');
    expect(NODE_ONLY_PREFIXES).toContain('/admin/config');
    expect(baseFor('/admin/config')).toBe('/api');
  });
});
