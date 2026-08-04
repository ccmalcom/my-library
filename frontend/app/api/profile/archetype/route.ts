import { eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { ARCHETYPE_HOOKS, scoreToLetter } from '@/lib/server/archetype';
import { tsToIso } from '@/lib/server/serialize';

function toDate(ts: string): Date {
  return new Date(ts.replace(' ', 'T') + 'Z');
}

/** Port of api.py::get_archetype / _archetype_out. */
export const GET = withApi('/api/profile/archetype', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.readerArchetypes)
    .where(eq(schema.readerArchetypes.userId, ctx.user.userId));
  const row = rows[0];
  if (!row) throw new ApiError(404, 'No archetype derived yet');

  const metaRows = await db
    .select()
    .from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, ctx.user.userId));
  ctx.timer.mark('db');
  const lastProfiledAt = metaRows[0]?.lastProfiledAt ?? null;

  const axis = (key: 'lens' | 'engine' | 'range' | 'resonance', score: number, rationale: string | null) => ({
    score,
    letter: scoreToLetter(key, score),
    rationale: rationale ? rationale : null, // Python `rationale or None`: '' → null
  });

  return Response.json({
    code: row.code,
    name: row.archetypeName,
    tagline: row.archetypeTagline,
    hook: ARCHETYPE_HOOKS[row.code] ?? '',
    lens: axis('lens', row.axisLens, row.lensRationale),
    engine: axis('engine', row.axisEngine, row.engineRationale),
    range: axis('range', row.axisRange, row.rangeRationale),
    resonance: axis('resonance', row.axisResonance, row.resonanceRationale),
    derived_at: tsToIso(row.derivedAt),
    is_stale:
      lastProfiledAt !== null && toDate(row.derivedAt) < toDate(lastProfiledAt),
  });
});
