import type { schema } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';

export type TraitRow = typeof schema.tasteTraits.$inferSelect;

/** Port of api.py's TraitOut serialization — trait row -> wire JSON. */
export function traitOut(t: TraitRow) {
  return {
    id: t.id,
    claim: t.claim,
    reveal_line: t.revealLine,
    polarity: t.polarity,
    exhibits: t.exhibits,
    contrasts: t.contrasts,
    inference_confidence: t.inferenceConfidence,
    status: t.status,
    user_note: t.userNote,
    user_weight: t.userWeight,
    verdict_updated_at: tsToIso(t.verdictUpdatedAt),
    created_at: tsToIso(t.createdAt),
  };
}
