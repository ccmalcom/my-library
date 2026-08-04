import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { getConfigValue, setConfigValue, DEBUG_MODE_KEY } from '@/lib/server/config';

const PutBody = z.object({ debug_mode: z.boolean() });

export const GET = withApi(
  '/api/admin/config',
  async () => {
    const value = await getConfigValue(getDb(), DEBUG_MODE_KEY);
    return Response.json({ debug_mode: value === true });
  },
  { requireAdmin: true }
);

export const PUT = withApi(
  '/api/admin/config',
  async (req) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError(422, 'request body must be JSON');
    }
    const parsed = PutBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
    }
    await setConfigValue(getDb(), DEBUG_MODE_KEY, parsed.data.debug_mode);
    return Response.json({ debug_mode: parsed.data.debug_mode });
  },
  { requireAdmin: true }
);
