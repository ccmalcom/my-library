type BadgeVariant = 'default' | 'mono' | 'success' | 'danger' | 'warning' | 'accent';
interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}
export declare function Badge({
  children,
  variant,
  className,
}: BadgeProps): import('react').JSX.Element;
export {};
