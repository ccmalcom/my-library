'use client';

import { useRef, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';

// ── Heading map ────────────────────────────────────────────────────────────────

const HEADINGS: Record<string, string> = {
  'post-setup':          'How was getting set up?',
  'post-first-profile':  'Does your reader profile feel like you?',
  'post-recs':           'How were these recommendations?',
};

// ── Shared field styles (mirrored from FeedbackModal) ─────────────────────────

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

// ── Inner modal component ─────────────────────────────────────────────────────
// Renders the targeted prompt modal with Submit / Ask me later / Don't ask again.

interface TargetedModalProps {
  trigger: string;
  runId?: string;
  heading: string;
  onClose: () => void;
}

function TargetedModal({ trigger, runId, heading, onClose }: TargetedModalProps) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const bodyTrimmed = body.trim();
  const canSubmit = bodyTrimmed.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.submitFeedback({
        category: trigger,
        body: bodyTrimmed,
        trigger,
        run_id: runId ?? null,
        page: typeof window !== 'undefined' ? window.location.pathname : null,
        app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
      });
      toast.success('Thanks for your feedback!');
      onClose();
    } catch {
      toast.error('Failed to submit - please try again.');
      setSubmitting(false);
    }
  }

  // Ask me later: snooze this trigger (per run for post-recs, global for one-time)
  async function handleAskLater() {
    try {
      await api.dismissFeedback({
        trigger,
        run_id: runId ?? '',
        mode: 'ask_later',
      });
    } catch {
      // Silent - snooze failure is not user-visible
    }
    onClose();
  }

  // Don't ask again: terminal dismiss (run_id='' = global off-switch for this trigger)
  async function handleDontAsk() {
    try {
      await api.dismissFeedback({
        trigger,
        run_id: '',
        mode: 'dont_ask',
      });
    } catch {
      // Silent
    }
    onClose();
  }

  // Escape / X / backdrop = Ask me later (not silent close)
  function handleClose() {
    void handleAskLater();
  }

  return (
    <Modal
      labelId='targeted-feedback-modal'
      onClose={handleClose}
      className='fade-in flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl'
    >
      {/* Header */}
      <div className='mb-6'>
        <h2 id='targeted-feedback-modal' className='text-lg font-bold leading-tight text-text'>
          {heading}
        </h2>
      </div>

      {/* Body textarea */}
      <div className='mb-6 flex-1'>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder='Please share your thoughts...'
          disabled={submitting}
          className={[inputClass, 'resize-y disabled:opacity-50 disabled:cursor-not-allowed'].join(' ')}
        />
      </div>

      {/* Footer: Submit + Ask me later + Don't ask again */}
      <div className='flex flex-col gap-3'>
        <div className='flex gap-2'>
          <Button
            variant='ghost'
            onClick={() => void handleAskLater()}
            disabled={submitting}
          >
            Ask me later
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!canSubmit}
          >
            Submit
          </Button>
        </div>
        <button
          type='button'
          onClick={() => void handleDontAsk()}
          disabled={submitting}
          className='self-start text-xs text-faint underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50'
        >
          Don&apos;t ask again
        </button>
      </div>
    </Modal>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseFeedbackPromptResult {
  fire: () => void;
  modal: ReactNode | null;
}

/**
 * Encapsulates eligibility checking + fire-once-per-session guard for targeted
 * feedback prompts. Call `fire()` at the right moment; the hook calls
 * GET /feedback/prompt and, if show=true, surfaces a targeted modal with
 * Submit / Ask me later / Don't ask again.
 *
 * The fire-once guard resets when `runId` changes so different post-recs runs
 * each get one chance.
 */
export function useFeedbackPrompt(
  trigger: string,
  runId?: string,
): UseFeedbackPromptResult {
  const firedRef   = useRef(false);
  const lastRunId  = useRef<string | undefined>(undefined);
  const [open, setOpen] = useState(false);

  // Reset guard when runId changes (new rec run)
  if (runId !== lastRunId.current) {
    lastRunId.current = runId;
    firedRef.current  = false;
  }

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    api.feedbackPrompt(trigger, runId).then((resp) => {
      if (resp.show) setOpen(true);
    }).catch(() => {
      // Eligibility check failures are silent - never block the user
    });
  }, [trigger, runId]);

  const heading = HEADINGS[trigger] ?? 'How is MyLibrary working for you?';

  const modal: ReactNode | null = open ? (
    <TargetedModal
      trigger={trigger}
      runId={runId}
      heading={heading}
      onClose={() => setOpen(false)}
    />
  ) : null;

  return { fire, modal };
}
