/**
 * Port of recommend.recommend_similar() — ephemeral "more books like this" for
 * one owned library book.
 *
 * Book-anchored: retrieval seeds from the single book's facets rather than the
 * taste profile, and it skips the profile-missing/stale gate, cold-start gating
 * and the directive constraints that /recommend applies. Results are NOT
 * persisted -- no `recommendations` rows -- so this opens no transaction at all.
 * Same-author caps and language filtering still apply, reused unchanged from the
 * shared 3c-1 retrieval core.
 */
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { RECOMMEND_NO_KEY_MESSAGE, SIMILAR_NOT_ENOUGH_METADATA_MESSAGE } from './claudeErrors';
import type { Db } from './db';
import { ApiError } from './errors';
import {
  assemble,
  fillOlDescriptions,
  metadataPool,
  seedPool,
  MAX_CANDIDATES,
  PER_QUERY,
  SEED_QUERIES,
  type AssembledCandidate,
} from './recAssemble';
import { rankModel, RANK_MAX_TOKENS, SEED_MAX_TOKENS, SEED_MODEL, SEED_TOOL } from './recPrompts';
import { buildBookSignal, type BookAnchor } from './recSignal';
import {
  BOOK_FACET_SYSTEM,
  SIMILAR_RANK_SYSTEM,
  SIMILAR_RANK_TOOL,
  buildBookFacetPrompt,
  buildSimilarRerankPrompt,
} from './recSimilarPrompts';
import { round2 } from './serialize';

interface RankedSimilar extends AssembledCandidate {
  score: number;
  rationale: string;
}

export async function runSimilar(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  bookId: number,
  n: number
): Promise<Record<string, unknown>> {
  // Python's _client() checks the key at point of USE, inside _book_facet_queries.
  // That call happens AFTER the metadata catalog sweep, so a keyless user still
  // makes every metadata request before seeing the 400. Do not hoist this.
  const requireClient = (): ClaudeClient => {
    if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);
    return client;
  };

  const signal = await buildBookSignal(db, userId, bookId);
  // Python raises RuntimeError("Book N not found."), which api.py maps to a 400.
  // Unreachable through the route (it 404s on ownership first), kept for fidelity.
  if (signal === null) throw new ApiError(400, `Book ${bookId} not found.`);

  const anchor = signal.anchor;
  if (!signal.top_subjects.length && !anchor.description && !anchor.author) {
    throw new ApiError(400, SIMILAR_NOT_ENOUGH_METADATA_MESSAGE);
  }

  // cold_start is always false here: library thinness is irrelevant to a single seed.
  const metaPool = await metadataPool(db, signal, PER_QUERY, false);
  const seedQueries = await bookFacetQueries(db, requireClient(), anchor, userId, SEED_QUERIES);
  const seedEntries = await seedPool(db, seedQueries, PER_QUERY);

  const candidates = assemble(metaPool, seedEntries, signal, MAX_CANDIDATES);
  await fillOlDescriptions(db, candidates);
  const model = rankModel();

  if (candidates.length === 0) {
    return {
      anchor_book_id: anchor.id,
      anchor_title: anchor.title,
      count: 0,
      model,
      seed_queries: seedQueries,
      recommendations: [],
    };
  }

  const ranked = await rerankSimilar(db, requireClient(), candidates, anchor, userId, n);

  const recsOut = ranked.map((c, i) => ({
    rank: i + 1,
    title: c.title,
    author: c.author,
    year: c.year,
    isbn13: c.isbn13,
    cover_url: c.cover_url,
    subjects: c.subjects ?? [],
    description: c.description,
    catalog_source: c.catalog_source,
    catalog_id: c.catalog_id,
    retrieval_pool: c.retrieval_pool,
    seed_reason: c.seed_reason,
    score: round2(c.score),
    rationale: c.rationale,
  }));

  return {
    anchor_book_id: anchor.id,
    anchor_title: anchor.title,
    count: recsOut.length,
    model,
    seed_queries: seedQueries,
    recommendations: recsOut,
  };
}

/** recommend._book_facet_queries: stage 1b. Reuses SEED_TOOL, like Python. */
async function bookFacetQueries(
  db: Db,
  client: ClaudeClient,
  anchor: BookAnchor,
  userId: string,
  nQueries: number
): Promise<string[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'similar_seed' },
    {
      model: SEED_MODEL,
      max_tokens: SEED_MAX_TOKENS,
      system: BOOK_FACET_SYSTEM,
      tools: [SEED_TOOL],
      tool_choice: { type: 'tool', name: 'propose_search_queries' },
      messages: [{ role: 'user', content: buildBookFacetPrompt(anchor, nQueries) }],
    }
  );
  // Python matches the FIRST tool_use block without checking its name.
  const input = toolInput(message as any, '');
  if (!input) return [];
  const items = (input.queries as Array<{ query?: string }> | undefined) ?? [];
  return items.filter((q) => (q?.query ?? '').trim() !== '').map((q) => String(q.query).trim());
}

/** recommend._rerank_similar: stage 2. */
async function rerankSimilar(
  db: Db,
  client: ClaudeClient,
  candidates: AssembledCandidate[],
  anchor: BookAnchor,
  userId: string,
  n: number
): Promise<RankedSimilar[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'similar_rerank' },
    {
      model: rankModel(),
      max_tokens: RANK_MAX_TOKENS,
      system: SIMILAR_RANK_SYSTEM,
      tools: [SIMILAR_RANK_TOOL],
      tool_choice: { type: 'tool', name: 'rank_similar_books' },
      messages: [{ role: 'user', content: buildSimilarRerankPrompt(candidates, anchor, n) }],
    }
  );

  const input = toolInput(message as any, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];

  const out: RankedSimilar[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Drop hallucinated / duplicate indices. Same intentional divergence from
    // Python's `isinstance(idx, int)` as recommendRun.claudeRerank -- JSON.parse
    // erases the int/float distinction, and this is the safer reading either way.
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= candidates.length ||
      seenIdx.has(idx)
    ) {
      continue;
    }
    seenIdx.add(idx);
    out.push({
      ...candidates[idx],
      score: Number(r.score ?? 0),
      rationale: String(r.rationale ?? '').trim(),
    });
  }

  out.sort((a, b) => b.score - a.score);
  // Prefer candidates with descriptions (better UX), but never drop below n if
  // description-having candidates are scarce.
  const withDesc = out.filter((c) => c.description);
  const withoutDesc = out.filter((c) => !c.description);
  return [...withDesc, ...withoutDesc].slice(0, n);
}
