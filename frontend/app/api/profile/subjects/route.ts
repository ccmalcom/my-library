import { asc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { effectiveRating, pyTitle } from '@/lib/server/serialize';

/** Insertion-ordered counter matching Python collections.Counter.most_common. */
class Counter {
  private m = new Map<string, number>();
  add(key: string): void {
    this.m.set(key, (this.m.get(key) ?? 0) + 1);
  }
  mostCommon(n: number): [string, number][] {
    return [...this.m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  get size(): number {
    return this.m.size;
  }
}

/** Port of api.py::get_profile_subjects. */
export const GET = withApi('/api/profile/subjects', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, ctx.user.userId))
    .orderBy(asc(schema.books.id));
  ctx.timer.mark('db');

  const overall = new Counter();
  const byTier = new Map<string, Counter>();

  for (const row of rows) {
    const b = row.books;
    const rating = effectiveRating(b.appRating, b.goodreadsRating);
    if (rating === null) continue;
    const subjects = (row.enrichment?.subjects ?? null) as string[] | null;
    if (!subjects || subjects.length === 0) continue;
    const tier = String(rating);
    const seen = new Set<string>();
    for (const raw of subjects.slice(0, 15)) {
      const normalised = pyTitle(raw.trim());
      if (normalised && !seen.has(normalised)) {
        seen.add(normalised);
        overall.add(normalised);
        if (!byTier.has(tier)) byTier.set(tier, new Counter());
        byTier.get(tier)!.add(normalised);
      }
      if (seen.size >= 8) break;
    }
  }

  const byTierOut: Record<string, { subject: string; count: number }[]> = {};
  const tiers = [...byTier.keys()].sort((a, b) => Number(b) - Number(a));
  for (const tier of tiers) {
    byTierOut[tier] = byTier
      .get(tier)!
      .mostCommon(12)
      .map(([subject, count]) => ({ subject, count }));
  }
  return Response.json({
    overall: overall.mostCommon(25).map(([subject, count]) => ({ subject, count })),
    by_tier: byTierOut,
  });
});
