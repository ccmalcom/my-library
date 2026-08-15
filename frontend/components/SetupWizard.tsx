'use client';

import { useRef, useState, useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { mutate } from 'swr';
import {
  api,
  API_KEY_STATUS_KEY,
  PROFILE_STATUS_KEY,
  USER_PROFILE_KEY,
  type Book,
} from '@/lib/api';
import { Button, Field, Input, Spinner, StarRating } from '@/components/ui';
import AddBookModal from '@/components/AddBookModal';
import RevealSequence from '@/components/reveal/RevealSequence';
import { useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';

type Step = 'name' | 'api-key' | 'upload' | 'enrich' | 'manual' | 'profile' | 'done';

interface IngestResult {
  inserted: number;
  skipped: number;
  total: number;
}

const CSV_STEPS: { key: Step; label: string }[] = [
  { key: 'name', label: 'Your name' },
  { key: 'api-key', label: 'API key' },
  { key: 'upload', label: 'Upload' },
  { key: 'enrich', label: 'Enrich' },
  { key: 'profile', label: 'Profile' },
  { key: 'done', label: 'Done' },
];
const MANUAL_STEPS: { key: Step; label: string }[] = [
  { key: 'name', label: 'Your name' },
  { key: 'api-key', label: 'API key' },
  { key: 'manual', label: 'Add books' },
  { key: 'profile', label: 'Profile' },
  { key: 'done', label: 'Done' },
];

// ── Step indicator ─────────────────────────────────────────────────────────────

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
    <div className="mb-8 flex flex-wrap items-center gap-2">
      {steps.map(({ key, label }, i) => {
        const done = order.indexOf(key) < currentIdx;
        const active = key === current;
        return (
          <div key={key} className="flex items-center gap-2">
            <div
              className={[
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors',
                done
                  ? 'bg-success text-base'
                  : active
                    ? 'bg-accent text-base'
                    : 'bg-elevated text-faint',
              ].join(' ')}
            >
              {done ? '✓' : i + 1}
            </div>
            <span
              className={[
                'text-sm',
                active ? 'font-medium text-text' : done ? 'text-success' : 'text-faint',
              ].join(' ')}
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <div className={['mx-1 h-px w-8', done ? 'bg-success' : 'bg-border'].join(' ')} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step: Name ────────────────────────────────────────────────────────────────

function NameStep({ onDone }: { onDone: () => void }) {
  const [checking, setChecking] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getProfile()
      .then((profile) => {
        if (profile.display_name) onDone();
        else setChecking(false);
      })
      .catch(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await api.setProfile(trimmed);
      await mutate(USER_PROFILE_KEY);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
      setSaving(false);
    }
  }

  if (checking) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-text">What should we call you?</h2>
        <p className="text-sm text-muted">Just for the greeting. Change it anytime in settings.</p>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <Field label="Your name" error={error ?? undefined}>
            {(p) => (
              <Input
                {...p}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder="e.g. Alex"
                autoFocus
              />
            )}
          </Field>
        </div>
        <Button
          type="submit"
          size="lg"
          loading={saving}
          disabled={saving || !name.trim()}
          className="w-full"
        >
          {saving ? 'Saving\u2026' : 'Continue'}
        </Button>
      </form>
    </div>
  );
}

// ── Step: API Key ─────────────────────────────────────────────────────────────

function ApiKeyStep({ onDone }: { onDone: () => void }) {
  const [checking, setChecking] = useState(true);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .apiKeyStatus()
      .then((status) => {
        if (status.configured) onDone();
        else setChecking(false);
      })
      .catch(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.setApiKey(key.trim());
      await mutate(API_KEY_STATUS_KEY);
      setKey('');
      setSaved(true);
      setTimeout(onDone, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key.');
      setSaving(false);
    }
  }

  if (checking) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-text">Add your Anthropic API key</h2>
        <p className="text-sm text-muted">
          ShelfSprite runs on Claude. It reads your ratings to build a taste profile and find your
          next books, and that takes an API key.
        </p>
      </div>

      <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning space-y-1">
        <p>Without a key, ShelfSprite can shelve your books but can&apos;t think about them.</p>
        <p>
          Get one at{' '}
          <a
            href="https://console.anthropic.com/"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            console.anthropic.com
          </a>
          .
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <Field
            label="API key"
            hint="Encrypted on the server, never shown again. Manage it in settings."
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setSaved(false);
                }}
                placeholder="sk-ant-..."
                autoComplete="off"
                className="font-mono"
              />
            )}
          </Field>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        {saved && <p className="text-sm text-success">Key saved. Moving on...</p>}
        <Button
          type="submit"
          size="lg"
          loading={saving}
          disabled={saving || !key.trim() || saved}
          className="w-full"
        >
          {saving ? 'Saving\u2026' : 'Save key & continue'}
        </Button>
      </form>
    </div>
  );
}

