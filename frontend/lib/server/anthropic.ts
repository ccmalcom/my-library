/**
 * Per-user Anthropic spend tracking — the Node twin of mylibrary/usage.py.
 * trackedCreate wraps messages.create and records token usage + computed cost
 * into usage_events. Recording is best-effort: failures are logged and
 * swallowed so they can never break a Claude-powered flow. Pricing table is
 * copied from mylibrary/usage.py — keep the two in sync until cutover.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { logDebug } from './log';

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

type Pricing = [number, number, number, number]; // USD/1M: input, output, cache_write, cache_read

const MODEL_PRICING: Record<string, Pricing> = {
  'claude-sonnet-4-6': [3.0, 15.0, 3.75, 0.3],
  'claude-haiku-4-5-20251001': [1.0, 5.0, 1.25, 0.1],
};
const DEFAULT_PRICING: Pricing = [3.0, 15.0, 3.75, 0.3];

// Sonnet 5 promo ends 2026-08-31 (inclusive) — mirrors mylibrary/usage.py.
const SONNET_5_PROMO_END = new Date('2026-08-31T23:59:59Z');
const SONNET_5_PROMO: Pricing = [2.0, 10.0, 2.5, 0.2];
const SONNET_5_LIST: Pricing = [3.0, 15.0, 3.75, 0.3];

function pricing(model: string, today: Date): Pricing {
  if (model === 'claude-sonnet-5') {
    return today <= SONNET_5_PROMO_END ? SONNET_5_PROMO : SONNET_5_LIST;
  }
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

function tok(usage: UsageLike | null, name: keyof UsageLike): number {
  const v = usage?.[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function costUsd(model: string, usage: UsageLike | null, today: Date = new Date()): number {
  const [inRate, outRate, cwRate, crRate] = pricing(model, today);
  return (
    (tok(usage, 'input_tokens') * inRate +
      tok(usage, 'output_tokens') * outRate +
      tok(usage, 'cache_creation_input_tokens') * cwRate +
      tok(usage, 'cache_read_input_tokens') * crRate) /
    1_000_000
  );
}

export async function recordUsage(
  db: Db,
  entry: { userId: string; model: string; operation: string; usage: UsageLike | null }
): Promise<void> {
  try {
    await db.execute(sql`
      insert into usage_events
        (user_id, model, operation, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_usd)
      values
        (${entry.userId}, ${entry.model}, ${entry.operation},
         ${tok(entry.usage, 'input_tokens')}, ${tok(entry.usage, 'output_tokens')},
         ${tok(entry.usage, 'cache_creation_input_tokens')},
         ${tok(entry.usage, 'cache_read_input_tokens')},
         ${costUsd(entry.model, entry.usage)})
    `);
  } catch (err) {
    // Recording must never break the calling operation (parity with Python).
    logDebug('usage', `usage recording failed for user=${entry.userId} op=${entry.operation}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface MessagesClient {
  messages: { create: (params: Record<string, unknown>) => Promise<unknown> };
}

export async function trackedCreate<T extends MessagesClient>(
  client: T,
  db: Db,
  meta: { userId: string; operation: string },
  params: { model: string } & Record<string, unknown>
): Promise<Awaited<ReturnType<T['messages']['create']>>> {
  const message = (await client.messages.create(params)) as Awaited<
    ReturnType<T['messages']['create']>
  >;
  const usage = (message as { usage?: UsageLike | null })?.usage ?? null;
  await recordUsage(db, {
    userId: meta.userId,
    model: params.model,
    operation: meta.operation,
    usage,
  });
  return message;
}
