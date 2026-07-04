'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { api, PROFILE_STATUS_KEY, type ProfileStatus } from '@/lib/api';
import { Spinner } from '@/components/ui';

export default function ReprofileBanner() {
  const { data: status } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY, () => api.profileStatus());
  const { mutate } = useSWR<ProfileStatus>(PROFILE_STATUS_KEY);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status?.dirty) return null;

  async function handleReprofile() {
    setRunning(true);
    setError(null);
    try {
      await api.updateProfile();
      await mutate();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The update didn't finish. Your current profile still stands \u2014 try again."
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border-b border-warning/30 bg-warning/10">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-sm text-warning">
          <span className="font-semibold">Your taste has new evidence. </span> Ratings and edits
          since the last build aren&apos;t in your profile yet. Re-profile to fold them in — one
          Claude call, when you choose.
          {error && <span className="ml-2 text-danger">{error}</span>}
        </p>
        <button
          type="button"
          onClick={handleReprofile}
          disabled={running}
          className={[
            'inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-semibold text-base transition-all',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-base',
            running
              ? 'cursor-not-allowed bg-warning opacity-70'
              : 'bg-warning hover:opacity-90 active:scale-95',
          ].join(' ')}
        >
          {running && <Spinner size="sm" />}
          {running ? 'Updating\u2026' : 'Update profile'}
        </button>
      </div>
    </div>
  );
}
