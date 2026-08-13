import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setDispatchForTests, rearmAfterResponse } from '../enrichmentDispatch';

describe('enrichment tick dispatch', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  });

  afterEach(() => {
    _setDispatchForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([307, 500])('logs a %s response without throwing', async (status) => {
    let scheduled: Promise<void> | undefined;
    const dispatch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    _setDispatchForTests({
      schedule: (callback) => {
        scheduled = Promise.resolve(callback());
      },
      fetch: dispatch,
    });

    expect(() =>
      rearmAfterResponse(new Request('https://library.example/api/enrich'), 'job-non-ok')
    ).not.toThrow();
    await expect(scheduled).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`job-non-ok.*${status}`))
    );
  });

  it('logs a rejected fetch without letting the rejection escape', async () => {
    let scheduled: Promise<void> | undefined;
    const failure = new Error('network unavailable');
    const dispatch = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    _setDispatchForTests({
      schedule: (callback) => {
        scheduled = Promise.resolve(callback());
      },
      fetch: dispatch,
    });

    expect(() =>
      rearmAfterResponse(new Request('https://library.example/api/enrich'), 'job-rejected')
    ).not.toThrow();
    await expect(scheduled).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('job-rejected'), failure);
  });

  it('dispatches a successful tick exactly once without logging an error', async () => {
    let scheduled: Promise<void> | undefined;
    const dispatch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    _setDispatchForTests({
      schedule: (callback) => {
        scheduled = Promise.resolve(callback());
      },
      fetch: dispatch,
    });

    rearmAfterResponse(new Request('https://library.example/api/enrich'), 'job-success');
    await expect(scheduled).resolves.toBeUndefined();

    expect(consoleError).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(new URL('https://library.example/api/enrich/tick'), {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-cron-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ job_id: 'job-success' }),
      cache: 'no-store',
    });
  });
});
