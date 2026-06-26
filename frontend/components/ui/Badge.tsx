type BadgeVariant = 'default' | 'mono' | 'success' | 'danger' | 'warning' | 'accent';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-elevated text-muted',
  mono:    'bg-elevated text-muted font-mono',
  success: 'bg-success-quiet text-success',
  danger:  'bg-danger-quiet text-danger',
  warning: 'bg-warning-quiet text-warning',
  accent:  'bg-accent-quiet text-accent',
};

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        variantClasses[variant],
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}
