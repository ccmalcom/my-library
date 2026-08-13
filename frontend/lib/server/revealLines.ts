/**
 * Port of mylibrary/reveal.py's Haiku "reveal line" generation (reveal.py:100-167): rewrites
 * each of a user's analytic taste-trait claims missing a `reveal_line` as a short,
 * second-person line for the Wrapped-style reveal. Idempotent — traits that already have a
 * line are never re-sent, and if none are missing (or the user has no traits) no Claude call
 * is made at all.
 *
 * DESIGN NOTE (client nullability): Python only resolves the API key AFTER confirming there
 * is pending work (reveal.py:110-126) — the no-op case requires no key. distillDirective and
 * deriveArchetype's routes eagerly resolve the key before calling in because their Python
 * twins always need one; this flow's route instead resolves the key optimistically (cheap,
 * no network call) and passes `null` if none is configured. generateRevealLines checks for
 * pending work FIRST and returns early (never touching `client`) when there's nothing to do,
 * so `null` is safe in that case. Only when there IS pending work and `client` is `null` does
 * it throw ApiError(400, REVEAL_NO_KEY_MESSAGE) — mirroring Python's RuntimeError exactly.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import type { ClaudeClient } from './claude';
import { toolInput } from './claude';
import { trackedCreate } from './anthropic';
import { pyJsonDumps } from './serialize';
import { REVEAL_NO_KEY_MESSAGE } from './claudeErrors';

export const REVEAL_MODEL = 'claude-haiku-4-5-20251001';

// Copied verbatim from mylibrary/reveal.py:27-34.
export const REVEAL_SYSTEM =
  "You rewrite a reader's analytic taste traits as short, second-person reveal lines " +
  "for a personal reading app. Each line addresses the reader directly ('You...'), " +
  'uses concrete nouns over abstractions, contains no hedging words, and asserts ' +
  "nothing the source claim doesn't already say. Never gush; the delight is in the " +
  'specificity. Use plain punctuation only: no em dashes. ' +
  'Return one line per trait id via the record_reveal_lines tool.';

// Copied verbatim from mylibrary/reveal.py:37-48.
export const REVEAL_FEWSHOTS: Array<[string, string]> = [
  [
    'Rewards dense, stylized prose; rates workmanlike prose lower',
    'You notice sentences. Plain prose has to work twice as hard.',
  ],
  [
    'Reader consistently rewards character interiority over plot momentum',
    "You'll forgive a slow plot if the people feel real.",
  ],
  [
    'Rewards completed series over standalones',
    'When you commit, you commit. Standalones rarely make your top shelf.',
  ],
  [
    'Penalizes romance subplots that interrupt the main narrative',
    'Love stories that stall the plot lose you fast.',
  ],
  [
    'Possible preference for translated fiction; sample is small',
    'You keep drifting toward books written in other languages first.',
  ],
];

// Copied verbatim from mylibrary/reveal.py:50-74.
export const REVEAL_TOOL = {
  name: 'record_reveal_lines',
  description: 'Record one second-person reveal line per trait id.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'The trait id being rewritten.' },
            reveal_line: {
              type: 'string',
              description:
                '<=14 words, second person, concrete, no hedging, ' +
                'derivable from the claim. Plain punctuation, no em dashes.',
            },
          },
          required: ['id', 'reveal_line'],
        },
      },
    },
    required: ['lines'],
  },
};

export interface RevealTraitPayload {
  id: number;
  claim: string;
  polarity: string;
}

/**
 * Port of reveal.py::_build_reveal_prompt (77-97). Pure — no I/O. Note the few-shot line
 * format: `  claim: "{claim}"\n  line:  "{line}"` — TWO spaces after `line:` so `claim: ` and
 * `line:  ` are the same visual width. Load-bearing for byte parity.
 */
