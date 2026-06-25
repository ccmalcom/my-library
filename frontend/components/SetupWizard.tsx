"use client";

import { useRef, useState, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { api, API_KEY_STATUS_KEY, PROFILE_STATUS_KEY, type Book } from "@/lib/api";
import AddBookModal from "@/components/AddBookModal";

// The onboarding wizard. Rendered both at the standalone /setup route and INLINE by
// <LibraryGate> on /, /swipe, /library when the logged-in user has no library yet. When the
// gate renders it, it passes `onComplete` so the final step can hand control back to the page
// (swap the wizard out for the real dashboard) instead of relying on a route change.

// ── Types ──────────────────────────────────────────────────────────────────────

type Step = "api-key" | "upload" | "enrich" | "manual" | "profile" | "done";

interface IngestResult {
  inserted: number;
  skipped: number;
  total: number;
}

// The two onboarding paths show different step rails.
const CSV_STEPS: { key: Step; label: string }[] = [
  { key: "api-key", label: "API Key" },
  { key: "upload", label: "Upload" },
  { key: "enrich", label: "Enrich" },
  { key: "profile", label: "Profile" },
  { key: "done", label: "Done" },
];
const MANUAL_STEPS: { key: Step; label: string }[] = [
  { key: "api-key", label: "API Key" },
  { key: "manual", label: "Add books" },
  { key: "profile", label: "Profile" },
  { key: "done", label: "Done" },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function StepIndicator({
  current,
  steps,
}: {
  current: Step;
  steps: { key: Step; label: string }[];
}) {
  const order = steps.map((s) => s.key);
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

// ── Step 0: API Key ────────────────────────────────────────────────────────────

function ApiKeyStep({ onDone }: { onDone: () => void }) {
  const [checking, setChecking] = useState(true);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount: if a key is already configured, skip this step immediately.
  useEffect(() => {
    api.apiKeyStatus().then((status) => {
      if (status.configured) {
        onDone();
      } else {
        setChecking(false);
      }
    }).catch(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.setApiKey(key.trim());
      await mutate(API_KEY_STATUS_KEY);
      setKey("");
      setSaved(true);
      setTimeout(onDone, 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save key.");
      setSaving(false);
    }
  }

  if (checking) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner className="h-6 w-6 text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">Add your Anthropic API key</h2>
        <p className="text-slate-400 text-sm">
          MyLibrary uses Claude to build your taste profile and generate recommendations.
          An API key is required before you can complete setup.
        </p>
      </div>

      <div className="rounded-xl border border-amber-700/40 bg-amber-900/10 p-4 text-sm text-amber-300 space-y-1">
        <p>⚠️ Profile and recommendations won&apos;t work without a key.</p>
        <p>
          Get one free at{" "}
          <a
            href="https://console.anthropic.com/"
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            console.anthropic.com
          </a>
          .
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
          API key
        </label>
        <input
          type="password"
          value={key}
          onChange={(e) => { setKey(e.target.value); setSaved(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder="sk-ant-…"
          autoComplete="off"
          className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 font-mono text-sm text-slate-200 placeholder-slate-600 focus:border-blue-600 focus:outline-none"
        />
        <p className="text-xs text-slate-500">
          Stored encrypted on the server and never shown again. You can manage it later in Settings.
        </p>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {saved && <p className="text-emerald-400 text-sm">✓ Key saved — continuing…</p>}

      <button
        onClick={handleSave}
        disabled={saving || !key.trim() || saved}
        className={[
          "w-full rounded-lg py-3 font-semibold text-white transition-all flex items-center justify-center gap-2",
          saving || !key.trim() || saved
            ? "cursor-not-allowed bg-blue-700 opacity-50"
            : "bg-blue-600 hover:bg-blue-500 active:scale-[0.99]",
        ].join(" ")}
      >
        {saving ? <><Spinner />Saving…</> : "Save key & continue"}
      </button>
    </div>
  );
}

// ── Step 1: Upload ─────────────────────────────────────────────────────────────

function UploadStep({
  onDone,
  onManual,
}: {
  onDone: (result: IngestResult) => void;
  onManual: () => void;
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

      <div className="flex items-center gap-3 text-xs text-slate-600">
        <div className="h-px flex-1 bg-slate-700" />
        or
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      <button
        type="button"
        onClick={onManual}
        className="w-full rounded-lg border border-slate-700 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
      >
        I don&apos;t have a Goodreads export — add books manually
      </button>
    </div>
  );
}

// ── Manual setup (no CSV) ──────────────────────────────────────────────────────

function ManualStep({ onDone }: { onDone: () => void }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [adding, setAdding] = useState(false);
  const [finishing, setFinishing] = useState(false);

  async function handleFinish() {
    setFinishing(true);
    // Seed fresh stats into the SWR cache (data passed explicitly, not a bare
    // revalidate) so the dashboard sees total > 0 and doesn't bounce back to /setup.
    await mutate("stats", api.stats(), { revalidate: false });
    onDone();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-white">Build your starter library</h2>
        <p className="text-sm text-slate-400">
          Add a few books you&apos;ve read and rate them. Even five or six rated favorites give
          the taste profile enough to work with — you can always add more later.
        </p>
      </div>

      {books.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-600 bg-slate-800/40 p-8 text-center">
          <div className="mb-2 text-4xl">📚</div>
          <p className="text-sm text-slate-400">No books yet. Add your first one to get started.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {books.map((b) => (
            <li
              key={b.id}
              className="flex items-center gap-3 rounded-lg border border-slate-700 bg-[#0f1117] p-2.5"
            >
              <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded bg-slate-800">
                {b.cover_url ? (
                  <Image src={b.cover_url} alt="" fill className="object-cover" unoptimized />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-600">📚</div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-200">{b.title}</p>
                <p className="truncate text-xs text-slate-500">{b.author ?? "Unknown author"}</p>
              </div>
              {b.effective_rating ? (
                <span className="shrink-0 text-sm text-amber-400">
                  {"★".repeat(b.effective_rating)}
                </span>
              ) : (
                <span className="shrink-0 text-xs text-slate-600">unrated</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setAdding(true)}
        className="w-full rounded-lg border border-blue-700 bg-blue-900/30 py-2.5 text-sm font-semibold text-blue-200 transition hover:bg-blue-900/60"
      >
        + Add a book
      </button>

      <button
        type="button"
        onClick={handleFinish}
        disabled={books.length === 0 || finishing}
        className={[
          "flex w-full items-center justify-center gap-2 rounded-lg py-3 font-semibold text-white transition-all",
          books.length === 0 || finishing
            ? "cursor-not-allowed bg-blue-700 opacity-50"
            : "bg-blue-600 hover:bg-blue-500 active:scale-[0.99]",
        ].join(" ")}
      >
        {finishing ? <Spinner /> : null}
        {books.length === 0
          ? "Add at least one book to continue"
          : `Finish with ${books.length} book${books.length !== 1 ? "s" : ""}`}
      </button>

      {adding && (
        <AddBookModal
          onClose={() => setAdding(false)}
          onAdded={(book) => {
            setBooks((prev) => [...prev, book]);
            setAdding(false);
          }}
        />
      )}
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

// ── Step 3: Profile ────────────────────────────────────────────────────────────

function ProfileStep({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleProfile() {
    setLoading(true);
    setError(null);
    try {
      await api.runProfile();
      await Promise.all([
        mutate("profile", api.profile(), { revalidate: false }),
        mutate(PROFILE_STATUS_KEY, api.profileStatus(), { revalidate: false }),
      ]);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Profile build failed.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-white">Build your taste profile</h2>
        <p className="text-sm text-slate-400">
          This analyzes your rated books to create the taste traits that power
          recommendations. It usually takes around 30–60 seconds.
        </p>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-sm text-slate-400 space-y-2">
        <p>✅ Creates your initial taste traits from your library</p>
        <p>✅ Required before running recommendations</p>
        <p>⏱ Uses your configured Anthropic API key</p>
      </div>

      {loading && (
        <div className="rounded-xl border border-blue-700/40 bg-blue-900/20 p-4 text-sm text-blue-300 flex items-start gap-3">
          <Spinner className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Analyzing your ratings and building your profile…</span>
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        onClick={handleProfile}
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
            Building profile…
          </>
        ) : (
          "Build Profile"
        )}
      </button>
    </div>
  );
}

// ── Step 4: Done ───────────────────────────────────────────────────────────────

function DoneStep({ profiled, onComplete }: { profiled: boolean; onComplete?: () => void }) {
  const router = useRouter();

  // Inline (gate) mode: hand control back to the page so it swaps the wizard out for the
  // dashboard. Standalone /setup route: just navigate home as before. Do both — harmless.
  function handleFinish() {
    onComplete?.();
    router.push("/");
  }

  return (
    <div className="space-y-6 text-center">
      <div className="text-6xl">🎉</div>
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">You're all set!</h2>
        <p className="text-slate-400 text-sm">
          {profiled
            ? "Your library is ready and your taste profile is built. Head to the dashboard to run your first AI recommendations."
            : "Your library is ready. Build your taste profile before requesting recommendations."}
        </p>
      </div>

      {!profiled && (
        <div className="rounded-xl border border-amber-700/40 bg-amber-900/10 p-4 text-sm text-amber-300 text-left">
          ⚠️ Recommendations need a taste profile first. Build it via the CLI (<code className="text-amber-200">python -m mylibrary.cli profile</code>) or come back here.
        </div>
      )}

      <button
        onClick={handleFinish}
        className="w-full rounded-lg py-3 font-semibold text-white bg-blue-600 hover:bg-blue-500 active:scale-[0.99] transition-all"
      >
        Go to Dashboard →
      </button>
    </div>
  );
}

// ── Wizard ───────────────────────────────────────────────────────────────────────

export default function SetupWizard({ onComplete }: { onComplete?: () => void }) {
  const [step, setStep] = useState<Step>("api-key");
  const [path, setPath] = useState<"csv" | "manual">("csv");
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [profiled, setProfiled] = useState(false);

  const rail = path === "manual" ? MANUAL_STEPS : CSV_STEPS;

  return (
    <div className="fade-in min-h-[60vh] flex flex-col items-center justify-center py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-white">Welcome to MyLibrary</h1>
          <p className="mt-1 text-slate-400">
            {step === "api-key"
              ? "A few quick steps to get you started."
              : path === "manual"
              ? "Let's build your starter library."
              : "Let's get your reading history imported."}
          </p>
        </div>

        <StepIndicator current={step} steps={rail} />

        {/* Card */}
        <div className="rounded-2xl border border-slate-700 bg-[#1a1f2e] p-6">
          {step === "api-key" && (
            <ApiKeyStep
              onDone={() => setStep("upload")}
            />
          )}
          {step === "upload" && (
            <UploadStep
              onDone={(result) => {
                setIngestResult(result);
                setStep("enrich");
              }}
              onManual={() => {
                setPath("manual");
                setStep("manual");
              }}
            />
          )}
          {step === "enrich" && ingestResult && (
            <EnrichStep
              ingestResult={ingestResult}
              onDone={() => {
                setStep("profile");
              }}
            />
          )}
          {step === "manual" && (
            <ManualStep
              onDone={() => {
                setStep("profile");
              }}
            />
          )}
          {step === "profile" && (
            <ProfileStep
              onDone={() => {
                setProfiled(true);
                setStep("done");
              }}
            />
          )}
          {step === "done" && <DoneStep profiled={profiled} onComplete={onComplete} />}
        </div>
      </div>
    </div>
  );
}
