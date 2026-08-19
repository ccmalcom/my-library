import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { emailsForUserIds, serializeFeedbackRow } from '@/lib/server/adminFeedback';
import { GitHubError, createIssue, isGithubConfigured } from '@/lib/server/github';

// Title and body arrive from the admin's edited modal. Deriving them server-side
// instead would silently discard those edits.
const Body = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string(),
});

export const POST = withApi(
  '/api/admin/feedback/[id]/github-issue',
  async (req, ctx) => {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }
    const id = parseIdParam(ctx.params.id);

    const db = getDb();
    const [row] = await db.select().from(schema.feedback).where(eq(schema.feedback.id, id));
    if (!row) throw new ApiError(404, 'feedback not found');
    // Checked before the configuration check so a double-click reads as a
    // duplicate rather than as a misconfiguration.
    if (row.githubIssueNumber !== null) {
      throw new ApiError(409, 'feedback already has a GitHub issue');
    }
    if (!isGithubConfigured()) throw new ApiError(503, 'GitHub is not configured');
    ctx.timer.mark('db');

    // The GitHub call is the irreversible half, so it happens before the local
    // write: a row that claims an issue which does not exist is worse than an
    // issue with no row pointing at it, and the 409 above is what a retry hits.
    // Same reasoning as createInvite in lib/server/invites.ts.
    let issue;
    try {
      issue = await createIssue({ title: parsed.data.title, body: parsed.data.body });
    } catch (err) {
      if (err instanceof GitHubError) throw new ApiError(502, err.message);
      throw err;
    }
    ctx.timer.mark('github');

    const [updated] = await db
      .update(schema.feedback)
      .set({
        githubIssueNumber: issue.number,
        githubIssueUrl: issue.url,
        status: 'reported',
      })
      .where(eq(schema.feedback.id, id))
      .returning();

    const emails = await emailsForUserIds(db, [updated!.userId]);
    return Response.json(serializeFeedbackRow(updated!, emails.get(updated!.userId) ?? null));
  },
  { requireAdmin: true }
);
