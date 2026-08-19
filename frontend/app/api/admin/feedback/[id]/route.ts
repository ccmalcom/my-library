import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { emailsForUserIds, serializeFeedbackRow } from '@/lib/server/adminFeedback';
import { FEEDBACK_STATUSES } from '@/lib/server/feedbackStatus';

// The enum is built from the shared constant so the vocabulary has exactly one
// definition; adding a status must not require editing a second list here.
const Body = z.object({ status: z.enum(FEEDBACK_STATUSES) });

export const PATCH = withApi(
  '/api/admin/feedback/[id]',
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
    const [row] = await db
      .update(schema.feedback)
      .set({ status: parsed.data.status })
      .where(eq(schema.feedback.id, id))
      .returning();
    if (!row) throw new ApiError(404, 'feedback not found');
    ctx.timer.mark('db');

    const emails = await emailsForUserIds(db, [row.userId]);
    return Response.json(serializeFeedbackRow(row, emails.get(row.userId) ?? null));
  },
  { requireAdmin: true }
);
