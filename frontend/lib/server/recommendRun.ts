/**
 * Port of recommend.recommend() — the two-stage recommender orchestrator.
 *
 * Locked decision: the LLM is NOT the recommender. Final picks are always real
 * catalog books that survived retrieval; Claude only reranks and explains them, and
 * every id it cites is validated before persisting.
 *
 * Structure differs from Python in one way, deliberately: Python holds a single
 * session across the whole flow, but db.ts opens the pool with max: 1, so touching
 * the outer `db` while a transaction is open deadlocks. Both Claude calls and every
 * catalog fetch therefore run OUTSIDE any transaction, and the recommendation rows
 * are written in one transaction afterwards. Python writes nothing before its calls
 * either, so the observable behavior matches.
 */
import { randomUUID } from 'node:crypto';
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import {
  NO_LOVED_BOOKS_MESSAGE,
  NO_PROFILE_MESSAGE,
  RECOMMEND_NO_KEY_MESSAGE,
} from './claudeErrors';
import { schema, type Db } from './db';
import { ApiError } from './errors';
import { asIdList } from './profileBuild';
import { ensureProfileMeta } from './profileMeta';
import { booksChangedSince } from './profileUpdate';
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
import { applyDirectiveConstraints } from './recFilters';
import {
  buildRerankPrompt,
  buildSeedPrompt,
  rankModel,
  RANK_MAX_TOKENS,
  RANK_TOOL,
  RANK_SYSTEM,
  SEED_MAX_TOKENS,
  SEED_MODEL,
  SEED_SYSTEM,
  SEED_TOOL,
} from './recPrompts';
import { buildSignal, isColdStart, type RecSignal } from './recSignal';
import { round2, utcnowTs } from './serialize';

export interface RecommendOptions {
  n: number;
  useMetadata: boolean;
  useClaudeSeeds: boolean;
}

interface RankedCandidate extends AssembledCandidate {
  score: number;
  rationale: string;
  grounded_trait_ids: number[];
  grounded_book_ids: number[];
}

export async function runRecommend(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  opts: RecommendOptions
): Promise<Record<string, unknown>> {
  const { n, useMetadata, useClaudeSeeds } = opts;

  // Python's _client() checks the key at point of USE, so a caller that never reaches
  // a Claude stage (use_claude_seeds=false and an empty candidate pool) still succeeds.
  const requireClient = (): ClaudeClient => {
    if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);
    return client;
  };

  let signal = await buildSignal(db, userId);
  if (signal.loved.length === 0) throw new ApiError(400, NO_LOVED_BOOKS_MESSAGE);

  // Block recommendations when the taste profile is missing or stale. Python computes
  // `changed` BEFORE testing last_profiled_at, then raises the missing-profile error
  // first; the order matters only for which message a brand-new user sees.
  const meta = await ensureProfileMeta(db, userId);
  const changed = await booksChangedSince(db, meta.lastProfiledAt, userId);
  if (meta.lastProfiledAt === null) throw new ApiError(400, NO_PROFILE_MESSAGE);
  if (changed.length > 0) {
    throw new ApiError(
      400,
      `${changed.length} book(s) have been rated/reviewed since the last profile ` +
        'build. Re-profile first (POST /profile/update) so recommendations ' +
        'reflect your current taste.'
    );
  }

  const directiveConstraints = signal.directive_constraints ?? {};
  const statedLanguages = directiveConstraints.languages as string[] | undefined;
  if (statedLanguages && statedLanguages.length) {
    // A stated language constraint overrides the reader's library languages for this
    // run (same semantics as discover): assemble() reads library_languages via
    // allowedLanguages, so overriding it here is enough.
    signal = { ...signal, library_languages: new Set(statedLanguages) } as RecSignal;
  }

  const coldStart = isColdStart(signal);
  const metaPool = useMetadata ? await metadataPool(db, signal, PER_QUERY, coldStart) : [];

  let seedQueries: string[] = [];
  let seedEntries: Awaited<ReturnType<typeof seedPool>> = [];
  if (useClaudeSeeds) {
    seedQueries = await claudeSeedQueries(db, requireClient(), signal, userId, SEED_QUERIES);
    seedEntries = await seedPool(db, seedQueries, PER_QUERY);
  }

  let candidates = assemble(metaPool, seedEntries, signal, MAX_CANDIDATES);
  candidates = applyDirectiveConstraints(candidates, directiveConstraints);
  await fillOlDescriptions(db, candidates);

  if (candidates.length === 0) {
    return {
      run_id: null,
      served: 0,
      candidates: 0,
      cold_start: coldStart,
      note: 'Retrieval surfaced no new candidates (catalog empty/offline?).',
      recommendations: [],
    };
  }

  const ranked = await claudeRerank(db, requireClient(), candidates, signal, userId, n);

  const runId = randomUUID().replace(/-/g, '').slice(0, 12); // uuid4().hex[:12]
  const createdAt = utcnowTs();
  const recsOut: Record<string, unknown>[] = [];

  await db.transaction(async (tx) => {
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      const rank = i + 1;
      await tx.insert(schema.recommendations).values({
        userId,
        runId,
        rank,
        title: c.title,
        author: c.author,
        year: c.year,
        isbn13: c.isbn13,
        coverUrl: c.cover_url,
        subjects: c.subjects ?? [],
        description: c.description,
        catalogSource: c.catalog_source,
        catalogId: c.catalog_id,
        retrievalPool: c.retrieval_pool,
        seedReason: c.seed_reason,
        score: c.score,
        rationale: c.rationale,
        groundedTraitIds: c.grounded_trait_ids ?? [],
        groundedBookIds: c.grounded_book_ids ?? [],
        status: 'served',
        createdAt,
      });
      recsOut.push({
        rank,
        title: c.title,
        author: c.author,
        year: c.year,
        score: round2(c.score),
        rationale: c.rationale,
        retrieval_pool: c.retrieval_pool,
        seed_reason: c.seed_reason,
        grounded_trait_ids: c.grounded_trait_ids ?? [],
        grounded_book_ids: c.grounded_book_ids ?? [],
      });
    }
  });

  return {
    run_id: runId,
    served: recsOut.length,
    candidates: candidates.length,
    cold_start: coldStart,
    pool_metadata: metaPool.length,
    pool_seed: seedEntries.length,
    seed_queries: seedQueries,
    model: rankModel(),
    recommendations: recsOut,
  };
}

