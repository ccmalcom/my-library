'use client';

import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  getDirective,
  putDirective,
  deleteDirective,
  DIRECTIVE_KEY,
  type Directive,
  type DirectiveConstraints,
} from '@/lib/api';
import { Button, Textarea, Card, Badge } from '@/components/ui';
import DirectiveChat from '@/components/DirectiveChat';

function constraintChips(c: DirectiveConstraints): string[] {
  const chips: string[] = [];
  if (c.languages?.length) chips.push(`languages: ${c.languages.join(', ')}`);
  if (c.min_year != null) chips.push(`from ${c.min_year}`);
  if (c.max_year != null) chips.push(`to ${c.max_year}`);
  if (c.exclude_subjects?.length) chips.push(`avoid: ${c.exclude_subjects.join(', ')}`);
  if (c.exclude_authors?.length) chips.push(`skip authors: ${c.exclude_authors.join(', ')}`);
  return chips;
}

export default function CustomInstructions() {
  const { mutate } = useSWRConfig();
  const { data } = useSWR<Directive>(DIRECTIVE_KEY, getDirective);
  const [text, setText] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<DirectiveConstraints | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed local edit state from the fetched record once.
  const effectiveText = text ?? data?.nl_text ?? '';
  const effectiveConstraints = constraints ?? data?.constraints ?? {};
  const chips = constraintChips(effectiveConstraints);

  async function save() {
    setSaving(true);
    try {
      await putDirective({
        nl_text: effectiveText.trim() || null,
        constraints: effectiveConstraints,
      });
      await mutate(DIRECTIVE_KEY);
      setText(null);
      setConstraints(null);
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    setSaving(true);
    try {
      await deleteDirective();
      await mutate(DIRECTIVE_KEY);
      setText('');
      setConstraints({});
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold text-text">Custom instructions</h3>
        <Button variant="ghost" size="sm" onClick={() => setChatOpen(true)}>
          Help me write this
        </Button>
      </div>
      <p className="text-sm text-muted">
        Tell the recommender what you want in your own words: &ldquo;more nonfiction this
        year&rdquo;, &ldquo;nothing bleak&rdquo;, &ldquo;short books&rdquo;. This steers every
        recommendation.
      </p>
      <Textarea
        rows={4}
        value={effectiveText}
        onChange={(e) => setText(e.target.value)}
        placeholder="More character-driven literary fiction. No grimdark. Keep it under 400 pages."
      />
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </div>
      )}
      <div className="flex gap-3">
        <Button onClick={save} loading={saving} disabled={saving}>
          Save
        </Button>
        {data?.nl_text && (
          <Button variant="ghost" onClick={clearAll} disabled={saving}>
            Clear
          </Button>
        )}
      </div>
      {chatOpen && (
        <DirectiveChat
          currentText={effectiveText}
          onClose={() => setChatOpen(false)}
          onApply={(proposed, c) => {
            setText(proposed);
            setConstraints(c);
            setChatOpen(false);
          }}
        />
      )}
    </Card>
  );
}
