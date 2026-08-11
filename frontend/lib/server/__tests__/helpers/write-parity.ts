import { expect } from 'vitest';
import scenariosJson from '../fixtures/parity/write-scenarios.json';
import seedJson from '../fixtures/parity/seed.json';
import { makeTestDb, loadSeed, type Seed } from './pglite';
import { _setDbForTests } from '../../db';

type Handler = (req: Request, routeCtx?: { params?: Record<string, string> }) => Promise<Response>;

interface MultipartFixture {
  file?: {
    filename: string;
    content: string;
    content_type?: string;
  };
  fields?: Record<string, string>;
}

interface ScenarioStep {
  req: string;
  json?: unknown;
  multipart?: MultipartFixture;
  response_mode?: 'json' | 'text' | 'base64';
  status: number;
  body: unknown;
  headers?: Record<string, string | null>;
  maskDetail?: boolean;
}

/** Route registry: pattern → handler import. Later tasks append rows here as
 *  they create routes; a step whose path matches no row throws loudly. */
import * as booksRoute from '../../../../app/api/books/route';
import * as profileStatusRoute from '../../../../app/api/profile/status/route';
import * as bookFeedbackRoute from '../../../../app/api/books/[id]/feedback/route';
import * as bookShelfRoute from '../../../../app/api/books/[id]/shelf/route';
import * as bookEnrichmentRoute from '../../../../app/api/books/[id]/enrichment/route';
import * as bookByIdRoute from '../../../../app/api/books/[id]/route';
import * as recFeedbackRoute from '../../../../app/api/recommendations/[id]/feedback/route';
import * as recommendationsRejectedRoute from '../../../../app/api/recommendations/rejected/route';
import * as apiKeyRoute from '../../../../app/api/settings/api-key/route';
import * as apiKeyStatusRoute from '../../../../app/api/settings/api-key/status/route';
import * as profileSettingsRoute from '../../../../app/api/settings/profile/route';
import * as directiveRoute from '../../../../app/api/directive/route';
import * as traitByIdRoute from '../../../../app/api/profile/traits/[id]/route';
import * as feedbackRoute from '../../../../app/api/feedback/route';
import * as feedbackPromptRoute from '../../../../app/api/feedback/prompt/route';
import * as feedbackDismissRoute from '../../../../app/api/feedback/dismiss/route';
import * as tasteSignalRoute from '../../../../app/api/taste-signal/route';
import * as importPreviewRoute from '../../../../app/api/import/preview/route';
import * as importRoute from '../../../../app/api/import/route';
import * as exportRoute from '../../../../app/api/export/route';

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
  {
    method: 'GET',
    pattern: /^\/profile\/status$/,
    handler: () => profileStatusRoute.GET as Handler,
  },
  {
    method: 'GET',
    pattern: /^\/recommendations\/rejected$/,
    handler: () => recommendationsRejectedRoute.GET as Handler,
  },
  {
    method: 'PATCH',
    pattern: /^\/books\/(?<id>\d+)\/feedback$/,
    handler: () => bookFeedbackRoute.PATCH as Handler,
  },
  {
    method: 'PATCH',
    pattern: /^\/books\/(?<id>\d+)\/shelf$/,
    handler: () => bookShelfRoute.PATCH as Handler,
  },
  {
    method: 'PATCH',
    pattern: /^\/books\/(?<id>\d+)\/enrichment$/,
    handler: () => bookEnrichmentRoute.PATCH as Handler,
  },
  {
    method: 'DELETE',
    pattern: /^\/books\/(?<id>\d+)$/,
    handler: () => bookByIdRoute.DELETE as Handler,
  },
  {
    method: 'PATCH',
    pattern: /^\/recommendations\/(?<id>\d+)\/feedback$/,
    handler: () => recFeedbackRoute.PATCH as Handler,
  },
  { method: 'PUT', pattern: /^\/settings\/api-key$/, handler: () => apiKeyRoute.PUT as Handler },
  {
    method: 'DELETE',
    pattern: /^\/settings\/api-key$/,
    handler: () => apiKeyRoute.DELETE as Handler,
  },
  {
    method: 'GET',
    pattern: /^\/settings\/api-key\/status$/,
    handler: () => apiKeyStatusRoute.GET as Handler,
  },
  {
    method: 'PUT',
    pattern: /^\/settings\/profile$/,
    handler: () => profileSettingsRoute.PUT as Handler,
  },
  { method: 'GET', pattern: /^\/directive$/, handler: () => directiveRoute.GET as Handler },
  { method: 'PUT', pattern: /^\/directive$/, handler: () => directiveRoute.PUT as Handler },
  { method: 'DELETE', pattern: /^\/directive$/, handler: () => directiveRoute.DELETE as Handler },
  {
    method: 'PATCH',
    pattern: /^\/profile\/traits\/(?<id>\d+)$/,
    handler: () => traitByIdRoute.PATCH as Handler,
  },
  { method: 'POST', pattern: /^\/feedback$/, handler: () => feedbackRoute.POST as Handler },
  {
    method: 'GET',
    pattern: /^\/feedback\/prompt$/,
    handler: () => feedbackPromptRoute.GET as Handler,
  },
  {
    method: 'POST',
    pattern: /^\/feedback\/dismiss$/,
    handler: () => feedbackDismissRoute.POST as Handler,
  },
  { method: 'POST', pattern: /^\/taste-signal$/, handler: () => tasteSignalRoute.POST as Handler },
  {
    method: 'POST',
    pattern: /^\/import\/preview$/,
    handler: () => importPreviewRoute.POST as Handler,
  },
  { method: 'POST', pattern: /^\/import$/, handler: () => importRoute.POST as Handler },
  { method: 'GET', pattern: /^\/export$/, handler: () => exportRoute.GET as Handler },
];

