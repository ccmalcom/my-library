import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(422, 'validation error: query parameter out of range');
  }
  return n;
}

/** Port of feedback.py::admin_list_feedback — all users, newest first, paginated. */
export const GET = withApi(
  '/api/admin/feedback',
  async (req, ctx) => {
    const url = new URL(req.url);
    const limit = intParam(url.searchParams.get('limit'), 50, 1, 200);
    const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const userId = url.searchParams.get('user_id');
    const category = url.searchParams.get('category');

    const filters: SQL[] = [];
    if (userId) filters.push(eq(schema.feedback.userId, userId));
    if (category) filters.push(eq(schema.feedback.category, category));
    const where = filters.length ? and(...filters) : undefined;

    const db = getDb();
    const [agg] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.feedback)
      .where(where);

    const rows = await db
      .select()
      .from(schema.feedback)
      .where(where)
      .orderBy(desc(schema.feedback.createdAt), desc(schema.feedback.id))
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
      items: rows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        email: emails.get(row.userId) ?? null,
        category: row.category,
        body: row.body,
        trigger: row.trigger,
        run_id: row.runId,
        page: row.page,
        app_version: row.appVersion,
        created_at: tsToIso(row.createdAt),
      })),
      total: Number(agg?.total ?? 0),
      limit,
      offset,
    });
  },
  { requireAdmin: true }
);
