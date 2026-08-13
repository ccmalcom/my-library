/**
 * Port of directive.py's Haiku "distill" flow (directive.py:122-273): turns a reader's
 * free-text message into a proposed custom-instructions record. Ephemeral — never writes
 * the directive; the caller shows the proposal and only PUT /directive persists it.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from './db';
import type { ClaudeClient } from './claude';
import { toolInput } from './claude';
import { trackedCreate } from './anthropic';
import { pyJsonDumps } from './serialize';
import { cleanDirectiveConstraints } from './directive';

export const DISTILL_MODEL = 'claude-haiku-4-5-20251001';

// Copied verbatim from mylibrary/directive.py:124-145 — a single differing character
// fails prompt-parity (parity-prompts.test.ts).
export const DISTILL_SYSTEM =
  "You are an authoring aid for a personal reading app. Your job is to turn a reader's " +
  'messy, natural-language message about what they want to read into a clean, durable ' +
  "'custom instructions' record that steers their book recommendations. You do NOT " +
  'recommend books and you do NOT chat for its own sake; you distill.\n\n' +
  'Return, via the record_directive tool:\n' +
  "- proposed_text: a tightened rewrite of the reader's standing preferences in their own " +
  'voice, second person, a few plain sentences. Fold in anything still true from their ' +
  'CURRENT instructions; drop anything they just contradicted. This is the durable record, ' +
  'so write it to stand on its own without the chat.\n' +
  '- constraints: ONLY hard, catalog-filterable filters the reader actually stated: ' +
  'languages (ISO 639-1), min_year / max_year, exclude_subjects, exclude_authors ' +
  '(surnames). Do NOT invent filters. Do NOT emit page-count or series filters; those are ' +
  'not filterable, so leave length or series wishes in proposed_text as soft guidance.\n' +
  '- conflicts: short plain-language notes when the new request contradicts something in ' +
  "the reader's EXISTING SIGNALS (a rejected taste trait, or a book they marked " +
  'less-like-this). One sentence each; empty list when there is no clash. Never resolve a ' +
  'conflict yourself; just surface it.\n' +
  '- assistant_message: one short, friendly line to the reader: confirm what you captured ' +
  'and, only if useful, ask one clarifying question.\n\n' +
  'Use plain punctuation only. No em dashes.';

// Copied verbatim from mylibrary/directive.py:147-184.
export const DISTILL_TOOL = {
  name: 'record_directive',
  description:
    'Record the distilled custom-instructions text, derived hard constraints, ' +
    'any conflicts with existing signals, and one short message back to the reader.',
  input_schema: {
    type: 'object',
    properties: {
      proposed_text: {
        type: 'string',
        description:
          'The durable custom-instructions record, second person, plain ' +
          'sentences. Stands on its own without the chat.',
      },
      constraints: {
        type: 'object',
        description: 'Hard filters the reader stated. Omit any not stated.',
        properties: {
          languages: {
            type: 'array',
            items: { type: 'string' },
            description: 'ISO 639-1 codes, only when a language is named.',
          },
          min_year: { type: 'integer' },
          max_year: { type: 'integer' },
          exclude_subjects: { type: 'array', items: { type: 'string' } },
          exclude_authors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Author surnames to avoid.',
          },
        },
      },
      conflicts: {
        type: 'array',
        items: { type: 'string' },
        description: 'One-sentence notes where the request clashes with existing signals.',
      },
      assistant_message: {
        type: 'string',
        description: 'One short line back to the reader.',
      },
    },
    required: ['proposed_text'],
  },
};

/**
 * Port of directive.py's prompt concatenation (directive.py:237-245). `message` is
 * trimmed before embedding — `(message or "").strip()` in Python — `currentText` is not
 * (only its `|| '(none yet)'` fallback is applied).
 */
export function buildDistillPrompt(
  currentText: string | null,
  signals: Record<string, unknown>,
  message: string
): string {
  return (
    'CURRENT INSTRUCTIONS (may be empty):\n' +
    (currentText || '(none yet)') +
    '\n\nEXISTING SIGNALS (JSON - for conflict detection only):\n' +
    pyJsonDumps(signals) +
    '\n\nREADER MESSAGE:\n"' +
    (message || '').trim() +
    '"'
  );
}

