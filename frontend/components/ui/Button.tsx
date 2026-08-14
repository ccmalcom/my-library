'use client';
import { forwardRef } from 'react';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  // Dark ink on saturated fills: white on --accent is 3.07:1 (2.68 on hover),
  // --bg on --accent is 5.99:1 (6.86 on hover). Matches the star-filter pattern
  // already shipping in app/(main)/library/page.tsx.
  primary: 'bg-accent text-base hover:bg-accent-hover',
  secondary: 'bg-surface border border-border text-text hover:bg-elevated',
  ghost: 'bg-transparent text-muted hover:text-text hover:bg-surface',
  danger: 'bg-danger text-base hover:opacity-90',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base';

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'primary', size = 'md', loading, disabled, children, className = '', ...props },
    ref
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all',
        'active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed',
        focusRing,
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(' ')}
      {...props}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  )
);
Button.displayName = 'Button';
