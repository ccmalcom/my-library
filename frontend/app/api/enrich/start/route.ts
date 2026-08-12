import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '@/lib/server/db';
import { rearmAfterResponse } from '@/lib/server/enrichmentDispatch';
import {
  claimJob,
  createOrGetActiveJob,
  FUNCTION_CEILING_SECONDS,
  oneBookEnrichmentRunner,
  runClaimedChunk,
  serializeJob,
} from '@/lib/server/enrichmentJobs';
import { ApiError, withApi } from '@/lib/server/http';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';
import { enrichJobs } from '@/lib/server/schema';

const EnrichStartBody = z.object({
  force: z.boolean().default(false),
  limit: z.number().int().nullable().default(null),
});

export const maxDuration = FUNCTION_CEILING_SECONDS;

async function readJob(db: Db, jobId: string) {
  const rows = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, jobId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`enrichment job disappeared after creation: ${jobId}`);
  return row;
}

export const POST = withApi('/api/enrich/start', async (request, ctx) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(422, 'request body must be JSON');
  }
  const parsed = EnrichStartBody.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  const rateLimit = await checkRateLimit(db, {
    key: `enrichStart:${ctx.user.userId}`,
    ...RATE_LIMITS.enrichStart,
  });
  if (!rateLimit.allowed) {
    return rateLimitExceededResponse(
      RATE_LIMITS.enrichStart.limit,
      RATE_LIMITS.enrichStart.windowSeconds
    );
  }

  const { created, job } = await createOrGetActiveJob(db, ctx.user.userId, parsed.data);
  if (!created) return Response.json(job);

  const claimedRow = await claimJob(db, job.job_id, new Date());
  if (!claimedRow) return Response.json(serializeJob(await readJob(db, job.job_id)));

  await runClaimedChunk(db, claimedRow, {
    nowMs: () => Date.now(),
    runOne: oneBookEnrichmentRunner(claimedRow.userId),
    dispatch: async (jobId) => {
      rearmAfterResponse(request, jobId);
    },
  });

  return Response.json(serializeJob(await readJob(db, job.job_id)));
});
