import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { round4, tsToIso } from '@/lib/server/serialize';

/** Python: Query(50, ge=1, le=200) and Query(0, ge=0) -> 422 outside the range. */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(422, 'validation error: query parameter out of range');
  }
  return n;
}

/** Port of usage.py::admin_list_usage — all users, newest first, paginated. */
export const GET = withApi(
  '/api/admin/usage',
  async (req, ctx) => {
    const url = new URL(req.url);
    const limit = intParam(url.searchParams.get('limit'), 50, 1, 200);
    const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const userId = url.searchParams.get('user_id');
    const operation = url.searchParams.get('operation');

    const filters: SQL[] = [];
    if (userId) filters.push(eq(schema.usageEvents.userId, userId));
    if (operation) filters.push(eq(schema.usageEvents.operation, operation));
    const where = filters.length ? and(...filters) : undefined;

    const db = getDb();
    const [agg] = await db
      .select({
        total: sql<number>`count(*)`,
        totalCost: sql<number>`coalesce(sum(${schema.usageEvents.costUsd}), 0.0)`,
      })
      .from(schema.usageEvents)
      .where(where);

    const rows = await db
      .select()
      .from(schema.usageEvents)
      .where(where)
      .orderBy(desc(schema.usageEvents.createdAt), desc(schema.usageEvents.id))
      .limit(limit)
      .offset(offset);
    ctx.timer.mark('db');

    const rowUserIds = [...new Set(rows.map((r) => r.userId))];
    const emails = new Map<string, string>();
    if (rowUserIds.length) {
      const invites = await db
        .select({ sid: schema.invites.supabaseUserId, email: schema.invites.email })
        .from(schema.invites)
        .where(inArray(schema.invites.supabaseUserId, rowUserIds));
      for (const i of invites) if (i.sid) emails.set(i.sid, i.email);
    }

    return Response.json({
      events: rows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        // Python: emails.get(row.user_id) -> None when absent, not omitted.
        email: emails.get(row.userId) ?? null,
        model: row.model,
        operation: row.operation,
        input_tokens: row.inputTokens ?? 0,
        output_tokens: row.outputTokens ?? 0,
        cache_creation_input_tokens: row.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: row.cacheReadInputTokens ?? 0,
        // NOT rounded -- Python emits float(row.cost_usd or 0.0) per event and
        // rounds only the aggregate below.
        cost_usd: row.costUsd ?? 0.0,
        created_at: tsToIso(row.createdAt),
      })),
      total: Number(agg?.total ?? 0),
      // round(x, 4) in CPython is banker's rounding on the exact binary value.
      // round4 routes through pyRound; Math.round(x*1e4)/1e4 disagrees on ties.
      total_cost_usd: round4(Number(agg?.totalCost ?? 0)),
      limit,
      offset,
    });
  },
  { requireAdmin: true }
);
