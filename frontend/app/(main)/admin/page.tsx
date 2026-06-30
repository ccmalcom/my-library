'use client';

import { useState } from 'react';
import useSWR from 'swr';
import {
  adminMe,
  listAdminUsers,
  inviteUser,
  revokeUser,
  ADMIN_ME_KEY,
  ADMIN_USERS_KEY,
  type AdminUser,
} from '@/lib/api';
import { Button, Card, Badge, Spinner, useToast } from '@/components/ui';

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

const labelClass = 'mb-2 block font-mono text-xs font-semibold uppercase tracking-widest text-muted';

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'danger' | 'warning'> = {
  invited: 'warning',
  active: 'success',
  revoked: 'danger',
};

export default function AdminPage() {
  const { data: me, isLoading: meLoading } = useSWR(ADMIN_ME_KEY, adminMe);
  const {
    data: users,
    isLoading: usersLoading,
    mutate,
  } = useSWR(me?.is_admin ? ADMIN_USERS_KEY : null, listAdminUsers);
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [inviting, setInviting] = useState(false);

  if (meLoading) {
    return (
      <div className='mx-auto flex max-w-2xl justify-center px-4 py-16'>
        <Spinner label='Loading' />
      </div>
    );
  }

  if (!me?.is_admin) {
    return (
      <div className='mx-auto max-w-2xl px-4 py-8'>
        <Card className='text-sm text-text'>Not authorized.</Card>
      </div>
    );
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setInviting(true);
    try {
      await inviteUser(trimmed);
      setEmail('');
      toast.success('Invite sent.');
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invite failed.');
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className='mx-auto max-w-2xl px-4 py-8'>
      <h1 className='mb-1 font-display text-3xl font-bold tracking-tight text-text'>Admin</h1>
      <p className='mb-8 text-sm text-muted'>Invite new users and manage access.</p>

      <section className='mb-6'>
        <Card>
          <h2 className='mb-4 font-display text-lg font-semibold text-text'>Invite a user</h2>
          <form onSubmit={handleInvite} className='space-y-3'>
            <div>
              <label className={labelClass}>Email</label>
              <input
                type='email'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder='invite@example.com'
                required
                className={inputClass}
              />
            </div>
            <Button type='submit' loading={inviting} disabled={inviting || !email.trim()}>
              {inviting ? 'Sending...' : 'Invite'}
            </Button>
          </form>
        </Card>
      </section>

      <section>
        <Card className='p-0'>
          <h2 className='px-5 pt-5 font-display text-lg font-semibold text-text'>Users</h2>
          {usersLoading ? (
            <div className='flex justify-center p-8'>
              <Spinner label='Loading users' />
            </div>
          ) : !users || users.length === 0 ? (
            <p className='p-5 text-sm text-faint'>No invited users yet.</p>
          ) : (
            <div className='mt-4 divide-y divide-border'>
              {users.map((u) => (
                <UserRow key={u.id} user={u} onRevoked={() => mutate()} />
              ))}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

function UserRow({ user, onRevoked }: { user: AdminUser; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const toast = useToast();

  async function handleRevoke() {
    if (!user.supabase_user_id) {
      toast.error('User has not signed up yet — nothing to revoke.');
      setConfirming(false);
      return;
    }
    setRevoking(true);
    try {
      await revokeUser(user.supabase_user_id);
      toast.success(`${user.email} revoked.`);
      onRevoked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revoke failed.');
    } finally {
      setRevoking(false);
      setConfirming(false);
    }
  }

  const canRevoke = user.status !== 'revoked';

  return (
    <div className='flex items-center justify-between gap-3 px-5 py-3'>
      <div className='min-w-0'>
        <p className='truncate text-sm font-medium text-text'>{user.email}</p>
        <p className='font-mono text-xs text-faint'>{user.book_count} books</p>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <Badge variant={STATUS_VARIANT[user.status] ?? 'default'}>{user.status}</Badge>
        {canRevoke && (
          confirming ? (
            <Button variant='danger' size='sm' loading={revoking} onClick={handleRevoke}>
              {revoking ? 'Revoking...' : 'Confirm'}
            </Button>
          ) : (
            <Button variant='ghost' size='sm' onClick={() => setConfirming(true)} disabled={revoking}>
              Revoke
            </Button>
          )
        )}
      </div>
    </div>
  );
}
