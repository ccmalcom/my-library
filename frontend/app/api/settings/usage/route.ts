import { and, eq, gte } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { round4 } from '@/lib/server/serialize';

/** Port of usage.py::cap_status — month-to-date spend, soft-warn only. */
export const GET = withApi('/api/settings/usage', async (_req, ctx) => {
  // `??` only falls back on null/undefined — an explicitly empty-string env var (a real
  // state in local isolated-env setups, and a possible deployment misconfiguration) would
  // otherwise parseFloat('') into NaN and silently poison cap_usd/pct/warn. Empty string is
  // falsy in JS, so `||` treats unset and empty-string the same way.
  const cap = parseFloat(process.env.MYLIBRARY_MONTHLY_SOFT_CAP_USD || '5.0');
  const warnThreshold = parseFloat(process.env.MYLIBRARY_USAGE_WARN_THRESHOLD || '0.8');

  const now = new Date();
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00`;

  const db = getDb();
  const rows = await db
    .select({
      operation: schema.usageEvents.operation,
      costUsd: schema.usageEvents.costUsd,
    })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.userId, ctx.user.userId),
        gte(schema.usageEvents.createdAt, monthStart)
      )
    );
  ctx.timer.mark('db');

  let spent = 0;
  const byOp: Record<string, number> = {};
  for (const r of rows) {
    const c = r.costUsd ?? 0;
    spent += c;
    byOp[r.operation] = (byOp[r.operation] ?? 0) + c;
  }
  const pct = cap > 0 ? spent / cap : 0;
  return Response.json({
    spent_usd: round4(spent),
    cap_usd: cap,
    pct: round4(pct),
    warn: pct >= warnThreshold,
    by_operation: Object.fromEntries(Object.entries(byOp).map(([k, v]) => [k, round4(v)])),
  });
});
