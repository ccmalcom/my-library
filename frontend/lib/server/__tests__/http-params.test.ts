import { describe, it, expect } from 'vitest';
import { withApi } from '../http';

describe('withApi params', () => {
  it('passes awaited route params into ctx.params', async () => {
    const handler = withApi(
      '/api/books/[id]/feedback',
      async (_req, ctx) => Response.json({ id: ctx.params.id }),
      { requireAuth: false }
    );
    const res = await handler(new Request('http://test/api/books/7/feedback'), {
      params: Promise.resolve({ id: '7' }),
    });
    expect(await res.json()).toEqual({ id: '7' });
  });

  it('defaults ctx.params to {} for static routes', async () => {
    const handler = withApi(
      '/api/stats',
      async (_req, ctx) => Response.json({ keys: Object.keys(ctx.params) }),
      { requireAuth: false }
    );
    const res = await handler(new Request('http://test/api/stats'));
    expect(await res.json()).toEqual({ keys: [] });
  });
});
