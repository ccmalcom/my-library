/**
 * Port of profile.py's cold-start taste-profile extractor (_TOOL, _SYSTEM,
 * _build_prompt, extract_taste_profile). Strings are copied verbatim from Python —
 * prompt parity is asserted byte-for-byte in parity-prompts.test.ts.
 */
import { eq, and } from 'drizzle-orm';
import { schema, type Db } from './db';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { pyJsonDumps, pyRepr, utcnowTs } from './serialize';
import { ApiError } from './errors';
import { buildTiers, type Tiers } from './profileTiers';
import {
  feedbackContext,
  feedbackBlock,
  removeRejectedClaims,
  type FeedbackContext,
} from './profileFeedback';
import { NO_RATED_BOOKS_MESSAGE } from './claudeErrors';

/** Twin of config.get_settings().model — read at call time, as Python does. */
export function profileModel(): string {
  return process.env.MYLIBRARY_MODEL || 'claude-sonnet-5';
}

export const PROFILE_MAX_TOKENS = 3000;

/** Shared by _TOOL and _REVISE_TOOL in Python (`"input_schema": _TOOL["input_schema"]`). */
export const TRAIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    traits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: {
            type: 'string',
            description:
              "A specific, falsifiable claim about what drives this " +
              "reader's ratings, e.g. 'Rewards dense political " +
              "world-building over fast plotting.' Avoid generic " +
              'genre statements.',
          },
          polarity: {
            type: 'string',
            enum: ['reward', 'aversion'],
            description:
              "'reward' = trait associated with higher ratings; " +
              "'aversion' = trait shared by lower-rated books.",
          },
          exhibits: {
            type: 'array',
            items: { type: 'integer' },
            description:
              "Book ids that EXHIBIT the trait: for a 'reward', the " +
              "high-rated books showing it; for an 'aversion', the " +
              'low-rated books showing it. These must be consistent ' +
              'with the polarity — do NOT put high-rated books here ' +
              'for an aversion.',
          },
          contrasts: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'Book ids that anchor the CONTRAST — the counter-examples ' +
              'that make the distinction sharp (e.g. for an aversion to ' +
              'X, similar books WITHOUT X that scored higher). May be ' +
              'empty if the trait stands on its exhibits alone.',
          },
          inference_confidence: {
            type: 'number',
            description: '0..1 — how strongly the evidence supports the claim.',
          },
        },
        required: ['claim', 'polarity', 'exhibits', 'contrasts', 'inference_confidence'],
      },
    },
  },
  required: ['traits'],
};

export const PROFILE_TOOL = {
  name: 'record_taste_traits',
  description:
    "Record the taste traits inferred from the reader's rated library. " +
    'Each trait must distinguish rating tiers and cite the book ids that support it.',
  input_schema: TRAIT_INPUT_SCHEMA,
};

export const PROFILE_SYSTEM =
  'You are a literary taste analyst. You infer what drives a specific reader\'s ' +
  'ratings from their library metadata. You reason about CONTRAST between rating ' +
  'tiers, never asserting a trait without citing the books that evidence it. You ' +
  'only cite book ids that appear in the provided data.';

/**
 * Twin of profile._build_prompt. `Tier sizes: {counts}` interpolates a Python DICT
 * REPR (single quotes, insertion order) — not JSON — hence pyRepr over a Map.
 */
export function buildProfilePrompt(tiers: Tiers, feedback: FeedbackContext | null): string {
  const counts = new Map<string, number>([...tiers.entries()].map(([k, v]) => [k, v.length]));
  return (
    "Below is a reader's library, grouped by star rating and status. Each book has " +
    'enriched metadata (subjects, year, length, series). Most books have no review ' +
    'text, so reason mainly from metadata + the rating tiers — but where a book ' +
    "carries a `review` field, those are the reader's own words: treat them as the " +
    'strongest, most direct signal, above any metadata inference.\n\n' +
    `Tier sizes: ${pyRepr(counts)}. Note the heavy positive skew — 'loved it' has low ` +
    'discriminative power, so focus on what is genuinely distinguishing.\n\n' +
    'The `dnf` tier contains books the reader abandoned before finishing. Treat ' +
    'these as the strongest possible aversion signal, even stronger than 1-2 star ' +
    'ratings, since the reader could not complete them. Any `review` field on a ' +
    'DNF book is direct first-person evidence explaining why they quit.\n\n' +
    'The `rejected` tier contains books the reader explicitly skipped when ' +
    'recommended, with a note explaining why. These are direct first-person ' +
    'statements of aversion — treat each `note` as reliable testimony about what ' +
    'this reader does NOT want, and use them to sharpen aversion traits.\n\n' +
    "Infer the reader's taste traits. Prioritize, in order:\n" +
    '  1. What separates the 5-star books from the 4-star books?\n' +
    "  2. What do the lowest-rated books (<=2 and 3), DNF books, and rejected recommendations share? (these are 'aversion' traits)\n" +
    '  3. Cross-cutting rewards visible across the high tiers.\n\n' +
    'For EACH trait, split the evidence into two fields:\n' +
    '  - `exhibits`: the books that SHOW the trait. These MUST match the polarity — ' +
    "an aversion's exhibits are LOW-rated books, a reward's exhibits are HIGH-rated. " +
    "Never put high-rated books in an aversion's exhibits.\n" +
    '  - `contrasts`: the counter-examples that sharpen the distinction (e.g. for an ' +
    'aversion to X, similar books WITHOUT X that scored higher). May be empty.\n\n' +
    'Temporal context: The `read_year` field shows when each book was read (or ' +
    'added to the shelf). Tastes evolve, so weight this accordingly:\n' +
    '  - Recent reads (2020+) are the strongest signal of current preferences.\n' +
    '  - Mid-era reads (2015-2019) are relevant but may reflect a transitional period.\n' +
    '  - Older reads (pre-2015) may reflect a different life stage entirely — for ' +
    "example, a heavy YA phase in one's teens is not necessarily a current preference.\n" +
    '  - Lower `inference_confidence` for traits supported only by older reads unless ' +
    'those same traits are echoed in more recent ones. If a trait is consistent across ' +
    'all eras, call it an enduring preference (and note that in the claim).\n' +
    '  IMPORTANT EXCEPTION — do NOT apply temporal discounting to traits rooted in ' +
    'values or representation (e.g. LGBTQ+ themes, feminist perspectives, racial or ' +
    "political identity in fiction). A reader's core values rarely regress with age: " +
    'the absence of such themes in recent reads more likely reflects the books ' +
    "available than a shift in the reader's preferences. If a value-based trait is " +
    'consistent across any era of the library, treat it as enduring regardless of ' +
    'when those books were read. Only downweight it if recent reads actively ' +
    'contradict it (e.g. the reader started rating books with that theme *lower*).\n\n' +
    'Quality rules:\n' +
    '  - Use ONLY book ids from the data below.\n' +
    '  - Make claims specific and falsifiable, not generic genre labels.\n' +
    "  - Do NOT force a book into a trait it doesn't fit just to pad the evidence.\n" +
    "  - Keep traits DISTINCT — don't emit two traits describing the same pattern.\n" +
    '  - Distinguish genuine taste from mechanical rating drift (e.g. later books in ' +
    'a long series slipping a star is series fatigue, not a standalone taste trait).\n' +
    '  - Lower your inference_confidence when a trait rests on very few books.\n' +
    '  - Aim for 6-12 traits. Record them with the record_taste_traits tool.\n\n' +
    'LIBRARY DATA (JSON):\n' +
    pyJsonDumps(tiers) +
    feedbackBlock(feedback)
  );
}

