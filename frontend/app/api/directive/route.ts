import { eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';

const EMPTY = { nl_text: null, constraints: {}, updated_at: null };

export const GET = withApi('/api/directive', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, ctx.user.userId));
  ctx.timer.mark('db');
  const row = rows[0];
  // Python truthiness: `not (row.nl_text or row.constraints)` — an empty dict is
  // falsy in Python, so nl_text='' + constraints={} → the EMPTY shape.
  const constraints = (row?.constraints ?? {}) as Record<string, unknown>;
  const meaningful =
    row && (row.nlText || Object.keys(constraints).length > 0);
  if (!meaningful) return Response.json(EMPTY);
  return Response.json({
    nl_text: row.nlText,
    constraints,
    updated_at: tsToIso(row.updatedAt),
  });
});
