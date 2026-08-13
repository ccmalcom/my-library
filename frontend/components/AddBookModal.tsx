'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { BookOpen } from 'lucide-react';
import { api, type Book, type CatalogResult, type Shelf } from '@/lib/api';
import { Button, Modal, StarRating, useToast } from '@/components/ui';

interface Props {
  onAdded: (book: Book) => void;
  onClose: () => void;
  defaultShelf?: Shelf;
}

const SHELF_OPTIONS: { value: Shelf; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'currently-reading', label: 'Reading' },
  { value: 'to-read', label: 'To read' },
  { value: 'did-not-finish', label: 'DNF' },
];

type SearchOutcome = { query: string; hits: CatalogResult[] } | { query: string; error: string };

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

export default function AddBookModal({ onAdded, onClose, defaultShelf = 'read' }: Props) {
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);

  const [selected, setSelected] = useState<CatalogResult | null>(null);
  const [shelf, setShelf] = useState<Shelf>(defaultShelf);
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState('');
  const [saving, setSaving] = useState(false);
  const [addedCount, setAddedCount] = useState(0);

  const reqId = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
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

  async function handleAdd() {
    if (!selected) return;
    setSaving(true);
    try {
      const book = await api.addBook({
        title: selected.title,
        author: selected.author,
        year: selected.year,
        isbn13: selected.isbn13,
        shelf,
        rating: rating > 0 ? rating : undefined,
        review: review.trim() || undefined,
        cover_url: selected.cover_url,
        subjects: selected.subjects,
        catalog_source: selected.source,
        catalog_id: selected.catalog_id,
      });
      toast.success(`${selected.title} added to library.`);
      onAdded(book);
      // Keep the modal open for rapid successive adds: reset the form and refocus search.
      setSelected(null);
      setQuery('');
      setOutcome(null);
      setRating(0);
      setReview('');
      setSaving(false);
      setAddedCount((n) => n + 1);
      requestAnimationFrame(() => searchRef.current?.focus());
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Failed to add book.';
      const msg = raw.includes('409') ? "Already shelved. That one's in your library." : raw;
      toast.error(msg);
      setSaving(false);
    }
  }

  const reviewWithoutRating = review.trim() !== '' && rating === 0;

  return (
    <Modal
      labelId="add-book-title"
      onClose={onClose}
      className="fade-in flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface p-6 shadow-2xl"
    >
      <h2 id="add-book-title" className="mb-4 font-display text-lg font-bold text-text">
        Add a book
      </h2>

      {!selected ? (
        <>
          <input
            autoFocus
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, author, or ISBN..."
            className={inputClass}
          />

          <div className="mt-4 min-h-[120px] flex-1 overflow-y-auto">
            {isSearching && (
              <p className="py-8 text-center text-sm text-muted">Searching the catalogs…</p>
            )}
            {searchError && <p className="py-4 text-sm text-danger">{searchError}</p>}
            {!isSearching && !searchError && shouldSearch && displayResults.length === 0 && (
              <p className="py-8 text-center text-sm text-muted">
                No matches. Try a different spelling.
              </p>
            )}
            {!isSearching && trimmedQuery.length < 2 && (
              <p className="py-8 text-center text-sm text-faint">
                Type at least 2 characters to search.
              </p>
            )}
            <ul className="space-y-1">
              {displayResults.map((r, i) => (
                <li key={`${r.source}-${r.catalog_id ?? i}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(r);
                    }}
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

          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-faint">
              {addedCount > 0 ? `Added ${addedCount} book${addedCount > 1 ? 's' : ''}` : ''}
            </span>
            <Button variant="ghost" onClick={onClose}>
              {addedCount > 0 ? 'Done' : 'Cancel'}
            </Button>
          </div>
        </>
      ) : (
        <>
          {/* Selected book */}
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
              onClick={() => {
                setSelected(null);
                setRating(0);
                setReview('');
              }}
              className="shrink-0 text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
            >
              Change
            </button>
          </div>

          {/* Shelf */}
          <div className="mt-5">
            <span className="mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted">
              Shelf
            </span>
            <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-elevated p-1">
              {SHELF_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setShelf(o.value)}
                  className={[
                    'flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    shelf === o.value
                      ? 'bg-surface text-text shadow'
                      : 'text-muted hover:text-text',
                  ].join(' ')}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Optional rating */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-xs font-semibold uppercase tracking-widest text-muted">
                Your rating <span className="font-normal normal-case text-faint">· optional</span>
              </span>
              {rating > 0 && (
                <button
                  type="button"
                  onClick={() => setRating(0)}
                  className="text-xs text-faint hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
                >
                  Clear
                </button>
              )}
            </div>
            <StarRating
              value={rating}
              onChange={setRating}
              allowHalf
              size={30}
              label="Your rating"
            />
          </div>

          {/* Optional review */}
          <div className="mt-5">
            <label className="mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted">
              Review <span className="font-normal normal-case text-faint">· optional</span>
            </label>
            <textarea
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={3}
              placeholder="What did you think? Your words feed the taste profile..."
              className={[inputClass, 'resize-y'].join(' ')}
            />
            {reviewWithoutRating && (
              <p className="mt-1 text-xs text-warning">
                A review needs a rating to anchor it. Add stars first.
              </p>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} loading={saving} disabled={saving || reviewWithoutRating}>
              {saving ? 'Adding\u2026' : 'Add to library'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
