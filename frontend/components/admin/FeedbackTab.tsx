'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { listAdminFeedback, updateAdminFeedbackStatus, type AdminFeedbackItem } from '@/lib/api';
import {
  ACTIVE_FEEDBACK_STATUSES,
  FEEDBACK_STATUSES,
  type FeedbackStatus,
} from '@/lib/server/feedbackStatus';
import { Badge, Button, Card, Field, Spinner, useToast } from '@/components/ui';
import { FeedbackIssueModal } from './FeedbackIssueModal';
import { Pagination } from './Pagination';

const PAGE_SIZE = 25;

const CATEGORY_VARIANT: Record<string, 'default' | 'danger' | 'success' | 'warning' | 'accent'> = {
  bug: 'danger',
  idea: 'accent',
  confusing: 'warning',
  praise: 'success',
  targeted: 'default',
};

const STATUS_VARIANT: Record<string, 'default' | 'danger' | 'success' | 'warning' | 'accent'> = {
  open: 'warning',
  reported: 'accent',
  in_progress: 'default',
  resolved: 'success',
};

const STATUS_LABEL: Record<string, string> = {
  open: 'open',
  reported: 'reported',
  in_progress: 'in progress',
  resolved: 'resolved',
};

/** The default view is a work queue: everything except what is already done. */
const ACTIVE_FILTER = ACTIVE_FEEDBACK_STATUSES.join(',');

const selectClasses =
  'rounded-lg border border-border bg-base px-2 py-1 text-xs text-text focus:border-accent focus:outline-none';

export function FeedbackTab() {
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<string>(ACTIVE_FILTER);

  const { data, isLoading, mutate } = useSWR(
    ['admin-feedback', offset, category, status] as const,
    () =>
      listAdminFeedback({
        limit: PAGE_SIZE,
        offset,
        category: category || undefined,
        status: status || undefined,
      })
  );

  function handleCategoryChange(value: string) {
    setCategory(value);
    setOffset(0);
  }

  function handleStatusFilterChange(value: string) {
    setStatus(value);
    setOffset(0);
  }

  /**
   * Splice one updated row back into the cached page without a refetch, unless
   * the new status no longer matches the active status filter — in that case
   * drop it from the cache immediately and revalidate so pagination/total stay
   * consistent with what the server would return.
   */
  function applyUpdated(updated: AdminFeedbackItem) {
    const allowedStatuses = status ? status.split(',') : null;
    const stillMatchesFilter = !allowedStatuses || allowedStatuses.includes(updated.status);

    if (!stillMatchesFilter) {
      void mutate(
        (current) =>
          current
            ? {
                ...current,
                items: current.items.filter((i) => i.id !== updated.id),
                total: Math.max(0, current.total - 1),
              }
            : current,
        { revalidate: true }
      );
      return;
    }

    void mutate(
      (current) =>
        current
          ? { ...current, items: current.items.map((i) => (i.id === updated.id ? updated : i)) }
          : current,
      { revalidate: false }
    );
  }

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Feedback</h2>
          {data ? (
            <p className="text-xs text-faint">
              {data.total} submission{data.total !== 1 ? 's' : ''}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Filter by status">
            {(p) => (
              <select
                {...p}
                value={status}
                onChange={(e) => handleStatusFilterChange(e.target.value)}
                className={selectClasses}
              >
                <option value={ACTIVE_FILTER}>Open &amp; active</option>
                <option value="">All statuses</option>
                {FEEDBACK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Filter by category">
            {(p) => (
              <select
                {...p}
                value={category}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className={selectClasses}
              >
                <option value="">All categories</option>
                <option value="bug">bug</option>
                <option value="idea">idea</option>
                <option value="confusing">confusing</option>
                <option value="praise">praise</option>
                <option value="targeted">targeted</option>
              </select>
            )}
          </Field>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner label="Loading feedback" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <p className="p-5 text-sm text-faint">No feedback yet.</p>
      ) : (
        <div className="mt-4 divide-y divide-border">
          {data.items.map((item) => (
            <FeedbackRow
              key={item.id}
              item={item}
              githubConfigured={data.github_configured}
              onUpdated={applyUpdated}
            />
          ))}
        </div>
      )}

      {data ? (
        <Pagination
          offset={offset}
          limit={PAGE_SIZE}
          total={data.total}
          onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          onNext={() => setOffset(offset + PAGE_SIZE)}
        />
      ) : null}
    </Card>
  );
}

function FeedbackRow({
  item,
  githubConfigured,
  onUpdated,
}: {
  item: AdminFeedbackItem;
  githubConfigured: boolean;
  onUpdated: (updated: AdminFeedbackItem) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const toast = useToast();

  async function handleStatusChange(next: string) {
    if (next === item.status) return;
    setSaving(true);
    try {
      onUpdated(await updateAdminFeedbackStatus(item.id, next as FeedbackStatus));
    } catch {
      // The row keeps showing its persisted status when the request fails.
      toast.error('Could not update the status.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-5 py-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="truncate text-sm font-medium text-text">{item.email ?? item.user_id}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={STATUS_VARIANT[item.status] ?? 'default'}>
            {STATUS_LABEL[item.status] ?? item.status}
          </Badge>
          <Badge variant={CATEGORY_VARIANT[item.category] ?? 'default'}>{item.category}</Badge>
          <span className="font-mono text-xs text-faint">
            {new Date(item.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      <p className="text-sm text-muted">{item.body}</p>

      {item.trigger ? (
        <p className="mt-1 font-mono text-xs text-faint">
          trigger: {item.trigger}
          {item.page ? ` · ${item.page}` : ''}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          id={`status-${item.id}`}
          aria-label={`Status for feedback ${item.id}`}
          value={item.status}
          disabled={saving}
          onChange={(e) => void handleStatusChange(e.target.value)}
          className={selectClasses}
        >
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        {item.github_issue_url ? (
          <a
            href={item.github_issue_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-accent hover:underline"
          >
            #{item.github_issue_number}
          </a>
        ) : githubConfigured ? (
          <Button size="sm" variant="secondary" onClick={() => setModalOpen(true)}>
            Create GitHub issue
          </Button>
        ) : null}
      </div>

      {modalOpen ? (
        <FeedbackIssueModal item={item} onClose={() => setModalOpen(false)} onCreated={onUpdated} />
      ) : null}
    </div>
  );
}
