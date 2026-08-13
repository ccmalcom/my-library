import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { effectiveRating, tsToIso } from '@/lib/server/serialize';

/** Port of library.py::profile_status (read-only — see Interfaces note). */
export const GET = withApi('/api/profile/status', async (_req, ctx) => {
  const db = getDb();
  const userId = ctx.user.userId;

  const metaRows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  const meta = metaRows[0] ?? null;
  const since = meta?.lastProfiledAt ?? null;

  const changedWhere = since
    ? and(
        eq(schema.books.userId, userId),
        isNotNull(schema.books.feedbackUpdatedAt),
        gt(schema.books.feedbackUpdatedAt, since)
      )
    : and(eq(schema.books.userId, userId), isNotNull(schema.books.feedbackUpdatedAt));
  const candidates = await db
    .select()
    .from(schema.books)
    .where(changedWhere)
    .orderBy(asc(schema.books.id));
  const changed = candidates.filter(
    (b) =>
      effectiveRating(b.appRating, b.goodreadsRating) !== null ||
      b.exclusiveShelf === 'did-not-finish' ||
      b.isFavorite
  );

  const verdictWhere = since
    ? and(
        eq(schema.tasteTraits.userId, userId),
        isNotNull(schema.tasteTraits.verdictUpdatedAt),
        gt(schema.tasteTraits.verdictUpdatedAt, since)
      )
    : and(eq(schema.tasteTraits.userId, userId), isNotNull(schema.tasteTraits.verdictUpdatedAt));
  const verdictCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.tasteTraits)
    .where(verdictWhere);
  const traitVerdictDirty = Number(verdictCount[0]?.n ?? 0) > 0;
  ctx.timer.mark('db');

  const recRejectDirty =
    meta?.recFeedbackUpdatedAt != null && (since === null || meta.recFeedbackUpdatedAt > since);
  const enrichmentCorrectedDirty =
    meta?.enrichmentCorrectedAt != null && (since === null || meta.enrichmentCorrectedAt > since);

  return Response.json({
    dirty: changed.length > 0 || traitVerdictDirty || recRejectDirty || enrichmentCorrectedDirty,
    changed_books: changed.length,
    changed_book_ids: changed.map((b) => b.id),
    last_profiled_at: tsToIso(since),
    last_profile_kind: meta?.lastProfileKind ?? null,
  });
});
