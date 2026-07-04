'use client';

import type { ReactNode } from 'react';

/** Full-screen dark card that every beat renders inside. */
export function RevealFrame({
  children,
  accent,
  progress,
  onSkip,
}: {
  children: ReactNode;
  accent: string;
  progress?: { index: number; total: number };
  onSkip?: () => void;
}) {
  return (
    <div
      style={{ ['--user-accent' as string]: accent }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-base px-6 py-10 text-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex w-full max-w-xl flex-1 flex-col items-center justify-center">
        {children}
      </div>

      {progress && (
        <div className="mt-6 flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: progress.total }).map((_, i) => (
            <span
              key={i}
              className={[
                'h-1.5 rounded-full transition-all',
                i === progress.index ? 'w-6 bg-user' : 'w-1.5 bg-elevated',
              ].join(' ')}
            />
          ))}
        </div>
      )}

      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-4 font-mono text-xs text-faint hover:text-muted transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
        >
          Skip to my profile
        </button>
      )}
    </div>
  );
}

/** Primary "advance" button, tinted with the archetype accent. */
export function RevealButton({
  children,
  onClick,
  variant = 'primary',
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'ghost';
}) {
  const base =
    'mt-8 inline-flex items-center justify-center rounded-lg px-6 py-3 text-sm font-semibold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base';
  const styles =
    variant === 'primary'
      ? 'bg-user text-base hover:opacity-90'
      : 'text-muted hover:text-text';
  return (
    <button type="button" onClick={onClick} className={[base, styles].join(' ')}>
      {children}
    </button>
  );
}
