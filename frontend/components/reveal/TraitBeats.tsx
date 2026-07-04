'use client';

import type { Beat } from '@/lib/revealBeats';
import { RevealButton } from './revealFrame';

type RewardBeat = Extract<Beat, { kind: 'reward-trait' }>;
type AversionsBeat = Extract<Beat, { kind: 'aversions' }>;

/** "A", "A and B", or "A, B, and C" — matches the spec's evidence-row grammar. */
function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function RewardTraitBeat({ beat, onNext }: { beat: RewardBeat; onNext: () => void }) {
  const { trait, lowConfidence, exhibitTitles, contrastTitles } = beat;
  const line = trait.reveal_line ?? trait.claim;
  const evidence =
    exhibitTitles.length > 0
      ? `Because of ${joinWithAnd(exhibitTitles.map((t) => `“${t}”`))}.`
      : null;

  return (
    <div className="space-y-5">
      {lowConfidence && (
        <p className="font-mono text-xs italic text-faint">We’re less sure about this one —</p>
      )}
      <h2 className="font-display text-3xl font-bold leading-tight text-text sm:text-4xl">
        <span className="text-user">{line}</span>
      </h2>
      {evidence && <p className="text-sm text-muted">{evidence}</p>}
      {contrastTitles.length > 0 && (
        <p className="text-xs italic text-faint">
          (And because “{contrastTitles[0]}” didn’t land the same way.)
        </p>
      )}
      <RevealButton onClick={onNext}>Continue</RevealButton>
    </div>
  );
}

export function AversionsBeat({ beat, onNext }: { beat: AversionsBeat; onNext: () => void }) {
  return (
    <div className="space-y-5">
      <h2 className="font-display text-2xl font-bold leading-tight text-text sm:text-3xl">
        And some things you’ve quietly told us you’re done with.
      </h2>
      <ul className="space-y-3 text-left">
        {beat.items.map(({ trait, evidence }) => (
          <li key={trait.id} className="border-l-2 border-danger/40 pl-3">
            <p className="text-sm text-text">{trait.reveal_line ?? trait.claim}</p>
            {evidence && <p className="text-xs italic text-faint">({evidence})</p>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-faint">
        Aversions matter as much as favorites — they’re half of what makes recommendations
        feel like yours.
      </p>
      <RevealButton onClick={onNext}>Continue</RevealButton>
    </div>
  );
}
