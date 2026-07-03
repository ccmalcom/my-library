'use client';

import { useRef, useState } from 'react';
import { mutate } from 'swr';
import { BookOpen } from 'lucide-react';
import { api, type ImportPreview, type ImportSummary, type MappingField } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';

const MAPPING_FIELDS: { field: MappingField; label: string; required?: boolean }[] = [
  { field: 'title', label: 'Title', required: true },
  { field: 'author', label: 'Author' },
  { field: 'isbn13', label: 'ISBN' },
  { field: 'rating', label: 'Rating' },
  { field: 'review', label: 'Review' },
  { field: 'shelf', label: 'Shelf / status' },
  { field: 'date_read', label: 'Date read' },
];

const FORMAT_LABEL: Record<string, string> = {
  goodreads: 'Goodreads',
  storygraph: 'The StoryGraph',
  canonical: 'MyLibrary backup',
  unknown: 'Custom CSV',
};

const selectClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'focus:border-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

export default function ImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (summary: ImportSummary) => void;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<MappingField, string>>(
    {} as Record<MappingField, string>
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(f: File | null | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setError('Please choose a .csv file.');
      return;
    }
    setError(null);
    setFile(f);
    setBusy(true);
    try {
      const p = await api.importPreview(f);
      setPreview(p);
      const seed = {} as Record<MappingField, string>;
      (Object.keys(p.suggested_mapping) as MappingField[]).forEach((k) => {
        seed[k] = p.suggested_mapping[k] ?? '';
      });
      setMapping(seed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const needsMapping = preview?.format === 'unknown';
  const canImport = preview !== null && (!needsMapping || !!mapping.title);

  async function handleImport() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const opts = needsMapping
        ? {
            format: 'generic',
            mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) as Record<
              string,
              string
            >,
          }
        : { format: preview.format };
      const summary = await api.importLibrary(file, opts);
      await mutate('stats', api.stats(), { revalidate: false });
      toast.success(`Imported ${summary.inserted} new, updated ${summary.updated}.`);
      onImported(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
      setBusy(false);
    }
  }

  return (
    <Modal
      labelId="import-title"
      onClose={onClose}
      className="fade-in flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface p-6 shadow-2xl"
    >
      <h2 id="import-title" className="mb-1 font-display text-lg font-bold text-text">
        Import books
      </h2>
      <p className="mb-4 text-sm text-muted">
        Goodreads, StoryGraph, a MyLibrary backup, or any CSV from another app.
      </p>

      {!preview && (
        <label
          htmlFor="import-file"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFile(e.dataTransfer.files[0]);
          }}
          className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-elevated/40 p-8 text-center transition-colors hover:border-muted"
        >
          <input
            id="import-file"
            ref={inputRef}
            type="file"
            accept=".csv"
            className="sr-only"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <BookOpen className="mx-auto mb-2 h-10 w-10 text-faint" />
          <p className="font-medium text-text">Drop a CSV here, or click to browse</p>
          <p className="mt-1 text-xs text-faint">StoryGraph, Calibre, LibraryThing, ...</p>
        </label>
      )}

      {preview && (
        <div className="flex-1 overflow-y-auto">
          <p className="mb-3 text-sm text-muted">
            Detected: <span className="font-medium text-text">{FORMAT_LABEL[preview.format]}</span>
            {' - '}
            {preview.headers.length} columns.
          </p>

          {needsMapping && (
            <div className="space-y-3">
              <p className="text-xs text-faint">
                We could not recognize this format. Match your columns to the fields below.
              </p>
              {MAPPING_FIELDS.map(({ field, label, required }) => (
                <div key={field} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-sm text-muted">
                    {label}
                    {required ? ' *' : ''}
                  </span>
                  <select
                    value={mapping[field] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                    className={selectClass}
                  >
                    <option value="">- none -</option>
                    {preview.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {preview && (
          <Button onClick={handleImport} loading={busy} disabled={!canImport || busy}>
            {busy ? 'Importing...' : 'Import'}
          </Button>
        )}
      </div>
    </Modal>
  );
}
