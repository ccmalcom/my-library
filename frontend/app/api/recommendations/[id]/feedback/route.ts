import { eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { bookOut } from '@/lib/server/books';
import { ensureLibraryBook, REJECT_REASONS } from '@/lib/server/recs';
import { ensureProfileMeta } from '@/lib/server/profileMeta';
import { parseIdParam, utcnowTs, pyList } from '@/lib/server/serialize';

/** Port of api.py::feedback (PATCH /recommendations/{id}/feedback) — the swipe-decision
 *  route. "Provided" means key present in the raw JSON body (Pydantic's
 *  model_fields_set), NOT "value is non-null" — hence the manual `raw` inspection
 *  below instead of a zod schema, which would collapse that distinction. */
export const PATCH = withApi('/api/recommendations/[id]/feedback', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') {
    throw new ApiError(422, 'validation error: invalid body');
  }
  const statusProvided = 'status' in raw;
  const userNoteProvided = 'user_note' in raw;
  const status = raw.status as string | null;
  const userNote = raw.user_note as string | null;
  const rejectReasons = (raw.reject_reasons ?? null) as string[] | null;
  const rejectReasonsProvided = rejectReasons !== null;

  const VALID = ['accepted', 'rejected', 'already_read'];
  if (statusProvided && !VALID.includes(status as string)) {
    // Python interpolates a set repr here — order is hash-seed-dependent, so this
    // exact string is a documented deviation; the fixture step is maskDetail'd.
    throw new ApiError(422, "status must be one of {'accepted', 'rejected', 'already_read'}");
  }
  if (!statusProvided && !userNoteProvided && !rejectReasonsProvided) {
    throw new ApiError(422, 'Provide status and/or user_note');
  }
  if (rejectReasonsProvided && (statusProvided ? status : null) !== 'rejected') {
    throw new ApiError(422, "reject_reasons may only be provided when status is 'rejected'");
  }
  if (rejectReasonsProvided) {
    const valid = rejectReasons.length > 0 && rejectReasons.every((r) => (REJECT_REASONS as readonly string[]).includes(r));
    if (!valid) {
      if (rejectReasons.length === 0) {
        throw new ApiError(422, `reject_reasons must be a non-empty list. Valid codes: ${pyList([...REJECT_REASONS])}`);
      }
      const unknown = rejectReasons.filter((r) => !(REJECT_REASONS as readonly string[]).includes(r));
      throw new ApiError(422, `Unknown reject_reasons: ${pyList(unknown)}. Valid codes: ${pyList([...REJECT_REASONS])}`);
    }
  }

  const recId = parseIdParam(ctx.params.id);
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const recs = await tx.select().from(schema.recommendations)
      .where(eq(schema.recommendations.id, recId));
    const rec = recs[0];
    if (!rec || rec.userId !== ctx.user.userId) {
      throw new ApiError(404, `Recommendation ${recId} not found`);
    }

    const updates: Partial<typeof rec> = {};
    if (statusProvided) updates.status = status as string;
    if (userNoteProvided) updates.userNote = userNote;
    if (rejectReasonsProvided) {
      updates.rejectReasons = rejectReasons;
      const meta = await ensureProfileMeta(tx, ctx.user.userId);
      await tx.update(schema.profileMeta).set({ recFeedbackUpdatedAt: utcnowTs() })
        .where(eq(schema.profileMeta.id, meta.id));
    }
    if (Object.keys(updates).length) {
      await tx.update(schema.recommendations).set(updates)
        .where(eq(schema.recommendations.id, recId));
    }
    const updated = { ...rec, ...updates };

    // Python: `req.status or rec.status` — falls back when status wasn't provided.
    const effective = (statusProvided && status) || updated.status;
    let book: unknown = null;
    if (effective === 'accepted') {
      const r = await ensureLibraryBook(tx, updated, 'to-read', ctx.user.userId);
      book = bookOut(r.book, r.enrichment);
    } else if (effective === 'already_read') {
      const r = await ensureLibraryBook(tx, updated, 'read', ctx.user.userId);
      book = bookOut(r.book, r.enrichment);
    }
    return { status: updated.status, user_note: updated.userNote, book };
  });
  ctx.timer.mark('db');
  return Response.json(result);
});
