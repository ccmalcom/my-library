'use client';

import { useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui';
import { type ArchetypeOut } from '@/lib/api';

const AXIS_LABELS = [
  { left: 'Immersive',  right: 'Reflective'      },
  { left: 'Plot-first', right: 'Character-first'  },
  { left: 'Broad',      right: 'Deep'             },
  { left: 'Heart',      right: 'Mind'             },
];

interface Props {
  archetype: ArchetypeOut;
  onClose: () => void;
}

export function ArchetypeShareModal({ archetype, onClose }: Props) {
  const toast    = useToast();
  const titleId  = 'archetype-share-title';
  const cardRef  = useRef<HTMLDivElement>(null);

  // Axis letter row: e.g. "I  P  B  H"
  const axisLetters = [
    archetype.lens.letter,
    archetype.engine.letter,
    archetype.range.letter,
    archetype.resonance.letter,
  ].join('  ');

  // Axis label pairs for the small row below the code
  const axisPairs = AXIS_LABELS.map((a, i) => {
    const letters = [archetype.lens, archetype.engine, archetype.range, archetype.resonance];
    const letter  = letters[i]!.letter;
    const label   = letter === a.left[0] ? a.left : a.right;
    return label;
  }).join('  |  ');

  async function handleCopyImage() {
    const canvas = document.createElement('canvas');
    canvas.width  = 800;
    canvas.height = 560;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      toast.error('Canvas not supported in this browser');
      return;
    }

    // Background
    ctx.fillStyle = '#1e1b18';
    ctx.fillRect(0, 0, 800, 560);

    // Accent wash (top strip)
    ctx.fillStyle = 'rgba(255, 92, 58, 0.12)';
    ctx.fillRect(0, 0, 800, 120);

    // Wordmark
    ctx.fillStyle = '#a3a09d';
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('MyLibrary', 56, 68);

    // Code
    ctx.fillStyle = '#FF5C3A';
    ctx.font = 'bold 96px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(archetype.code, 400, 230);

    // Name
    ctx.fillStyle = '#f5f0eb';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText(archetype.name, 400, 300);

    // Tagline
    ctx.fillStyle = '#a3a09d';
    ctx.font = 'italic 20px system-ui, sans-serif';
    ctx.fillText(archetype.tagline, 400, 350);

    // Axis labels row
    ctx.fillStyle = '#6b6866';
    ctx.font = '16px monospace';
    ctx.fillText(axisPairs, 400, 430);

    // Bottom border accent
    ctx.fillStyle = '#FF5C3A';
    ctx.fillRect(56, 480, 688, 2);

    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Canvas toBlob returned null');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success('Image copied to clipboard');
    } catch {
      toast.error('Could not copy image -- try a different browser');
    }
  }

  async function handleCopyText() {
    const text = `I am ${archetype.name} (${archetype.code}) on MyLibrary`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not access clipboard');
    }
  }

  return (
    <Modal labelId={titleId} onClose={onClose} className='w-full max-w-md'>
      <div className='rounded-2xl border border-border bg-surface p-6 space-y-5'>
        <h2
          id={titleId}
          className='font-display text-lg font-bold text-text'
        >
          Share your reader type
        </h2>

        {/* Share card preview */}
        <div
          ref={cardRef}
          className='relative overflow-hidden rounded-xl bg-elevated border border-border p-6 text-center'
          style={{ minHeight: '220px' }}
        >
          {/* Accent wash */}
          <div
            className='absolute inset-x-0 top-0 h-16 opacity-20'
            style={{ background: 'var(--accent, #FF5C3A)' }}
            aria-hidden='true'
          />
          <p className='relative font-mono text-xs text-muted mb-3'>MyLibrary</p>
          <p className='relative font-mono text-5xl font-bold text-accent tracking-widest mb-2'>
            {archetype.code}
          </p>
          <p className='relative font-display text-xl font-bold text-text mb-1'>
            {archetype.name}
          </p>
          <p className='relative text-sm text-muted italic mb-4'>{archetype.tagline}</p>
          <p className='relative font-mono text-xs text-faint'>{axisPairs}</p>
        </div>

        {/* Actions */}
        <div className='flex flex-col gap-2'>
          <Button variant='secondary' size='md' onClick={handleCopyImage} className='w-full'>
            Copy as image
          </Button>
          <Button variant='ghost' size='md' onClick={handleCopyText} className='w-full'>
            Copy text
          </Button>
        </div>

        <div className='flex justify-end'>
          <Button variant='ghost' size='sm' onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
