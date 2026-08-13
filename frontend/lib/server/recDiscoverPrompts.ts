/**
 * Port of recommend.py's two /discover prompts (_DISCOVER_SYSTEM/_DISCOVER_TOOL and
 * _DISCOVER_RANK_SYSTEM/_DISCOVER_RANK_TOOL) plus their builders.
 *
 * Discovery grounds in the reader's REQUEST; the taste profile is secondary
 * tie-break context only, which is why neither prompt carries the user-steering
 * block that /recommend's reranker uses. Stage A reuses recPrompts' Haiku model and
 * token budget, exactly as Python does.
 *
 * Every string here is copied VERBATIM from Python and asserted byte-for-byte in
 * parity-discover-prompts.test.ts. Do not reflow or re-punctuate them.
 */
import type { AssembledCandidate } from './recAssemble';
import { tasteAndLoved, type PromptBlock } from './recPrompts';
import type { RecSignal } from './recSignal';
import { pyJsonDumps } from './serialize';

// --- stage A: interpret the request ----------------------------------------

export const DISCOVER_SYSTEM =
  "You translate a reader's natural-language book request into catalog search queries and " +
  'constraints. You never name specific titles; you produce search TERMS (themes, genres, ' +
  'styles, comparable-author names when the reader gives one) that a book catalog can ' +
  'resolve.\n\n' +
  'Rules:\n' +
  "- The reader's request is the primary signal. Their taste profile is provided as " +
  'secondary context: use it to break ties and set tone (e.g. their prose preferences), ' +
  'never to override what they asked for. If they ask for something their profile dislikes, ' +
  'honor the request; people read outside their pattern on purpose.\n' +
  '- If the request names a book or author ("like The Fifth Season"), decompose WHY someone ' +
  'asks for that book into 3-6 distinct facets (e.g. geological apocalypse setting; ' +
  'second-person narration; rage as the engine; found family under oppression) and emit one ' +
  'query per facet. Facets, not synonyms: six rewordings of the same idea retrieve the same ' +
  'shelf six times.\n' +
  '- If the request is a mood or situation ("something gentle for a bad week", "a beach book ' +
  'that isn\'t dumb"), translate the mood into concrete catalog language: pacing, stakes, tone.\n' +
  '- Extract hard constraints ONLY when the reader states them: language, publication era ' +
  '(min_year / max_year), and subjects to avoid (exclude_subjects, e.g. "nothing violent" ' +
  '-> war, violence). These are filters, not queries. Do not invent constraints the reader ' +
  "didn't state, and do not constrain by length or series; those aren't filterable.\n" +
  '- When the request is ambiguous, emit queries covering the 2-3 most likely readings rather ' +
  'than guessing one.\n\n' +
  'Examples (request -> facets; constraints only when stated):\n' +
  '- "Find me a book like Project Hail Mary" -> facets: lone-problem-solver survival scifi; ' +
  'competence-porn engineering narration; first-contact friendship; humor inside hard sci-fi; ' +
  'race-against-extinction stakes. No constraints.\n' +
  '- "Something gentle for a bad week" -> facets: low-stakes literary comfort; kindness between ' +
  'strangers; cozy small-community fiction; quiet healing narratives. Constraints: ' +
  'exclude_subjects: [grief, war, abuse].\n' +
  '- "A thriller my book club won\'t hate" -> facets: literary crime; character-driven suspense; ' +
  'thrillers with prose ambition; discussable moral-dilemma plots. No hard constraints.\n' +
  '- "Nonfiction that reads like a novel" -> facets: narrative nonfiction; immersive reportage; ' +
  'true crime with literary structure; biography with scene-level storytelling. No hard ' +
  'constraints.';

