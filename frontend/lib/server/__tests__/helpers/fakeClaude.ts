import type { ClaudeClient, ClaudeMessage } from '../../claude';

export interface RecordedCall {
  params: Record<string, unknown>;
}

/** Injectable Claude client. Records every create() call for prompt-parity
 *  assertions and returns queued responses in order. Never touches the network. */
export function fakeClaude(responses: ClaudeMessage[]): ClaudeClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(params: Record<string, unknown>) {
        calls.push({ params });
        if (i >= responses.length) throw new Error(`fakeClaude: no queued response #${i}`);
        return responses[i++];
      },
    },
  };
}
