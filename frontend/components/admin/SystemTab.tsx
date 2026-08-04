'use client';

import useSWR from 'swr';
import { useEffect, useState } from 'react';
import {
  getAdminConfig,
  putAdminConfig,
  pingBackend,
  ADMIN_CONFIG_KEY,
} from '@/lib/api';
import {
  getBackendChoice,
  setBackendChoice,
  pythonBase,
  type BackendChoice,
} from '@/lib/backend';
import { Badge, Button, Card, Spinner, useToast } from '@/components/ui';

const CHOICES: { value: BackendChoice; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Per-route defaults (migration waves flip groups)' },
  { value: 'python', label: 'Python', hint: 'Force everything to the Railway backend' },
  { value: 'node', label: 'Node', hint: 'Force everything to same-origin /api' },
];

export function SystemTab() {
  const toast = useToast();
  // Lazy initializer, not an effect: this tab only ever mounts after the user
  // clicks it (default tab is 'users'), so it's never part of the initial
  // SSR/hydration pass — reading localStorage here can't cause a mismatch.
  const [choice, setChoice] = useState<BackendChoice>(() => getBackendChoice());
  const [health, setHealth] = useState<{ python: boolean | null; node: boolean | null }>({
    python: null,
    node: null,
  });
  const {
    data: config,
    error: configError,
    mutate,
    isLoading,
  } = useSWR(ADMIN_CONFIG_KEY, getAdminConfig);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void pingBackend(pythonBase(), '/healthz').then((ok) =>
      setHealth((h) => ({ ...h, python: ok }))
    );
    void pingBackend('', '/api/healthz').then((ok) => setHealth((h) => ({ ...h, node: ok })));
  }, []);

  function pickBackend(next: BackendChoice) {
    setBackendChoice(next);
    setChoice(next);
    toast.success(`Backend set to ${next} (this browser).`);
  }

  async function toggleDebug() {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await putAdminConfig(!config.debug_mode);
      await mutate(updated, { revalidate: false });
      toast.success(`Debug mode ${updated.debug_mode ? 'on' : 'off'}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update debug mode.');
    } finally {
      setSaving(false);
    }
  }

  function healthBadge(state: boolean | null) {
    if (state === null) return <Badge variant="default">checking…</Badge>;
    return state ? <Badge variant="success">up</Badge> : <Badge variant="danger">down</Badge>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold text-text">Backends</h2>
        <p className="mb-4 text-sm text-muted">
          Which backend this browser talks to during the migration.
        </p>
        <div className="mb-4 flex items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            Python (Railway) {healthBadge(health.python)}
          </span>
          <span className="flex items-center gap-2">Node (/api) {healthBadge(health.node)}</span>
        </div>
        <div className="space-y-2">
          {CHOICES.map((c) => (
            <label key={c.value} className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="radio"
                name="backend"
                checked={choice === c.value}
                onChange={() => pickBackend(c.value)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-text">{c.label}</span>
                <span className="block text-xs text-muted">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold text-text">Debug mode</h2>
        <p className="mb-4 text-sm text-muted">
          Verbose structured logs and Server-Timing headers on the Node backend. Off = quiet
          standard logs.
        </p>
        {configError ? (
          <p className="text-sm text-danger">
            Couldn&apos;t load debug mode: {configError instanceof Error ? configError.message : 'request failed'}
          </p>
        ) : isLoading || !config ? (
          <Spinner label="Loading" />
        ) : (
          <Button variant="secondary" loading={saving} onClick={toggleDebug}>
            {config.debug_mode ? 'Turn debug off' : 'Turn debug on'}
          </Button>
        )}
      </Card>
    </div>
  );
}
