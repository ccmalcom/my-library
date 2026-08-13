import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { createInvite, InviteError } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

const Body = z.object({
  email: z.string(),
  display_name: z.string().nullable().optional(),
  anthropic_api_key: z.string().nullable().optional(),
});

/** Port of api.py::admin_invite. 201 on success. */
export const POST = withApi(
  '/api/admin/invite',
  async (req, ctx) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError(422, 'request body must be JSON');
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }
    try {
      const out = await createInvite({
        email: parsed.data.email,
        invitedBy: ctx.user.userId,
        displayName: parsed.data.display_name ?? null,
        anthropicApiKey: parsed.data.anthropic_api_key ?? null,
      });
      return Response.json(out, { status: 201 });
    } catch (err) {
      if (err instanceof InviteError) throw new ApiError(422, err.message);
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
  },
  { requireAdmin: true }
);
