'use client';

import { useState } from 'react';
import { setTraitVerdict, api, type Trait } from '@/lib/api';
import { useToast } from '@/components/ui';
import type { Beat } from '@/lib/revealBeats';
import { RevealButton } from './revealFrame';

type RewardBeat = Extract<Beat, { kind: 'reward-trait' }>;
type AversionsBeat = Extract<Beat, { kind: 'aversions' }>;

export type Verdict = 'confirmed' | 'edited' | 'rejected';

const CONFIRM_TOAST = "Noted. We'll lean on this.";
const REJECT_TOAST = 'Fair enough, forgotten.';

/** "A", "A and B", or "A, B, and C" — matches the spec's evidence-row grammar. */
function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Shared verdict-control cluster for one trait. */
function VerdictControls({
  trait,
  lowConfidence,
  labels,
  onVerdict,
  onNext,
}: {
  trait: Trait;
  lowConfidence: boolean;
  labels: { confirm: string; reject: string; edit: string };
  onVerdict: (id: number, v: Verdict) => void;
  onNext: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trait.claim);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await setTraitVerdict(trait.id, { status: 'confirmed' });
      onVerdict(trait.id, 'confirmed');
      toast.success(CONFIRM_TOAST);
      onNext();
    } catch {
      toast.error("That didn't take. Try again.");
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await setTraitVerdict(trait.id, { status: 'rejected' });
      onVerdict(trait.id, 'rejected');
      toast.info(REJECT_TOAST);
      onNext();
    } catch {
      toast.error("That didn't take. Try again.");
      setBusy(false);
    }
  }

  async function saveEdit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.updateTrait(trait.id, { claim: trimmed, user_note: trimmed });
      onVerdict(trait.id, 'edited');
      toast.success('Noted. Your profile just got sharper.');
      onNext();
    } catch {
      toast.error("That didn't take. Try again.");
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          aria-label="Rewrite this trait in your own words"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          autoFocus
          className="w-full resize-none rounded-lg border border-user bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
        <p className="text-xs text-faint">
          Say it your way. It feeds your recommendations directly.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveEdit()}
            className="rounded-lg bg-user px-4 py-2 text-sm font-semibold text-base disabled:opacity-50"
          >
            That’s better
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="px-3 py-2 text-sm text-muted hover:text-text"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void confirm()}
        className="rounded-lg bg-user px-4 py-2 text-sm font-semibold text-base disabled:opacity-50"
      >
        {lowConfidence ? 'Actually, yes' : labels.confirm}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void reject()}
        className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-text disabled:opacity-50"
      >
        {labels.reject}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setDraft(trait.claim);
          setEditing(true);
        }}
        className="px-3 py-2 text-sm text-faint hover:text-muted disabled:opacity-50"
      >
        {labels.edit}
      </button>
    </div>
  );
}

export function RewardTraitBeat({
  beat,
  onNext,
  onVerdict,
}: {
  beat: RewardBeat;
  onNext: () => void;
  onVerdict: (id: number, v: Verdict) => void;
}) {
  const { trait, lowConfidence, exhibitTitles, contrastTitles } = beat;
  const line = trait.reveal_line ?? trait.claim;
  const evidence =
    exhibitTitles.length > 0
      ? `Because of ${joinWithAnd(exhibitTitles.map((t) => `\u201C${t}\u201D`))}.`
      : null;

  return (
    <div className="space-y-5">
      {lowConfidence && (
        <p className="font-mono text-xs italic text-faint">We’re less sure about this one.</p>
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
      <div className="pt-2">
        <VerdictControls
          trait={trait}
          lowConfidence={lowConfidence}
          labels={{ confirm: 'That\u2019s me', reject: 'Not quite', edit: 'Almost\u2026' }}
          onVerdict={onVerdict}
          onNext={onNext}
        />
      </div>
    </div>
  );
}

export function AversionsBeat({
  beat,
  onNext,
  onVerdict,
}: {
  beat: AversionsBeat;
  onNext: () => void;
  onVerdict: (id: number, v: Verdict) => void;
}) {
  return (
    <div className="space-y-5">
      <h2 className="font-display text-2xl font-bold leading-tight text-text sm:text-3xl">
        And some things you’ve quietly told us you’re done with.
      </h2>
      <ul className="space-y-4 text-left">
        {beat.items.map(({ trait, evidence }) => (
          <li key={trait.id} className="border-l-2 border-danger/40 pl-3">
            <p className="text-sm text-text">{trait.reveal_line ?? trait.claim}</p>
            {evidence && <p className="mb-2 text-xs italic text-faint">({evidence})</p>}
            <VerdictControls
              trait={trait}
              lowConfidence={false}
              labels={{
                confirm: 'True',
                reject: 'Not really',
                edit: 'It\u2019s more specific than that\u2026',
              }}
              onVerdict={onVerdict}
              onNext={() => {
                /* aversions advance together; per-line verdict does not auto-advance */
              }}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-faint">
        Aversions matter as much as favorites. They’re half of what makes recommendations feel like
        yours.
      </p>
      <RevealButton onClick={onNext}>Continue</RevealButton>
    </div>
  );
}