// ── Step: Upload ──────────────────────────────────────────────────────────────

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
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setError(
        "That's not a .csv. Export one from Goodreads (My Books \u203A Import/Export) or The " +
          'StoryGraph and try again.'
      );
      return;
    }
    setFile(f);
    setError(null);
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.importLibrary(file, { format: 'auto' });
      await mutate('stats', api.stats(), { revalidate: false });
      onDone(result as unknown as IngestResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      setError(
        msg.includes('422')
          ? "We couldn't read that format. Finish setup, then use Settings \u2192 Import to map the columns yourself."
          : msg
      );
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-text">Import your library</h2>
        <p className="text-sm text-muted">
          Export a CSV from Goodreads (My Books &rsaquo; Import/Export) or The StoryGraph (Manage
          Account &rsaquo; Export), then drop it here.
        </p>
      </div>

      {/* Drop zone — <label> so the whole area activates the file input */}
      <label
        htmlFor="csv-upload"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFile(e.dataTransfer.files[0]);
        }}
        className={[
          'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 sm:p-10 text-center transition-colors',
          file ? 'border-success bg-success/5' : 'border-border hover:border-muted bg-elevated/40',
        ].join(' ')}
      >
        <input
          id="csv-upload"
          ref={inputRef}
          type="file"
          accept=".csv"
          className="sr-only"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {file ? (
          <div className="space-y-1">
            <p className="font-medium text-success">{file.name}</p>
            <p className="text-xs text-faint">
              {(file.size / 1024).toFixed(0)} KB, click to change
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <BookOpen className="mx-auto h-10 w-10 text-faint" />
            <p className="font-medium text-text">Drop your CSV here, or click to browse</p>
            <p className="text-xs text-faint">goodreads_library_export.csv</p>
          </div>
        )}
      </label>

      {error && <p className="text-sm text-danger">{error}</p>}

      <form onSubmit={handleSubmit}>
        <Button
          type="submit"
          size="lg"
          loading={loading}
          disabled={!file || loading}
          className="w-full"
        >
          {loading ? 'Importing\u2026' : 'Import library'}
        </Button>
      </form>

      <p className="text-center text-xs text-faint">
        No Goodreads or StoryGraph history?{' '}
        <a href="/shelfsprite-template.csv" download className="text-accent hover:underline">
          Download a CSV template
        </a>
        , fill in the books you remember, and drop it in above.
      </p>

      <div className="flex items-center gap-3 text-xs text-faint">
        <div className="h-px flex-1 bg-border" />
        or
        <div className="h-px flex-1 bg-border" />
      </div>

      <button
        type="button"
        onClick={onManual}
        className={[
          'w-full rounded-lg border border-border py-3 text-sm font-medium text-muted transition',
          'hover:border-muted hover:text-text',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
        ].join(' ')}
      >
        No export? Add books by hand
      </button>
    </div>
  );
}

// ── Step: Manual ──────────────────────────────────────────────────────────────