/** Mask volatile server-generated values; preserve the null/non-null distinction. */
const VOLATILE_KEYS = new Set([
  'feedback_updated_at',
  'verdict_updated_at',
  'updated_at',
  'created_at',
  'date_added',
  'snooze_until',
  'resolved_at',
  'derived_at',
]);
export function maskVolatile(v: unknown): unknown {
  if (typeof v === 'string') {
    return v
      .replace(
        /\"exported_at\": \"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00\"/,
        '\"exported_at\": \"2000-01-01T00:00:00.000000+00:00\"'
      )
      .replace(
        // SQLite-recorded goldens use second-precision CURRENT_TIMESTAMP;
        // replay and production Postgres may include fractional seconds.
        /\"created_at\": \"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\"/g,
        '\"created_at\": \"2000-01-01T00:00:00\"'
      );
  }
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

/** Mask only the clock-derived date stamp in an otherwise exact export filename. */
export function maskVolatileHeader(value: string | null): string | null {
  return value?.replace(/mylibrary-backup-\d{8}\.(csv|json)/, 'mylibrary-backup-<date>.$1') ?? null;
}

function maskVolatileHeaders(
  headers: Record<string, string | null>
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, maskVolatileHeader(value)])
  );
}

function resolve(
  method: string,
  path: string
): { handler: Handler; params: Record<string, string> } {
  for (const row of REGISTRY) {
    if (row.method !== method) continue;
    const m = path.match(row.pattern);
    if (m) return { handler: row.handler(), params: { ...(m.groups ?? {}) } };
  }
  throw new Error(`no registered handler for ${method} ${path} — add it to REGISTRY`);
}

export async function runScenario(name: string): Promise<void> {
  const scenarios = scenariosJson as unknown as Record<string, ScenarioStep[]>;
  const steps = scenarios[name];
  if (!steps) throw new Error(`no scenario named ${name}`);
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as unknown as Seed);
    _setDbForTests(db);
    for (const [i, step] of steps.entries()) {
      const [method, pathAndQuery] = step.req.split(' ');
      const path = pathAndQuery.split('?')[0];
      const { handler, params } = resolve(method, path);
      const form = step.multipart ? new FormData() : null;
      if (form && step.multipart) {
        for (const [key, value] of Object.entries(step.multipart.fields ?? {})) {
          form.set(key, value);
        }
        const f = step.multipart.file;
        if (f) {
          form.set(
            'file',
            new File([f.content], f.filename, { type: f.content_type ?? 'text/csv' })
          );
        }
      }
      const req = new Request(`http://test/api${pathAndQuery}`, {
        method,
        headers: step.json != null ? { 'content-type': 'application/json' } : {},
        body: form ?? (step.json != null ? JSON.stringify(step.json) : undefined),
      });
      const res = await handler(req, { params });
      expect(res.status, `${name}[${i}] ${step.req} status`).toBe(step.status);
      expect(
        maskVolatileHeaders(
          Object.fromEntries(
            Object.keys(step.headers ?? {}).map((key) => [key, res.headers.get(key)])
          )
        ),
        `${name}[${i}] ${step.req} headers`
      ).toEqual(maskVolatileHeaders(step.headers ?? {}));
      if (step.status === 204) continue;
      let body: unknown =
        step.response_mode === 'base64'
          ? Buffer.from(await res.arrayBuffer()).toString('base64')
          : step.response_mode === 'text'
            ? await res.text()
            : await res.json();
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
