import { afterEach, beforeEach, expect } from 'vitest';
import fixturesJson from '../fixtures/parity/python-responses.json';
import seedJson from '../fixtures/parity/seed.json';
import { makeTestDb, loadSeed, type Seed } from './pglite';
import { _setDbForTests } from '../../db';
import { _resetDebugCache } from '../../config';

const FIXED_TEST_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const ENV_KEYS = [
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_JWKS_URL',
  'ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
  'ADMIN_EMAILS',
  'MYLIBRARY_MONTHLY_SOFT_CAP_USD',
  'MYLIBRARY_USAGE_WARN_THRESHOLD',
  'FEEDBACK_PROMPTS_ENABLED',
  'FEEDBACK_SNOOZE_HOURS',
  'MYLIBRARY_MODEL',
  'GOOGLE_BOOKS_API_KEY',
];

/** Local-mode env identical to the Python fixture run. Registers hooks. */
export function setupParityEnv(): void {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_JWKS_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ADMIN_EMAILS;
    delete process.env.FEEDBACK_PROMPTS_ENABLED;
    delete process.env.FEEDBACK_SNOOZE_HOURS;
    // Deleted, not pinned: gen_claude_fixtures.py pins MYLIBRARY_MODEL to
    // config.DEFAULT_MODEL when recording, so leaving this unset makes
    // profileModel() exercise its own fallback and fail loudly if the two
    // defaults ever drift apart. A developer with MYLIBRARY_MODEL exported
    // (it lives in .env) would otherwise fail the profile prompt-parity tests.
    delete process.env.MYLIBRARY_MODEL;
    // The Python fixture generator forces this empty so no live key is baked into a
    // recorded URL; a developer with it exported would build `...&key=...` URLs that
    // match no fixture entry and fail every replayed catalog fetch.
    delete process.env.GOOGLE_BOOKS_API_KEY;
    process.env.ENCRYPTION_KEY = FIXED_TEST_KEY;
    process.env.MYLIBRARY_MONTHLY_SOFT_CAP_USD = '5.0';
    process.env.MYLIBRARY_USAGE_WARN_THRESHOLD = '0.8';
    _resetDebugCache();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _setDbForTests(null);
  });
}

type Stage = 'empty' | 'seeded';

export async function checkParity(
  stage: Stage,
  requestKey: string,
  handler: (req: Request) => Promise<Response>,
  normalize?: (body: unknown) => unknown
): Promise<void> {
  const fixture = (fixturesJson as any)[stage]?.[requestKey];
  if (!fixture) throw new Error(`no fixture for stage=${stage} request=${requestKey}`);
  const { db, close } = await makeTestDb();
  try {
    if (stage === 'seeded') await loadSeed(db, seedJson as unknown as Seed);
    _setDbForTests(db);
    const [method, pathAndQuery] = requestKey.split(' ');
    const res = await handler(new Request(`http://test/api${pathAndQuery}`, { method }));
    expect(res.status).toBe(fixture.status);
    let body: unknown = await res.json();
    let expected: unknown = fixture.body;
    if (normalize) {
      body = normalize(body);
      expected = normalize(expected);
    }
    expect(body).toEqual(expected);
  } finally {
    _setDbForTests(null);
    await close();
  }
}
