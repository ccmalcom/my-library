/**
 * Port of recommend._build_signal — the recommender's single read of the library.
 *
 * DEVIATION (deliberate, same as wave 3b's profileTiers): every query here carries an
 * explicit ORDER BY that Python does not have. Python relies on Postgres's arbitrary
 * row order, which happens to be insertion order on a freshly-seeded table. That is
 * good enough for Python but not for a byte-identical prompt assertion, so Node pins
 * the order. If a prompt-parity test ever disagrees with the recorded fixture, adjust
 * the SEED -- do not remove these ORDER BYs.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { surname } from './dedup';
import { dedupKey, seriesInfo } from './recFilters';
import { effectiveRating, pyFloat, round2, type PyFloat } from './serialize';

/** recommend.py:51-62 tuning knobs. */
export const TOP_SUBJECTS = 8;
export const TOP_AUTHORS = 6;
export const LOVED_MIN = 4; // effective rating at/above which a book counts as "loved"
export const LOVED_SAMPLE = 20; // loved books shown to Claude for context
export const COLD_START_LOVED = 8;
export const COLD_START_RATED = 12;

const REJECTED_STATUS = 'rejected';

export interface LovedBook {
  id: number;
  title: string;
  author: string | null;
  rating: number;
  year: number | null;
  subjects: string[];
  read_year: number | null;
}

export interface TraitPayload {
  id: number;
  claim: string;
  polarity: string | null;
  confidence: PyFloat;
  user_weight: PyFloat;
  status: string;
}

export interface RejectedNote {
  title: string;
  author: string | null;
  note: string;
}

export interface RecSignal {
  library_keys: Set<string>;
  library_isbns: Set<string>;
  library_languages: Set<string>;
  library_authors: Set<string>;
  library_titles: string[];
  library_series: Map<string, Set<number>>;
  loved: LovedBook[];
  rated_count: number;
  top_subjects: string[];
  top_authors: string[];
  traits: TraitPayload[];
  more_like: string[];
  less_like: string[];
  /** Map, not an object: _user_steering_block joins these in insertion order. */
  reject_reason_counts: Map<string, number>;
  rejected_with_notes: RejectedNote[];
  directive_text: string | null;
  directive_constraints: Record<string, unknown>;
}

/**
 * Twin of collections.Counter.most_common(n): count descending, ties broken by
 * INSERTION order, earliest first. (CPython routes through heapq.nlargest, which
 * decorates each item with a descending order counter, giving exactly this.) The
 * index tiebreak is explicit rather than relying on Array.sort's stability.
 */
