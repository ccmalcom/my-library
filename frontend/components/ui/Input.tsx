'use client';
import { forwardRef } from 'react';

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const baseClasses = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder:text-faint',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  'focus-visible:ring-offset-2 focus-visible:ring-offset-base',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  'aria-[invalid=true]:border-danger',
].join(' ');

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', ...props }, ref) => (
    <input
      ref={ref}
      className={[baseClasses, className].join(' ')}
      {...props}
    />
  )
);
Input.displayName = 'Input';
