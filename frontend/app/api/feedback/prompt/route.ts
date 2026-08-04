import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { checkPromptEligibility } from '@/lib/server/feedbackPrompts';

/** Port of api.py::get_feedback_prompt. Returns `{ show: true | false }` — respects
 *  the global enable flag, one-time trigger state, snooze windows, and the
 *  post-recs per-run signal. */
export const GET = withApi('/api/feedback/prompt', async (req, ctx) => {
  const sp = new URL(req.url).searchParams;
  const trigger = sp.get('trigger');
  if (trigger === null) throw new ApiError(422, 'validation error: trigger is required');
  const triggerNorm = trigger.toLowerCase().trim();
  const runIdRaw = sp.get('run_id');
  const runIdNorm = runIdRaw && runIdRaw.trim() ? runIdRaw.trim() : null;
  if (triggerNorm === 'post-recs' && !runIdNorm) {
    throw new ApiError(422, "run_id is required when trigger='post-recs'");
  }
  const show = await checkPromptEligibility(getDb(), ctx.user.userId, triggerNorm, runIdNorm);
  ctx.timer.mark('db');
  return Response.json({ show });
});
