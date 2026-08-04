import { withApi } from '@/lib/server/http';

export const GET = withApi(
  '/api/healthz',
  async () => Response.json({ status: 'ok', backend: 'node' }),
  { requireAuth: false }
);
