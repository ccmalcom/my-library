"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { api, type Recommendation, type Trait } from "@/lib/api";
import SwipeCard from "@/components/SwipeCard";

export default function SwipePage() {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const { data: recs, isLoading: recsLoading, error: recsError } =
    useSWR<Recommendation[]>("recommendations", () => api.recommendations());

  const { data: traits = [] } =
    useSWR<Trait[]>("profile", () => api.profile());

  const handleDecide = useCallback(
    async (recId: number, status: "accepted" | "rejected" | "already_read") => {
      // Optimistically remove from visible stack
      setDismissed((prev) => new Set([...prev, recId]));

      try {
        await api.feedback(recId, { status });
      } catch (e) {
        console.error("Feedback failed:", e);
        // Re-add to stack on failure
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(recId);
          return next;
        });
      }
    },
    []
  );

  if (recsLoading) {
    return (
      <div className="fade-in flex items-center justify-center py-24">
        <div className="text-center space-y-3">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-700 border-t-blue-500" />
          <p className="text-slate-400">Loading recommendations…</p>
        </div>
      </div>
    );
  }

  if (recsError) {
    return (
      <div className="fade-in py-12 text-center">
        <p className="text-red-400">Failed to load recommendations.</p>
        <p className="mt-1 text-sm text-slate-500">{String(recsError)}</p>
      </div>
    );
  }

  // Only show "served" recs that haven't been dismissed yet
  const pending = (recs ?? [])
    .filter((r) => r.status === "served" && !dismissed.has(r.id))
    .sort((a, b) => a.rank - b.rank);

  // Include locally dismissed in the total to check completion
  const total = (recs ?? []).filter((r) => r.status === "served" || dismissed.has(r.id));

  if ((recs ?? []).length === 0) {
    return (
      <div className="fade-in py-20 text-center space-y-4">
        <p className="text-2xl">📭</p>
        <h2 className="text-xl font-semibold text-white">No recommendations yet</h2>
        <p className="text-slate-400">
          Go to the home page and run a recommendation batch first.
        </p>
        <button
          onClick={() => router.push("/")}
          className="mt-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Back to Home
        </button>
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <div className="fade-in py-20 text-center space-y-4">
        <p className="text-4xl">🎉</p>
        <h2 className="text-xl font-semibold text-white">All done!</h2>
        <p className="text-slate-400">
          You reviewed all {total.length} recommendations.
        </p>
        <button
          onClick={() => router.push("/to-read")}
          className="mt-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          View To-Read Shelf
        </button>
      </div>
    );
  }

  // Show up to 3 cards in the stack (top card + 2 behind)
  const visibleStack = pending.slice(0, 3);

  return (
    <div className="fade-in flex flex-col items-center gap-6 py-6">
      {/* Progress */}
      <p className="text-sm text-slate-400">
        {dismissed.size} / {(recs ?? []).filter((r) => r.status === "served" || dismissed.has(r.id)).length} reviewed
      </p>

      {/* Card stack */}
      <div className="relative h-[520px] w-full max-w-sm">
        {visibleStack
          .slice()
          .reverse()
          .map((rec, idx) => {
            const isTop = idx === visibleStack.length - 1;
            return (
              <SwipeCard
                key={rec.id}
                rec={rec}
                traits={traits}
                onDecide={handleDecide}
                zIndex={idx + 1}
                isTop={isTop}
              />
            );
          })}
      </div>

      {/* Button controls */}
      <div className="flex gap-4">
        <button
          onClick={() => {
            const top = pending[0];
            if (top) void handleDecide(top.id, "rejected");
          }}
          className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-red-500 bg-[#1a1f2e] text-2xl text-red-400 shadow transition hover:bg-red-900/30 active:scale-95"
          title="Not interested"
        >
          ✕
        </button>
        <button
          onClick={() => {
            const top = pending[0];
            if (top) void handleDecide(top.id, "already_read");
          }}
          className="flex h-12 w-12 items-center justify-center self-center rounded-full border-2 border-amber-500 bg-[#1a1f2e] text-xl text-amber-400 shadow transition hover:bg-amber-900/30 active:scale-95"
          title="Already read"
        >
          📖
        </button>
        <button
          onClick={() => {
            const top = pending[0];
            if (top) void handleDecide(top.id, "accepted");
          }}
          className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-green-500 bg-[#1a1f2e] text-2xl text-green-400 shadow transition hover:bg-green-900/30 active:scale-95"
          title="Add to to-read"
        >
          ♥
        </button>
      </div>

      <p className="text-xs text-slate-600">
        Drag left/right or use the buttons
      </p>
    </div>
  );
}
