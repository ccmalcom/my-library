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
import { Button, Card, useToast } from '@/components/ui';
import { getSupabaseClient, authEnabled } from '@/utils/supabase/client';

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
  const toast = useToast();

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

  const [nameInput, setNameInput] = useState('');
  const [nameSaving, setNameSaving] = useState(false);

  const [emailCurrentPassword, setEmailCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    setNameSaving(true);
    try {
      await api.setProfile(trimmed);
      setNameInput('');
      toast.success('Display name saved.');
      await mutate(USER_PROFILE_KEY);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save name.');
    } finally {
      setNameSaving(false);
    }
  }

  const configured = status?.configured ?? false;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    try {
      await api.setApiKey(key.trim());
      setKey('');
      toast.success('API key saved.');
      await mutate(API_KEY_STATUS_KEY);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save key.');
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailError(null);
    const supabase = getSupabaseClient();
    if (!supabase) return;
    setEmailSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) throw new Error('Could not get current user.');
      if (signInError) {
        setEmailError(signInError.message || 'Failed to verify password.');
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ email: newEmail.trim() });
      if (updateError) throw updateError;
      setEmailCurrentPassword('');
      setNewEmail('');
      toast.success('Check your new inbox to confirm the change.');
    } catch (e) {
      setEmailError(e instanceof Error ? e.message : 'Failed to update email.');
    } finally {
      setEmailSaving(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords don't match.");
      return;
    }
    const supabase = getSupabaseClient();
    if (!supabase) return;
    setPasswordSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) throw new Error('Could not get current user.');
      if (signInError) {
        setPasswordError(signInError.message || 'Failed to verify password.');
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password updated.');
    } catch (e) {
      setPasswordError(e instanceof Error ? e.message : 'Failed to update password.');
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    try {
      await api.clearApiKey();
      toast.success('API key removed.');
      await mutate(API_KEY_STATUS_KEY);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove key.');
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
                onChange={(e) => setNameInput(e.target.value)}
                placeholder={userProfile?.display_name ?? 'e.g. Alex'}
                className={inputClass}
              />
            </div>
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

      {/* Change email */}
      {authEnabled && (
        <section className='mb-6'>
          <Card>
            <h2 className='mb-4 font-display text-lg font-semibold text-text'>Change email</h2>
            <form onSubmit={handleChangeEmail} className='space-y-3'>
              <div>
                <label className={labelClass}>Current password</label>
                <input
                  type='password'
                  value={emailCurrentPassword}
                  onChange={(e) => { setEmailCurrentPassword(e.target.value); setEmailError(null); }}
                  autoComplete='current-password'
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>New email</label>
                <input
                  type='email'
                  value={newEmail}
                  onChange={(e) => { setNewEmail(e.target.value); setEmailError(null); }}
                  placeholder='new@example.com'
                  className={inputClass}
                />
              </div>
              {emailError && <p className='text-xs text-danger'>{emailError}</p>}
              <p className='text-xs text-faint'>
                A confirmation link will be sent to your new address.
              </p>
              <Button
                type='submit'
                loading={emailSaving}
                disabled={emailSaving || !emailCurrentPassword || !newEmail}
              >
                {emailSaving ? 'Saving...' : 'Update email'}
              </Button>
            </form>
          </Card>
        </section>
      )}

      {/* Change password */}
      {authEnabled && (
        <section className='mb-6'>
          <Card>
            <h2 className='mb-4 font-display text-lg font-semibold text-text'>Change password</h2>
            <form onSubmit={handleChangePassword} className='space-y-3'>
              <div>
                <label className={labelClass}>Current password</label>
                <input
                  type='password'
                  value={currentPassword}
                  onChange={(e) => { setCurrentPassword(e.target.value); setPasswordError(null); }}
                  autoComplete='current-password'
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>New password</label>
                <input
                  type='password'
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setPasswordError(null); }}
                  autoComplete='new-password'
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Confirm new password</label>
                <input
                  type='password'
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(null); }}
                  autoComplete='new-password'
                  className={inputClass}
                />
                {confirmPassword && newPassword !== confirmPassword && (
                  <p className='mt-1 text-xs text-danger'>Passwords don&apos;t match.</p>
                )}
              </div>
              {passwordError && <p className='text-xs text-danger'>{passwordError}</p>}
              <Button
                type='submit'
                loading={passwordSaving}
                disabled={
                  passwordSaving ||
                  !currentPassword ||
                  !newPassword ||
                  !confirmPassword ||
                  newPassword !== confirmPassword
                }
              >
                {passwordSaving ? 'Saving...' : 'Update password'}
              </Button>
            </form>
          </Card>
        </section>
      )}

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
                onChange={(e) => setKey(e.target.value)}
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
