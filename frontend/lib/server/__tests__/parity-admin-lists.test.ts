import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET as adminUsage } from '../../../app/api/admin/usage/route';
import { GET as adminFeedback } from '../../../app/api/admin/feedback/route';

/**
 * usage_events.created_at comes from the seed's {"$hoursAgo": N} sentinel, so it
 * resolves against the *run* clock on Node and against the *recording* clock in the
 * fixture — they can never be equal. Mask the value on both sides, preserving null,
 * exactly as write-parity.ts::maskVolatile does for its volatile keys.
 *
 * Nothing about the route is lost. Row ORDER is still compared (the events array is
 * compared element-wise and every event carries a distinct id), and tsToIso's actual
 * formatting is exactly compared by the seeded-roster case in parity-admin-reads.test.ts,
 * whose invites.created_at values are fixed strings. Only the unstable value is dropped.
 */
function maskEventTimestamps(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = body as { events?: unknown };
  if (!Array.isArray(b.events)) return body;
  return {
    ...b,
    events: b.events.map((e) => {
      const ev = e as Record<string, unknown>;
      return { ...ev, created_at: ev.created_at === null ? null : '<set>' };
    }),
  };
}

describe('GET /api/admin/usage parity', () => {
  setupParityEnv();
  test('empty', () => checkParity('empty', 'GET /admin/usage', adminUsage, maskEventTimestamps));
  test('seeded', () => checkParity('seeded', 'GET /admin/usage', adminUsage, maskEventTimestamps));
  test('paginated', () =>
    checkParity('seeded', 'GET /admin/usage?limit=2&offset=1', adminUsage, maskEventTimestamps));
});

describe('GET /api/admin/feedback parity', () => {
  setupParityEnv();
  test('empty', () => checkParity('empty', 'GET /admin/feedback', adminFeedback));
  test('seeded', () => checkParity('seeded', 'GET /admin/feedback', adminFeedback));
  test('filtered by category', () =>
    checkParity('seeded', 'GET /admin/feedback?category=bug', adminFeedback));
  test('paginated', () =>
    checkParity('seeded', 'GET /admin/feedback?limit=2&offset=1', adminFeedback));
});
