import { vi } from 'vitest';

export interface ReplayEntry { status: number; body?: unknown; headers?: Record<string, string>; }

/**
 * Replace global fetch with a fixture-driven stub. Any URL not present in the
 * map throws — a test must never reach the real network. onCall fires per
 * attempted fetch so tests can assert cache hits and retry counts.
 */
export function installHttpReplay(
  fixtures: Record<string, ReplayEntry>,
  onCall?: (url: string) => void
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    onCall?.(url);
    const entry = fixtures[url];
    if (!entry) throw new Error(`httpReplay: no fixture for ${url}`);
    return new Response(entry.body === undefined ? null : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
