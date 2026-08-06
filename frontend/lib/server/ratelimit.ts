/**
 * Fixed-window rate limiting on Postgres (rate_limits table) — the Node twin
 * of the Python SlowAPI per-user limits. One upsert per check; windows are
 * aligned to epoch multiples of windowSeconds. Old windows are deleted
 * opportunistically on each call (single-user scale — this is cheap).
 */
import { sql } from 'drizzle-orm';
import type { Db } from './db';

/** Parity with mylibrary/api.py decorators: 30/minute catalog search, 5/minute enrich
 *  start, 30/minute directive draft. Each route uses its own bucket key — these limits
 *  are independent, not shared. */
export const RATE_LIMITS = {
  catalogSearch: { limit: 30, windowSeconds: 60 },
  enrichStart: { limit: 5, windowSeconds: 60 },
  directiveDraft: { limit: 30, windowSeconds: 60 },
} as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  db: Db,
  opts: { key: string; limit: number; windowSeconds: number; nowMs?: number }
): Promise<RateLimitResult> {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const windowStart = nowSec - (nowSec % opts.windowSeconds);

  const result = await db.execute(sql`
    insert into rate_limits (bucket_key, window_start, count)
    values (${opts.key}, ${windowStart}, 1)
    on conflict (bucket_key, window_start)
      do update set count = rate_limits.count + 1
    returning count
  `);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  const count = Number((rows[0] as { count: number | string }).count);

  // Opportunistic cleanup of expired windows for this key.
  await db.execute(
    sql`delete from rate_limits where bucket_key = ${opts.key} and window_start < ${windowStart}`
  );

  return {
    allowed: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
    retryAfterSeconds: windowStart + opts.windowSeconds - nowSec,
  };
}