export function mostCommon(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .map(([key, count], index) => ({ key, count, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, n)
    .map((e) => e.key);
}

/** recommend._is_cold_start: thin libraries cannot support author/subject inference. */
export function isColdStart(signal: Pick<RecSignal, 'loved' | 'rated_count'>): boolean {
  return (
    (signal.loved?.length ?? 0) < COLD_START_LOVED || (signal.rated_count ?? 0) < COLD_START_RATED
  );
}

export async function buildSignal(db: Db, userId: string): Promise<RecSignal> {
  const rows = await db
    .select({ b: schema.books, enr: schema.enrichment })
    .from(schema.books)
    // Safe against fan-out: enrichment.book_id carries a UNIQUE index, so this is 1:1.
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));

  const library_keys = new Set<string>();
  const library_isbns = new Set<string>();
  const library_languages = new Set<string>();
  const library_authors = new Set<string>();
  const library_titles: string[] = [];
  const library_series = new Map<string, Set<number>>();
  const loved: LovedBook[] = [];
  const subjectCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  let rated_count = 0;

  for (const { b, enr } of rows) {
    library_keys.add(dedupKey(b.title, b.author));
    if (b.title) library_titles.push(b.title);
    const info = seriesInfo(b.title);
    if (info !== null) {
      const [name, position] = info;
      let owned = library_series.get(name);
      if (!owned) {
        owned = new Set<number>();
        library_series.set(name, owned);
      }
      owned.add(position);
    }
    if (b.isbn13) library_isbns.add(b.isbn13);
    const enrLang = enr?.language ?? null;
    if (enrLang) library_languages.add(enrLang);
    if (b.author) library_authors.add(surname(b.author));

    const rating = effectiveRating(b.appRating, b.goodreadsRating);
    if (rating !== null) rated_count++;
    if (rating === null || rating < LOVED_MIN) continue;

    const subjects = ((enr?.subjects as string[] | null) ?? []) as string[];
    for (const s of subjects) subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
    if (b.author) authorCounts.set(b.author, (authorCounts.get(b.author) ?? 0) + 1);
    // Python's `b.date_read or b.date_added`: a date object is never falsy, so this
    // is a plain null-coalesce, not a truthiness fallback.
    const readDate = b.dateRead ?? b.dateAdded;
    loved.push({
      id: b.id,
      title: b.title,
      author: b.author,
      rating,
      year: b.yearPublished,
      subjects: subjects.slice(0, 8),
      read_year: readDate ? Number(readDate.slice(0, 4)) : null,
    });
  }

  // Explicitly rejected recommendations are excluded too, so they never resurface.
  const rejected = await db
    .select()
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, userId),
        eq(schema.recommendations.status, REJECTED_STATUS)
      )
    )
    .orderBy(asc(schema.recommendations.id));

  const rejected_with_notes: RejectedNote[] = [];
  for (const r of rejected) {
    library_keys.add(dedupKey(r.title, r.author));
    if (r.title) library_titles.push(r.title);
    if (r.isbn13) library_isbns.add(r.isbn13);
    if (r.userNote) {
      rejected_with_notes.push({ title: r.title, author: r.author, note: r.userNote });
    }
  }

  // Python: `loved.sort(key=lambda d: (d["rating"], d["read_year"] or 0), reverse=True)`.
  // reverse=True is STABLE in CPython -- it does not reverse equal elements -- and
  // Array.prototype.sort is stable in V8, so returning 0 on a full tie matches.
  loved.sort((x, y) => y.rating - x.rating || (y.read_year ?? 0) - (x.read_year ?? 0));

  const traitRows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(desc(schema.tasteTraits.inferenceConfidence), asc(schema.tasteTraits.id));

  // Rejected traits are dead to the reranker -- excluded entirely. Each survivor
  // carries its user_weight + status so stage 2 can weight its influence.
  const traits: TraitPayload[] = traitRows
    .filter((t) => (t.status || 'proposed') !== REJECTED_STATUS)
    .map((t) => ({
      id: t.id,
      claim: t.claim,
      polarity: t.polarity,
      // pyFloat so json.dumps parity holds: Python renders 1.0, JSON.stringify renders 1.
      confidence: pyFloat(round2(t.inferenceConfidence)),
      user_weight: pyFloat(t.userWeight ?? 1.0),
      status: t.status || 'proposed',
    }));

  // more/less-like book labels, same join as profile._feedback_context.
  const bookById = new Map(rows.map(({ b }) => [b.id, b]));
  const signalRows = await db
    .select()
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), eq(schema.tasteSignal.targetKind, 'book')))
    .orderBy(asc(schema.tasteSignal.id));

  const more_like: string[] = [];
  const less_like: string[] = [];
  for (const sig of signalRows) {
    if (sig.targetBookId === null) continue;
    // bookById comes from the user-scoped query above, so this preserves Python's
    // `Book.user_id == user_id` filter without a second round trip.
    const book = bookById.get(sig.targetBookId);
    if (book === undefined) continue;
    const label = book.author ? `${book.title} by ${book.author}` : book.title;
    if (sig.direction === 'more') more_like.push(label);
    else if (sig.direction === 'less') less_like.push(label);
  }

  const reasonRows = await db
    .select()
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, userId),
        eq(schema.recommendations.status, REJECTED_STATUS),
        isNotNull(schema.recommendations.rejectReasons)
      )
    )
    .orderBy(asc(schema.recommendations.id));

  const reject_reason_counts = new Map<string, number>();
  for (const r of reasonRows) {
    for (const reason of ((r.rejectReasons as string[] | null) ?? []) as string[]) {
      reject_reason_counts.set(reason, (reject_reason_counts.get(reason) ?? 0) + 1);
    }
  }

  const directiveRows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, userId));
  const directive = directiveRows[0];
  const storedConstraints = (directive?.constraints as Record<string, unknown> | null) ?? null;
  let directive_text: string | null = null;
  let directive_constraints: Record<string, unknown> = {};
  // Python: `if directive is not None and (directive.nl_text or directive.constraints)`.
  // `{}` is FALSY in Python, so a row with no text and empty constraints is ignored
  // entirely -- `!storedConstraints` would not reproduce that in JS.
  if (
    directive &&
    (directive.nlText || (storedConstraints && Object.keys(storedConstraints).length > 0))
  ) {
    directive_text = directive.nlText;
    directive_constraints = storedConstraints ?? {};
  }

  return {
    library_keys,
    library_isbns,
    library_languages,
    library_authors,
    library_titles,
    library_series,
    loved,
    rated_count,
    top_subjects: mostCommon(subjectCounts, TOP_SUBJECTS),
    top_authors: mostCommon(authorCounts, TOP_AUTHORS),
    traits,
    more_like,
    less_like,
    reject_reason_counts,
    rejected_with_notes,
    directive_text,
    directive_constraints,
  };
}
