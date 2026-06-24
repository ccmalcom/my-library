"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { api, type Book, type CatalogResult, type Shelf } from "@/lib/api";

interface Props {
  /** Called after a successful add, with the created book. */
  onAdded: (book: Book) => void;
  /** Close without adding (backdrop / cancel). */
  onClose: () => void;
  /** Shelf the added book lands on. Defaults to "read". */
  defaultShelf?: Shelf;
}

const SHELF_OPTIONS: { value: Shelf; label: string }[] = [
  { value: "read", label: "Read" },
  { value: "currently-reading", label: "Reading" },
  { value: "to-read", label: "To read" },
];

/**
 * Search-and-pick add-a-book flow. The user types a query, picks a real catalog hit
 * (so no invented titles), then optionally sets a shelf + star rating before adding.
 * The picked result's cover/subjects/isbn ride along into POST /books.
 */
export default function AddBookModal({ onAdded, onClose, defaultShelf = "read" }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selected, setSelected] = useState<CatalogResult | null>(null);
  const [shelf, setShelf] = useState<Shelf>(defaultShelf);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [review, setReview] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Debounced catalog search. A request id guards against out-of-order responses.
  const reqId = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (selected) return; // don't re-search once a pick is being configured
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const hits = await api.catalogSearch(q);
        if (id === reqId.current) setResults(hits);
      } catch (e) {
        if (id === reqId.current) {
          setSearchError(e instanceof Error ? e.message : "Search failed.");
          setResults([]);
        }
      } finally {
        if (id === reqId.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, selected]);

  async function handleAdd() {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
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
      onAdded(book);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to add book.";
      // POST /books → 409 when the book is already in the library.
      setSaveError(
        msg.includes("409") ? "That book is already in your library." : msg
      );
      setSaving(false);
    }
  }

  const shownStars = hover || rating;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="fade-in flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-slate-700 bg-[#1a1f2e] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-bold text-white">Add a book</h2>

        {!selected ? (
          <>
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, author, or ISBN…"
              className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-blue-600 focus:outline-none"
            />

            <div className="mt-4 min-h-[120px] flex-1 overflow-y-auto">
              {searching && (
                <p className="py-8 text-center text-sm text-slate-500">Searching…</p>
              )}
              {searchError && <p className="py-4 text-sm text-red-400">{searchError}</p>}
              {!searching && !searchError && query.trim().length >= 2 && results.length === 0 && (
                <p className="py-8 text-center text-sm text-slate-500">
                  No matches. Try a different spelling.
                </p>
              )}
              {!searching && query.trim().length < 2 && (
                <p className="py-8 text-center text-sm text-slate-600">
                  Type at least 2 characters to search.
                </p>
              )}
              <ul className="space-y-1">
                {results.map((r, i) => (
                  <li key={`${r.source}-${r.catalog_id ?? i}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(r);
                        setSaveError(null);
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-slate-800/60"
                    >
                      <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded bg-slate-800">
                        {r.cover_url ? (
                          <Image src={r.cover_url} alt="" fill className="object-cover" unoptimized />
                        ) : (
                          <div className="flex h-full items-center justify-center text-base text-slate-600">📚</div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-200">{r.title}</p>
                        <p className="truncate text-xs text-slate-500">
                          {r.author ?? "Unknown author"}
                          {r.year ? ` · ${r.year}` : ""}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Selected book */}
            <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-[#0f1117] p-3">
              <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded bg-slate-800">
                {selected.cover_url ? (
                  <Image src={selected.cover_url} alt="" fill className="object-cover" unoptimized />
                ) : (
                  <div className="flex h-full items-center justify-center text-lg text-slate-600">📚</div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-white">{selected.title}</p>
                <p className="truncate text-sm text-slate-400">
                  {selected.author ?? "Unknown author"}
                  {selected.year ? ` · ${selected.year}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setRating(0);
                  setReview("");
                }}
                className="shrink-0 text-xs text-slate-500 hover:text-slate-300"
              >
                Change
              </button>
            </div>

            {/* Shelf */}
            <div className="mt-5">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Shelf
              </span>
              <div className="flex gap-1 rounded-lg border border-slate-700 bg-[#0f1117] p-1">
                {SHELF_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setShelf(o.value)}
                    className={[
                      "flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition",
                      shelf === o.value
                        ? "bg-slate-700 text-white"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Optional rating */}
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Your rating <span className="font-normal normal-case text-slate-500">· optional</span>
                </span>
                {rating > 0 && (
                  <button
                    type="button"
                    onClick={() => setRating(0)}
                    className="text-xs text-slate-500 hover:text-slate-300"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="flex gap-1" onMouseLeave={() => setHover(0)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onMouseEnter={() => setHover(n)}
                    onClick={() => setRating(n)}
                    className="text-3xl leading-none transition-transform hover:scale-110"
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  >
                    <span className={n <= shownStars ? "text-amber-400" : "text-slate-600"}>★</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Optional review */}
            <div className="mt-5">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Review <span className="font-normal normal-case text-slate-500">· optional</span>
              </label>
              <textarea
                value={review}
                onChange={(e) => setReview(e.target.value)}
                rows={3}
                placeholder="What did you think? Your words feed the taste profile…"
                className="w-full resize-y rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-blue-600 focus:outline-none"
              />
            </div>

            {saveError && <p className="mt-4 text-sm text-red-400">{saveError}</p>}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={saving}
                className={[
                  "rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all",
                  saving
                    ? "cursor-not-allowed bg-blue-700 opacity-60"
                    : "bg-blue-600 hover:bg-blue-500 active:scale-95",
                ].join(" ")}
              >
                {saving ? "Adding…" : "Add to library"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
