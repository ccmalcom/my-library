'use client';

import { useState } from 'react';
import { BookOpen, Plus, Check, Search, Sparkles } from 'lucide-react';
import { Spinner, useToast } from '@/components/ui';
import { api, type DiscoverBook } from '@/lib/api';
import ShelfSprite from '@/components/ShelfSprite';

export default function DiscoverPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interpretation, setInterpretation] = useState<string | null>(null);
  const [results, setResults] = useState<DiscoverBook[] | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [addingRank, setAddingRank] = useState<number | null>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.discover(q);
      setInterpretation(res.interpretation || null);
      setResults(res.recommendations);
      setAdded(new Set());
    } catch {
      setError('Discovery tripped - your request is fine, try running it again.');
      setResults(null);
      setInterpretation(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(rec: DiscoverBook) {
    setAddingRank(rec.rank);
    try {
      await api.addBook({
        title: rec.title,
        author: rec.author,
        year: rec.year,
        isbn13: rec.isbn13,
        shelf: 'to-read',
        cover_url: rec.cover_url,
        subjects: rec.subjects,
        catalog_source: rec.catalog_source,
        catalog_id: rec.catalog_id,
      });
      setAdded((prev) => new Set([...prev, rec.rank]));
      toast.success(`Added ${rec.title} to your to-read shelf.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally {
      setAddingRank(null);
    }
  }

  return (
    <div className="fade-in space-y-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-text">
            Discover
          </h1>
          <p className="mt-1 text-sm text-muted">
            Ask for anything and get real books off the live catalog, explained.
          </p>
        </div>
        <ShelfSprite
          variant="discover"
          priority
          sizes="(max-width: 640px) 96px, 112px"
          className="h-24 w-24 shrink-0 sm:h-28 sm:w-28"
        />
      </div>

      <form onSubmit={runSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              'Ask for anything - "like Piranesi", "a thriller my book club won\'t hate"...'
            }
            aria-label="Describe the book you want"
            className={[
              'w-full min-w-0 rounded-full border border-border bg-surface py-2 pl-9 pr-4 text-sm text-text',
              'placeholder:text-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            ].join(' ')}
          />
        </div>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className={[
            'inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-base',
            'transition hover:opacity-90 disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
          ].join(' ')}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Search
        </button>
      </form>

      {loading && (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size="lg" />
          <p className="text-sm text-muted">Reading the request… searching the shelves…</p>
        </div>
      )}

      {!loading && error && <p className="py-8 text-center text-sm text-danger">{error}</p>}

      {!loading && !error && interpretation && (
        <p className="text-sm text-muted">
          <span className="text-faint">Looking for:</span> {interpretation}
        </p>
      )}

      {!loading && !error && results && results.length === 0 && (
        <p className="py-8 text-center text-sm text-faint">
          The catalog came up dry on that one. Try fewer constraints, or a different comparison
          book.
        </p>
      )}

      {!loading && !error && results && results.length > 0 && (
        <div className="space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-faint">
            Closest matches on the live catalog
          </p>
          <ul className="space-y-4">
            {results.map((rec) => {
              const isAdded = added.has(rec.rank);
              return (
                <li key={rec.rank} className="flex gap-3">
                  <div className="relative h-24 w-16 shrink-0 overflow-hidden rounded-md bg-elevated">
                    {rec.cover_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={rec.cover_url}
                        alt={`Cover of ${rec.title}`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-faint">
                        <BookOpen className="h-6 w-6" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text">{rec.title}</p>
                    <p className="truncate text-xs text-muted">{rec.author ?? 'Unknown author'}</p>
                    {rec.rationale && (
                      <p className="mt-1 text-xs leading-relaxed text-muted">{rec.rationale}</p>
                    )}
                    <button
                      type="button"
                      disabled={isAdded || addingRank === rec.rank}
                      onClick={() => handleAdd(rec)}
                      className={[
                        'mt-2 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                        isAdded
                          ? 'border-success/40 bg-success/10 text-success'
                          : 'border-border text-muted hover:border-muted hover:text-text',
                        'disabled:opacity-60',
                      ].join(' ')}
                    >
                      {isAdded ? (
                        <>
                          <Check className="h-3 w-3" /> On to-read
                        </>
                      ) : (
                        <>
                          <Plus className="h-3 w-3" />
                          {addingRank === rec.rank ? 'Adding...' : 'Add to to-read'}
                        </>
                      )}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
