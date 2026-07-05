interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function Pagination({ offset, limit, total, onPrev, onNext }: PaginationProps) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
      <p className="text-xs text-faint">
        {start}-{end} of {total}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onPrev}
          disabled={offset === 0}
          className="rounded-lg px-2 py-1 text-xs font-medium text-muted hover:text-text disabled:opacity-40 disabled:hover:text-muted"
        >
          Prev
        </button>
        <button
          onClick={onNext}
          disabled={offset + limit >= total}
          className="rounded-lg px-2 py-1 text-xs font-medium text-muted hover:text-text disabled:opacity-40 disabled:hover:text-muted"
        >
          Next
        </button>
      </div>
    </div>
  );
}
