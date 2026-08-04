import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { checkRateLimit, RATE_LIMITS } from '../ratelimit';
import type { Db } from '../db';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => close());

describe('checkRateLimit', () => {
  it('allows up to the limit inside one window, then blocks', async () => {
    const opts = { key: 'search:local', limit: 3, windowSeconds: 60, nowMs: 120_000 };
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(db, opts);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(2 - i);
    }
    const blocked = await checkRateLimit(db, opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('resets in the next window', async () => {
    const base = { key: 'k', limit: 1, windowSeconds: 60 };
    expect((await checkRateLimit(db, { ...base, nowMs: 30_000 })).allowed).toBe(true);
    expect((await checkRateLimit(db, { ...base, nowMs: 31_000 })).allowed).toBe(false);
    expect((await checkRateLimit(db, { ...base, nowMs: 61_000 })).allowed).toBe(true);
  });

  it('tracks keys independently', async () => {
    const a = { key: 'a', limit: 1, windowSeconds: 60, nowMs: 10_000 };
    const b = { key: 'b', limit: 1, windowSeconds: 60, nowMs: 10_000 };
    expect((await checkRateLimit(db, a)).allowed).toBe(true);
    expect((await checkRateLimit(db, b)).allowed).toBe(true);
    expect((await checkRateLimit(db, a)).allowed).toBe(false);
  });

  it('exposes the Python parity limits', () => {
    expect(RATE_LIMITS.catalogSearch).toEqual({ limit: 30, windowSeconds: 60 });
    expect(RATE_LIMITS.enrichStart).toEqual({ limit: 5, windowSeconds: 60 });
  });
});
