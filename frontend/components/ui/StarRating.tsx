'use client';
import { useId, useState, KeyboardEvent, MouseEvent } from 'react';
import { RATING_MAX, RATING_STEP } from '@/lib/server/rating';

interface StarRatingProps {
  /** 0 = unrated; otherwise 0.5-5 (whole stars only when allowHalf is false). */
  value: number;
  onChange?: (value: number) => void;
  max?: number;
  label?: string;
  readOnly?: boolean;
  size?: number;
  /** Enable half-star selection: left half of a star picks the .5 value. */
  allowHalf?: boolean;
}

export function StarRating({
  value,
  onChange,
  max = RATING_MAX,
  label = 'Rating',
  readOnly = false,
  size = 20,
  allowHalf = false,
}: StarRatingProps) {
  const [hovered, setHovered] = useState(0);
  const uid = useId();
  const step = allowHalf ? RATING_STEP : 1;
  const min = step;

  function clamp(next: number) {
    return Math.min(max, Math.max(min, next));
  }

  /** Which value a pointer at `e` over star `star` represents. */
  function valueAt(e: MouseEvent<HTMLButtonElement>, star: number) {
    if (!allowHalf) return star;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 1;
    return fraction <= 0.5 ? star - 0.5 : star;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (readOnly || !onChange) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(clamp(value + step));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(clamp(value - step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(min);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(max);
    } else if (e.key >= '1' && e.key <= String(max)) {
      e.preventDefault();
      onChange(Number(e.key));
    }
  }

  function starFill(star: number, display: number) {
    return display >= star ? 1 : display >= star - 0.5 ? 0.5 : 0;
  }

  if (readOnly) {
    return (
      <span
        role="img"
        aria-label={`${label}: ${value || 0} of ${max}`}
        className="flex items-center gap-1"
      >
        {Array.from({ length: max }, (_, i) => {
          const star = i + 1;
          return (
            <StarIcon key={star} fill={starFill(star, value)} size={size} index={star} uid={uid} />
          );
        })}
      </span>
    );
  }

  const display = hovered || value;

  return (
    <div
      role="radiogroup"
      aria-label={`${label}: ${value || 0} of ${max}`}
      className="flex items-center gap-1"
    >
      {Array.from({ length: max }, (_, i) => {
        const star = i + 1;
        // 1 = full, 0.5 = half, 0 = empty.
        const fill = starFill(star, display);
        const tabIdx = star === Math.ceil(value || 1) ? 0 : -1;

        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value > star - 1 && value <= star}
            aria-label={star === 1 ? '1 star' : `${star} stars`}
            disabled={readOnly}
            tabIndex={tabIdx}
            onClick={(e) => !readOnly && onChange && onChange(valueAt(e, star))}
            onMouseMove={(e) => !readOnly && setHovered(valueAt(e, star))}
            onMouseLeave={() => !readOnly && setHovered(0)}
            onKeyDown={handleKeyDown}
            className={[
              'rounded transition-transform',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              'focus-visible:ring-offset-1 focus-visible:ring-offset-base',
              readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-110 active:scale-95',
            ].join(' ')}
          >
            <StarIcon fill={fill} size={size} index={star} uid={uid} />
          </button>
        );
      })}
    </div>
  );
}

const STAR_PATH =
  'M10 1.5l2.47 5.02 5.54.8-4.01 3.91.95 5.52L10 14.27l-4.95 2.48.95-5.52L2 7.32l5.54-.8L10 1.5z';

function StarIcon({
  fill,
  size,
  index,
  uid,
}: {
  fill: number;
  size: number;
  index: number;
  uid: string;
}) {
  // Clip-path ids must be unique per StarRating component instance and per star.
  const clipId = `star-half-${uid}-${index}`;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="10" height="20" />
        </clipPath>
      </defs>
      <path fill="none" stroke="var(--border)" strokeWidth="1.5" d={STAR_PATH} />
      {fill === 1 && <path fill="var(--accent)" d={STAR_PATH} />}
      {fill === 0.5 && <path fill="var(--accent)" d={STAR_PATH} clipPath={`url(#${clipId})`} />}
    </svg>
  );
}
