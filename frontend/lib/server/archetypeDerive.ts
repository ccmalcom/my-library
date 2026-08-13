/**
 * Port of mylibrary/archetype.py's Haiku 4-axis reader-archetype derivation
 * (archetype.py:139-330). Takes an already-built Claude client — same pattern as
 * directiveDistill.ts: the route resolves the API key and throws ApiError(400,
 * ARCHETYPE_NO_KEY_MESSAGE) before calling in (see claude.ts / archetype.py:230-234),
 * which is why that RuntimeError is not one of the conditions handled here.
 */
import { asc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import type { ClaudeClient } from './claude';
import { toolInput } from './claude';
import { trackedCreate } from './anthropic';
import { utcnowTs } from './serialize';
import { ARCHETYPES, scoresToCode } from './archetype';

export const ARCHETYPE_MODEL = 'claude-haiku-4-5-20251001';

// Copied verbatim from mylibrary/archetype.py:193-198.
export const ARCHETYPE_SYSTEM =
  "You are a literary analyst scoring a reader's personality across 4 axes based on their " +
  'taste traits. Each axis is a float from -1.0 (left pole) to +1.0 (right pole). ' +
  'Use the full range; avoid clustering near 0 unless the evidence is genuinely mixed. ' +
  'Call record_archetype_scores with all 8 fields.';

// Copied verbatim from mylibrary/archetype.py:139-189.
export const ARCHETYPE_TOOL = {
  name: 'record_archetype_scores',
  description: "Record the reader's axis scores derived from their taste profile.",
  input_schema: {
    type: 'object',
    properties: {
      lens: {
        type: 'number',
        description: '-1=Immersive (transported, escape), +1=Reflective (ideas, craft, challenge)',
      },
      engine: {
        type: 'number',
        description:
          '-1=Plot-first (momentum, twists), +1=Character-first (interiority, relationships)',
      },
      range: {
        type: 'number',
        description: '-1=Broad (genre eclectic), +1=Deep (genre loyal, series reader)',
      },
      resonance: {
        type: 'number',
        description:
          '-1=Heart (emotional resonance, mood), +1=Mind (intellectual craft, structure)',
      },
      lens_rationale: {
        type: 'string',
        description: 'Brief rationale for the lens score.',
      },
      engine_rationale: {
        type: 'string',
        description: 'Brief rationale for the engine score.',
      },
      range_rationale: {
        type: 'string',
        description: 'Brief rationale for the range score.',
      },
      resonance_rationale: {
        type: 'string',
        description: 'Brief rationale for the resonance score.',
      },
    },
    required: [
      'lens',
      'engine',
      'range',
      'resonance',
      'lens_rationale',
      'engine_rationale',
      'range_rationale',
      'resonance_rationale',
    ],
  },
};

export interface TraitLike {
  claim: string;
  polarity: string | null;
}

/**
 * Port of archetype.py::_build_prompt (201-213). Iterates ALL of the caller-supplied
 * traits (no status filter — deriveArchetype below queries every TasteTrait row for the
 * user, matching Python's unfiltered query) in the order given.
 */
export function buildArchetypePrompt(traits: TraitLike[]): string {
  const lines = ["Score this reader's taste profile across 4 axes.\n\nTaste traits:"];
  for (const t of traits) {
    // Node's taste_traits.polarity column is NOT NULL, so this is always truthy in
    // practice; kept as a falsy-check for structural parity with Python's
    // `getattr(t, "polarity", None)` pattern.
    const polarity = t.polarity ? ` [${t.polarity}]` : '';
    lines.push(`- ${t.claim}${polarity}`);
  }
  lines.push(
    '\nAxes:\n' +
      '  lens:      -1=Immersive (escape/absorption), +1=Reflective (ideas/craft)\n' +
      '  engine:    -1=Plot-first (events/twists), +1=Character-first (interiority)\n' +
      '  range:     -1=Broad (eclectic genres), +1=Deep (genre loyal, series)\n' +
      '  resonance: -1=Heart (emotional/mood), +1=Mind (intellectual/structural)\n'
  );
  return lines.join('\n');
}

/** Port of archetype.py::_clamp_axis (274-277). */
function clampAxis(x: unknown): number {
  const n = typeof x === 'number' ? x : Number(x);
  if (!Number.isFinite(n)) {
    throw new ApiError(400, 'Claude returned a non-finite axis score.');
  }
  return Math.max(-1, Math.min(1, n));
}

interface AxisScores {
  lens: number;
  engine: number;
  range: number;
  resonance: number;
}

/**
 * Port of archetype.py:279-287's try/except (KeyError, TypeError, ValueError) around the
 * four `_clamp_axis(float(tool_input[...]))` calls. Python's exception embeds its own
 * exception-string formatting for malformed payloads (missing keys, non-numeric values);
 * Claude's structured tool-calling makes that path essentially unreachable in practice
 * (input_schema requires all 4 as numbers), so exact byte-parity for Python's message
 * formatting is NOT chased here — deliberately approximate, per plan. The one exact-parity
 * error in this block is clampAxis's non-finite message above, which is never caught by
 * this try/catch (it propagates as its own ApiError, same as Python's RuntimeError
 * propagating uncaught through the KeyError/TypeError/ValueError except clause).
 */
function extractAxisScores(input: Record<string, unknown>): AxisScores {
  try {
    return {
      lens: clampAxis(input.lens),
      engine: clampAxis(input.engine),
      range: clampAxis(input.range),
      resonance: clampAxis(input.resonance),
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(400, `Invalid archetype tool payload returned by Claude: ${message}`);
  }
}

/** Port of archetype.py:288-292's `ARCHETYPES.get(code)` + None guard. Exported for direct
 *  testing of the (practically unreachable, given 16/16 code coverage) guard clause. */
export function lookupArchetype(code: string): { name: string; tagline: string } {
  const archetype = ARCHETYPES[code];
  if (!archetype) {
    throw new ApiError(400, `Unknown archetype code derived: ${code}`);
  }
  return archetype;
}

export interface ArchetypeResult {
  code: string;
  name: string;
  tagline: string;
  axisLens: number;
  axisEngine: number;
  axisRange: number;
  axisResonance: number;
  lensRationale: string;
  engineRationale: string;
  rangeRationale: string;
  resonanceRationale: string;
  derivedAt: string;
}

/**
 * Port of archetype.py::derive_archetype (220-330), minus key resolution/client
 * construction (see module doc). Fetches all of the user's taste traits, calls Claude
 * Haiku, clamps + assembles the 4-axis code, and upserts the reader_archetypes row —
 * mirroring Python's find-or-update-else-create inside one session (archetype.py:295-303)
 * with a Drizzle transaction (wave-2 convention). The return value mirrors Python's
 * ArchetypeResult dataclass; api.py's post_archetype discards it and re-queries instead
 * (see route.ts), which this does too — deriveArchetype's return value exists for
 * direct testability, matching what distillDirective.ts does for its own flow.
 */
export async function deriveArchetype(
  db: Db,
  client: ClaudeClient,
  userId: string
): Promise<ArchetypeResult> {
  const traits = await db
    .select({ claim: schema.tasteTraits.claim, polarity: schema.tasteTraits.polarity })
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .orderBy(asc(schema.tasteTraits.id));
  if (traits.length === 0) {
    throw new ApiError(400, 'No taste profile found. Build your taste profile first.');
  }

  const prompt = buildArchetypePrompt(traits);
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'archetype' },
    {
      model: ARCHETYPE_MODEL,
      max_tokens: 512,
      system: ARCHETYPE_SYSTEM,
      tools: [ARCHETYPE_TOOL],
      tool_choice: { type: 'tool', name: 'record_archetype_scores' },
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const input = toolInput(message, 'record_archetype_scores');
  if (!input) {
    throw new ApiError(400, 'Claude response missing tool payload (record_archetype_scores).');
  }

  const scores = extractAxisScores(input);
  const code = scoresToCode(scores);
  const archetype = lookupArchetype(code);

  const now = utcnowTs();
  const lensRationale = String(input.lens_rationale ?? '');
  const engineRationale = String(input.engine_rationale ?? '');
  const rangeRationale = String(input.range_rationale ?? '');
  const resonanceRationale = String(input.resonance_rationale ?? '');

  const values = {
    code,
    archetypeName: archetype.name,
    archetypeTagline: archetype.tagline,
    axisLens: scores.lens,
    axisEngine: scores.engine,
    axisRange: scores.range,
    axisResonance: scores.resonance,
    lensRationale,
    engineRationale,
    rangeRationale,
    resonanceRationale,
    derivedAt: now,
  };

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: schema.readerArchetypes.id })
      .from(schema.readerArchetypes)
      .where(eq(schema.readerArchetypes.userId, userId));
    if (existing[0]) {
      await tx
        .update(schema.readerArchetypes)
        .set(values)
        .where(eq(schema.readerArchetypes.id, existing[0].id));
    } else {
      await tx.insert(schema.readerArchetypes).values({ userId, ...values });
    }
  });

  return {
    code,
    name: archetype.name,
    tagline: archetype.tagline,
    axisLens: scores.lens,
    axisEngine: scores.engine,
    axisRange: scores.range,
    axisResonance: scores.resonance,
    lensRationale,
    engineRationale,
    rangeRationale,
    resonanceRationale,
    derivedAt: now,
  };
}
