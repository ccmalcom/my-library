import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { bookOut } from '@/lib/server/books';
import { parseIdParam, utcnowTs } from '@/lib/server/serialize';
import { ensureProfileMeta } from '@/lib/server/profileMeta';

const Body = z.object({
  catalog_source: z.string(),
  catalog_id: z.string(),
  cover_url: z.string().nullish(),
  subjects: z.array(z.string()).nullish(),
  description: z.string().nullish(),
});

// Port of library.correct_enrichment + api.py's PATCH /books/{book_id}/enrichment —
// re-points a mis-resolved (typically LOW-confidence) book's enrichment at a
// user-picked catalog match. Only catalog-derived fields are replaced; the book's
// own title/author/rating/review are untouched.
export const PATCH = withApi('/api/books/[id]/enrichment', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }
  const b = parsed.data;
  const catalogSource = (b.catalog_source ?? '').trim();
  const catalogId = (b.catalog_id ?? '').trim();
  if (!catalogSource || !catalogId) {
    throw new ApiError(422, 'catalog_source and catalog_id are required.');
  }
  const bookId = parseIdParam(ctx.params.id);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);

  const fields = {
    resolvedSource: catalogSource,
    resolvedId: catalogId,
    subjects: b.subjects ?? [],
    coverUrl: b.cover_url ?? null,
    description: b.description ?? null, // always overwritten, even to null — Python behavior
    confidenceLabel: 'CORRECTED',
    resolutionConfidence: 1.0,
    matchMethod: 'user_correction',
    resolvedAt: utcnowTs(),
  };
  const enr = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.enrichment)
      .where(eq(schema.enrichment.bookId, bookId));
    if (existing[0]) {
      await tx.update(schema.enrichment).set(fields).where(eq(schema.enrichment.bookId, bookId));
    } else {
      await tx.insert(schema.enrichment).values({ bookId, ...fields });
    }

    const meta = await ensureProfileMeta(tx, ctx.user.userId);
    await tx
      .update(schema.profileMeta)
      .set({ enrichmentCorrectedAt: utcnowTs() })
      .where(eq(schema.profileMeta.id, meta.id));

    return (
      (await tx.select().from(schema.enrichment).where(eq(schema.enrichment.bookId, bookId)))[0] ??
      null
    );
  });
  ctx.timer.mark('db');
  return Response.json(bookOut(book, enr));
});
