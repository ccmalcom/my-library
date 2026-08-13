import { getDb } from '@/lib/server/db';
import { isValidCronSecret, rearmAfterResponse } from '@/lib/server/enrichmentDispatch';
import { repairActiveJobs } from '@/lib/server/enrichmentJobs';
import { ApiError, withApi } from '@/lib/server/http';

export const GET = withApi(
  '/api/enrich/janitor',
  async (request) => {
    if (!isValidCronSecret(request)) throw new ApiError(401, 'Unauthorized');

    const summary = await repairActiveJobs(getDb(), new Date(), (jobId) => {
      rearmAfterResponse(request, jobId);
    });
    return Response.json(summary);
  },
  { requireAuth: false }
);
