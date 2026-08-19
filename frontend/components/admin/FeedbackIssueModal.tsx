'use client';

import { useState } from 'react';
import { createFeedbackGithubIssue, type AdminFeedbackItem } from '@/lib/api';
import { Button, Field, Input, Modal, Textarea } from '@/components/ui';

const TITLE_MAX = 60;

/** `[feedback] ` plus the opening of the submission, trimmed at a word boundary. */
export function defaultIssueTitle(item: AdminFeedbackItem): string {
  const flat = item.body.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX) return `[feedback] ${flat}`;
  const cut = flat.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `[feedback] ${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function defaultIssueBody(item: AdminFeedbackItem): string {
  const meta = [
    `- **Category:** ${item.category}`,
    `- **From:** ${item.email ?? item.user_id}`,
    item.page ? `- **Page:** ${item.page}` : null,
    item.trigger ? `- **Trigger:** ${item.trigger}` : null,
    item.app_version ? `- **App version:** ${item.app_version}` : null,
    `- **ShelfSprite feedback ID:** ${item.id}`,
  ].filter(Boolean);
  const quoted = item.body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${meta.join('\n')}\n\n---\n\n${quoted}\n`;
}

interface Props {
  item: AdminFeedbackItem;
  onClose: () => void;
  onCreated: (updated: AdminFeedbackItem) => void;
}

export function FeedbackIssueModal({ item, onClose, onCreated }: Props) {
  const [title, setTitle] = useState(() => defaultIssueTitle(item));
  const [body, setBody] = useState(() => defaultIssueBody(item));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await createFeedbackGithubIssue(item.id, { title: title.trim(), body }));
      onClose();
    } catch (err) {
      // Keep the modal open and preserve the admin's edits when GitHub fails.
      setError(err instanceof Error ? err.message : 'Could not create the issue.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      labelId="feedback-issue-title"
      onClose={onClose}
      className="fade-in max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface shadow-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <h2 id="feedback-issue-title" className="font-display text-lg font-semibold text-text">
          Create GitHub issue
        </h2>

        <Field label="Title">
          {(p) => (
            <Input
              {...p}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={256}
              required
            />
          )}
        </Field>

        <Field label="Body">
          {(p) => (
            <Textarea
              {...p}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              className="font-mono text-xs"
            />
          )}
        </Field>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={!title.trim()}>
            Create issue
          </Button>
        </div>
      </form>
    </Modal>
  );
}
