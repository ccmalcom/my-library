'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { getUsage, USAGE_KEY, type Usage } from '@/lib/api';

export default function UsageWarningBanner() {
  const { data } = useSWR<Usage>(USAGE_KEY, getUsage);
  const [dismissed, setDismissed] = useState(false);

  if (!data?.warn || dismissed) return null;

  return (
    <div className='border-b border-warning/30 bg-warning/10'>
      <div className='mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2.5'>
        <p className='text-sm text-warning'>
          You&apos;ve used <span className='font-semibold'>${data.spent_usd.toFixed(2)}</span> of your $
          {data.cap_usd.toFixed(2)} monthly Claude budget. Recommendations and profiles still run — this is
          just a heads-up.{' '}
          <Link href='/settings' className='font-semibold underline'>
            Details
          </Link>
        </p>
        <button
          type='button'
          onClick={() => setDismissed(true)}
          className={[
            'rounded-lg px-2 py-1 text-xs font-medium text-warning transition hover:bg-warning/10',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-base',
          ].join(' ')}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
