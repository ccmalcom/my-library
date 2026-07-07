'use client';

import { useState } from 'react';
import { draftDirective, type DirectiveConstraints, type DirectiveDraft } from '@/lib/api';
import { Button, Modal, Textarea } from '@/components/ui';

export default function DirectiveChat({
  currentText,
  onClose,
  onApply,
}: {
  currentText: string;
  onClose: () => void;
  onApply: (proposedText: string, constraints: DirectiveConstraints) => void;
}) {
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<DirectiveDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!message.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const out = await draftDirective({
        message: message.trim(),
        current_text: currentText || null,
      });
      setDraft(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      labelId="directive-chat-title"
      onClose={onClose}
      className="fade-in flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl"
    >
      <h2 id="directive-chat-title" className="mb-4 font-display text-lg font-bold text-text">
        Help me write my instructions
      </h2>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Describe what you&rsquo;re after in plain words. I&rsquo;ll turn it into clean
          instructions you can review and save.
        </p>
        <Textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="I want deep characters and slow-burn plots, nothing too bleak, and I'm trying to read more nonfiction this year."
        />
        <Button onClick={send} loading={loading} disabled={loading || !message.trim()}>
          {loading ? 'Thinking...' : 'Draft it'}
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}

        {draft && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            {draft.assistant_message && (
              <p className="text-sm italic text-muted">{draft.assistant_message}</p>
            )}
            <div>
              <p className="text-xs font-semibold uppercase text-faint">Proposed instructions</p>
              <p className="whitespace-pre-wrap text-sm text-text">{draft.proposed_text}</p>
            </div>
            {draft.conflicts.length > 0 && (
              <div className="rounded-md bg-warning-quiet p-3">
                <p className="text-xs font-semibold uppercase text-warning">
                  Heads up: these clash with existing feedback
                </p>
                <ul className="list-disc pl-5 text-sm text-warning">
                  {draft.conflicts.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex gap-3">
              <Button onClick={() => onApply(draft.proposed_text, draft.constraints)}>
                Use this
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
