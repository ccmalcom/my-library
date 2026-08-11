/**
 * Port of recommend.py's two /recommend prompts (_SEED_TOOL/_SEED_SYSTEM and
 * _RANK_TOOL/_RANK_SYSTEM) plus their builders.
 *
 * Every string here is copied VERBATIM from Python and asserted byte-for-byte in
 * parity-recommend-prompts.test.ts. Do not reflow or re-punctuate them.
 */
import { profileModel } from './profileBuild';
import type { AssembledCandidate } from './recAssemble';
import { LOVED_SAMPLE, type RecSignal } from './recSignal';
import { pyJsonDumps } from './serialize';

export interface PromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

// --- stage 1b: propose search queries --------------------------------------

export const SEED_MODEL = 'claude-haiku-4-5-20251001';
export const SEED_MAX_TOKENS = 1500;

export const SEED_TOOL = {
  name: 'propose_search_queries',
  description:
    'Propose catalog SEARCH queries that would surface books this reader is likely ' +
    'to love next. These are search terms (subjects, micro-genres, comp-author ' +
    'phrasings), NOT specific book titles. Each is run against a live book catalog.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                "A catalog search query, e.g. 'literary science fiction " +
                "first contact' or 'inauthor:\"Ursula K. Le Guin\"'. Avoid " +
                'naming books the reader already owns.',
            },
            reason: {
              type: 'string',
              description: 'Which trait/pattern this query chases.',
            },
          },
          required: ['query', 'reason'],
        },
      },
    },
    required: ['queries'],
  },
};

export const SEED_SYSTEM =
  "You expand a reader's taste profile into catalog search queries for discovery. You " +
  "propose search TERMS, never specific titles, and you aim the queries at the reader's " +
  'distinguishing traits (what separates their 5-star from 4-star books), not generic ' +
  'bestsellers.';

// --- stage 2: rerank + explain ---------------------------------------------

export const RANK_MAX_TOKENS = 4000;

/** Python reads settings.model at call time; profileModel() is the same env lookup. */
export function rankModel(): string {
  return profileModel();
}

export const RANK_TOOL = {
  name: 'rank_recommendations',
  description:
    "Rank the provided real catalog candidates by how well they fit this reader's " +
    'taste profile, and explain each pick. Choose ONLY from the given candidates.',
  input_schema: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate_index: {
              type: 'integer',
              description: 'The `idx` of a provided candidate. Must exist.',
            },
            score: {
              type: 'number',
              description: "0..1 fit with the reader's taste profile.",
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a well-read friend: what the ' +
                'book does, anchored to at most two library books by title, ' +
                'naming the mechanism of the fit. Honest about stretch picks. ' +
                'Plain punctuation, no em dashes. No generic praise, no ' +
                'clinical trait-speak.',
            },
            grounded_trait_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Trait ids (from the profile) this pick leans on.',
            },
            grounded_book_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Library book ids this candidate is most like.',
            },
          },
          required: [
            'candidate_index',
            'score',
            'rationale',
            'grounded_trait_ids',
            'grounded_book_ids',
          ],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const RANK_SYSTEM =
  'You are a book recommender. You rank a fixed list of real catalog candidates against ' +
  "a reader's evidence-backed taste profile. You never invent books; you only rank the " +
  'candidates given. Every pick cites the trait ids and library book ids it is grounded ' +
  'in, drawn only from the provided data. You prefer specific fit over popularity, and ' +
  'you respect aversion traits (penalize candidates that trip them).\n\n' +
  'Write each rationale like a well-read friend pressing the book into their hands, in ' +
  '1-2 sentences: lead with what the book does, then anchor it to at most two of their ' +
  'library books by title. Name the mechanism of the fit (pace, voice, structure, mood: ' +
  'whatever the trait actually is), never just shared genre. If the pick is a stretch, ' +
  'say so honestly and name what still connects. Use plain punctuation only: no em ' +
  'dashes. Never write "you\'ll love this", generic praise, or clinical trait ' +
  'language.\n\n' +
  'Examples of the target voice:\n' +
  '- Technically sci-fi, but it moves like the quiet family novels you rate highest: one ' +
  'household, twenty years, every chapter a knife slid in slowly.\n' +
  "- A reach: you rarely go for war fiction. But it's told in the clipped, unsentimental " +
  "voice that carried The Remains of the Day for you, and it's short enough to bail on " +
  'cheap.\n' +
  '- Romance-adjacent without the love-triangle stall you keep one-starring: the couple ' +
  'is together by chapter three, and the book is about what happens after.';

