'use client';

import { useState } from 'react';
import FeedbackModal from '@/components/FeedbackModal';

export default function FeedbackLauncher() {
  const [modalOpen, setModalOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  return (
    <>
      {/* Desktop banner */}
      {!bannerDismissed && (
        <div className='hidden sm:block border-b border-accent/30 bg-accent/5'>
          <div className='mx-auto flex max-w-4xl items-center justify-between gap-2 px-4 py-2.5'>
            <p className='text-sm text-accent'>Share feedback on the beta</p>
            <div className='flex items-center gap-2'>
              <button
                type='button'
                onClick={() => setModalOpen(true)}
                className={[
                  'inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-semibold text-base transition-all',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
                  'bg-accent hover:opacity-90 active:scale-95',
                ].join(' ')}
              >
                Give feedback
              </button>
              <button
                type='button'
                onClick={() => setBannerDismissed(true)}
                className={[
                  'inline-flex items-center justify-center rounded-lg p-1.5 text-accent transition-all',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
                  'hover:bg-accent/10 active:scale-95',
                ].join(' ')}
                aria-label='Dismiss'
              >
                <svg
                  width='16'
                  height='16'
                  viewBox='0 0 16 16'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <line x1='4' y1='4' x2='12' y2='12' />
                  <line x1='12' y1='4' x2='4' y2='12' />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile floating button */}
      <button
        type='button'
        onClick={() => setModalOpen(true)}
        className={[
          'sm:hidden fixed bottom-20 right-4 z-50 rounded-lg px-4 py-2.5 text-sm font-semibold text-base',
          'bg-accent text-white transition-all',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base',
          'hover:opacity-90 active:scale-95',
        ].join(' ')}
      >
        Feedback
      </button>

      {/* Modal */}
      {modalOpen && (
        <FeedbackModal
          heading='Share your feedback'
          onClose={() => setModalOpen(false)}
          onResolved={() => setModalOpen(false)}
        />
      )}
    </>
  );
}
