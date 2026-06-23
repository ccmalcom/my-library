"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { api, type Stats } from "@/lib/api";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-[#1a1f2e] p-5 text-center">
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-400 uppercase tracking-wide">{label}</p>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: stats, isLoading } = useSWR<Stats>("stats", () => api.stats());

  // First-run detection: redirect to setup if no books have been imported yet.
  const needsSetup = !isLoading && stats != null && stats.total === 0;
  useEffect(() => {
    if (needsSetup) {
      router.replace("/setup");
    }
  }, [needsSetup, router]);

  // Don't render the dashboard until we know setup is complete — otherwise the
  // home page flashes for a moment before the redirect to /setup fires.
  if (isLoading || !stats || needsSetup) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  async function handleRun() {
    setRunning(true);
    setError(null);
    try {
      await api.runRecommend(10);
      router.push("/swipe");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setRunning(false);
    }
  }

  return (
    <div className="fade-in space-y-8 py-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Your Library</h1>
        <p className="mt-1 text-slate-400">
          AI-powered recommendations grounded in your actual reading taste.
        </p>
      </div>

      {/* Stats grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl border border-slate-700 bg-[#1a1f2e]"
            />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total books" value={stats.total} />
          <StatCard label="Rated" value={stats.rated} />
          <StatCard
            label="Mean rating"
            value={stats.mean_rating != null ? stats.mean_rating.toFixed(2) : "—"}
          />
          <StatCard
            label="To read"
            value={stats.shelves?.["to-read"] ?? stats.shelves?.to_read ?? "—"}
          />
        </div>
      ) : null}

      {/* Stars breakdown */}
      {stats?.by_star && Object.keys(stats.by_star).length > 0 && (
        <div className="rounded-xl border border-slate-700 bg-[#1a1f2e] p-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Ratings breakdown
          </p>
          <div className="space-y-2">
            {[5, 4, 3, 2, 1].map((star) => {
              const count = stats.by_star[String(star)] ?? 0;
              const pct = stats.rated > 0 ? (count / stats.rated) * 100 : 0;
              return (
                <div key={star} className="flex items-center gap-3">
                  <span className="w-8 text-right text-sm text-slate-300">
                    {"★".repeat(star)}
                  </span>
                  <div className="flex-1 overflow-hidden rounded-full bg-slate-800 h-2">
                    <div
                      className="h-2 rounded-full bg-amber-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-sm text-slate-400">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Run recommendations */}
      <div className="rounded-xl border border-slate-700 bg-[#1a1f2e] p-6 text-center">
        <h2 className="mb-1 text-lg font-semibold text-white">Ready for new picks?</h2>
        <p className="mb-5 text-sm text-slate-400">
          Claude will analyze your taste profile and find 10 books matched to you.
          This takes 30–60 seconds.
        </p>

        <button
          onClick={handleRun}
          disabled={running}
          className={[
            "inline-flex items-center gap-2 rounded-lg px-6 py-3 font-semibold text-white transition-all",
            running
              ? "cursor-not-allowed bg-blue-700 opacity-70"
              : "bg-blue-600 hover:bg-blue-500 active:scale-95",
          ].join(" ")}
        >
          {running ? (
            <>
              <Spinner />
              Running recommendations…
            </>
          ) : (
            "Run Recommendations"
          )}
        </button>

        {error && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
