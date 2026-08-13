/**
 * Debug-mode-aware structured logging. One JSON line per request in normal
 * mode; debug mode adds logDebug lines and Server-Timing headers (attached by
 * http.ts). Stack traces belong in logs, never in HTTP responses.
 */
import { randomUUID } from 'node:crypto';

export interface Span {
  name: string;
  durationMs: number;
}

export interface RequestLogEntry {
  requestId: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  userId?: string;
  error?: string;
}

export function newRequestId(): string {
  return randomUUID();
}

export function makeTimer(now: () => number = () => performance.now()) {
  const start = now();
  let last = start;
  const spans: Span[] = [];
  return {
    mark(name: string): void {
      const t = now();
      spans.push({ name, durationMs: t - last });
      last = t;
    },
    spans(): Span[] {
      return [...spans];
    },
    totalMs(): number {
      return now() - start;
    },
  };
}

export function serverTimingHeader(spans: Span[]): string {
  return spans.map((s) => `${s.name};dur=${s.durationMs.toFixed(1)}`).join(', ');
}

export function logRequest(entry: RequestLogEntry): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', ...entry }));
}

export function logDebug(
  requestId: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: 'debug', requestId, message, ...extra })
  );
}
