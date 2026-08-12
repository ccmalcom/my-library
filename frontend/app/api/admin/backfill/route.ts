import { withApi, ApiError } from '@/lib/server/http';
import { backfillFromSupabase } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

/**
 * Port of api.py::admin_backfill. The body is ignored on both sides -- Python
 * declares no request model for this route.
 */
export const POST = withApi(
  '/api/admin/backfill',
  async (_req, ctx) => {
    try {
      return Response.json(await backfillFromSupabase({ invitedBy: ctx.user.userId }));
    } catch (err) {
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
  },
  { requireAdmin: true }
);
