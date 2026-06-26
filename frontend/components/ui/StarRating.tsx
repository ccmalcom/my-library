'use client';
import { useState, KeyboardEvent } from 'react';

interface StarRatingProps {
  value: number;
  onChange?: (value: number) => void;
  max?: number;
  label?: string;
  readOnly?: boolean;
  size?: number;
}

export function StarRating({
  value,
  onChange,
  max = 5,
  label = 'Rating',
  readOnly = false,
  size = 20,
}: StarRatingProps) {
  const [hovered, setHovered] = useState(0);

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, star: number) {
    if (readOnly || !onChange) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(Math.min(max, star + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(Math.max(1, star - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(max);
    } else if (e.key >= '1' && e.key <= String(max)) {
      e.preventDefault();
      onChange(Number(e.key));
    }
  }

  const display = readOnly ? value : hovered || value;

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex items-center gap-1"
    >
      {Array.from({ length: max }, (_, i) => {
        const star = i + 1;
        const filled = star <= display;
        const tabIdx = star === (value || 1) ? 0 : -1;
        const starLabel = star === 1 ? '1 star' : `${star} stars`;

        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={star === value}
            aria-label={starLabel}
            disabled={readOnly}
            tabIndex={tabIdx}
            onClick={() => !readOnly && onChange && onChange(star)}
            onMouseEnter={() => !readOnly && setHovered(star)}
            onMouseLeave={() => !readOnly && setHovered(0)}
            onKeyDown={(e) => handleKeyDown(e, star)}
            className={[
              'rounded transition-transform',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'focus-visible:ring-offset-1 focus-visible:ring-offset-base',
              readOnly
                ? 'cursor-default'
                : 'cursor-pointer hover:scale-110 active:scale-95',
            ].join(' ')}
          >
            <StarIcon filled={filled} size={size} />
          </button>
        );
      })}
    </div>
  );
}

function StarIcon({ filled, size }: { filled: boolean; size: number }) {
  const path =
    'M10 1.5l2.47 5.02 5.54.8-4.01 3.91.95 5.52L10 14.27l-4.95 2.48.95-5.52L2 7.32l5.54-.8L10 1.5z';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      {filled ? (
        <path fill="var(--accent)" d={path} />
      ) : (
        <path
          fill="none"
          stroke="var(--border)"
          strokeWidth="1.5"
          d={path}
        />
      )}
    </svg>
  );
}
