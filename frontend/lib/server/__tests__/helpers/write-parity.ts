import { expect } from 'vitest';
import scenariosJson from '../fixtures/parity/write-scenarios.json';
import seedJson from '../fixtures/parity/seed.json';
import { makeTestDb, loadSeed, type Seed } from './pglite';
import { _setDbForTests } from '../../db';

type Handler = (req: Request, routeCtx?: { params?: Record<string, string> }) => Promise<Response>;

/** Route registry: pattern → handler import. Later tasks append rows here as
 *  they create routes; a step whose path matches no row throws loudly. */
import * as booksRoute from '../../../../app/api/books/route';
import * as profileStatusRoute from '../../../../app/api/profile/status/route';
import * as bookFeedbackRoute from '../../../../app/api/books/[id]/feedback/route';
import * as bookShelfRoute from '../../../../app/api/books/[id]/shelf/route';
import * as bookEnrichmentRoute from '../../../../app/api/books/[id]/enrichment/route';
import * as bookByIdRoute from '../../../../app/api/books/[id]/route';
// (Tasks 8–12 add imports here: ... )

interface RegistryRow {
  method: string;
  pattern: RegExp; // named groups become params
  handler: () => Handler;
}

export const REGISTRY: RegistryRow[] = [
  { method: 'POST', pattern: /^\/books$/, handler: () => booksRoute.POST as Handler },
  { method: 'GET', pattern: /^\/books$/, handler: () => booksRoute.GET as Handler },
  // Wave-1 GET probes used by scenarios get rows too as needed:
  // /profile/status, /recommendations/rejected, /directive, /settings/api-key/status
  // — added in the task that first replays a scenario using them.
  { method: 'GET', pattern: /^\/profile\/status$/, handler: () => profileStatusRoute.GET as Handler },
  { method: 'PATCH', pattern: /^\/books\/(?<id>\d+)\/feedback$/, handler: () => bookFeedbackRoute.PATCH as Handler },
  { method: 'PATCH', pattern: /^\/books\/(?<id>\d+)\/shelf$/, handler: () => bookShelfRoute.PATCH as Handler },
  { method: 'PATCH', pattern: /^\/books\/(?<id>\d+)\/enrichment$/, handler: () => bookEnrichmentRoute.PATCH as Handler },
  { method: 'DELETE', pattern: /^\/books\/(?<id>\d+)$/, handler: () => bookByIdRoute.DELETE as Handler },
];

/** Mask volatile server-generated values; preserve the null/non-null distinction. */
const VOLATILE_KEYS = new Set([
  'feedback_updated_at', 'verdict_updated_at', 'updated_at', 'created_at',
  'date_added', 'snooze_until', 'resolved_at', 'derived_at',
]);
export function maskVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskVolatile);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => {
        if (VOLATILE_KEYS.has(k)) return [k, val === null ? null : '<set>'];
        // Cross-runtime row-order safety: /profile/status returns changed_book_ids
        // in query order, which SQLite and PGlite need not agree on (wave-1 precedent:
        // its parity test compares this field sorted).
        if (k === 'changed_book_ids' && Array.isArray(val)) {
          return [k, [...(val as number[])].sort((a, b) => a - b)];
        }
        return [k, maskVolatile(val)];
      })
    );
  }
  return v;
}

function resolve(method: string, path: string): { handler: Handler; params: Record<string, string> } {
  for (const row of REGISTRY) {
    if (row.method !== method) continue;
    const m = path.match(row.pattern);
    if (m) return { handler: row.handler(), params: { ...(m.groups ?? {}) } };
  }
  throw new Error(`no registered handler for ${method} ${path} — add it to REGISTRY`);
}

export async function runScenario(name: string): Promise<void> {
  const steps = (scenariosJson as any)[name];
  if (!steps) throw new Error(`no scenario named ${name}`);
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as unknown as Seed);
    _setDbForTests(db);
    for (const [i, step] of (steps as any[]).entries()) {
      const [method, pathAndQuery] = step.req.split(' ');
      const path = pathAndQuery.split('?')[0];
      const { handler, params } = resolve(method, path);
      const req = new Request(`http://test/api${pathAndQuery}`, {
        method,
        headers: step.json != null ? { 'content-type': 'application/json' } : {},
        body: step.json != null ? JSON.stringify(step.json) : undefined,
      });
      const res = await handler(req, { params });
      expect(res.status, `${name}[${i}] ${step.req} status`).toBe(step.status);
      if (step.status === 204) continue;
      let body: unknown = await res.json();
      let expected: unknown = step.body;
      if (step.maskDetail) {
        body = { ...(body as object), detail: '<masked>' };
        expected = { ...(expected as object), detail: '<masked>' };
      }
      expect(maskVolatile(body), `${name}[${i}] ${step.req} body`).toEqual(maskVolatile(expected));
    }
  } finally {
    _setDbForTests(null);
    await close();
  }
}
