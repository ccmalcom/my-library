import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { costUsd, recordUsage, trackedCreate } from '../anthropic';
import type { Db } from '../db';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
});
afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

async function usageRows(): Promise<any[]> {
  const result = await db.execute('select * from usage_events order by id');
  return Array.isArray(result) ? result : (result as any).rows;
}

describe('costUsd', () => {
  it('prices sonnet-4-6 like the Python table', () => {
    // 1M input + 1M output + 1M cache_write + 1M cache_read = 3 + 15 + 3.75 + 0.30
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    expect(costUsd('claude-sonnet-4-6', usage)).toBeCloseTo(22.05, 6);
  });

  it('uses the sonnet-5 promo rate before 2026-09-01 and list after', () => {
    const usage = { input_tokens: 1_000_000 };
    expect(costUsd('claude-sonnet-5', usage, new Date('2026-08-15'))).toBeCloseTo(2.0, 6);
    expect(costUsd('claude-sonnet-5', usage, new Date('2026-09-01'))).toBeCloseTo(3.0, 6);
  });

  it('falls back to the most expensive tier for unknown models', () => {
    expect(costUsd('mystery-model', { output_tokens: 1_000_000 })).toBeCloseTo(15.0, 6);
  });

  it('treats missing token fields as zero', () => {
    expect(costUsd('claude-haiku-4-5-20251001', {})).toBe(0);
  });
});

describe('recordUsage', () => {
  it('inserts a usage_events row with computed cost', async () => {
    await recordUsage(db, {
      userId: 'u1',
      model: 'claude-haiku-4-5-20251001',
      operation: 'profile_full',
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'u1',
      model: 'claude-haiku-4-5-20251001',
      operation: 'profile_full',
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(Number(rows[0].cost_usd)).toBeCloseTo((1000 * 1 + 500 * 5) / 1_000_000, 9);
  });

  it('never throws, even when the insert fails', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const broken = { execute: () => Promise.reject(new Error('db down')) } as unknown as Db;
    await expect(
      recordUsage(broken, { userId: 'u1', model: 'm', operation: 'op', usage: {} })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled(); // failure is logged, not raised
  });
});

describe('trackedCreate', () => {
  it('returns the message and records its usage', async () => {
    const message = {
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const client = { messages: { create: vi.fn().mockResolvedValue(message) } };
    const result = await trackedCreate(
      client,
      db,
      { userId: 'u2', operation: 'recommend_rerank' },
      { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [] }
    );
    expect(result).toBe(message);
    expect(client.messages.create).toHaveBeenCalledOnce();
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'u2', operation: 'recommend_rerank', model: 'claude-sonnet-4-6' });
  });
});
