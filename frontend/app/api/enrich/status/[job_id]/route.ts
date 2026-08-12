import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/server/db';
import { rearmAfterResponse } from '@/lib/server/enrichmentDispatch';
import { failIfStale, serializeJob } from '@/lib/server/enrichmentJobs';
import { ApiError, withApi } from '@/lib/server/http';
import { enrichJobs } from '@/lib/server/schema';

export const GET = withApi('/api/enrich/status/[job_id]', async (request, ctx) => {
  const jobId = ctx.params.job_id;
  const db = getDb();
  const rows = await db
    .select()
    .from(enrichJobs)
    .where(and(eq(enrichJobs.jobId, jobId), eq(enrichJobs.userId, ctx.user.userId)))
    .limit(1);
  const found = rows[0];
  if (!found) throw new ApiError(404, `Job '${jobId}' not found`);

  const now = new Date();
  const job = await failIfStale(db, found, now);
  if (
    job.status === 'running' &&
    (job.leaseExpiresAt === null ||
      Date.parse(`${job.leaseExpiresAt.replace(' ', 'T')}Z`) <= now.getTime())
  ) {
    rearmAfterResponse(request, jobId);
  }
  return Response.json(serializeJob(job));
});
