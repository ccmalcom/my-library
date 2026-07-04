'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { listAdminUsage, type AdminUsageEvent } from '@/lib/api';
import { Badge, Card, Spinner } from '@/components/ui';
import { Pagination } from './Pagination';

const PAGE_SIZE = 25;

const OPERATION_VARIANT: Record<string, 'default' | 'accent' | 'mono'> = {
  profile_full: 'accent',
  profile_update: 'accent',
  recommend_seed: 'default',
  recommend_rerank: 'default',
  archetype: 'mono',
};

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function UsageTab() {
  const [offset, setOffset] = useState(0);
  const [operation, setOperation] = useState('');

  const { data, isLoading } = useSWR(['admin-usage', offset, operation] as const, () =>
    listAdminUsage({ limit: PAGE_SIZE, offset, operation: operation || undefined })
  );

  function handleFilterChange(value: string) {
    setOperation(value);
    setOffset(0);
  }

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">API usage</h2>
          {data ? (
            <p className="text-xs text-faint">
              {data.total} event{data.total !== 1 ? 's' : ''} · {formatCost(data.total_cost_usd)}{' '}
              total
            </p>
          ) : null}
        </div>
        <select
          value={operation}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="rounded-lg border border-border bg-base px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
        >
          <option value="">All operations</option>
          <option value="profile_full">profile_full</option>
          <option value="profile_update">profile_update</option>
          <option value="recommend_seed">recommend_seed</option>
          <option value="recommend_rerank">recommend_rerank</option>
          <option value="archetype">archetype</option>
        </select>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner label="Loading usage" />
        </div>
      ) : !data || data.events.length === 0 ? (
        <p className="p-5 text-sm text-faint">No usage events yet.</p>
      ) : (
        <div className="mt-4 divide-y divide-border">
          {data.events.map((event) => (
            <UsageRow key={event.id} event={event} />
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

function UsageRow({ event }: { event: AdminUsageEvent }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text">{event.email ?? event.user_id}</p>
        <p className="font-mono text-xs text-faint">
          {event.model} · {event.input_tokens + event.output_tokens} tokens ·{' '}
          {new Date(event.created_at).toLocaleString()}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={OPERATION_VARIANT[event.operation] ?? 'default'}>{event.operation}</Badge>
        <span className="font-mono text-xs text-muted">{formatCost(event.cost_usd)}</span>
      </div>
    </div>
  );
}
