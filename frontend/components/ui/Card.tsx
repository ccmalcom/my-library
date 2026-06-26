interface CardProps {
  children: React.ReactNode;
  elevated?: boolean;
  className?: string;
  as?: React.ElementType;
}

export function Card({
  children,
  elevated = false,
  className = '',
  as: Tag = 'div',
}: CardProps) {
  return (
    <Tag
      className={[
        'rounded-xl border border-border p-5',
        elevated ? 'bg-elevated' : 'bg-surface',
        className,
      ].join(' ')}
    >
      {children}
    </Tag>
  );
}