export function buildRevealPrompt(traits: RevealTraitPayload[]): string {
  const examples = REVEAL_FEWSHOTS.map(
    ([claim, line]) => `  claim: "${claim}"\n  line:  "${line}"`
  ).join('\n');
  return (
    'Rewrite each analytic taste claim below as a second-person reveal line.\n\n' +
    'Rules for every line:\n' +
    '  - 14 words or fewer.\n' +
    "  - Address the reader as 'You'. Present tense.\n" +
    "  - Concrete nouns over abstractions ('slow first chapters', not 'gradual pacing').\n" +
    "  - No hedging words inside the line (no 'maybe', 'probably', 'we think').\n" +
    "  - Assert nothing the claim doesn't already say. No new facts.\n" +
    "  - For an aversion, keep a knowing tone: 'not for you', never 'you failed to appreciate'.\n" +
    '  - Plain punctuation only. No em dashes.\n\n' +
    'Examples:\n' +
    examples +
    '\n\nReturn exactly one line per id via record_reveal_lines.\n\n' +
    'TRAITS (JSON):\n' +
    pyJsonDumps(traits)
  );
}

export interface RevealLinesResult {
  generated: number;
  traits: number;
  model: string;
}

/**
 * Port of reveal.py::generate_reveal_lines (100-167), minus key resolution/client
 * construction (see module doc above — `client` is nullable, unlike distillDirective's and
 * deriveArchetype's required ClaudeClient, because this flow only needs a key when there is
 * pending work).
 *
 * Row order: Python's `pending` query has no explicit ORDER BY (reveal.py:110-114); Node
 * queries `ORDER BY id ASC` explicitly, verified byte-exact against the real captured
 * Python prompt fixture (parity-prompts.test.ts) — the seed's freshly-inserted rows come
 * back from SQLite's unordered query in insertion/primary-key order, which id-ascending
 * reproduces.
 */
export async function generateRevealLines(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  maxTokens = 1200
): Promise<RevealLinesResult> {
  const pending = await db
    .select({
      id: schema.tasteTraits.id,
      claim: schema.tasteTraits.claim,
      polarity: schema.tasteTraits.polarity,
    })
    .from(schema.tasteTraits)
    .where(and(eq(schema.tasteTraits.userId, userId), isNull(schema.tasteTraits.revealLine)))
    .orderBy(asc(schema.tasteTraits.id));

  if (pending.length === 0) {
    return { generated: 0, traits: 0, model: REVEAL_MODEL };
  }

  if (!client) {
    throw new ApiError(400, REVEAL_NO_KEY_MESSAGE);
  }

  const payload: RevealTraitPayload[] = pending.map((t) => ({
    id: t.id,
    claim: t.claim,
    polarity: t.polarity,
  }));

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'reveal_lines' },
    {
      model: REVEAL_MODEL,
      max_tokens: maxTokens,
      system: REVEAL_SYSTEM,
      tools: [REVEAL_TOOL],
      tool_choice: { type: 'tool', name: 'record_reveal_lines' },
      messages: [{ role: 'user', content: buildRevealPrompt(payload) }],
    }
  );

  const input = toolInput(message, 'record_reveal_lines');
  const rawLines = Array.isArray(input?.lines) ? (input.lines as unknown[]) : [];

  // Port of reveal.py:147-151's dict comprehension. A Map (not a plain object) to match
  // Python dict semantics: re-setting an existing key updates its value in place without
  // moving it — irrelevant for the persistence loop below (order doesn't affect which ids
  // win) but kept for structural parity.
  const byId = new Map<number, string>();
  for (const item of rawLines) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.id === null || rec.id === undefined) continue;
    const line = String(rec.reveal_line ?? '').trim();
    if (!line) continue;
    byId.set(Number(rec.id), line);
  }

  const validIds = new Set(payload.map((p) => p.id));
  let generated = 0;
  await db.transaction(async (tx) => {
    for (const [tid, line] of byId) {
      if (!validIds.has(tid)) continue;
      const rows = await tx
        .select({
          id: schema.tasteTraits.id,
          userId: schema.tasteTraits.userId,
          revealLine: schema.tasteTraits.revealLine,
        })
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.id, tid));
      const trait = rows[0];
      if (!trait || trait.userId !== userId) continue;
      if (trait.revealLine) continue; // a concurrent generation may have filled it
      await tx
        .update(schema.tasteTraits)
        .set({ revealLine: line })
        .where(eq(schema.tasteTraits.id, tid));
      generated += 1;
    }
  });

  return { generated, traits: payload.length, model: REVEAL_MODEL };
}