function ManualStep({ onDone }: { onDone: () => void }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [adding, setAdding] = useState(false);
  const [finishing, setFinishing] = useState(false);

  async function handleFinish() {
    setFinishing(true);
    await mutate('stats', api.stats(), { revalidate: false });
    onDone();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-text">Build your starter library</h2>
        <p className="text-sm text-muted">
          Add a handful of books you&apos;ve read and rate them. Five or six favorites are enough to
          start reading you. Add the rest whenever.
        </p>
      </div>

      {books.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-elevated/40 p-8 text-center">
          <BookOpen className="mb-2 h-8 w-8 text-faint" />
          <p className="text-sm text-muted">
            Empty shelf. Add the first book, the one you&apos;d make everyone read.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {books.map((b) => (
            <li
              key={b.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-base p-2.5"
            >
              <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded bg-elevated">
                {b.cover_url ? (
                  <Image src={b.cover_url} alt="" fill className="object-cover" unoptimized />
                ) : (
                  <div className="flex h-full items-center justify-center text-faint">
                    <BookOpen className="h-4 w-4" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{b.title}</p>
                <p className="truncate text-xs text-faint">{b.author ?? 'Unknown author'}</p>
              </div>
              {b.effective_rating ? (
                <span className="shrink-0">
                  {/* Not '\u2605'.repeat(rating): repeat() truncates its count, so a
                      4.5 rendered four stars while aria-label said "4.5". */}
                  <StarRating value={b.effective_rating} readOnly size={14} />
                </span>
              ) : (
                <span className="shrink-0 text-xs text-faint">unrated</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <Button variant="secondary" className="w-full" onClick={() => setAdding(true)}>
        + Add a book
      </Button>

      <Button
        size="lg"
        loading={finishing}
        disabled={books.length === 0 || finishing}
        className="w-full"
        onClick={handleFinish}
      >
        {books.length === 0
          ? 'Add at least one book to continue'
          : `Finish with ${books.length} book${books.length !== 1 ? 's' : ''}`}
      </Button>

      {adding && (
        <AddBookModal
          onClose={() => setAdding(false)}
          onAdded={(book) => {
            setBooks((prev) => [...prev, book]);
          }}
        />
      )}
    </div>
  );
}

// ── Step: Enrich ──────────────────────────────────────────────────────────────

const ENRICH_POLL_MS = 2000;

function EnrichStep({ ingestResult, onDone }: { ingestResult: IngestResult; onDone: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  async function pollStatus(id: string) {
    try {
      const job = await api.enrichStatus(id);
      setStatus(job.status);
      setProgress(job.progress);
      setTotal(job.total);
      if (job.status === 'done') {
        await mutate('stats', api.stats(), { revalidate: false });
        onDone();
      } else if (job.status === 'error') {
        setError(job.error ?? 'Enrichment failed.');
      } else {
        pollRef.current = setTimeout(() => void pollStatus(id), ENRICH_POLL_MS);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check job status.');
    }
  }

  async function handleEnrich() {
    setError(null);
    setProgress(0);
    setTotal(0);
    try {
      const job = await api.enrichStart();
      setJobId(job.job_id);
      setStatus(job.status);
      pollRef.current = setTimeout(() => void pollStatus(job.job_id), ENRICH_POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start enrichment.');
    }
  }

  const running = status === 'pending' || status === 'running';
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const progressLabel = total > 0 ? `${progress} / ${total} books (${pct}%)` : 'Starting\u2026';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-text">Enrich your library</h2>
        <p className="text-sm text-muted">
          <strong className="text-text">{ingestResult.inserted}</strong> books in
          {ingestResult.skipped > 0 && ` (${ingestResult.skipped} already existed)`}. Now we fetch
          what the CSV left out (covers, page counts, genres) from Open Library and Google Books.
          About <strong className="text-text">5–10 minutes</strong> for a typical library.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted space-y-1.5">
        <p>Pulls covers and metadata from public catalogs</p>
        <p>Recommendations need this done first</p>
        <p>Safe to interrupt; it resumes where it stopped</p>
      </div>

      {running && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-xl border border-accent/30 bg-accent-quiet p-4 text-sm text-accent">
            <Spinner size="sm" className="mt-0.5 shrink-0" />
            <span>
              {status === 'pending'
                ? 'Queued. Starting shortly\u2026'
                : 'Fetching covers and metadata from the public catalogs\u2026'}
            </span>
          </div>
          {total > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted">
                <span>{progressLabel}</span>
                <span>{pct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-elevated">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      {!running && !jobId && (
        <Button size="lg" className="w-full" onClick={() => void handleEnrich()}>
          Enrich now
        </Button>
      )}

      {error && jobId && (
        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            setJobId(null);
            setStatus('idle');
            setError(null);
            void handleEnrich();
          }}
        >
          Retry enrichment
        </Button>
      )}
    </div>
  );
}

// ── Step: Profile ─────────────────────────────────────────────────────────────

function ProfileStep({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleProfile() {
    setLoading(true);
    setError(null);
    try {
      await api.runProfile();
      await Promise.all([
        mutate('profile', api.profile(), { revalidate: false }),
        mutate(PROFILE_STATUS_KEY, api.profileStatus(), { revalidate: false }),
      ]);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Profile build failed.');
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-text">Build your taste profile</h2>
        <p className="text-sm text-muted">
          This is the good part: Claude reads every rating and review you just imported and works
          out what you actually like. 30–60 seconds.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-elevated p-4 text-sm text-muted space-y-1.5">
        <p>Creates your initial taste traits from your library</p>
        <p>Required before running recommendations</p>
        <p>Uses your configured Anthropic API key</p>
      </div>

      {loading && (
        <div className="flex items-start gap-3 rounded-xl border border-accent/30 bg-accent-quiet p-4 text-sm text-accent">
          <Spinner size="sm" className="mt-0.5 shrink-0" />
          <span>Reading between your ratings…</span>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <Button
        size="lg"
        loading={loading}
        disabled={loading}
        className="w-full"
        onClick={handleProfile}
      >
        {loading ? 'Building profile\u2026' : 'Build my profile'}
      </Button>
    </div>
  );
}

// ── Step: Done ────────────────────────────────────────────────────────────────

function DoneStep({ profiled, onComplete }: { profiled: boolean; onComplete?: () => void }) {
  const router = useRouter();
  const { fire, modal } = useFeedbackPrompt('post-setup');
  const [revealOpen, setRevealOpen] = useState(false);

  useEffect(() => {
    fire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goHome() {
    onComplete?.();
    router.push('/');
  }

  function goRecommend() {
    onComplete?.();
    router.push('/swipe');
  }

  if (revealOpen) {
    return <RevealSequence onClose={goHome} onFinish={goRecommend} />;
  }

  return (
    <>
      <div className="space-y-6 text-center">
        <div>
          <h2 className="mb-2 text-2xl font-bold text-text">Your library is in.</h2>
          <p className="text-sm text-muted">
            {profiled
              ? 'Books shelved, taste profiled. Now let us show you what we found.'
              : 'Books are shelved. Build your taste profile next; recommendations need it.'}
          </p>
        </div>

        {!profiled && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning text-left">
            Recommendations need a taste profile first. Go to My profile to build it.
          </div>
        )}

        {profiled ? (
          <Button size="lg" className="w-full" onClick={() => setRevealOpen(true)}>
            Show me what you found
          </Button>
        ) : (
          <Button size="lg" className="w-full" onClick={goHome}>
            Take me home
          </Button>
        )}
      </div>
      {modal}
    </>
  );
}

// ── Wizard ────────────────────────────────────────────────────────────────────

export default function SetupWizard({ onComplete }: { onComplete?: () => void }) {
  const [step, setStep] = useState<Step>('name');
  const [path, setPath] = useState<'csv' | 'manual'>('csv');
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [profiled, setProfiled] = useState(false);

  const rail = path === 'manual' ? MANUAL_STEPS : CSV_STEPS;

  return (
    <div className="fade-in flex min-h-[60vh] flex-col items-center justify-center py-6 sm:py-12">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <h1 className="font-display text-3xl font-bold tracking-tight text-text">
            Welcome to ShelfSprite
          </h1>
          <p className="mt-1 text-sm text-muted">
            {step === 'name' || step === 'api-key'
              ? 'Five minutes, and it starts knowing your taste.'
              : path === 'manual'
                ? "Let's build your starter library."
                : "Let's get your reading history imported."}
          </p>
        </div>

        <StepIndicator current={step} steps={rail} />

        <div className="rounded-2xl border border-border bg-surface p-6">
          {step === 'name' && <NameStep onDone={() => setStep('api-key')} />}
          {step === 'api-key' && <ApiKeyStep onDone={() => setStep('upload')} />}
          {step === 'upload' && (
            <UploadStep
              onDone={(result) => {
                setIngestResult(result);
                setStep('enrich');
              }}
              onManual={() => {
                setPath('manual');
                setStep('manual');
              }}
            />
          )}
          {step === 'enrich' && ingestResult && (
            <EnrichStep ingestResult={ingestResult} onDone={() => setStep('profile')} />
          )}
          {step === 'manual' && <ManualStep onDone={() => setStep('profile')} />}
          {step === 'profile' && (
            <ProfileStep
              onDone={() => {
                setProfiled(true);
                setStep('done');
              }}
            />
          )}
          {step === 'done' && <DoneStep profiled={profiled} onComplete={onComplete} />}
        </div>
      </div>
    </div>
  );
}
