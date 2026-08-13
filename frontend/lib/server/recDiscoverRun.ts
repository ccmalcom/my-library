/**
 * Port of recommend.discover() — ephemeral natural-language discovery.
 *
 * Two-stage and REQUEST-anchored: stage A (Haiku) interprets the free-text request
 * into catalog queries + hard constraints, retrieval resolves them against the live
 * catalog, and stage B (the rerank model) ranks the real candidates by fit to the
 * request. The taste profile is secondary tie-break context only, the standing
 * directive does not steer this path at all, and there is no profile-missing/stale
 * gate. Results are NOT persisted, so this opens no transaction.
 */
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { DISCOVER_EMPTY_QUERY_MESSAGE, RECOMMEND_NO_KEY_MESSAGE } from './claudeErrors';
import type { Db } from './db';
import { ApiError } from './errors';
import {
  assemble,
  discoveryPool,
  fillOlDescriptions,
  MAX_CANDIDATES,
  PER_QUERY,
  type AssembledCandidate,
} from './recAssemble';
import { applyDiscoveryConstraints, cleanConstraints } from './recFilters';
import {
  DISCOVER_RANK_SYSTEM,
  DISCOVER_RANK_TOOL,
  DISCOVER_SYSTEM,
  DISCOVER_TOOL,
  buildDiscoverRerankPrompt,
  buildInterpretPrompt,
} from './recDiscoverPrompts';
import { rankModel, RANK_MAX_TOKENS, SEED_MAX_TOKENS, SEED_MODEL } from './recPrompts';
import { buildSignal, type RecSignal } from './recSignal';
import { round2 } from './serialize';

interface Interpretation {
  interpretation: string;
  queries: string[];
  constraints: Record<string, unknown>;
}

interface RankedDiscovery extends AssembledCandidate {
  score: number;
  rationale: string;
}

export async function runDiscover(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  query: string,
  n: number
): Promise<Record<string, unknown>> {
  const q = (query ?? '').trim();
  if (!q) throw new ApiError(400, DISCOVER_EMPTY_QUERY_MESSAGE);

  // Python's _client() checks the key at point of USE, inside _interpret_query.
  // Discovery has no metadata pool, so that is before any catalog request.
  const requireClient = (): ClaudeClient => {
    if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);
    return client;
  };

  // The FULL signal: library exclusion sets (including rejected recommendations)
  // plus traits/loved as secondary context. buildSignal never raises on a thin or
  // profile-less library, which is why discovery works before a profile exists.
  let signal = await buildSignal(db, userId);

  const interp = await interpretQuery(db, requireClient(), q, signal, userId);
  const model = rankModel();

  if (interp.queries.length === 0) {
    return {
      query: q,
      interpretation: interp.interpretation,
      count: 0,
      model,
      queries: [],
      recommendations: [],
    };
  }

  // A stated language constraint OVERRIDES the reader's library languages for this
  // run (people ask for other-language books on purpose). assemble() reads
  // library_languages via allowedLanguages, so overriding it here is enough.
  const statedLanguages = interp.constraints.languages as string[] | undefined;
  if (statedLanguages && statedLanguages.length) {
    signal = { ...signal, library_languages: new Set(statedLanguages) } as RecSignal;
  }

  let pool = await discoveryPool(db, interp.queries, PER_QUERY);
  // Filter the RAW pool, before the cap, so a constraint-violating book can never
  // displace a valid one.
  pool = applyDiscoveryConstraints(pool, interp.constraints);
  // Discovery is purely query-driven: no metadata pool. The interpreted queries ARE
  // the seed pool, so every candidate comes out tagged 'claude_seed'.
  const candidates = assemble([], pool, signal, MAX_CANDIDATES);
  await fillOlDescriptions(db, candidates);

  if (candidates.length === 0) {
    // NOTE: unlike the no-queries return above, this one carries the queries.
    return {
      query: q,
      interpretation: interp.interpretation,
      count: 0,
      model,
      queries: interp.queries,
      recommendations: [],
    };
  }

  const ranked = await rerankDiscovery(
    db,
    requireClient(),
    candidates,
    q,
    interp.interpretation,
    signal,
    userId,
    n
  );

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
    query: q,
    interpretation: interp.interpretation,
    count: recsOut.length,
    model,
    queries: interp.queries,
    recommendations: recsOut,
  };
}

/** recommend._interpret_query: stage A. */
async function interpretQuery(
  db: Db,
  client: ClaudeClient,
  query: string,
  signal: RecSignal,
  userId: string
): Promise<Interpretation> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'discover_interpret' },
    {
      model: SEED_MODEL,
      max_tokens: SEED_MAX_TOKENS,
      system: DISCOVER_SYSTEM,
      tools: [DISCOVER_TOOL],
      tool_choice: { type: 'tool', name: 'interpret_request' },
      messages: [{ role: 'user', content: buildInterpretPrompt(query, signal) }],
    }
  );

  // Python matches the FIRST tool_use block without checking its name, and falls
  // back to a fully-empty interpretation when there is none.
  const input = toolInput(message as any, '');
  if (!input) return { interpretation: '', queries: [], constraints: {} };

  const items = (input.queries as Array<{ query?: string }> | undefined) ?? [];
  return {
    interpretation: String(input.interpretation ?? '').trim(),
    queries: items.filter((x) => (x?.query ?? '').trim() !== '').map((x) => String(x.query).trim()),
    constraints: cleanConstraints((input.constraints as Record<string, unknown>) ?? {}),
  };
}

/** recommend._rerank_discovery: stage B. */
async function rerankDiscovery(
  db: Db,
  client: ClaudeClient,
  candidates: AssembledCandidate[],
  query: string,
  interpretation: string,
  signal: RecSignal,
  userId: string,
  n: number
): Promise<RankedDiscovery[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'discover_rerank' },
    {
      model: rankModel(),
      max_tokens: RANK_MAX_TOKENS,
      system: DISCOVER_RANK_SYSTEM,
      tools: [DISCOVER_RANK_TOOL],
      tool_choice: { type: 'tool', name: 'rank_discovery' },
      messages: [
        {
          role: 'user',
          content: buildDiscoverRerankPrompt(candidates, query, interpretation, signal, n),
        },
      ],
    }
  );

  const input = toolInput(message as any, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];

  const out: RankedDiscovery[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Drop hallucinated / duplicate indices. Same intentional divergence from
    // Python's `isinstance(idx, int)` as recommendRun and recSimilarRun.
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
