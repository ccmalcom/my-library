'use client';

import useSWR from 'swr';
import { useEffect, useState } from 'react';
import { getAdminConfig, putAdminConfig, pingBackend, ADMIN_CONFIG_KEY } from '@/lib/api';
import { Badge, Button, Card, Spinner, useToast } from '@/components/ui';

export function SystemTab() {
  const toast = useToast();
  const [health, setHealth] = useState<boolean | null>(null);
  const {
    data: config,
    error: configError,
    mutate,
    isLoading,
  } = useSWR(ADMIN_CONFIG_KEY, getAdminConfig);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void pingBackend('', '/api/healthz').then(setHealth);
  }, []);

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
        <h2 className="mb-1 font-display text-lg font-semibold text-text">Debug mode</h2>
        <p className="mb-4 text-sm text-muted">
          Verbose structured logs and Server-Timing headers on the Node backend. Off = quiet
          standard logs.
        </p>
        <div className="mb-4 flex items-center gap-2 text-sm">
          Node (/api) {healthBadge(health)}
        </div>
        {configError ? (
          <p className="text-sm text-danger">
            Couldn&apos;t load debug mode:{' '}
            {configError instanceof Error ? configError.message : 'request failed'}
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
