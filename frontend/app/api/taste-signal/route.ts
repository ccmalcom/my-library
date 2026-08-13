import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { utcnowTs, tsToIso } from '@/lib/server/serialize';
import { ensureProfileMeta } from '@/lib/server/profileMeta';

const Body = z.object({
  direction: z.enum(['more', 'less']), // Pydantic Literal → schema-level 422 (string-detail deviation)
  target_kind: z.enum(['book', 'rec']),
  target_book_id: z.number().int().nullish(),
  snapshot: z.record(z.string(), z.unknown()).nullish(),
});

/** Port of library.py::record_taste_signal via api.py::post_taste_signal. Persists a
 *  more/less-like-this steering signal and dirties the profile (bumps
 *  ProfileMeta.rec_feedback_updated_at) so the next build incorporates it. */
export const POST = withApi('/api/taste-signal', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const b = parsed.data;
  const db = getDb();

  if (b.target_kind === 'book') {
    if (b.target_book_id == null) {
      throw new ApiError(422, 'target_book_id is required for book-kind signals');
    }
    const rows = await db
      .select()
      .from(schema.books)
      .where(and(eq(schema.books.id, b.target_book_id), eq(schema.books.userId, ctx.user.userId)));
    // NOTE: no trailing period — this 404 comes from record_taste_signal, unlike library.py's.
    if (!rows[0]) throw new ApiError(404, `Book ${b.target_book_id} not found`);
  } else if (b.target_kind === 'rec') {
    // Python `if not snapshot` — empty object is falsy too.
    if (!b.snapshot || Object.keys(b.snapshot).length === 0) {
      throw new ApiError(422, 'snapshot is required for rec-kind signals');
    }
  }

  const signal = await db.transaction(async (tx) => {
    const [signal] = await tx
      .insert(schema.tasteSignal)
      .values({
        userId: ctx.user.userId,
        direction: b.direction,
        targetKind: b.target_kind,
        targetBookId: b.target_book_id ?? null,
        snapshot: b.snapshot ?? null,
        createdAt: utcnowTs(),
      })
      .returning();

    const meta = await ensureProfileMeta(tx, ctx.user.userId);
    await tx
      .update(schema.profileMeta)
      .set({ recFeedbackUpdatedAt: utcnowTs() })
      .where(eq(schema.profileMeta.id, meta.id));
    return signal;
  });

  ctx.timer.mark('db');
  return Response.json(
    {
      id: signal.id,
      direction: signal.direction,
      target_kind: signal.targetKind,
      target_book_id: signal.targetBookId,
      snapshot: signal.snapshot,
      created_at: tsToIso(signal.createdAt),
    },
    { status: 201 }
  );
});
