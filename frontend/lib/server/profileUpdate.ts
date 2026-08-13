/**
 * Port of profile.py's incremental re-profile: change detection, the revise
 * prompt (books_changed_since, _REVISE_TOOL, _REVISE_SYSTEM, _build_update_prompt),
 * and update_taste_profile's branch table + Claude call. Strings are copied
 * verbatim from Python — prompt parity is asserted byte-for-byte in
 * parity-prompts.test.ts.
 */
import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { effectiveRating, pyFloat, pyJsonDumps, pyRepr } from './serialize';
import { bookPayload, type BookRow, type EnrichmentRow } from './profileTiers';
import {
  feedbackBlock,
  feedbackContext,
  removeRejectedClaims,
  type FeedbackContext,
} from './profileFeedback';
import {
  TRAIT_INPUT_SCHEMA,
  extractTasteProfile,
  persistProposedTraits,
  profileModel,
  PROFILE_MAX_TOKENS,
} from './profileBuild';
import { ensureProfileMeta } from './profileMeta';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';

export const REVISE_TOOL = {
  name: 'revise_taste_traits',
  description:
    "Return the REVISED full taste-trait set after accounting for the reader's " +
    'latest rating/review changes. Keep traits that still hold (adjusting confidence ' +
    'or evidence as warranted), drop traits the new evidence contradicts, and add new ' +
    'traits the changes reveal. Cite only book ids present in the provided data.',
  // Same per-trait shape as the cold-start tool, so persistence is identical.
  input_schema: TRAIT_INPUT_SCHEMA,
};

export const REVISE_SYSTEM =
  "You are a literary taste analyst maintaining a reader's evolving taste profile. " +
  'You are given the profile you previously inferred plus the reader\'s most recent ' +
  'rating and review changes. You make the SMALLEST revision that honors the new ' +
  'evidence: keep what still holds, adjust confidence where the new data strengthens ' +
  'or weakens a claim, retire claims the new evidence contradicts, and add genuinely ' +
  "new traits. Review text is the reader's own words — weight it above metadata " +
  'inference. Cite only book ids that appear in the provided data.';

/**
 * Twin of profile.books_changed_since. The rated/DNF/favorite filter is applied in
 * application code, exactly as Python does, because `effective_rating` is a Python
 * property with no SQL equivalent. ORDER BY id keeps `changed_ids` deterministic —
 * it is interpolated into the prompt.
 */
export async function booksChangedSince(
  db: Db,
  since: string | null,
  userId: string
): Promise<BookRow[]> {
  const conds = [
    eq(schema.books.userId, userId),
    isNotNull(schema.books.feedbackUpdatedAt),
  ];
  if (since !== null) conds.push(gt(schema.books.feedbackUpdatedAt, since));

  const rows = await db
    .select()
    .from(schema.books)
    .where(and(...conds))
    .orderBy(asc(schema.books.id));

  return rows.filter(
    (b) =>
      effectiveRating(b.appRating, b.goodreadsRating) !== null ||
      b.exclusiveShelf === 'did-not-finish' ||
      b.isFavorite
  );
}

/**
 * Twin of profile._build_update_prompt. `CHANGED BOOK IDS` interpolates a Python
 * LIST REPR (`[2, 3, 9]`), and `booksMeta` must be a Map so its String(id) keys keep
 * query order rather than V8's numeric-key order.
 */
export function buildUpdatePrompt(
  currentTraits: Record<string, unknown>[],
  booksMeta: Map<string, Record<string, unknown>>,
  changedIds: number[],
  feedback: FeedbackContext | null
): string {
  return (
    'The reader has updated some ratings and/or written new reviews since this ' +
    'profile was last built. Revise the profile accordingly — do NOT re-derive it ' +
    'from scratch.\n\n' +
    'You are NOT given the whole library, only the books needed to reason about the ' +
    'change: the books that changed, plus the books the current traits already cite. ' +
    'Cite book ids only from the BOOKS map below.\n\n' +
    'How to revise:\n' +
    '  - Keep traits that still hold. Raise/lower `inference_confidence` if the new ' +
    'evidence strengthens or weakens them, and add/remove cited book ids as fitting.\n' +
    '  - Drop a trait whose evidence the changes now contradict (e.g. the reader ' +
    're-rated its key exhibit, or a new review states the opposite).\n' +
    '  - Add new traits the changes reveal — especially anything stated outright in a ' +
    'review.\n' +
    '  - A new/edited `review` is direct testimony; prefer it over metadata guesses.\n' +
    '  - Return the COMPLETE revised trait set (the unchanged traits too), 6-12 traits, ' +
    'via the revise_taste_traits tool.\n\n' +
    `CHANGED BOOK IDS (the edits driving this update): ${pyRepr(changedIds)}\n\n` +
    'CURRENT TRAITS (JSON):\n' +
    pyJsonDumps(currentTraits) +
    '\n\nBOOKS (id -> metadata; the only books you may cite) (JSON):\n' +
    pyJsonDumps(booksMeta) +
    feedbackBlock(feedback)
  );
}

export interface UpdateInputs {
  currentTraits: Record<string, unknown>[];
  booksMeta: Map<string, Record<string, unknown>>;
  changedIds: number[];
}

