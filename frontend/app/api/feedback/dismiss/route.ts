import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { dismissPrompt } from '@/lib/server/feedbackPrompts';

/** Port of api.py::post_feedback_dismiss.
 *  mode=dont_ask  -> permanently silence this trigger (global off-switch).
 *  mode=ask_later -> snooze for settings.feedback_snooze_hours hours.
 *  Returns 204 No Content. */
export const POST = withApi('/api/feedback/dismiss', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mode = typeof raw?.mode === 'string' ? raw.mode : '';
  if (mode !== 'ask_later' && mode !== 'dont_ask') {
    throw new ApiError(422, "mode must be 'ask_later' or 'dont_ask'");
  }
  const trigger = String(raw?.trigger ?? '').toLowerCase().trim();
  const runIdRaw = raw?.run_id;
  const runIdNorm = typeof runIdRaw === 'string' && runIdRaw.trim() ? runIdRaw.trim() : null;
  if (trigger === 'post-recs' && mode === 'ask_later' && !runIdNorm) {
    throw new ApiError(422, "run_id is required when trigger='post-recs' and mode='ask_later'");
  }
  await dismissPrompt(getDb(), ctx.user.userId, trigger, runIdNorm, mode);
  ctx.timer.mark('db');
  return new Response(null, { status: 204 });
});
