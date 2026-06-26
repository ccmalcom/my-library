'use client';

import { useRef, useState } from 'react';
import { motion, useMotionValue, useTransform, animate } from 'framer-motion';
import Image from 'next/image';
import { BookOpen } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { Recommendation, Trait } from '@/lib/api';

interface Props {
  rec: Recommendation;
  traits: Trait[];
  onDecide: (recId: number, status: 'accepted' | 'rejected' | 'already_read') => void;
  zIndex?: number;
  isTop: boolean;
}

const DRAG_THRESHOLD = 120;

export default function SwipeCard({ rec, traits, onDecide, zIndex = 0, isTop }: Props) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-250, 250], [-18, 18]);
  const acceptOpacity = useTransform(x, [0, DRAG_THRESHOLD], [0, 1]);
  const rejectOpacity = useTransform(x, [-DRAG_THRESHOLD, 0], [1, 0]);
  const [descExpanded, setDescExpanded] = useState(false);

  const traitIds = new Set(rec.grounded_trait_ids ?? []);
  const matchedTraits = traits.filter((t) => traitIds.has(t.id)).slice(0, 5);

  const cardRef = useRef<HTMLDivElement>(null);

  async function flyOff(direction: 'left' | 'right') {
    const target = direction === 'right' ? 600 : -600;
    await animate(x, target, { duration: 0.35, ease: 'easeOut' });
    onDecide(rec.id, direction === 'right' ? 'accepted' : 'rejected');
  }

  function handleDragEnd() {
    const val = x.get();
    if (val > DRAG_THRESHOLD) {
      void flyOff('right');
    } else if (val < -DRAG_THRESHOLD) {
      void flyOff('left');
    } else {
      animate(x, 0, { type: 'spring', stiffness: 300, damping: 25 });
    }
  }

  const desc = rec.description;
  const descShort = desc && desc.length > 180 ? desc.slice(0, 177) + '...' : desc;

  return (
    <motion.div
      ref={cardRef}
      style={{ x, rotate, zIndex }}
      drag={isTop ? 'x' : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      onDragEnd={handleDragEnd}
      animate={isTop ? {} : { scale: 0.95, y: 8 }}
      className={[
        'drag-card absolute inset-0 mx-auto max-w-sm w-full',
        'rounded-2xl border border-border bg-surface shadow-2xl',
        'select-none overflow-hidden flex flex-col',
      ].join(' ')}
    >
      {/* Accept overlay */}
      <motion.div
        style={{ opacity: acceptOpacity }}
        className='pointer-events-none absolute inset-0 z-10 flex items-start justify-end rounded-2xl border-4 border-success p-4'
      >
        <span className='rotate-12 rounded-lg bg-success px-3 py-1 text-lg font-bold text-base'>
          LIKE
        </span>
      </motion.div>

      {/* Reject overlay */}
      <motion.div
        style={{ opacity: rejectOpacity }}
        className='pointer-events-none absolute inset-0 z-10 flex items-start justify-start rounded-2xl border-4 border-danger p-4'
      >
        <span className='-rotate-12 rounded-lg bg-danger px-3 py-1 text-lg font-bold text-base'>
          NOPE
        </span>
      </motion.div>

      {/* Cover image */}
      <div className='relative h-56 w-full bg-elevated'>
        {rec.cover_url ? (
          <Image
            src={rec.cover_url}
            alt={`Cover of ${rec.title}`}
            fill
            className='object-contain'
            draggable={false}
            unoptimized
          />
        ) : (
          <div className='flex h-full items-center justify-center text-faint'>
            <BookOpen className='h-12 w-12' />
          </div>
        )}
      </div>

      {/* Content */}
      <div className='flex-1 overflow-y-auto p-5 space-y-3'>
        <div>
          <h2 className='text-lg font-display font-bold leading-tight text-text'>{rec.title}</h2>
          <p className='text-sm text-muted'>
            {rec.author ?? 'Unknown author'}
            {rec.year ? ` · ${rec.year}` : ''}
          </p>
        </div>

        {/* Subjects */}
        {rec.subjects && rec.subjects.length > 0 && (
          <div className='flex flex-wrap gap-1'>
            {rec.subjects.slice(0, 4).map((s) => (
              <Badge key={s} variant='mono'>{s}</Badge>
            ))}
          </div>
        )}

        {/* Description (what the book is about) */}
        {desc && (
          <div>
            <p className='mb-1 font-mono text-xs uppercase tracking-widest text-faint'>About</p>
            <p className='text-sm leading-relaxed text-muted'>
              {descExpanded ? desc : descShort}
            </p>
            {desc.length > 180 && (
              <button
                type='button'
                onClick={() => setDescExpanded((v) => !v)}
                className='mt-1 text-xs text-accent hover:underline focus-visible:outline-none'
              >
                {descExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        )}

        {/* Rationale (why for you) */}
        {rec.rationale && (
          <div>
            <p className='mb-1 font-mono text-xs uppercase tracking-widest text-faint'>Why for you</p>
            <p className='text-sm leading-relaxed text-text'>{rec.rationale}</p>
          </div>
        )}

        {/* Matched taste traits */}
        {matchedTraits.length > 0 && (
          <div>
            <p className='mb-1.5 font-mono text-xs uppercase tracking-widest text-faint'>
              Matched taste
            </p>
            <div className='flex flex-wrap gap-1.5'>
              {matchedTraits.map((t) => (
                <Badge
                  key={t.id}
                  variant={t.polarity === 'reward' ? 'accent' : 'warning'}
                >
                  {t.claim.length > 40 ? t.claim.slice(0, 38) + '...' : t.claim}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