/**
 * Gathers the incremental prompt's two payloads: the current proposed traits and
 * the books they cite unioned with the changed books (profile.py:752-786).
 * `inference_confidence` is wrapped in pyFloat so an integral 1.0 serializes as
 * `1.0`, matching Python, rather than JSON.stringify's `1`.
 */
export async function collectUpdateInputs(
  db: Db,
  userId: string,
  since: string | null
): Promise<UpdateInputs> {
  const changed = await booksChangedSince(db, since, userId);
  const changedIds = changed.filter((b) => !b.excludeFromProfile).map((b) => b.id);

  const currentRows = await db
    .select()
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')))
    .orderBy(asc(schema.tasteTraits.id));

  const currentTraits = currentRows.map((t) => ({
    id: t.id,
    claim: t.claim,
    polarity: t.polarity,
    inference_confidence: pyFloat(t.inferenceConfidence),
    exhibits: (t.exhibits as number[] | null) ?? [],
    contrasts: (t.contrasts as number[] | null) ?? [],
  }));

  const citedIds = new Set<number>();
  for (const t of currentRows) {
    for (const i of ((t.exhibits as number[] | null) ?? [])) citedIds.add(i);
    for (const i of ((t.contrasts as number[] | null) ?? [])) citedIds.add(i);
  }
  const wantedIds = [...new Set([...citedIds, ...changedIds])];

  const booksMeta = new Map<string, Record<string, unknown>>();
  if (wantedIds.length) {
    const rows = await db
      .select({ book: schema.books, enrichment: schema.enrichment })
      .from(schema.books)
      .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
      .where(and(eq(schema.books.userId, userId), inArray(schema.books.id, wantedIds)))
      .orderBy(asc(schema.books.id));
    for (const { book, enrichment } of rows) {
      const payload = bookPayload(book, enrichment as EnrichmentRow | null);
      payload.rating = effectiveRating(book.appRating, book.goodreadsRating);
      booksMeta.set(String(book.id), payload);
    }
  }

  return { currentTraits, booksMeta, changedIds };
}

/**
 * Twin of profile.update_taste_profile. Four of its six branches never reach Claude;
 * see the branch table in the wave-3b plan. Like extractTasteProfile, the Claude call
 * runs outside any transaction and all writes land in one transaction afterwards.
 */
export async function updateTasteProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number = PROFILE_MAX_TOKENS
): Promise<Record<string, unknown>> {
  const model = profileModel();

  const existing = await db
    .select({ id: schema.tasteTraits.id })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));

  // Python's get_profile_meta creates the row on first use and commits it.
  const meta = await ensureProfileMeta(db, userId);
  const since = meta.lastProfiledAt;

  if (!existing.length || since === null) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  const changed = await booksChangedSince(db, since, userId);
  const changedIds = changed.filter((b) => !b.excludeFromProfile).map((b) => b.id);

  const traitVerdicts = await db
    .select({ id: schema.tasteTraits.id })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), gt(schema.tasteTraits.verdictUpdatedAt, since)))
    .limit(1);
  const newSignals = await db
    .select({ id: schema.tasteSignal.id })
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), gt(schema.tasteSignal.createdAt, since)))
    .limit(1);
  const hasFeedbackSince =
    traitVerdicts.length > 0 ||
    newSignals.length > 0 ||
    (meta.recFeedbackUpdatedAt !== null && meta.recFeedbackUpdatedAt > since);

  // A LOW-confidence match correction changes metadata without touching feedback
  // timestamps, so it never shows up in `changed`; force a full rebuild.
  if (meta.enrichmentCorrectedAt !== null && meta.enrichmentCorrectedAt > since) {
    return extractTasteProfile(db, client, userId, maxTokens);
  }

  if (!changedIds.length) {
    if (!changed.length && !hasFeedbackSince) {
      return {
        mode: 'update',
        changed_books: 0,
        traits_before: existing.length,
        traits_after: existing.length,
        note: 'Profile already up to date — no rating/review changes since last build.',
        model,
      };
    }
    if (!hasFeedbackSince) {
      // Only exclusion toggles changed; the incremental prompt cannot re-derive
      // their (removed) metadata signal.
      return extractTasteProfile(db, client, userId, maxTokens);
    }
    // Feedback-only update: fall through with an empty changedIds list.
  }

  const inputs = await collectUpdateInputs(db, userId, since);
  const feedback = await feedbackContext(db, userId);
  const prompt = buildUpdatePrompt(
    inputs.currentTraits,
    inputs.booksMeta,
    inputs.changedIds,
    feedback
  );

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_update' },
    {
      model,
      max_tokens: maxTokens,
      system: REVISE_SYSTEM,
      tools: [REVISE_TOOL],
      tool_choice: { type: 'tool', name: 'revise_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];
  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  // Unlike the full build, valid ids come from books_meta, not the tiers.
  const validIds = new Set<number>([...inputs.booksMeta.keys()].map((k) => Number(k)));

  const saved = await persistProposedTraits(db, userId, traits, validIds, 'update');

  return {
    mode: 'update',
    changed_books: inputs.changedIds.length,
    books_sent: inputs.booksMeta.size,
    traits_before: existing.length,
    traits_after: saved,
    model,
  };
}
