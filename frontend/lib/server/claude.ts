/**
 * Anthropic key resolution + client factory — twin of
 * mylibrary/user_settings.resolve_anthropic_key and the per-module
 * `Anthropic(api_key=...)` construction.
 *
 * NOTE: an env key set to "" resolves to null here (Python's `if not api_key`
 * raises), while GET /settings/api-key/status still reports configured:true for
 * the same value (Python's `is not None`). That inconsistency is Python's and is
 * reproduced on purpose — do not harmonize them.
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { decrypt } from './crypto';

export async function resolveAnthropicKey(db: Db, userId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  const stored = rows[0]?.anthropicApiKeyEncrypted;
  if (stored) {
    try {
      return decrypt(stored);
    } catch {
      /* fall through to env, same as a decrypt failure surfacing later */
    }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

export interface ClaudeMessage {
  content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
  usage?: Record<string, number> | null;
}
export interface ClaudeClient {
  messages: { create(params: Record<string, unknown>): Promise<ClaudeMessage> };
}

export function makeAnthropicClient(apiKey: string): ClaudeClient {
  return new Anthropic({ apiKey }) as unknown as ClaudeClient;
}

/** First tool_use block's input, or null — twin of the Python `for block in message.content` loops. */
export function toolInput(
  message: ClaudeMessage,
  toolName: string
): Record<string, unknown> | null {
  for (const block of message.content ?? []) {
    if (block.type === 'tool_use' && (!toolName || block.name === toolName)) {
      return block.input ?? {};
    }
  }
  return null;
}