/**
 * Port of directive.py:_existing_signals (187-214): the rejected traits + more/less-like
 * books used as conflict-detection context. Key insertion order (rejected_traits,
 * more_like, less_like) must match Python's dict literal for prompt-string parity.
 *
 * Both queries below feed lists straight into the byte-exact Claude prompt (via
 * pyJsonDumps), so row order must be deterministic — `ORDER BY id ASC` on both, same
 * convention Tasks 7/8 adopted for their own prompt-feeding queries (archetypeDerive.ts,
 * revealLines.ts), since an unordered query is at the mercy of the Postgres query plan.
 */
export async function existingSignals(db: Db, userId: string): Promise<Record<string, unknown>> {
  const rejectedTraits = (
    await db
      .select({ claim: schema.tasteTraits.claim })
      .from(schema.tasteTraits)
      .where(and(eq(schema.tasteTraits.userId, userId), eq(schema.tasteTraits.status, 'rejected')))
      .orderBy(asc(schema.tasteTraits.id))
  ).map((r) => r.claim);

  const signals = await db
    .select()
    .from(schema.tasteSignal)
    .where(and(eq(schema.tasteSignal.userId, userId), eq(schema.tasteSignal.targetKind, 'book')))
    .orderBy(asc(schema.tasteSignal.id));

  const bookIds = [
    ...new Set(
      signals
        .map((s) => s.targetBookId)
        .filter((id): id is number => id !== null && id !== undefined)
    ),
  ];
  const booksById = new Map<number, string>();
  if (bookIds.length) {
    const books = await db
      .select({ id: schema.books.id, title: schema.books.title, author: schema.books.author })
      .from(schema.books)
      .where(and(eq(schema.books.userId, userId), inArray(schema.books.id, bookIds)));
    for (const b of books) {
      booksById.set(b.id, b.author ? `${b.title} by ${b.author}` : b.title);
    }
  }

  const moreLike: string[] = [];
  const lessLike: string[] = [];
  for (const sig of signals) {
    const label = sig.targetBookId != null ? booksById.get(sig.targetBookId) : undefined;
    if (label === undefined) continue;
    (sig.direction === 'more' ? moreLike : lessLike).push(label);
  }

  return { rejected_traits: rejectedTraits, more_like: moreLike, less_like: lessLike };
}

export interface DistillResult {
  proposed_text: string;
  constraints: Record<string, unknown>;
  conflicts: string[];
  assistant_message: string;
}

/**
 * Port of directive.distill_directive (216-273), minus key resolution/client construction
 * (the route does that — see claude.ts — so this can take an already-built client, which
 * is also what makes it directly testable with fakeClaude). Tracks spend under operation
 * 'directive_distill'.
 */
export async function distillDirective(
  db: Db,
  client: ClaudeClient,
  opts: { message: string; currentText?: string | null; userId: string }
): Promise<DistillResult> {
  const signals = await existingSignals(db, opts.userId);
  const prompt = buildDistillPrompt(opts.currentText ?? null, signals, opts.message);

  const message = await trackedCreate(
    client,
    db,
    { userId: opts.userId, operation: 'directive_distill' },
    {
      model: DISTILL_MODEL,
      max_tokens: 1200,
      system: DISTILL_SYSTEM,
      tools: [DISTILL_TOOL],
      tool_choice: { type: 'tool', name: 'record_directive' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const data = toolInput(message, 'record_directive');
  if (data) {
    const conflictsRaw = Array.isArray(data.conflicts) ? data.conflicts : [];
    return {
      proposed_text: String(data.proposed_text ?? '').trim(),
      constraints: cleanDirectiveConstraints(data.constraints ?? {}),
      conflicts: conflictsRaw.map((c) => String(c).trim()).filter((c) => c),
      assistant_message: String(data.assistant_message ?? '').trim(),
    };
  }
  return {
    proposed_text: opts.currentText || '',
    constraints: {},
    conflicts: [],
    assistant_message: '',
  };
}
