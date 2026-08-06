/**
 * Port of profile.py's structured-feedback layer (_feedback_context, _feedback_block).
 * Every query here feeds the byte-exact Claude prompt, so every one carries an
 * explicit ORDER BY (Python's have none and rely on physical row order).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from './db';
import { pyFloatStr } from './serialize';

export interface FeedbackContext {
  confirmed: string[];
  edited: string[];
  rejected: string[];
  downweighted: { claim: string; user_weight: number }[];
  more_like: string[];
  less_like: string[];
  favorites: string[];
  directive_text: string | null;
}

function label(title: string, author: string | null): string {
  return author ? `${title} by ${author}` : title;
}

/** Twin of profile._feedback_context. */
export async function feedbackContext(db: Db, userId: string): Promise<FeedbackContext> {
  const traits = await db
    .select({
      claim: schema.tasteTraits.claim,
      status: schema.tasteTraits.status,
      userWeight: schema.tasteTraits.userWeight,
    })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(asc(schema.tasteTraits.id));

  const confirmed = traits.filter((t) => t.status === 'confirmed').map((t) => t.claim);
  const edited = traits.filter((t) => t.status === 'edited').map((t) => t.claim);
  const rejected = traits.filter((t) => t.status === 'rejected').map((t) => t.claim);
  const downweighted = traits
    .filter((t) => t.userWeight !== null && t.userWeight < 1.0 && t.status !== 'rejected')
    .map((t) => ({ claim: t.claim, user_weight: t.userWeight }));

  const signals = await db
    .select({
      targetBookId: schema.tasteSignal.targetBookId,
      direction: schema.tasteSignal.direction,
    })
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), eq(schema.tasteSignal.targetKind, 'book')))
    .orderBy(asc(schema.tasteSignal.id));

  // Python resolves each signal's book with its own userId-scoped query; batching
  // into one IN(...) is equivalent because the map is keyed by id and scoped the same.
  const bookIds = [
    ...new Set(signals.map((s) => s.targetBookId).filter((id): id is number => id != null)),
  ];
  const labels = new Map<number, string>();
  if (bookIds.length) {
    const books = await db
      .select({ id: schema.books.id, title: schema.books.title, author: schema.books.author })
      .from(schema.books)
      .where(and(eq(schema.books.userId, userId), inArray(schema.books.id, bookIds)));
    for (const b of books) labels.set(b.id, label(b.title, b.author));
  }

  const more_like: string[] = [];
  const less_like: string[] = [];
  for (const sig of signals) {
    const l = sig.targetBookId != null ? labels.get(sig.targetBookId) : undefined;
    if (l === undefined) continue;
    if (sig.direction === 'more') more_like.push(l);
    else if (sig.direction === 'less') less_like.push(l);
  }

  const favoriteBooks = await db
    .select({ title: schema.books.title, author: schema.books.author })
    .from(schema.books)
    .where(and(eq(schema.books.userId, userId), eq(schema.books.isFavorite, true)))
    .orderBy(asc(schema.books.id));
  const favorites = favoriteBooks.map((b) => label(b.title, b.author));

  const directiveRows = await db
    .select()
    .from(schema.userDirective)
    .where(eq(schema.userDirective.userId, userId));
  const directive = directiveRows[0];
  let directive_text: string | null = null;
  if (directive) {
    // Python: `directive.nl_text or directive.constraints` — an empty dict is
    // FALSY in Python but `{}` is truthy in JS, hence the explicit key count.
    const constraints = (directive.constraints ?? {}) as Record<string, unknown>;
    if (directive.nlText || Object.keys(constraints).length > 0) {
      directive_text = directive.nlText;
    }
  }

  return {
    confirmed,
    edited,
    rejected,
    downweighted,
    more_like,
    less_like,
    favorites,
    directive_text,
  };
}

/** Twin of profile._feedback_block. Returns '' when no bucket is populated. */
export function feedbackBlock(feedback: FeedbackContext | null): string {
  if (!feedback) return '';
  const lines: string[] = [];

  const locked = [...feedback.confirmed, ...feedback.edited];
  if (locked.length) {
    lines.push(
      'The following traits are already locked in by the user and are stored ' +
        'separately — do NOT output them (or reworded variants) in your trait ' +
        'list, and do not contradict them: ' +
        locked.join('; ')
    );
  }
  if (feedback.rejected.length) {
    lines.push(
      'The following traits were rejected by the user — do NOT re-derive or ' +
        'include variants of these: ' +
        feedback.rejected.join('; ')
    );
  }
  if (feedback.downweighted.length) {
    const rendered = feedback.downweighted
      .map((d) => `${d.claim} (weight ${pyFloatStr(d.user_weight)})`)
      .join('; ');
    lines.push(
      'The following traits should be softened (user finds them less ' +
        'important): ' +
        rendered
    );
  }
  if (feedback.more_like.length) {
    lines.push(
      'The user wants MORE recommendations like: ' +
        feedback.more_like.join('; ') +
        ' — treat these as strong positive signal'
    );
  }
  if (feedback.less_like.length) {
    lines.push(
      'The user wants FEWER recommendations like: ' +
        feedback.less_like.join('; ') +
        ' — treat these as strong negative signal (aversion)'
    );
  }
  if (feedback.favorites.length) {
    lines.push(
      "The following are the user's all-time favorite books — weight these " +
        'as the strongest possible positive signal when deriving taste traits: ' +
        feedback.favorites.join('; ')
    );
  }
  const directiveText = (feedback.directive_text ?? '').trim();
  if (directiveText) {
    lines.push(
      'The reader wrote these custom instructions about what they want to read next. ' +
        'Treat them as direct, high-priority guidance when deriving traits (honor them; ' +
        'do not contradict them): ' +
        directiveText
    );
  }

  if (!lines.length) return '';
  return '\n\n## User Feedback\n' + lines.map((l) => `- ${l}`).join('\n') + '\n';
}
