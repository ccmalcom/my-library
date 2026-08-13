import { z } from 'zod';
import { getDb } from '@/lib/server/db';
import { enrichLibrary } from '@/lib/server/enrichment';
import { ApiError, withApi } from '@/lib/server/http';

const EnrichBody = z.object({
  force: z.boolean().default(false),
  limit: z.number().int().nullable().default(null),
  include_unrated: z.boolean().default(false),
});

export const POST = withApi('/api/enrich', async (req, ctx) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(422, 'request body must be JSON');
  }
  const parsed = EnrichBody.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const summary = await enrichLibrary(getDb(), {
    force: parsed.data.force,
    limit: parsed.data.limit,
    includeUnrated: parsed.data.include_unrated,
    userId: ctx.user.userId,
  });
  return Response.json(summary);
});
