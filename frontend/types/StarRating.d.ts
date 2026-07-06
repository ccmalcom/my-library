interface StarRatingProps {
  value: number;
  onChange?: (value: number) => void;
  max?: number;
  label?: string;
  readOnly?: boolean;
  size?: number;
}
export declare function StarRating({
  value,
  onChange,
  max,
  label,
  readOnly,
  size,
}: StarRatingProps): import('react').JSX.Element;
export {};