// --- builders ---------------------------------------------------------------

/**
 * The `TASTE TRAITS (JSON):` / `LOVED BOOKS (JSON):` pair shared by /recommend's two
 * prompts and /discover's two prompts. Exported for recDiscoverPrompts.ts, which
 * prefixes it with its own header line rather than duplicating the serialization.
 */
export function tasteAndLoved(signal: RecSignal): string {
  return (
    'TASTE TRAITS (JSON):\n' +
    pyJsonDumps(signal.traits) +
    '\n\nLOVED BOOKS (JSON):\n' +
    pyJsonDumps(signal.loved.slice(0, LOVED_SAMPLE))
  );
}

/** recommend._claude_seed_queries' message content. */
export function buildSeedPrompt(signal: RecSignal, nQueries: number): PromptBlock[] {
  const profileContext = tasteAndLoved(signal);

  let steering = '';
  if (signal.more_like.length) {
    steering +=
      ' Bias the queries toward the qualities of these books the reader wants ' +
      'more of: ' +
      pyJsonDumps(signal.more_like) +
      '.';
  }
  if (signal.less_like.length) {
    steering +=
      ' Avoid the qualities of these books the reader wants less of: ' +
      pyJsonDumps(signal.less_like) +
      '.';
  }

  const taskPrompt =
    "A reader's taste profile and a sample of their loved books are above. Propose " +
    `up to ${nQueries} CATALOG SEARCH QUERIES (search terms, not book titles) that ` +
    'would surface books they are likely to rate highly. Chase their distinguishing ' +
    'traits, cover their range, and avoid generic bestseller terms.' +
    steering;

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

/**
 * recommend._user_steering_block: the `## User Steering` section appended to the
 * cached profile prefix. The trailing weighting instruction is ALWAYS emitted, so
 * this never returns "" -- the reranker must always know traits carry weights.
 */
export function userSteeringBlock(signal: RecSignal): string {
  const directiveText = (signal.directive_text ?? '').trim();
  const lines: string[] = ['\n\n## User Steering'];

  if (signal.more_like.length) {
    lines.push(
      'MORE LIKE (books the reader explicitly wants more of):\n' + pyJsonDumps(signal.more_like)
    );
  }
  if (signal.less_like.length) {
    lines.push(
      'LESS LIKE (books the reader explicitly wants less of):\n' + pyJsonDumps(signal.less_like)
    );
  }
  if (signal.reject_reason_counts.size) {
    // A Map, so this joins in Python's dict insertion order.
    const reasons = [...signal.reject_reason_counts.entries()]
      .map(([r, c]) => `${r}: ${c} times`)
      .join(', ');
    lines.push('FREQUENT REJECT REASONS: ' + reasons);
  }
  if (directiveText) {
    lines.push(
      "CUSTOM INSTRUCTIONS (the reader's own standing guidance, in their words; honor " +
        'it as direct high-priority intent, second only to the hard constraints already ' +
        'applied to the candidate set):\n' +
        directiveText
    );
  }
  lines.push(
    'Favor candidates resembling the more-like books; penalize candidates ' +
      'resembling the less-like books; penalize candidates matching frequent reject ' +
      "reasons; weight trait influence by each trait's `user_weight`: traits with a " +
      'lower weight should influence the score less (0.0 = ignore, 1.0 = normal).'
  );
  return lines.join('\n\n');
}

/** recommend._claude_rerank's message content. */
export function buildRerankPrompt(
  candidates: AssembledCandidate[],
  signal: RecSignal,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    title: c.title,
    author: c.author,
    year: c.year,
    subjects: c.subjects ?? [],
  }));

  const rejectedBlock = signal.rejected_with_notes.length
    ? '\n\nREJECTED RECOMMENDATIONS WITH NOTES (JSON):\n' +
      'These are books the reader explicitly skipped with an explanation. Treat ' +
      'each note as direct testimony about what to avoid; heavily penalize ' +
      'candidates that share the same qualities.\n' +
      pyJsonDumps(signal.rejected_with_notes)
    : '';

  const profileContext = tasteAndLoved(signal) + rejectedBlock + userSteeringBlock(signal);

  const taskPrompt =
    `Rank the best ${n} candidates for this reader and explain each. Choose ONLY from ` +
    'the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit. Penalize ' +
    "anything that trips an aversion trait or resembles a rejected book's noted reason. " +
    'Ground every pick in specific trait ids ' +
    'and the library book ids it most resembles - use only ids that appear above.\n\n' +
    'CANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
