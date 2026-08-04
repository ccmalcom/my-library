import { asc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { effectiveRating, pyTitle, round4 } from '@/lib/server/serialize';

// Constants mirror highlights.py + recommend.py (locked cold-start thresholds).
const LOVED_MIN = 4;
const COLD_START_LOVED = 8;
const COLD_START_RATED = 12;
const NOVELLA_MAX_PAGES = 120;
const COLLECTION_TOKENS = ['short stor', 'story collection', 'collections', 'anthology'];
const MIN_AUTHOR_BOOKS = 2;

type Row = {
  books: typeof schema.books.$inferSelect;
  enrichment: typeof schema.enrichment.$inferSelect | null;
};

function classifyFormat(row: Row): [string, boolean] {
  const e = row.enrichment;
  if (e && (e.series || e.seriesPosition)) return ['series', false];
  const pages = row.books.pageCount;
  if (pages !== null && pages < NOVELLA_MAX_PAGES) return ['novella', false];
  const subjects = ((e?.subjects ?? []) as string[]).map((s) => s.toLowerCase());
  if (subjects.some((s) => COLLECTION_TOKENS.some((tok) => s.includes(tok)))) {
    return ['collection', false];
  }
  return ['novel', pages === null];
}

/** Port of highlights.py::compute_highlights. */
export const GET = withApi('/api/profile/highlights', async (_req, ctx) => {
  const db = getDb();
  const rows: Row[] = await db
    .select()
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, ctx.user.userId))
    .orderBy(asc(schema.books.id));
  ctx.timer.mark('db');

  const rated = rows.filter(
    (r) => effectiveRating(r.books.appRating, r.books.goodreadsRating) !== null
  );
  const ratingOf = (r: Row) =>
    effectiveRating(r.books.appRating, r.books.goodreadsRating)!;

  const loved = rated.filter((r) => ratingOf(r) >= LOVED_MIN);
  const thin = loved.length < COLD_START_LOVED || rated.length < COLD_START_RATED;

  const nAuthors = new Set(
    rated.map((r) => r.books.author).filter((a): a is string => !!a)
  ).size;

  // top_genres: rating-weighted, insertion-ordered (stable sort keeps ties in
  // first-seen order, matching Counter.most_common).
  const genreScore = new Map<string, number>();
  const genreBooks = new Map<string, number>();
  let enrichedRated = 0;
  for (const r of rated) {
    const subjects = (r.enrichment?.subjects ?? null) as string[] | null;
    if (!subjects || subjects.length === 0) continue;
    enrichedRated += 1;
    const seen = new Set<string>();
    for (const raw of subjects.slice(0, 8)) {
      const subject = pyTitle(raw.trim());
      if (!subject || seen.has(subject)) continue;
      seen.add(subject);
      genreScore.set(subject, (genreScore.get(subject) ?? 0) + ratingOf(r));
      genreBooks.set(subject, (genreBooks.get(subject) ?? 0) + 1);
    }
  }
  const topGenres = [...genreScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([subject]) => ({
      subject,
      share: enrichedRated ? round4((genreBooks.get(subject) ?? 0) / enrichedRated) : 0,
    }));

  // top_authors: books_read * avg_rating, min 2 books.
  const byAuthor = new Map<string, number[]>();
  for (const r of rated) {
    const a = r.books.author;
    if (!a) continue;
    if (!byAuthor.has(a)) byAuthor.set(a, []);
    byAuthor.get(a)!.push(ratingOf(r));
  }
  const authorScores: [string, number][] = [];
  for (const [author, ratings] of byAuthor) {
    if (ratings.length < MIN_AUTHOR_BOOKS) continue;
    const avg = ratings.reduce((s, x) => s + x, 0) / ratings.length;
    authorScores.push([author, ratings.length * avg]);
  }
  authorScores.sort((a, b) => b[1] - a[1]);
  const topAuthors = authorScores.slice(0, 3).map(([a]) => a);

  // format_mix — bucket order matters for the dominant tie-break (first max wins).
  const buckets: Record<string, number> = { novel: 0, novella: 0, collection: 0, series: 0 };
  let lowConf = false;
  for (const r of rated) {
    const [fmt, bookLow] = classifyFormat(r);
    buckets[fmt] += 1;
    lowConf = lowConf || bookLow;
  }
  let dominant: string | null = null;
  if (rated.length > 0) {
    for (const k of ['novel', 'novella', 'collection', 'series']) {
      if (dominant === null || buckets[k] > buckets[dominant]) dominant = k;
    }
    if (dominant !== null && buckets[dominant] === 0) dominant = null;
  }

  const years = rated
    .map((r) => r.books.yearPublished)
    .filter((y): y is number => !!y);
  const eraSplit =
    years.length > 0
      ? {
          pre_2000: years.filter((y) => y < 2000).length,
          post_2000: years.filter((y) => y >= 2000).length,
        }
      : null;

  return Response.json({
    thin,
    n_authors: nAuthors,
    top_genres: topGenres,
    top_authors: topAuthors,
    format_mix: { ...buckets, dominant, low_confidence: lowConf },
    era_split: eraSplit,
  });
});
