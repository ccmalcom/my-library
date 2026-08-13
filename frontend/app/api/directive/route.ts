import { eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { tsToIso, utcnowTs } from '@/lib/server/serialize';
import { cleanDirectiveConstraints } from '@/lib/server/directive';

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
  const meaningful = row && (row.nlText || Object.keys(constraints).length > 0);
  if (!meaningful) return Response.json(EMPTY);
  return Response.json({
    nl_text: row.nlText,
    constraints,
    updated_at: tsToIso(row.updatedAt),
  });
});

export const PUT = withApi('/api/directive', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (typeof raw?.nl_text === 'string' ? raw.nl_text : '').trim();
  const cleaned = cleanDirectiveConstraints(raw?.constraints);
  if (!text && !Object.keys(cleaned).length) {
    throw new ApiError(422, 'Custom instructions must not be empty.');
  }
  const db = getDb();
  const after = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.userDirective)
      .where(eq(schema.userDirective.userId, ctx.user.userId));
    if (rows[0]) {
      await tx
        .update(schema.userDirective)
        .set({
          nlText: text || null,
          constraints: Object.keys(cleaned).length ? cleaned : null,
          updatedAt: utcnowTs(), // ORM onupdate twin — only the update branch stamps it
        })
        .where(eq(schema.userDirective.id, rows[0].id));
    } else {
      await tx.insert(schema.userDirective).values({
        userId: ctx.user.userId,
        nlText: text || null,
        constraints: Object.keys(cleaned).length ? cleaned : null,
      });
    }
    // Python re-reads via get_directive and returns the same shape as GET.
    return (
      await tx
        .select()
        .from(schema.userDirective)
        .where(eq(schema.userDirective.userId, ctx.user.userId))
    )[0];
  });
  const constraints = (after?.constraints ?? {}) as Record<string, unknown>;
  const meaningful = after && (after.nlText || Object.keys(constraints).length > 0);
  ctx.timer.mark('db');
  if (!meaningful) return Response.json(EMPTY);
  return Response.json({
    nl_text: after.nlText,
    constraints,
    updated_at: tsToIso(after.updatedAt),
  });
});

export const DELETE = withApi('/api/directive', async (_req, ctx) => {
  const db = getDb();
  await db.delete(schema.userDirective).where(eq(schema.userDirective.userId, ctx.user.userId));
  ctx.timer.mark('db');
  return Response.json(EMPTY);
});
