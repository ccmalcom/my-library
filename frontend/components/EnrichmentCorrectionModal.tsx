'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { BookOpen } from 'lucide-react';
import { api, type Book, type CatalogResult } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';

interface Props {
  book: Book;
  onCorrected: (book: Book) => void;
  onClose: () => void;
  queuePosition?: { index: number; total: number };
  onFinishQueue?: () => void;
}

const LABEL_ID = 'enrichment-correction-title';

type SearchOutcome = { query: string; hits: CatalogResult[] } | { query: string; error: string };

export default function EnrichmentCorrectionModal({
  book,
  onCorrected,
  onClose,
  queuePosition,
  onFinishQueue,
}: Props) {
  const toast = useToast();

  const [query, setQuery] = useState(book.title);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [selected, setSelected] = useState<CatalogResult | null>(null);
  const [saving, setSaving] = useState(false);

  const reqId = useRef(0);
  const trimmedQuery = query.trim();
  const shouldSearch = !selected && trimmedQuery.length >= 2;
  useEffect(() => {
    if (!shouldSearch) return;
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const hits = await api.catalogSearch(trimmedQuery);
        if (id === reqId.current) setOutcome({ query: trimmedQuery, hits });
      } catch (e) {
        if (id === reqId.current) {
          setOutcome({
            query: trimmedQuery,
            error: e instanceof Error ? e.message : 'Search failed.',
          });
        }
      }
    }, 350);
    return () => clearTimeout(t);
  }, [shouldSearch, trimmedQuery]);
  // Only trust the outcome when it matches the query it was fetched for — otherwise
  // it's stale (from a prior query) and we're still effectively searching.
  const currentOutcome = shouldSearch && outcome?.query === trimmedQuery ? outcome : null;
  const displayResults = currentOutcome && 'hits' in currentOutcome ? currentOutcome.hits : [];
  const searchError = currentOutcome && 'error' in currentOutcome ? currentOutcome.error : null;
  const isSearching = shouldSearch && currentOutcome == null;

  function finishOrClose() {
    if (queuePosition && onFinishQueue) onFinishQueue();
    else onClose();
  }

  async function handleConfirm() {
    if (!selected || !selected.catalog_id) return;
    setSaving(true);
    try {
      const updated = await api.correctEnrichment(book.id, {
        catalog_source: selected.source,
        catalog_id: selected.catalog_id,
        cover_url: selected.cover_url,
        subjects: selected.subjects,
        description: selected.description,
      });
      onCorrected(updated);
      toast.success('Match updated.');
      finishOrClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update match.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      className="fade-in flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface p-6 shadow-2xl"
    >
      <div className="mb-4">
        {queuePosition && (
          <p className="mb-1 font-mono text-xs font-semibold uppercase tracking-widest text-accent">
            Fix matches · {queuePosition.index + 1} of {queuePosition.total}
          </p>
        )}
        <h2 id={LABEL_ID} className="font-display text-lg font-bold text-text">
          Fix this match
        </h2>
      </div>

      {/* Current (possibly wrong) match, for context */}
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-elevated p-3">
        <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded bg-surface">
          {book.cover_url ? (
            <Image
              src={book.cover_url}
              alt={`Cover of ${book.title}`}
              fill
              className="object-cover"
              unoptimized
            />
          ) : (
            <div className="flex h-full items-center justify-center text-faint">
              <BookOpen className="h-5 w-5" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-text">{book.title}</p>
          <p className="truncate text-sm text-muted">{book.author ?? 'Unknown author'}</p>
          <p className="mt-0.5 text-xs text-warning">Unverified catalog match</p>
        </div>
      </div>

      {!selected ? (
        <>
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, author, or ISBN..."
            className={[
              'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
              'placeholder-faint focus:border-accent focus:outline-none',
              'focus-visible:ring-1 focus-visible:ring-accent',
            ].join(' ')}
          />

          <div className="mt-4 min-h-[120px] flex-1 overflow-y-auto">
            {isSearching && (
              <p className="py-8 text-center text-sm text-muted">Searching the catalogs...</p>
            )}
            {searchError && <p className="py-4 text-sm text-danger">{searchError}</p>}
            {!isSearching && !searchError && shouldSearch && displayResults.length === 0 && (
              <p className="py-8 text-center text-sm text-muted">
                No matches. Try a different spelling.
              </p>
            )}
            <ul className="space-y-1">
              {displayResults.map((r, i) => (
                <li key={`${r.source}-${r.catalog_id ?? i}`}>
                  <button
                    type="button"
                    onClick={() => setSelected(r)}
                    className={[
                      'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition',
                      'hover:bg-elevated',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
                    ].join(' ')}
                  >
                    <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded bg-elevated">
                      {r.cover_url ? (
                        <Image
                          src={r.cover_url}
                          alt={`Cover of ${r.title}`}
                          fill
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-faint">
                          <BookOpen className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text">{r.title}</p>
                      <p className="truncate text-xs text-faint">
                        {r.author ?? 'Unknown author'}
                        {r.year ? ` · ${r.year}` : ''}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={finishOrClose}>
              {queuePosition ? 'Skip' : 'Cancel'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-elevated p-3">
            <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded bg-surface">
              {selected.cover_url ? (
                <Image
                  src={selected.cover_url}
                  alt={`Cover of ${selected.title}`}
                  fill
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex h-full items-center justify-center text-faint">
                  <BookOpen className="h-5 w-5" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-text">{selected.title}</p>
              <p className="truncate text-sm text-muted">
                {selected.author ?? 'Unknown author'}
                {selected.year ? ` · ${selected.year}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="shrink-0 text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
            >
              Change
            </button>
          </div>

          {!selected.catalog_id && (
            <p className="mt-2 text-xs text-warning">
              This result is missing a catalog id and can&apos;t be used. Pick another.
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={finishOrClose} disabled={saving}>
              {queuePosition ? 'Skip' : 'Cancel'}
            </Button>
            <Button
              onClick={handleConfirm}
              loading={saving}
              disabled={saving || !selected.catalog_id}
            >
              {saving ? 'Saving...' : queuePosition ? 'Confirm & next' : 'Confirm match'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
