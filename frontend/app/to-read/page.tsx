"use client";

import Image from "next/image";
import useSWR from "swr";
import { api, type Book } from "@/lib/api";

export default function ToReadPage() {
  const { data: books, isLoading, error } = useSWR<Book[]>(
    "books-to-read",
    () => api.books({ shelf: "to-read", limit: 500 })
  );

  if (isLoading) {
    return (
      <div className="fade-in grid gap-3 py-6 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-slate-700 bg-[#1a1f2e]"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center text-red-400">
        Failed to load shelf: {String(error)}
      </div>
    );
  }

  const sorted = (books ?? []).slice().sort((a, b) => {
    // Newest added first; fall back to title
    if (a.date_added && b.date_added) return b.date_added.localeCompare(a.date_added);
    if (a.date_added) return -1;
    if (b.date_added) return 1;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });

  return (
    <div className="fade-in space-y-6 py-6">
      <div>
        <h1 className="text-3xl font-bold text-white">To Read</h1>
        <p className="mt-1 text-slate-400">
          {sorted.length} book{sorted.length !== 1 ? "s" : ""} on your shelf
        </p>
      </div>

      {sorted.length === 0 ? (
        <div className="py-16 text-center text-slate-500">
          Your to-read shelf is empty. Accept some recommendations to fill it!
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map((book) => (
            <li
              key={book.id}
              className="flex gap-4 rounded-xl border border-slate-700 bg-[#1a1f2e] p-4"
            >
              {/* Cover */}
              <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-slate-800">
                {book.cover_url ? (
                  <Image
                    src={book.cover_url}
                    alt={`Cover of ${book.title}`}
                    fill
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-2xl text-slate-600">
                    📚
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-white">{book.title}</p>
                <p className="text-sm text-slate-400">{book.author ?? "Unknown author"}</p>
                {book.year_published && (
                  <p className="text-xs text-slate-500">{book.year_published}</p>
                )}
                {book.date_added && (
                  <p className="mt-1 text-xs text-slate-600">
                    Added {book.date_added}
                  </p>
                )}
              </div>

              {/* Source badge */}
              {book.confidence_label === "RECOMMENDATION" && (
                <span className="shrink-0 self-start rounded-full bg-blue-900/50 border border-blue-700 px-2 py-0.5 text-xs text-blue-300">
                  AI pick
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
