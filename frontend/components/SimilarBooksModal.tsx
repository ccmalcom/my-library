'use client';

import { useEffect, useState } from 'react';
import { BookOpen, Plus, Check } from 'lucide-react';
import { Modal, Spinner, useToast } from '@/components/ui';
import { api, type Book, type SimilarBook } from '@/lib/api';

interface Props {
  book: Book;
  onClose: () => void;
}

const LABEL_ID = 'similar-books-modal-title';

export default function SimilarBooksModal({ book, onClose }: Props) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SimilarBook[]>([]);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [addingRank, setAddingRank] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .similarBooks(book.id)
      .then((res) => {
        if (cancelled) return;
        setResults(res.recommendations);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not find similar reads.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [book.id]);

  async function handleAdd(rec: SimilarBook) {
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
    <Modal
      labelId={LABEL_ID}
      onClose={onClose}
      className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-xl"
    >
      <div className="border-b border-border p-4 sm:p-6">
        <p className="font-mono text-xs uppercase tracking-widest text-faint">More like</p>
        <h2 id={LABEL_ID} className="font-display text-xl font-semibold leading-snug text-text">
          {book.title}
        </h2>
      </div>

      <div className="overflow-y-auto p-4 sm:p-6">
        {loading && (
          <div className="flex flex-col items-center gap-3 py-12">
            <Spinner size="lg" />
            <p className="text-sm text-muted">Finding books like this one…</p>
          </div>
        )}

        {!loading && error && <p className="py-8 text-center text-sm text-danger">{error}</p>}

        {!loading && !error && results.length === 0 && (
          <p className="py-8 text-center text-sm text-faint">
            No close matches surfaced for this one.
          </p>
        )}

        {!loading && !error && results.length > 0 && (
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
                          {addingRank === rec.rank ? 'Adding…' : 'Add to to-read'}
                        </>
                      )}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
