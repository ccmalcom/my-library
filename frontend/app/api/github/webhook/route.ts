import { eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { githubConfig, verifyWebhookSignature } from '@/lib/server/github';
import type { FeedbackStatus } from '@/lib/server/feedbackStatus';

interface IssuesPayload {
  action?: string;
  issue?: { number?: number };
  label?: { name?: string };
  repository?: { full_name?: string };
}

/**
 * Deliberately small. `opened` is absent because the app just set `reported`
 * itself; `unlabeled` and `unassigned` are absent because reversing a status on
 * removal guesses at intent.
 */
function statusForAction(payload: IssuesPayload, inProgressLabel: string): FeedbackStatus | null {
  switch (payload.action) {
    case 'closed':
      return 'resolved';
    case 'reopened':
    case 'assigned':
      return 'in_progress';
    case 'labeled':
      return payload.label?.name?.toLowerCase() === inProgressLabel.toLowerCase()
        ? 'in_progress'
        : null;
    default:
      return null;
  }
}

/**
 * Public by necessity — GitHub cannot present a Supabase bearer token — so the
 * route authenticates itself, exactly as GET /api/admin/me performs its own admin
 * check rather than being pre-empted by the wrapper. proxy.ts already excludes
 * /api, so no matcher change is involved.
 */
export const POST = withApi(
  '/api/github/webhook',
  async (req, ctx) => {
    const cfg = githubConfig();
    // An unset secret is a misconfiguration, never a licence to skip verification.
    if (!cfg.webhookSecret) throw new ApiError(503, 'GitHub webhook is not configured');

    // Raw bytes, before any parsing: the HMAC covers exactly what GitHub signed.
    const rawBody = await req.text();
    if (!verifyWebhookSignature(rawBody, req.headers.get('x-hub-signature-256'))) {
      throw new ApiError(401, 'invalid webhook signature');
    }

    const event = req.headers.get('x-github-event');
    if (event === 'ping') return Response.json({ ok: true });
    // 200, not an error: GitHub retries and eventually disables endpoints that error.
    if (event !== 'issues') return Response.json({ ignored: true });

    let payload: IssuesPayload;
    try {
      payload = JSON.parse(rawBody) as IssuesPayload;
    } catch {
      throw new ApiError(422, 'webhook body must be JSON');
    }

    const number = payload.issue?.number;
    // The repository check is what stops a webhook from any other repository
    // moving rows by issue-number collision.
    if (typeof number !== 'number' || payload.repository?.full_name !== cfg.repo) {
      return Response.json({ ignored: true });
    }

    const status = statusForAction(payload, cfg.inProgressLabel);
    if (!status) return Response.json({ ignored: true });

    const db = getDb();
    const updated = await db
      .update(schema.feedback)
      .set({ status })
      .where(eq(schema.feedback.githubIssueNumber, number))
      .returning({ id: schema.feedback.id });
    ctx.timer.mark('db');

    return Response.json({ updated: updated.length, status });
  },
  { requireAuth: false }
);
