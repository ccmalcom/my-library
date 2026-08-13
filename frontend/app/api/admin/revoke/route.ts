import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { revokeUser, InviteError } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

const Body = z.object({ supabase_user_id: z.string() });

/** Port of api.py::admin_revoke. InviteError -> 404 (not 422, unlike invite). */
export const POST = withApi(
  '/api/admin/revoke',
  async (req) => {
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
      return Response.json(await revokeUser({ supabaseUserId: parsed.data.supabase_user_id }));
    } catch (err) {
      if (err instanceof InviteError) throw new ApiError(404, err.message);
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
  },
  { requireAdmin: true }
);
