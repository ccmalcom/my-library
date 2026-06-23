"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { api } from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────────────

type Step = "upload" | "enrich" | "done";

interface IngestResult {
  inserted: number;
  skipped: number;
  total: number;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "upload", label: "Upload" },
    { key: "enrich", label: "Enrich" },
    { key: "done", label: "Done" },
  ];
  const order: Step[] = ["upload", "enrich", "done"];
  const currentIdx = order.indexOf(current);

  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map(({ key, label }, i) => {
        const done = order.indexOf(key) < currentIdx;
        const active = key === current;
        return (
          <div key={key} className="flex items-center gap-2">
            <div
              className={[
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors",
                done
                  ? "bg-emerald-500 text-white"
                  : active
                  ? "bg-blue-600 text-white"
                  : "bg-slate-700 text-slate-400",
              ].join(" ")}
            >
              {done ? "✓" : i + 1}
            </div>
            <span
              className={[
                "text-sm",
                active ? "text-white font-medium" : done ? "text-emerald-400" : "text-slate-500",
              ].join(" ")}
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <div className={["w-8 h-px mx-1", done ? "bg-emerald-500" : "bg-slate-700"].join(" ")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Step 1: Upload ─────────────────────────────────────────────────────────────

function UploadStep({
  onDone,
}: {
  onDone: (result: IngestResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFile(f: File | null | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".csv")) {
      setError("Please select a .csv file exported from Goodreads.");
      return;
    }
    setFile(f);
    setError(null);
  }

  async function handleSubmit() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.ingestUpload(file);
      // Write fresh stats straight into the SWR cache so the dashboard sees the
      // imported count. We pass the data explicitly (rather than a bare
      // mutate("stats") revalidate) because no component is subscribed to the
      // "stats" key on this page, so a revalidate-only call wouldn't refetch and
      // the cache would stay at the stale total: 0 — which bounces us back here.
      await mutate("stats", api.stats(), { revalidate: false });
      onDone(result as unknown as IngestResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">Upload your Goodreads export</h2>
        <p className="text-slate-400 text-sm">
          In Goodreads, go to <strong className="text-slate-300">My Books → Import/Export → Export Library</strong>.
          Download the CSV, then drop it here.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFile(e.dataTransfer.files[0]);
        }}
        className={[
          "cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors",
          file
            ? "border-emerald-500 bg-emerald-500/5"
            : "border-slate-600 hover:border-slate-400 bg-slate-800/40",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {file ? (
          <div className="space-y-1">
            <p className="text-emerald-400 font-medium">{file.name}</p>
            <p className="text-slate-400 text-xs">{(file.size / 1024).toFixed(0)} KB — click to change</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-4xl">📚</div>
            <p className="text-slate-300 font-medium">Drop your CSV here, or click to browse</p>
            <p className="text-slate-500 text-xs">goodreads_library_export.csv</p>
          </div>
        )}
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={!file || loading}
        className={[
          "w-full rounded-lg py-3 font-semibold text-white transition-all flex items-center justify-center gap-2",
          !file || loading
            ? "cursor-not-allowed bg-blue-700 opacity-50"
            : "bg-blue-600 hover:bg-blue-500 active:scale-[0.99]",
        ].join(" ")}
      >
        {loading ? (
          <>
            <Spinner />
            Importing…
          </>
        ) : (
          "Import Library"
        )}
      </button>
    </div>
  );
}

// ── Step 2: Enrich ─────────────────────────────────────────────────────────────

function EnrichStep({
  ingestResult,
  onDone,
}: {
  ingestResult: IngestResult;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnrich() {
    setLoading(true);
    setError(null);
    try {
      await api.runEnrich();
      await mutate("stats", api.stats(), { revalidate: false });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enrichment failed.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">Enrich your library</h2>
        <p className="text-slate-400 text-sm">
          Imported <strong className="text-slate-300">{ingestResult.inserted}</strong> books
          {ingestResult.skipped > 0 && (
            <span> ({ingestResult.skipped} already existed)</span>
          )}
          . Enrichment fetches covers, page counts, and genres from Open Library and Google
          Books. It takes <strong className="text-slate-300">1–3 minutes</strong> for a typical
          library and is required before recommendations can run.
        </p>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-sm text-slate-400 space-y-2">
        <p>✅ Finds book covers and metadata from public catalogs</p>
        <p>✅ Required before running AI recommendations</p>
        <p>⏱ Resumable — if interrupted, re-runs pick up where they left off</p>
      </div>

      {loading && (
        <div className="rounded-xl border border-blue-700/40 bg-blue-900/20 p-4 text-sm text-blue-300 flex items-start gap-3">
          <Spinner className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Fetching metadata from Open Library and Google Books… this can take a couple
            minutes. Hang tight.
          </span>
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        onClick={handleEnrich}
        disabled={loading}
        className={[
          "w-full rounded-lg py-3 font-semibold text-white transition-all flex items-center justify-center gap-2",
          loading
            ? "cursor-not-allowed bg-blue-700 opacity-60"
            : "bg-blue-600 hover:bg-blue-500 active:scale-[0.99]",
        ].join(" ")}
      >
        {loading ? (
          <>
            <Spinner />
            Enriching…
          </>
        ) : (
          "Enrich Now"
        )}
      </button>
    </div>
  );
}

// ── Step 3: Done ───────────────────────────────────────────────────────────────

function DoneStep({ enriched }: { enriched: boolean }) {
  const router = useRouter();

  return (
    <div className="space-y-6 text-center">
      <div className="text-6xl">🎉</div>
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">You're all set!</h2>
        <p className="text-slate-400 text-sm">
          {enriched
            ? "Your library is imported and enriched. Head to the dashboard to run your first AI recommendations."
            : "Your library is imported. Run enrichment later from the dashboard before requesting recommendations."}
        </p>
      </div>

      {!enriched && (
        <div className="rounded-xl border border-amber-700/40 bg-amber-900/10 p-4 text-sm text-amber-300 text-left">
          ⚠️ Recommendations need enrichment first. Run it via the CLI (<code className="text-amber-200">python -m mylibrary.cli enrich</code>) or come back here.
        </div>
      )}

      <button
        onClick={() => router.push("/")}
        className="w-full rounded-lg py-3 font-semibold text-white bg-blue-600 hover:bg-blue-500 active:scale-[0.99] transition-all"
      >
        Go to Dashboard →
      </button>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function SetupPage() {
  const [step, setStep] = useState<Step>("upload");
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [enriched, setEnriched] = useState(false);

  return (
    <div className="fade-in min-h-[60vh] flex flex-col items-center justify-center py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-white">Welcome to MyLibrary</h1>
          <p className="mt-1 text-slate-400">Let's get your reading history imported.</p>
        </div>

        <StepIndicator current={step} />

        {/* Card */}
        <div className="rounded-2xl border border-slate-700 bg-[#1a1f2e] p-6">
          {step === "upload" && (
            <UploadStep
              onDone={(result) => {
                setIngestResult(result);
                setStep("enrich");
              }}
            />
          )}
          {step === "enrich" && ingestResult && (
            <EnrichStep
              ingestResult={ingestResult}
              onDone={() => {
                setEnriched(true);
                setStep("done");
              }}
            />
          )}
          {step === "done" && <DoneStep enriched={enriched} />}
        </div>
      </div>
    </div>
  );
}
