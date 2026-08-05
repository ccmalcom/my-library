import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { pyList } from '@/lib/server/serialize';
import { ONE_TIME_TRIGGERS, VALID_CATEGORIES, upsertPromptState } from '@/lib/server/feedbackPrompts';

/** Port of api.py::post_feedback. Validates category/body, inserts a Feedback row,
 *  and — for one-time triggers — upserts a FeedbackPromptState row to 'submitted'. */
export const POST = withApi('/api/feedback', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new ApiError(422, 'validation error: invalid body');
  const category = String(raw.category ?? '').toLowerCase().trim();
  if (!VALID_CATEGORIES.includes(category)) {
    throw new ApiError(422, `category must be one of ${pyList(VALID_CATEGORIES)}`);
  }
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!body || !body.trim()) throw new ApiError(422, 'body must be a non-empty string');
  const trigger = typeof raw.trigger === 'string' && raw.trigger ? raw.trigger.toLowerCase().trim() : null;
  const runId = typeof raw.run_id === 'string' && raw.run_id.trim() ? raw.run_id.trim() : null;
  if (trigger === 'post-recs' && !runId) {
    throw new ApiError(422, "run_id is required when trigger='post-recs'");
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(schema.feedback).values({
      userId: ctx.user.userId, category, body, trigger, runId,
      page: typeof raw.page === 'string' ? raw.page : null,
      appVersion: typeof raw.app_version === 'string' ? raw.app_version : null,
    });
    if (trigger && ONE_TIME_TRIGGERS.includes(trigger)) {
      await upsertPromptState(tx, { userId: ctx.user.userId, trigger, runId: '', status: 'submitted' });
    }
  });
  ctx.timer.mark('db');
  return Response.json({}, { status: 201 });
});
