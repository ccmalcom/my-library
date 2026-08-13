import { describe, expect, it } from 'vitest';

import { config } from '@/proxy';

// This file lives under lib/server because vitest.config.ts only collects its configured include globs.
describe('proxy matcher', () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it.each(['/api/enrich/tick', '/api/enrich/janitor', '/api/books', '/api/profile'])(
    'excludes API route %s',
    (path) => {
      expect(matcher.test(path)).toBe(false);
    }
  );

  it.each(['/', '/library', '/profile', '/settings', '/admin', '/login'])(
    'matches page route %s',
    (path) => {
      expect(matcher.test(path)).toBe(true);
    }
  );

  it.each(['/_next/static/chunk.js', '/favicon.ico'])('excludes asset route %s', (path) => {
    expect(matcher.test(path)).toBe(false);
  });
});
