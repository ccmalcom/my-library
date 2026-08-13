import { buildExport, utcDateStamp } from '@/lib/server/export';
import { getDb } from '@/lib/server/db';
import { ApiError, withApi } from '@/lib/server/http';

export const runtime = 'nodejs';

export const GET = withApi('/api/export', async (req, ctx) => {
  const format = new URL(req.url).searchParams.get('format') ?? 'csv';
  if (format !== 'csv' && format !== 'json') {
    throw new ApiError(422, "format must be 'csv' or 'json'.");
  }
  const body = await buildExport(getDb(), ctx.user.userId, format);
  ctx.timer.mark('db');
  const stamp = utcDateStamp(new Date());
  return new Response(body, {
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
      'Content-Disposition': `attachment; filename="shelfsprite-backup-${stamp}.${format}"`,
    },
  });
});
