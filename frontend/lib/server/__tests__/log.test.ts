import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTimer, serverTimingHeader, logRequest, logDebug, newRequestId } from '../log';

afterEach(() => vi.restoreAllMocks());

describe('log', () => {
  it('newRequestId returns unique ids', () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it('timer records named spans between marks', () => {
    let t = 0;
    const timer = makeTimer(() => t);
    t = 5;
    timer.mark('auth');
    t = 30;
    timer.mark('db');
    expect(timer.spans()).toEqual([
      { name: 'auth', durationMs: 5 },
      { name: 'db', durationMs: 25 },
    ]);
    expect(timer.totalMs()).toBe(30);
  });

  it('serverTimingHeader formats spans', () => {
    expect(
      serverTimingHeader([
        { name: 'auth', durationMs: 1.234 },
        { name: 'db', durationMs: 12 },
      ])
    ).toBe('auth;dur=1.2, db;dur=12.0');
  });

  it('logRequest writes one JSON line with the core fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logRequest({
      requestId: 'r1',
      route: 'healthz',
      method: 'GET',
      status: 200,
      durationMs: 3.2,
      userId: 'local',
    });
    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: 'info',
      requestId: 'r1',
      route: 'healthz',
      method: 'GET',
      status: 200,
      durationMs: 3.2,
      userId: 'local',
    });
    expect(typeof parsed.ts).toBe('string');
  });

  it('logDebug writes a debug-level JSON line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logDebug('r1', 'cache miss', { key: 'k' });
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ level: 'debug', requestId: 'r1', message: 'cache miss', key: 'k' });
  });
});
