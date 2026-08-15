'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { listAdminFeedback, type AdminFeedbackItem } from '@/lib/api';
import { Badge, Card, Field, Spinner } from '@/components/ui';
import { Pagination } from './Pagination';

const PAGE_SIZE = 25;

const CATEGORY_VARIANT: Record<string, 'default' | 'danger' | 'success' | 'warning' | 'accent'> = {
  bug: 'danger',
  idea: 'accent',
  confusing: 'warning',
  praise: 'success',
  targeted: 'default',
};

export function FeedbackTab() {
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState('');

  const { data, isLoading } = useSWR(['admin-feedback', offset, category] as const, () =>
    listAdminFeedback({ limit: PAGE_SIZE, offset, category: category || undefined })
  );

  function handleFilterChange(value: string) {
    setCategory(value);
    setOffset(0);
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
        <Field label="Filter by category">
          {(p) => (
            <select
              {...p}
              value={category}
              onChange={(e) => handleFilterChange(e.target.value)}
              className="rounded-lg border border-border bg-base px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
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

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner label="Loading feedback" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <p className="p-5 text-sm text-faint">No feedback yet.</p>
      ) : (
        <div className="mt-4 divide-y divide-border">
          {data.items.map((item) => (
            <FeedbackRow key={item.id} item={item} />
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

function FeedbackRow({ item }: { item: AdminFeedbackItem }) {
  return (
    <div className="px-5 py-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="truncate text-sm font-medium text-text">{item.email ?? item.user_id}</p>
        <div className="flex shrink-0 items-center gap-2">
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
    </div>
  );
}
