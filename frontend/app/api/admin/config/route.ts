import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, type Db } from '@/lib/server/db';
import { getConfigValue, setConfigValue, DEBUG_MODE_KEY } from '@/lib/server/config';

// Test seam: unit tests inject a PGlite db; production always uses getDb().
let testDb: Db | null = null;
export function _setDbForTests(db: Db | null): void {
  testDb = db;
}
function db(): Db {
  return testDb ?? getDb();
}

const PutBody = z.object({ debug_mode: z.boolean() });

export const GET = withApi(
  'admin/config',
  async () => {
    const value = await getConfigValue(db(), DEBUG_MODE_KEY);
    return Response.json({ debug_mode: value === true });
  },
  { requireAdmin: true }
);

export const PUT = withApi(
  'admin/config',
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
    await setConfigValue(db(), DEBUG_MODE_KEY, parsed.data.debug_mode);
    return Response.json({ debug_mode: parsed.data.debug_mode });
  },
  { requireAdmin: true }
);
