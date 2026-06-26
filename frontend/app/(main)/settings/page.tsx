'use client';

import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import {
  api,
  API_KEY_STATUS_KEY,
  PROFILE_STATUS_KEY,
  USER_PROFILE_KEY,
  type ApiKeyStatus,
  type UserProfile,
} from '@/lib/api';
import { Button, Card } from '@/components/ui';

function DangerAction({
  title,
  description,
  buttonLabel,
  onRun,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  onRun: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setRunning(true);
    setError(null);
    try {
      await onRun();
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className='flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger/5 p-4 sm:flex-row sm:items-center sm:justify-between'>
      <div className='min-w-0'>
        <p className='text-sm font-medium text-text'>{title}</p>
        <p className='text-xs text-faint'>{description}</p>
        {error && <p className='mt-1 text-xs text-danger'>{error}</p>}
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        {confirming ? (
          <>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setConfirming(false)}
              disabled={running}
            >
              Cancel
            </Button>
            <Button
              variant='danger'
              size='sm'
              loading={running}
              onClick={handleConfirm}
            >
              {running ? 'Working...' : 'Yes, do it'}
            </Button>
          </>
        ) : (
          <button
            type='button'
            onClick={() => setConfirming(true)}
            className={[
              'rounded-lg border border-danger/60 px-3 py-2 text-sm font-medium text-danger',
              'transition hover:bg-danger/10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-base',
            ].join(' ')}
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  );
}

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

const labelClass = 'mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted';

export default function SettingsPage() {
  const { data: status, isLoading } = useSWR<ApiKeyStatus>(
    API_KEY_STATUS_KEY,
    () => api.apiKeyStatus()
  );
  const { data: userProfile } = useSWR<UserProfile>(
    USER_PROFILE_KEY,
    () => api.getProfile()
  );

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [nameInput, setNameInput] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      await api.setProfile(trimmed);
      setNameInput('');
      setNameSaved(true);
      await mutate(USER_PROFILE_KEY);
    } catch (e) {
      setNameError(e instanceof Error ? e.message : 'Failed to save name.');
    } finally {
      setNameSaving(false);
    }
  }

  const configured = status?.configured ?? false;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.setApiKey(key.trim());
      setKey('');
      setSaved(true);
      await mutate(API_KEY_STATUS_KEY);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save key.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.clearApiKey();
      await mutate(API_KEY_STATUS_KEY);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove key.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className='mx-auto max-w-2xl px-4 py-8'>
      <h1 className='mb-1 font-display text-3xl font-bold tracking-tight text-text'>Settings</h1>
      <p className='mb-8 text-sm text-muted'>
        MyLibrary uses your own Anthropic API key for the taste profile and recommendations.
      </p>

      {/* Display name */}
      <section className='mb-6'>
        <Card>
          <h2 className='mb-4 font-display text-lg font-semibold text-text'>Display name</h2>

          {userProfile?.display_name && (
            <p className='mb-3 text-sm text-muted'>
              Currently: <span className='font-medium text-text'>{userProfile.display_name}</span>
            </p>
          )}

          <form onSubmit={handleSaveName} className='space-y-3'>
            <div>
              <label className={labelClass}>
                {userProfile?.display_name ? 'Update name' : 'Set your name'}
              </label>
              <input
                type='text'
                value={nameInput}
                onChange={(e) => { setNameInput(e.target.value); setNameSaved(false); }}
                placeholder={userProfile?.display_name ?? 'e.g. Alex'}
                className={inputClass}
              />
            </div>
            {nameError && <p className='text-sm text-danger'>{nameError}</p>}
            {nameSaved && <p className='text-sm text-success'>Saved.</p>}
            <Button
              type='submit'
              loading={nameSaving}
              disabled={nameSaving || !nameInput.trim()}
            >
              {nameSaving ? 'Saving...' : 'Save name'}
            </Button>
          </form>
        </Card>
      </section>

      {/* API key */}
      <section className='mb-6'>
        <Card>
          <div className='mb-4 flex items-center justify-between'>
            <h2 className='font-display text-lg font-semibold text-text'>Anthropic API key</h2>
            {!isLoading && (
              <span
                className={[
                  'rounded-full px-2.5 py-0.5 font-mono text-xs font-semibold',
                  configured
                    ? 'bg-success/20 text-success'
                    : 'bg-elevated text-muted',
                ].join(' ')}
              >
                {configured ? 'Configured' : 'Not set'}
              </span>
            )}
          </div>

          <form onSubmit={handleSave} className='space-y-3'>
            <div>
              <label className={labelClass}>{configured ? 'Replace key' : 'Add your key'}</label>
              <input
                type='password'
                value={key}
                onChange={(e) => { setKey(e.target.value); setSaved(false); }}
                placeholder='sk-ant-...'
                autoComplete='off'
                className={[inputClass, 'font-mono'].join(' ')}
              />
              <p className='mt-2 text-xs text-faint'>
                Stored encrypted on the server and never shown again. Get one at{' '}
                <a
                  href='https://console.anthropic.com/'
                  target='_blank'
                  rel='noreferrer'
                  className='text-accent hover:underline'
                >
                  console.anthropic.com
                </a>
                .
              </p>
            </div>

            {error && <p className='text-sm text-danger'>{error}</p>}
            {saved && <p className='text-sm text-success'>Saved.</p>}

            <div className='flex items-center gap-2'>
              <Button
                type='submit'
                loading={saving}
                disabled={saving || !key.trim()}
              >
                {saving ? 'Saving...' : 'Save key'}
              </Button>
              {configured && (
                <Button
                  type='button'
                  variant='ghost'
                  onClick={handleRemove}
                  disabled={saving}
                >
                  Remove key
                </Button>
              )}
            </div>
          </form>
        </Card>
      </section>

      {/* Danger zone */}
      <section className='rounded-2xl border border-danger/40 bg-surface p-6'>
        <h2 className='font-display text-lg font-semibold text-danger'>Danger zone</h2>
        <p className='mb-4 mt-1 text-sm text-muted'>
          These permanently delete your data and can&apos;t be undone.
        </p>

        <div className='space-y-3'>
          <DangerAction
            title='Reset taste profile'
            description='Deletes your taste traits and recommendations. Your books stay - rebuild the profile anytime.'
            buttonLabel='Reset profile'
            onRun={async () => {
              await api.clearProfile();
              await Promise.all([
                mutate('profile', [], { revalidate: false }),
                mutate(PROFILE_STATUS_KEY),
                mutate('recommendations', [], { revalidate: false }),
              ]);
            }}
          />

          <DangerAction
            title='Clear library'
            description='Deletes every book, its enrichment, and your taste profile - back to a clean first-setup state.'
            buttonLabel='Clear library'
            onRun={async () => {
              await api.clearLibrary();
              window.location.assign('/');
            }}
          />

          <DangerAction
            title='Delete account data'
            description='Deletes ALL your data: library, profile, recommendations, and your stored Anthropic key.'
            buttonLabel='Delete everything'
            onRun={async () => {
              await api.deleteAccount();
              window.location.assign('/');
            }}
          />
        </div>
      </section>
    </div>
  );
}
