"use client";

import { useState, Suspense } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR, { mutate } from "swr";
import { api, type Book, type Recommendation, type Shelf } from "@/lib/api";
import BookEditModal from "@/components/BookEditModal";

const READ_KEY    = "books-read";
const TO_READ_KEY = "books-to-read";
const REJECTED_KEY = "recs-rejected";

const STARS = [5, 4, 3, 2, 1] as const;
type Tab = "read" | "to-read" | "rejected";

// ── Shared helpers ────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: number | null }) {
  if (!rating) return <span className="text-xs text-slate-600">unrated</span>;
  return (
    <span className="text-sm text-amber-400">
      {"★".repeat(rating)}
      <span className="text-slate-600">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="search"
      placeholder="Search title or author…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 min-w-40 rounded-lg border border-slate-700 bg-[#1a1f2e] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-blue-600 focus:outline-none"
    />
  );
}

function SortSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-lg border border-slate-700 bg-[#1a1f2e] px-3 py-2 text-sm text-slate-300 focus:border-blue-600 focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Read tab ──────────────────────────────────────────────────────────────────

type ReadSort = "rating-desc" | "rating-asc" | "title-asc" | "date-desc";

const READ_SORT_OPTIONS: { value: ReadSort; label: string }[] = [
  { value: "rating-desc", label: "Rating ↓" },
  { value: "rating-asc",  label: "Rating ↑" },
  { value: "title-asc",   label: "Title A–Z" },
  { value: "date-desc",   label: "Date read ↓" },
];

function ReadTab({ books }: { books: Book[] }) {
  const [filterStar, setFilterStar] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ReadSort>("rating-desc");
  const [editing, setEditing] = useState<Book | null>(null);
  const [queue, setQueue] = useState<Book[] | null>(null);
  const [qIndex, setQIndex] = useState(0);

  const rated = books.filter((b) => b.effective_rating !== null);
  const unrated = books.filter((b) => b.effective_rating === null);

  function startReviewQueue() {
    if (unrated.length === 0) return;
    setQIndex(0);
    setQueue(unrated);
  }

  function advanceQueue() {
    setQueue((q) => {
      if (!q) return null;
      const next = qIndex + 1;
      if (next >= q.length) return null;
      setQIndex(next);
      return q;
    });
  }

  const filtered = rated
    .filter((b) => (filterStar !== null ? b.effective_rating === filterStar : true))
    .filter((b) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case "rating-desc": return (b.effective_rating ?? 0) - (a.effective_rating ?? 0);
        case "rating-asc":  return (a.effective_rating ?? 0) - (b.effective_rating ?? 0);
        case "title-asc":   return (a.title ?? "").localeCompare(b.title ?? "");
        case "date-desc": {
          if (a.date_read && b.date_read) return b.date_read.localeCompare(a.date_read);
          if (a.date_read) return -1;
          if (b.date_read) return 1;
          return 0;
        }
      }
    });

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-slate-400">
          {rated.length} rated book{rated.length !== 1 ? "s" : ""}
          {unrated.length > 0 && ` · ${unrated.length} unrated`}
        </p>
        {unrated.length > 0 && (
          <button
            type="button"
            onClick={startReviewQueue}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-blue-700 bg-blue-900/30 px-3.5 py-1.5 text-sm font-semibold text-blue-200 transition hover:bg-blue-900/60 active:scale-95"
          >
            ✎ {unrated.length} book{unrated.length !== 1 ? "s" : ""} missing reviews
          </button>
        )}
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={READ_SORT_OPTIONS} />
        <div className="flex gap-1">
          {STARS.map((s) => (
            <button
              key={s}
              onClick={() => setFilterStar(filterStar === s ? null : s)}
              className={[
                "rounded-md px-3 py-1.5 text-sm transition",
                filterStar === s
                  ? "bg-amber-500 text-slate-900 font-semibold"
                  : "border border-slate-700 text-slate-400 hover:border-slate-500",
              ].join(" ")}
            >
              {"★".repeat(s)}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-slate-500">No books match your filters.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {filtered.map((book) => (
            <li key={book.id}>
              <button
                type="button"
                onClick={() => setEditing(book)}
                className="flex w-full items-center gap-4 py-3 text-left transition hover:bg-slate-800/40 px-2 rounded-lg"
              >
                <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded bg-slate-800">
                  {book.cover_url ? (
                    <Image src={book.cover_url} alt="" fill className="object-cover" unoptimized />
                  ) : (
                    <div className="flex h-full items-center justify-center text-lg text-slate-600">📚</div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-200">{book.title}</p>
                  <p className="truncate text-sm text-slate-500">{book.author}</p>
                </div>
                <div className="shrink-0">
                  <StarRating rating={book.effective_rating} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <BookEditModal
          book={editing}
          listKey={READ_KEY}
          onClose={() => { setEditing(null); void mutate(READ_KEY); }}
        />
      )}

      {queue && queue[qIndex] && (
        <BookEditModal
          book={queue[qIndex]!}
          listKey={READ_KEY}
          queuePosition={{ index: qIndex, total: queue.length }}
          onFinishQueue={advanceQueue}
          onClose={() => { setQueue(null); void mutate(READ_KEY); }}
        />
      )}
    </div>
  );
}

// ── To Read tab ───────────────────────────────────────────────────────────────

type ToReadSort = "date-desc" | "date-asc" | "title-asc";

const TO_READ_SORT_OPTIONS: { value: ToReadSort; label: string }[] = [
  { value: "date-desc", label: "Date added ↓" },
  { value: "date-asc",  label: "Date added ↑" },
  { value: "title-asc", label: "Title A–Z" },
];

function ToReadTab({ books }: { books: Book[] }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ToReadSort>("date-desc");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<Book | null>(null);

  const filtered = books
    .filter((b) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return b.title?.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case "date-desc": {
          if (a.date_added && b.date_added) return b.date_added.localeCompare(a.date_added);
          if (a.date_added) return -1;
          if (b.date_added) return 1;
          return (a.title ?? "").localeCompare(b.title ?? "");
        }
        case "date-asc": {
          if (a.date_added && b.date_added) return a.date_added.localeCompare(b.date_added);
          if (a.date_added) return 1;
          if (b.date_added) return -1;
          return (a.title ?? "").localeCompare(b.title ?? "");
        }
        case "title-asc": return (a.title ?? "").localeCompare(b.title ?? "");
      }
    });

  async function moveTo(book: Book, shelf: Shelf, thenReview = false) {
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.setBookShelf(book.id, shelf);
      await Promise.all([mutate(TO_READ_KEY), mutate(READ_KEY)]);
      if (thenReview) setReviewing(book);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to move book.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(book: Book) {
    if (!window.confirm(`Remove "${book.title}" from your to-read shelf?`)) return;
    setBusyId(book.id);
    setActionError(null);
    try {
      await api.removeBook(book.id);
      await mutate(TO_READ_KEY);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to remove book.");
    } finally {
      setBusyId(null);
    }
  }

  if (books.length === 0) {
    return (
      <div className="py-16 text-center text-slate-500">
        Your to-read shelf is empty. Accept some recommendations to fill it!
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={TO_READ_SORT_OPTIONS} />
      </div>

      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-slate-500">No books match your search.</p>
      ) : (
        <ul className="space-y-3">
          {filtered.map((book) => {
            const busy = busyId === book.id;
            return (
              <li
                key={book.id}
                className="flex gap-4 rounded-xl border border-slate-700 bg-[#1a1f2e] p-4"
              >
                <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-slate-800">
                  {book.cover_url ? (
                    <Image src={book.cover_url} alt={`Cover of ${book.title}`} fill className="object-cover" unoptimized />
                  ) : (
                    <div className="flex h-full items-center justify-center text-2xl text-slate-600">📚</div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{book.title}</p>
                  <p className="text-sm text-slate-400">{book.author ?? "Unknown author"}</p>
                  {book.year_published && (
                    <p className="text-xs text-slate-500">{book.year_published}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => moveTo(book, "currently-reading")}
                      className="rounded-md border border-slate-600 px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:border-slate-400 hover:text-white disabled:opacity-50"
                    >
                      Start reading
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => moveTo(book, "read", true)}
                      className="rounded-md border border-green-700 bg-green-900/30 px-2.5 py-1 text-xs font-medium text-green-300 transition hover:bg-green-900/60 disabled:opacity-50"
                    >
                      Mark finished
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(book)}
                      className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:border-red-700 hover:text-red-300 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {reviewing && (
        <BookEditModal
          book={reviewing}
          listKey={READ_KEY}
          onClose={() => { setReviewing(null); void Promise.all([mutate(TO_READ_KEY), mutate(READ_KEY)]); }}
        />
      )}
    </div>
  );
}

// ── Rejected tab ──────────────────────────────────────────────────────────────

type RejectedSort = "date-desc" | "title-asc";

const REJECTED_SORT_OPTIONS: { value: RejectedSort; label: string }[] = [
  { value: "date-desc", label: "Date skipped ↓" },
  { value: "title-asc", label: "Title A–Z" },
];

function RejectedTab({ recs }: { recs: Recommendation[] }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<RejectedSort>("date-desc");

  const filtered = recs
    .filter((r) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return r.title?.toLowerCase().includes(q) || r.author?.toLowerCase().includes(q);
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case "date-desc": return b.created_at.localeCompare(a.created_at);
        case "title-asc": return (a.title ?? "").localeCompare(b.title ?? "");
      }
    });

  if (recs.length === 0) {
    return (
      <div className="py-16 text-center text-slate-500">
        No rejected recommendations yet.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} />
        <SortSelect value={sort} onChange={setSort} options={REJECTED_SORT_OPTIONS} />
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-slate-500">No results match your search.</p>
      ) : (
        <ul className="space-y-3">
          {filtered.map((rec) => (
            <li
              key={rec.id}
              className="flex gap-4 rounded-xl border border-slate-700 bg-[#1a1f2e] p-4"
            >
              <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded-md bg-slate-800">
                {rec.cover_url ? (
                  <Image src={rec.cover_url} alt={`Cover of ${rec.title}`} fill className="object-cover" unoptimized />
                ) : (
                  <div className="flex h-full items-center justify-center text-xl text-slate-600">📚</div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-white">{rec.title}</p>
                <p className="text-sm text-slate-400">
                  {rec.author ?? "Unknown author"}
                  {rec.year ? ` · ${rec.year}` : ""}
                </p>
                {rec.rationale && (
                  <p className="mt-1 text-xs text-slate-500 line-clamp-2">{rec.rationale}</p>
                )}
              </div>
              <span className="shrink-0 self-start rounded-full border border-red-800 bg-red-900/30 px-2 py-0.5 text-xs text-red-400">
                skipped
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Inner page (reads searchParams) ──────────────────────────────────────────

function LibraryInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawTab = searchParams.get("tab") ?? "read";
  const activeTab: Tab = (["read", "to-read", "rejected"] as const).includes(rawTab as Tab)
    ? (rawTab as Tab)
    : "read";

  function setTab(tab: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`/library?${params.toString()}`);
  }

  const { data: readBooks = [], isLoading: readLoading } = useSWR<Book[]>(
    READ_KEY,
    () => api.books({ shelf: "read", limit: 500 })
  );
  const { data: toReadBooks = [], isLoading: toReadLoading } = useSWR<Book[]>(
    TO_READ_KEY,
    () => api.books({ shelf: "to-read", limit: 500 })
  );

  const { data: rejectedRecs = [], isLoading: recsLoading } = useSWR<Recommendation[]>(
    REJECTED_KEY,
    () => api.rejectedRecs()
  );


  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "read",     label: "Read",     count: readBooks.length },
    { id: "to-read",  label: "To Read",  count: toReadBooks.length },
    { id: "rejected", label: "Rejected", count: rejectedRecs.length },
  ];

  const isLoading = readLoading || toReadLoading || (activeTab === "rejected" && recsLoading);

  return (
    <div className="fade-in space-y-6 py-6">
      <h1 className="text-3xl font-bold text-white">My Library</h1>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-xl border border-slate-800 bg-[#1a1f2e] p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
              activeTab === t.id
                ? "bg-slate-700 text-white shadow"
                : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            {t.label}
            {t.count > 0 && (
              <span
                className={[
                  "rounded-full px-1.5 py-0.5 text-xs",
                  activeTab === t.id
                    ? "bg-slate-600 text-slate-200"
                    : "bg-slate-800 text-slate-500",
                ].join(" ")}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl border border-slate-700 bg-[#1a1f2e]" />
          ))}
        </div>
      ) : (
        <>
          {activeTab === "read"     && <ReadTab     books={readBooks} />}
          {activeTab === "to-read"  && <ToReadTab   books={toReadBooks} />}
          {activeTab === "rejected" && <RejectedTab recs={rejectedRecs} />}
        </>
      )}
    </div>
  );
}

// ── Page export (Suspense wraps useSearchParams) ──────────────────────────────

export default function LibraryPage() {
  return (
    <Suspense
      fallback={
        <div className="fade-in space-y-6 py-6">
          <h1 className="text-3xl font-bold text-white">My Library</h1>
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl border border-slate-700 bg-[#1a1f2e]" />
            ))}
          </div>
        </div>
      }
    >
      <LibraryInner />
    </Suspense>
  );
}