/** recommend._claude_seed_queries: stage 1b. Returns query strings only. */
async function claudeSeedQueries(
  db: Db,
  client: ClaudeClient,
  signal: RecSignal,
  userId: string,
  nQueries: number
): Promise<string[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'recommend_seed' },
    {
      model: SEED_MODEL,
      max_tokens: SEED_MAX_TOKENS,
      system: SEED_SYSTEM,
      tools: [SEED_TOOL],
      tool_choice: { type: 'tool', name: 'propose_search_queries' },
      messages: [{ role: 'user', content: buildSeedPrompt(signal, nQueries) }],
    }
  );
  // Python matches the FIRST tool_use block without checking its name.
  const input = toolInput(message as any, '');
  if (!input) return [];
  const items = (input.queries as Array<{ query?: string }> | undefined) ?? [];
  return items.filter((q) => (q?.query ?? '').trim() !== '').map((q) => String(q.query).trim());
}

/** recommend._claude_rerank: stage 2. */
async function claudeRerank(
  db: Db,
  client: ClaudeClient,
  candidates: AssembledCandidate[],
  signal: RecSignal,
  userId: string,
  n: number
): Promise<RankedCandidate[]> {
  const validTraitIds = new Set(signal.traits.map((t) => t.id));
  const validBookIds = new Set(signal.loved.map((b) => b.id));

  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'recommend_rerank' },
    {
      model: rankModel(),
      max_tokens: RANK_MAX_TOKENS,
      system: RANK_SYSTEM,
      tools: [RANK_TOOL],
      tool_choice: { type: 'tool', name: 'rank_recommendations' },
      messages: [{ role: 'user', content: buildRerankPrompt(candidates, signal, n) }],
    }
  );

  const input = toolInput(message as any, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];

  const out: RankedCandidate[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Drop hallucinated / duplicate indices.
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
      // asIdList is profileBuild's existing twin of Python's
      // `[i for i in ... if i in valid_ids]` — reused rather than duplicated.
      grounded_trait_ids: asIdList(r.grounded_trait_ids, validTraitIds),
      grounded_book_ids: asIdList(r.grounded_book_ids, validBookIds),
    });
  }

  out.sort((a, b) => b.score - a.score);
  // Prefer candidates with descriptions (better UX), but never drop below n if
  // description-having candidates are scarce.
  const withDesc = out.filter((c) => c.description);
  const withoutDesc = out.filter((c) => !c.description);
  return [...withDesc, ...withoutDesc].slice(0, n);
}
