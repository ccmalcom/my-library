import { z } from 'zod';
import { getDb } from '@/lib/server/db';
import { isValidCronSecret, rearmAfterResponse } from '@/lib/server/enrichmentDispatch';
import {
  claimJob,
  FUNCTION_CEILING_SECONDS,
  oneBookEnrichmentRunner,
  runClaimedChunk,
} from '@/lib/server/enrichmentJobs';
import { ApiError, withApi } from '@/lib/server/http';

const EnrichTickBody = z
  .object({
    job_id: z.string().min(1),
  })
  .strict();

export const maxDuration = FUNCTION_CEILING_SECONDS;

export const POST = withApi(
  '/api/enrich/tick',
  async (request) => {
    if (!isValidCronSecret(request)) throw new ApiError(401, 'Unauthorized');

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ApiError(422, 'request body must be JSON');
    }
    const parsed = EnrichTickBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }

    const db = getDb();
    const claimedRow = await claimJob(db, parsed.data.job_id, new Date());
    if (!claimedRow) return Response.json({ claimed: false });

    const result = await runClaimedChunk(db, claimedRow, {
      nowMs: () => Date.now(),
      runOne: oneBookEnrichmentRunner(claimedRow.userId),
      dispatch: async (jobId) => {
        rearmAfterResponse(request, jobId);
      },
    });
    return Response.json({ claimed: true, outcome: result.outcome });
  },
  { requireAuth: false }
);