/** Twin of profile.mark_profiled — clears the 'dirty' state. Must run inside a tx. */
export async function markProfiled(tx: Db, kind: string, userId: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.profileMeta.id })
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  const stamp = { lastProfiledAt: utcnowTs(), lastProfileKind: kind };
  if (rows[0]) {
    await tx.update(schema.profileMeta).set(stamp).where(eq(schema.profileMeta.id, rows[0].id));
  } else {
    await tx.insert(schema.profileMeta).values({ userId, ...stamp });
  }
}

/**
 * Twin of profile.extract_taste_profile, minus key resolution (the route does that,
 * matching the wave-3a pattern, so this takes an already-built client and is
 * directly testable with fakeClaude).
 *
 * Python holds one session across the Claude call; Node cannot (db.ts uses max: 1,
 * so touching `db` inside an open transaction deadlocks). Reads happen first, the
 * Claude call runs with no transaction open, and all writes land in one transaction
 * afterwards. Python writes nothing before the call either, so this is equivalent.
 */
export async function extractTasteProfile(
  db: Db,
  client: ClaudeClient,
  userId: string,
  maxTokens: number = PROFILE_MAX_TOKENS
): Promise<Record<string, unknown>> {
  const tiers = await buildTiers(db, userId);
  let totalRated = 0;
  for (const [k, v] of tiers) if (k !== 'rejected') totalRated += v.length;
  if (totalRated === 0) throw new ApiError(400, NO_RATED_BOOKS_MESSAGE);

  const feedback = await feedbackContext(db, userId);
  const prompt = buildProfilePrompt(tiers, feedback);
  const model = profileModel();

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'profile_full' },
    {
      model,
      max_tokens: maxTokens,
      system: PROFILE_SYSTEM,
      tools: [PROFILE_TOOL],
      tool_choice: { type: 'tool', name: 'record_taste_traits' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  // Python breaks on the FIRST tool_use block regardless of its name.
  const input = toolInput(message, '');
  let traits = (Array.isArray(input?.traits) ? input.traits : []) as Record<string, unknown>[];

  traits = removeRejectedClaims(traits, feedback.rejected);
  traits = removeRejectedClaims(traits, [...feedback.confirmed, ...feedback.edited]);

  const validIds = new Set<number>();
  for (const [, list] of tiers) {
    for (const b of list) {
      if (typeof b.id === 'number') validIds.add(b.id);
    }
  }

  const saved = await db.transaction(async (tx) => {
    await tx
      .delete(schema.tasteTraits)
      .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'proposed')));

    let n = 0;
    for (const t of traits) {
      await tx.insert(schema.tasteTraits).values({
        userId,
        claim: String(t.claim ?? '').trim(),
        // Python's `t.get("polarity", "reward")` returns None on an explicit `null`
        // polarity, which would violate the NOT NULL column — Node's `?? 'reward'`
        // falls back instead. Deliberately safer, not a bug to reconcile with Python.
        polarity: String(t.polarity ?? 'reward'),
        exhibits: asIdList(t.exhibits, validIds),
        contrasts: asIdList(t.contrasts, validIds),
        inferenceConfidence: Number(t.inference_confidence ?? 0.0),
        status: 'proposed',
      });
      n++;
    }
    await markProfiled(tx, 'full', userId);
    return n;
  });

  const tierCounts: Record<string, number> = {};
  for (const [k, v] of tiers) tierCounts[k] = v.length;

  return {
    mode: 'full',
    rated_books: totalRated,
    tiers: tierCounts,
    traits_saved: saved,
    model,
  };
}

/** Python: `[i for i in t.get("exhibits", []) if i in valid_ids]`. */
function asIdList(raw: unknown, validIds: Set<number>): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is number => typeof i === 'number' && validIds.has(i));
}
