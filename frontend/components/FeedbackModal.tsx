'use client';

import { useState } from 'react';
import { api, type FeedbackSubmit } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';

interface Props {
  trigger?: string;
  runId?: string;
  heading: string;
  onClose: () => void;
  onResolved: () => void;
}

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

export default function FeedbackModal({
  trigger,
  runId,
  heading,
  onClose,
  onResolved,
}: Props) {
  const toast = useToast();

  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const bodyTrimmed = body.trim();
  const canSubmit = bodyTrimmed.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const payload: FeedbackSubmit = {
        category: trigger ?? 'feedback',
        body: bodyTrimmed,
        trigger: trigger ?? null,
        run_id: runId ?? null,
        page: typeof window !== 'undefined' ? window.location.pathname : null,
        app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
      };
      await api.submitFeedback(payload);
      toast.success('Thanks for your feedback!');
      onResolved();
    } catch (e) {
      toast.error('Failed to submit - please try again.');
      setSubmitting(false);
    }
  }

  return (
    <Modal
      labelId='feedback-modal'
      onClose={onClose}
      className='fade-in flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl'
    >
      {/* Header */}
      <div className='mb-6'>
        <h2 id='feedback-modal' className='text-lg font-bold leading-tight text-text'>
          {heading}
        </h2>
      </div>

      {/* Body textarea */}
      <div className='mb-6 flex-1'>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder='Please share your thoughts...'
          disabled={submitting}
          className={[inputClass, 'resize-y disabled:opacity-50 disabled:cursor-not-allowed'].join(' ')}
        />
      </div>

      {/* Footer actions */}
      <div className='flex gap-2'>
        <Button
          variant='ghost'
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          loading={submitting}
          disabled={!canSubmit}
        >
          Submit
        </Button>
      </div>
    </Modal>
  );
}
