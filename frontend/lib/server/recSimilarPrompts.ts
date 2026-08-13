/**
 * Port of recommend.py's two per-book prompts (_BOOK_FACET_SYSTEM and
 * _SIMILAR_RANK_TOOL/_SIMILAR_RANK_SYSTEM) plus their builders.
 *
 * These live apart from recPrompts.ts because they ground in ONE anchor book
 * rather than the taste profile -- no traits, no loved books, no user steering.
 * Stage 1b reuses recPrompts' SEED_TOOL/SEED_MODEL/SEED_MAX_TOKENS verbatim,
 * exactly as Python reuses _SEED_TOOL.
 *
 * Every string here is copied VERBATIM from Python and asserted byte-for-byte in
 * parity-similar-prompts.test.ts. Do not reflow or re-punctuate them.
 */
import type { AssembledCandidate } from './recAssemble';
import type { PromptBlock } from './recPrompts';
import type { BookAnchor } from './recSignal';
import { pyJsonDumps } from './serialize';

// --- stage 1b: decompose one book into search queries -----------------------

export const BOOK_FACET_SYSTEM =
  'You decompose ONE book into catalog search queries that would surface OTHER books ' +
  'like it. You propose search TERMS, never specific titles. Chase what makes this ' +
  'particular book distinctive (its voice, structure, pace, mood, and specific subject ' +
  "matter), not generic bestsellers in its genre. Do not aim queries at the book's own " +
  'author (same-author books are handled separately); reach for comparable books by ' +
  'other authors.';

/**
 * The `SEED BOOK (JSON):` block, byte-identical in both stages (Python builds the
 * same `book_context` string twice), so the two calls share an ephemeral cache prefix.
 *
 * A plain object literal is correct here: every key is alphabetic, so V8 preserves
 * insertion order. (The Map rule in serialize.ts exists for integer-like keys.) The
 * key ORDER below is load-bearing -- it is Python's dict literal order.
 */
export function seedBookContext(anchor: BookAnchor): string {
  return (
    'SEED BOOK (JSON):\n' +
    pyJsonDumps({
      title: anchor.title,
      author: anchor.author,
      year: anchor.year,
      subjects: anchor.subjects ?? [],
      series: anchor.series,
      description: anchor.description,
    })
  );
}

/** recommend._book_facet_queries' message content. */
export function buildBookFacetPrompt(anchor: BookAnchor, nQueries: number): PromptBlock[] {
  const taskPrompt =
    `The seed book is above. Propose up to ${nQueries} CATALOG SEARCH QUERIES ` +
    '(search terms, not book titles) that would surface books a reader who loved this ' +
    'one is likely to enjoy. Chase its distinguishing qualities (voice, structure, ' +
    'mood, and specific subject matter) and avoid generic bestseller terms and the ' +
    "book's own author.";

  return [
    { type: 'text', text: seedBookContext(anchor), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

// --- stage 2: rank candidates by resemblance to the seed book ---------------

export const SIMILAR_RANK_TOOL = {
  name: 'rank_similar_books',
  description:
    'Rank the provided real catalog candidates by how similar they are to the seed ' +
    'book, and explain each pick. Choose ONLY from the given candidates.',
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
              description: '0..1 similarity to the seed book.',
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a well-read friend: what the ' +
                'book does and how it echoes the seed book, naming the ' +
                'mechanism of the resemblance (pace, voice, structure, mood, ' +
                'subject), never just shared genre. Honest about stretch ' +
                'picks. Plain punctuation, no em dashes.',
            },
          },
          required: ['candidate_index', 'score', 'rationale'],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const SIMILAR_RANK_SYSTEM =
  'You recommend books similar to ONE specific book the reader already knows. You rank a ' +
  'fixed list of real catalog candidates by how much they resemble that seed book, and you ' +
  'never invent books; you only rank the candidates given. You prefer specific resemblance ' +
  '(voice, structure, pace, mood, subject) over shared genre or popularity.\n\n' +
  'Write each rationale like a well-read friend pressing the book into their hands, in 1-2 ' +
  'sentences: lead with what the book does, then name exactly how it echoes the seed book. ' +
  'If a pick is a stretch, say so honestly and name what still connects. Use plain ' +
  'punctuation only: no em dashes. Never write "you\'ll love this", generic praise, or ' +
  'clinical genre-speak.';

/** recommend._rerank_similar's message content. */
export function buildSimilarRerankPrompt(
  candidates: AssembledCandidate[],
  anchor: BookAnchor,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    title: c.title,
    author: c.author,
    year: c.year,
    subjects: c.subjects ?? [],
  }));

  const taskPrompt =
    `Rank the best ${n} candidates by similarity to the SEED BOOK and explain each. ` +
    'Choose ONLY from the CANDIDATES list (cite each by its `idx`). Score 0..1 for ' +
    'resemblance to the seed book. Name the mechanism of the resemblance in each ' +
    'rationale.\n\nCANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: seedBookContext(anchor), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