export const DISCOVER_TOOL = {
  name: 'interpret_request',
  description:
    "Translate a reader's natural-language book request into catalog SEARCH queries " +
    '(search terms: themes, styles, comparable-author names, never specific titles), ' +
    'the hard constraints they stated, and a one-sentence interpretation of what they want.',
  input_schema: {
    type: 'object',
    properties: {
      interpretation: {
        type: 'string',
        description: 'One sentence restating what the reader wants, in their own terms.',
      },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'A catalog search query for one facet: search terms, not a title.',
            },
            rationale: {
              type: 'string',
              description: 'Which facet of the request this query chases.',
            },
          },
          required: ['query', 'rationale'],
        },
      },
      constraints: {
        type: 'object',
        description: 'Hard filters the reader stated. Omit any they did not state.',
        properties: {
          languages: {
            type: 'array',
            items: { type: 'string' },
            description:
              "ISO 639-1 codes, e.g. ['en','fr']. Only when the reader names a language.",
          },
          min_year: {
            type: 'integer',
            description: 'Earliest publication year, when the reader states an era.',
          },
          max_year: {
            type: 'integer',
            description: 'Latest publication year, when the reader states an era.',
          },
          exclude_subjects: {
            type: 'array',
            items: { type: 'string' },
            description: "Subjects/themes to avoid, e.g. ['war','grief'] for 'nothing heavy'.",
          },
        },
      },
    },
    required: ['interpretation', 'queries'],
  },
};

/** recommend._interpret_query's message content. */
export function buildInterpretPrompt(query: string, signal: RecSignal): PromptBlock[] {
  const profileContext =
    'READER TASTE PROFILE (secondary context; the request rules):\n' + tasteAndLoved(signal);

  // The query is interpolated raw inside double quotes, exactly as Python does.
  // A query containing a `"` produces unbalanced quotes there too.
  const taskPrompt =
    `The reader asked: "${query}"\n\n` +
    'Interpret this request. Emit search QUERIES (facets, not titles), any hard ' +
    'CONSTRAINTS they stated (language, era, subjects to avoid; omit if unstated), and ' +
    'a one-sentence INTERPRETATION of what they want.';

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

// --- stage B: rank candidates by fit to the request -------------------------

export const DISCOVER_RANK_TOOL = {
  name: 'rank_discovery',
  description:
    "Rank the provided real catalog candidates by how well they answer the reader's " +
    'request, and explain each pick. Choose ONLY from the given candidates.',
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
              description: "0..1 fit with the reader's REQUEST.",
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences answering the request in its own terms: what the ' +
                'book does and which facet of the request it delivers. Name the ' +
                'mechanism (pace, voice, structure, mood, subject), not just ' +
                'shared genre. Honest about stretch picks. Plain punctuation, ' +
                'no em dashes.',
            },
          },
          required: ['candidate_index', 'score', 'rationale'],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const DISCOVER_RANK_SYSTEM =
  "You are a book recommender answering a reader's specific request. You rank a fixed list " +
  'of real catalog candidates by how well they answer THAT REQUEST, and you never invent ' +
  'books; you only rank the candidates given. Rank fit against the request first and the ' +
  "reader's taste profile second (use the profile only to break ties). You prefer specific " +
  'fit (voice, structure, pace, mood, subject) over popularity.\n\n' +
  'Write each rationale like a well-read friend pressing the book into their hands, in 1-2 ' +
  'sentences: lead with what the book does, then answer the request in its own terms: if ' +
  'they asked for "like The Fifth Season", say which facet of it this book delivers. Name ' +
  'the mechanism of the fit, never just shared genre. If a pick is a stretch, say so honestly ' +
  'and name what still connects. Use plain punctuation only: no em dashes. Never write ' +
  '"you\'ll love this", generic praise, or clinical trait language.';

/** recommend._rerank_discovery's message content. */
export function buildDiscoverRerankPrompt(
  candidates: AssembledCandidate[],
  query: string,
  interpretation: string,
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

  // NOTE the header differs from stage A's by one substring. Not a typo.
  const profileContext =
    'READER TASTE PROFILE (secondary - the request rules):\n' + tasteAndLoved(signal);

  const taskPrompt =
    `The reader asked: "${query}"\n` +
    `Interpreted as: ${interpretation}\n\n` +
    `Rank the best ${n} candidates against THIS REQUEST and explain each. Choose ONLY from ` +
    'the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit to the request. In ' +
    'each rationale, answer the request in its own terms.\n\n' +
    'CANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
