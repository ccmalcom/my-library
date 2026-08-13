import { createHash, timingSafeEqual } from 'node:crypto';
import { after } from 'next/server';

type Schedule = (callback: () => void | Promise<void>) => void;
type DispatchFetch = typeof globalThis.fetch;

let testOverrides: { schedule?: Schedule; fetch?: DispatchFetch } | null = null;

export function _setDispatchForTests(
  overrides: { schedule?: Schedule; fetch?: DispatchFetch } | null
): void {
  testOverrides = overrides;
}

export function requireCronSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is not set');
  return secret;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function isValidCronSecret(request: Request): boolean {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const candidate = authorization.slice('Bearer '.length);
  if (!candidate) return false;

  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  return timingSafeEqual(digest(candidate), digest(secret));
}

export function rearmAfterResponse(request: Request, jobId: string): void {
  const secret = requireCronSecret();
  const url = new URL('/api/enrich/tick', request.url);
  const schedule = testOverrides?.schedule ?? after;
  const dispatch = testOverrides?.fetch ?? globalThis.fetch.bind(globalThis);
  schedule(async () => {
    // after() runs post-response, so runClaimedChunk cannot catch this outcome; rearmed means
    // the tick was scheduled, not that it succeeded.
    try {
      const response = await dispatch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
        cache: 'no-store',
      });
      if (!response.ok) {
        console.error(`Failed to dispatch enrichment job ${jobId}: HTTP ${response.status}`);
      }
    } catch (error) {
      console.error(`Failed to dispatch enrichment job ${jobId}`, error);
    }
  });
}
