import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { DISTILL_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { distillDirective } from '@/lib/server/directiveDistill';

// Single Haiku call, well under 30s in practice — parity twin has no timeout of
// its own. Set to 300s (Hobby's max/default, confirmed via Vercel's docs as of
// this wave's verification) rather than a tighter number, so this route is safe
// on any plan tier without needing to know which one is active.
export const maxDuration = 300;

const Body = z.object({
  message: z.string().min(1).max(1000),
  current_text: z.string().max(4000).nullish(),
});

export const POST = withApi('/api/directive/draft', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `directive_draft:${ctx.user.userId}`,
    ...RATE_LIMITS.directiveDraft,
  });
  if (!rl.allowed) {
    // Same corrected 429 shape as catalog/search/route.ts: SlowAPI's unmodified default
    // handler ({"error": f"Rate limit exceeded: {exc.detail}"}, no extra headers) — see
    // that file's 429 branch for the full parity note. This route shares the Limiter
    // instance but not the bucket; "30 per 1 minute" is this decorator's own detail string.
    return new Response(JSON.stringify({ error: 'Rate limit exceeded: 30 per 1 minute' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Port of api.py:358-361's try/except RuntimeError -> HTTPException(400): Python raises
  // RuntimeError from inside distill_directive() when no key is configured. Node resolves
  // the key here instead (distillDirective takes an already-built client, so it can be
  // exercised directly with fakeClaude in tests without any key/env plumbing).
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) {
    throw new ApiError(400, DISTILL_NO_KEY_MESSAGE);
  }
  const client = makeAnthropicClient(apiKey);

  const out = await distillDirective(db, client, {
    message: parsed.data.message,
    currentText: parsed.data.current_text ?? null,
    userId: ctx.user.userId,
  });
  ctx.timer.mark('claude');
  return Response.json(out);
});
