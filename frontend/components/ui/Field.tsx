'use client';
import { useId } from 'react';

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => React.ReactNode;
}

export function Field({ label, error, hint, required, children }: FieldProps) {
  const baseId = useId();
  const errorId = error ? `${baseId}-error` : undefined;
  const hintId = hint && !error ? `${baseId}-hint` : undefined;
  const describedBy =
    [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={baseId} className="text-sm font-medium text-text">
        {label}
        {required && (
          <span className="ml-1 text-accent" aria-hidden="true">
            *
          </span>
        )}
      </label>

      {children({
        id: baseId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}

      {hintId && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {errorId && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
