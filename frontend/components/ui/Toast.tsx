'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastControls {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastControls | null>(null);

export function useToast(): ToastControls {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

// ── Individual toast ──────────────────────────────────────────────────────────

const COLORS: Record<ToastType, string> = {
  success: 'border-success/40 bg-success/10 text-success',
  error:   'border-danger/40  bg-danger/10  text-danger',
  info:    'border-border     bg-elevated   text-text',
};

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  return (
    <div
      role={item.type === 'error' ? 'alert' : 'status'}
      className={[
        'pointer-events-auto flex w-80 items-start gap-3 rounded-xl border px-4 py-3 shadow-lg',
        COLORS[item.type],
      ].join(' ')}
    >
      <p className='flex-1 text-sm leading-snug'>{item.message}</p>
      <button
        type='button'
        onClick={() => onDismiss(item.id)}
        aria-label='Dismiss'
        className='mt-0.5 shrink-0 opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current rounded'
      >
        <X className='h-4 w-4' />
      </button>
    </div>
  );
}

// ── Provider ──────────────────────────────────────────────────────────────────

const AUTO_DISMISS_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const add = useCallback(
    (message: string, type: ToastType) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const controls = useMemo<ToastControls>(
    () => ({
      success: (msg) => add(msg, 'success'),
      error:   (msg) => add(msg, 'error'),
      info:    (msg) => add(msg, 'info'),
    }),
    [add],
  );

  return (
    <ToastContext.Provider value={controls}>
      {children}
      <div
        className='pointer-events-none fixed bottom-4 right-4 z-[200] flex flex-col-reverse gap-2'
        aria-label='Notifications'
      >
        {toasts.map((t) => (
          <Toast key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
