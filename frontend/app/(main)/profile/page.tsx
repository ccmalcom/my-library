"use client";

import { useState, useRef, useEffect } from "react";
import useSWR, { mutate } from "swr";
import { api, type Trait, type Stats, type SubjectBreakdown, type Book } from "@/lib/api";

// ─── SWR keys ────────────────────────────────────────────────────────────────

const TRAITS_KEY   = "profile-traits";
const STATS_KEY    = "stats";
const SUBJECTS_KEY = "profile-subjects";
const BOOKS_KEY    = "books-all";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-lg font-semibold text-white">{children}</h2>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="py-10 text-center text-slate-500">{message}</p>
  );
}

// ─── Trait card ───────────────────────────────────────────────────────────────

function TraitCard({
  trait,
  bookMap,
}: {
  trait: Trait;
  bookMap: Map<number, string>;
}) {
  const isReward   = trait.polarity === "reward";
  const [editing, setEditing]   = useState(false);
  const [draft, setDraft]       = useState(trait.claim);
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep draft in sync if the trait claim changes externally (after a save).
  useEffect(() => {
    if (!editing) setDraft(trait.claim);
  }, [trait.claim, editing]);

  // Auto-grow textarea.
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
    }
  }, [editing, draft]);

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === trait.claim) {
      setEditing(false);
      setDraft(trait.claim);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateTrait(trait.id, { claim: trimmed });
      await mutate(TRAITS_KEY);
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setDraft(trait.claim);
    setSaveError(null);
  }

  const exhibitTitles  = (trait.exhibits  ?? []).map((id) => bookMap.get(id)).filter(Boolean) as string[];
  const contrastTitles = (trait.contrasts ?? []).map((id) => bookMap.get(id)).filter(Boolean) as string[];

  return (
    <div
      className={[
        "rounded-xl border p-4 space-y-3 transition",
        isReward
          ? "border-emerald-800/60 bg-emerald-950/30"
          : "border-rose-800/60 bg-rose-950/30",
      ].join(" ")}
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        {/* Polarity badge */}
        <span
          className={[
            "shrink-0 mt-0.5 rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
            isReward
              ? "bg-emerald-900 text-emerald-300"
              : "bg-rose-900 text-rose-300",
          ].join(" ")}
        >
          {isReward ? "Loves" : "Avoids"}
        </span>

        {/* Claim — edit mode or display */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              className="w-full resize-none rounded-lg border border-blue-600 bg-[#1a1f2e] px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === "Escape") cancel();
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Click to edit"
              className="text-left text-sm text-slate-200 hover:text-white group"
            >
              {trait.claim}
              <span className="ml-2 opacity-0 group-hover:opacity-60 text-xs text-slate-400 transition-opacity">
                ✎
              </span>
            </button>
          )}

          {saveError && (
            <p className="mt-1 text-xs text-red-400">{saveError}</p>
          )}
        </div>

        {/* Confidence + status pills */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-slate-500">
            {Math.round(trait.inference_confidence * 100)}% confidence
          </span>
          {trait.status !== "proposed" && (
            <span
              className={[
                "rounded-full px-1.5 py-0.5 text-xs",
                trait.status === "edited"
                  ? "bg-blue-900/50 text-blue-300"
                  : trait.status === "confirmed"
                  ? "bg-emerald-900/50 text-emerald-300"
                  : "bg-slate-700 text-slate-400",
              ].join(" ")}
            >
              {trait.status}
            </span>
          )}
        </div>
      </div>

      {/* Edit action row */}
      {editing && (
        <div className="flex items-center gap-2 pl-14">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-slate-600 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-400"
          >
            Cancel
          </button>
          <span className="text-xs text-slate-600">⌘↵ to save · Esc to cancel</span>
        </div>
      )}

      {/* Evidence books */}
      {(exhibitTitles.length > 0 || contrastTitles.length > 0) && (
        <div className="pl-14 space-y-1.5">
          {exhibitTitles.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-xs text-slate-500 mr-1">Evidence:</span>
              {exhibitTitles.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          {contrastTitles.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-xs text-slate-500 mr-1">Contrast:</span>
              {contrastTitles.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-slate-800/50 px-1.5 py-0.5 text-xs text-slate-500"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Traits section ───────────────────────────────────────────────────────────

function TraitsSection({
  traits,
  bookMap,
}: {
  traits: Trait[];
  bookMap: Map<number, string>;
}) {
  const [filter, setFilter] = useState<"all" | "reward" | "aversion">("all");

  const rewards   = traits.filter((t) => t.polarity === "reward");
  const aversions = traits.filter((t) => t.polarity === "aversion");

  const visible =
    filter === "all"
      ? traits
      : filter === "reward"
      ? rewards
      : aversions;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <SectionHeading>Taste Traits</SectionHeading>
          <p className="mt-0.5 text-xs text-slate-500">
            Claude inferred these from your ratings. Click any trait to reword it.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-700 bg-[#1a1f2e] p-1 text-xs">
          {(["all", "reward", "aversion"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={[
                "rounded-md px-2.5 py-1 capitalize transition",
                filter === f
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:text-slate-200",
              ].join(" ")}
            >
              {f === "all" ? `All (${traits.length})` : f === "reward" ? `Loves (${rewards.length})` : `Avoids (${aversions.length})`}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState message="No traits yet. Run the taste profiler first." />
      ) : (
        <div className="space-y-3">
          {visible.map((t) => (
            <TraitCard key={t.id} trait={t} bookMap={bookMap} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Rating distribution ──────────────────────────────────────────────────────

function RatingSection({ stats }: { stats: Stats }) {
  const total = stats.rated ?? 0;
  const byStarData = stats.by_star ?? {};
  return (
    <section className="space-y-4">
      <div>
        <SectionHeading>Rating Distribution</SectionHeading>
        <p className="mt-0.5 text-xs text-slate-500">
          {total} rated book{total !== 1 ? "s" : ""} · mean{" "}
          {stats.mean_rating != null ? stats.mean_rating.toFixed(2) : "—"} ★
        </p>
      </div>
      <div className="rounded-xl border border-slate-700 bg-[#1a1f2e] p-5 space-y-3">
        {[5, 4, 3, 2, 1].map((star) => {
          const count = byStarData[String(star)] ?? 0;
          const pct   = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={star} className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-right text-sm text-amber-400">
                {"★".repeat(star)}
              </span>
              <div className="flex-1 overflow-hidden rounded-full bg-slate-800 h-2.5">
                <div
                  className="h-2.5 rounded-full bg-amber-500 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-sm text-slate-400">
                {count}{" "}
                <span className="text-slate-600 text-xs">({pct.toFixed(0)}%)</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Genre breakdown ──────────────────────────────────────────────────────────

function GenreSection({ subjects }: { subjects: SubjectBreakdown }) {
  const [tier, setTier] = useState<string>("all");

  const tierKeys = Object.keys(subjects.by_tier); // already sorted desc by API

  const items =
    tier === "all"
      ? subjects.overall
      : (subjects.by_tier[tier] ?? []);

  const maxCount = items[0]?.count ?? 1;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <SectionHeading>Genre Breakdown</SectionHeading>
          <p className="mt-0.5 text-xs text-slate-500">
            Subjects from enriched catalog data across your rated books.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-700 bg-[#1a1f2e] p-1 text-xs">
          <button
            onClick={() => setTier("all")}
            className={[
              "rounded-md px-2.5 py-1 transition",
              tier === "all" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            All
          </button>
          {tierKeys.map((k) => (
            <button
              key={k}
              onClick={() => setTier(k)}
              className={[
                "rounded-md px-2.5 py-1 transition",
                tier === k ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200",
              ].join(" ")}
            >
              {"★".repeat(Number(k))}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState message="No subject data yet. Run enrich to pull catalog metadata." />
      ) : (
        <div className="rounded-xl border border-slate-700 bg-[#1a1f2e] p-5 space-y-2.5">
          {items.map(({ subject, count }) => {
            const pct = (count / maxCount) * 100;
            return (
              <div key={subject} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-sm text-slate-300" title={subject}>
                  {subject}
                </span>
                <div className="flex-1 overflow-hidden rounded-full bg-slate-800 h-2">
                  <div
                    className="h-2 rounded-full bg-blue-600 transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-6 shrink-0 text-right text-xs text-slate-500">{count}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-16 animate-pulse rounded-xl border border-slate-700 bg-[#1a1f2e]"
        />
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const { data: traits = [], isLoading: traitsLoading } = useSWR<Trait[]>(
    TRAITS_KEY,
    () => api.profile()
  );

  const { data: stats, isLoading: statsLoading } = useSWR<Stats>(
    STATS_KEY,
    () => api.stats()
  );

  const { data: subjects, isLoading: subjectsLoading } = useSWR<SubjectBreakdown>(
    SUBJECTS_KEY,
    () => api.profileSubjects()
  );

  // Load all books once so we can resolve book IDs → titles for trait evidence.
  const { data: allBooks = [] } = useSWR<Book[]>(
    BOOKS_KEY,
    () => api.books({ limit: 500 })
  );

  const bookMap = new Map(allBooks.map((b) => [b.id, b.title]));

  const isLoading = traitsLoading || statsLoading || subjectsLoading;

  return (
    <div className="fade-in space-y-10 py-6">
      <div>
        <h1 className="text-3xl font-bold text-white">My Profile</h1>
        <p className="mt-1 text-slate-400">
          What the recommender knows about your taste — and how you can correct it.
        </p>
      </div>

      {isLoading ? (
        <Skeleton />
      ) : (
        <>
          <TraitsSection traits={traits} bookMap={bookMap} />

          {stats && <RatingSection stats={stats} />}

          {subjects && <GenreSection subjects={subjects} />}
        </>
      )}
    </div>
  );
}
