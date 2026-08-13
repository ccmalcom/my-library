import { eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema, type Db } from '@/lib/server/db';
import { ARCHETYPE_HOOKS, scoreToLetter } from '@/lib/server/archetype';
import { tsToIso } from '@/lib/server/serialize';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { ARCHETYPE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { deriveArchetype } from '@/lib/server/archetypeDerive';

// Single Haiku call, well under 30s in practice — parity twin has no timeout of
// its own. 300s = Hobby's max/default (see directive/draft/route.ts for the full note).
export const maxDuration = 300;

type ReaderArchetypeRow = typeof schema.readerArchetypes.$inferSelect;

function toDate(ts: string): Date {
  return new Date(ts.replace(' ', 'T') + 'Z');
}

async function getLastProfiledAt(db: Db, userId: string): Promise<string | null> {
  const metaRows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  return metaRows[0]?.lastProfiledAt ?? null;
}

/** Port of api.py::_archetype_out — shared by GET and POST (api.py:1244-1281). */
function archetypeOut(row: ReaderArchetypeRow, lastProfiledAt: string | null) {
  const axis = (
    key: 'lens' | 'engine' | 'range' | 'resonance',
    score: number,
    rationale: string | null
  ) => ({
    score,
    letter: scoreToLetter(key, score),
    rationale: rationale ? rationale : null, // Python `rationale or None`: '' → null
  });

  return {
    code: row.code,
    name: row.archetypeName,
    tagline: row.archetypeTagline,
    hook: ARCHETYPE_HOOKS[row.code] ?? '',
    lens: axis('lens', row.axisLens, row.lensRationale),
    engine: axis('engine', row.axisEngine, row.engineRationale),
    range: axis('range', row.axisRange, row.rangeRationale),
    resonance: axis('resonance', row.axisResonance, row.resonanceRationale),
    derived_at: tsToIso(row.derivedAt),
    is_stale: lastProfiledAt !== null && toDate(row.derivedAt) < toDate(lastProfiledAt),
  };
}

/** Port of api.py::get_archetype. */
export const GET = withApi('/api/profile/archetype', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.readerArchetypes)
    .where(eq(schema.readerArchetypes.userId, ctx.user.userId));
  const row = rows[0];
  if (!row) throw new ApiError(404, 'No archetype derived yet');

  const lastProfiledAt = await getLastProfiledAt(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(archetypeOut(row, lastProfiledAt));
});

/**
 * Port of api.py::post_archetype (1244-1264). Resolves the Anthropic key here (same
 * pattern as directive/draft/route.ts — derive_archetype takes an already-built client),
 * derives + upserts via deriveArchetype, then re-queries and reuses archetypeOut, matching
 * Python's derive-then-re-query-then-shared-serializer structure exactly (the derive
 * return value is discarded, same as Python's).
 */
export const POST = withApi('/api/profile/archetype', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) {
    throw new ApiError(400, ARCHETYPE_NO_KEY_MESSAGE);
  }
  const client = makeAnthropicClient(apiKey);

  await deriveArchetype(db, client, ctx.user.userId);
  ctx.timer.mark('claude');

  const rows = await db
    .select()
    .from(schema.readerArchetypes)
    .where(eq(schema.readerArchetypes.userId, ctx.user.userId));
  const row = rows[0];
  if (!row) throw new ApiError(500, 'Archetype upsert failed');

  const lastProfiledAt = await getLastProfiledAt(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json(archetypeOut(row, lastProfiledAt));
});
