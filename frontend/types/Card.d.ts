interface CardProps {
  children: React.ReactNode;
  elevated?: boolean;
  className?: string;
  as?: React.ElementType;
}
export declare function Card({
  children,
  elevated,
  className,
  as: Tag,
}: CardProps): import('react').JSX.Element;
export {};
