import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { listRoster } from '@/lib/server/invites';

/** Port of api.py::admin_users. */
export const GET = withApi(
  '/api/admin/users',
  async (_req, ctx) => {
    const rows = await listRoster(getDb());
    ctx.timer.mark('db');
    return Response.json(rows);
  },
  { requireAdmin: true }
);
