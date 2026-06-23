# MyLibrary — Token Cost Audit

_Prices used: claude-sonnet-4-6 $3/$15 input/output per MTok; claude-haiku-4-5 $0.80/$4;
cache-write +25%, cache-read −90% vs input price. Verify against console.anthropic.com before
acting on dollar estimates._

---

## The four call sites

All Claude calls are in `profile.py` and `recommend.py`. There are no Claude calls in
`enrich.py` — enrichment is purely Open Library + Google Books.

### Call 1 — `extract_taste_profile` (full profile build)

**Function:** `profile.extract_taste_profile`
**Trigger:** `profile` CLI / `POST /profile` — cold-start or explicit full rebuild.

| Component | Tokens (est.) |
|-----------|---------------|
| System (`_SYSTEM`) | ~70 |
| Tool schema (`_TOOL`) | ~450 |
| Prompt instructions | ~500 |
| Library JSON (all rated books, 8 subjects each, optional review) | ~12,000–15,000 |
| **Total input** | **~13,000–16,000** |
| Output (6–12 traits with claim/exhibits/contrasts/confidence) | ~1,500–2,000 |

Cost per run: ≈ **$0.065–$0.078**.
Frequency: rare — once at cold start, infrequently thereafter.

**What's stable:** The system prompt and tool schema never change. The library JSON changes
only when the user ingests new books or rates/reviews existing ones.

### Call 2 — `update_taste_profile` (incremental re-profile)

**Function:** `profile.update_taste_profile`
**Trigger:** `reprofile` CLI / `POST /profile/update` — user-initiated after edits.

| Component | Tokens (est.) |
|-----------|---------------|
| System (`_REVISE_SYSTEM`) | ~70 |
| Tool schema (`_REVISE_TOOL`) | ~450 |
| Prompt instructions | ~350 |
| Current trait set (10 traits with id/claim/polarity/exhibits/contrasts/confidence) | ~1,200–1,500 |
| Books metadata (changed books ∪ books cited by current traits, typically 40–80 books) | ~2,000–4,500 |
| **Total input** | **~4,000–7,000** |
| Output | ~1,500–2,000 |

Cost per run: ≈ **$0.035–$0.050**.
This is already well-designed — it only sends the books needed to reason about the diff.

### Call 3 — `_claude_seed_queries` (stage 1b: propose search terms)

**Function:** `recommend._claude_seed_queries`
**Trigger:** each `recommend` run (unless `--no-seeds`).

| Component | Tokens (est.) |
|-----------|---------------|
| System (`_SEED_SYSTEM`) | ~55 |
| Tool schema (`_SEED_TOOL`) | ~220 |
| Prompt instruction | ~100 |
| Traits JSON (10 traits: claim/polarity/confidence only) | ~550 |
| Loved books JSON (up to 40 books × ~80 tok each) | ~3,200 |
| **Total input** | **~4,150** |
| Output (8 queries + reasons) | ~350–450 |

Cost per run: ≈ **$0.018** (mostly input).

### Call 4 — `_claude_rerank` (stage 2: rerank + explain)

**Function:** `recommend._claude_rerank`
**Trigger:** each `recommend` run.

| Component | Tokens (est.) |
|-----------|---------------|
| System (`_RANK_SYSTEM`) | ~65 |
| Tool schema (`_RANK_TOOL`) | ~380 |
| Prompt instruction | ~150 |
| Traits JSON (same as Call 3) | ~550 |
| Loved books JSON (same 40 books) | ~3,200 |
| Candidates JSON (up to 60 candidates × ~70 tok) | ~4,200 |
| **Total input** | **~8,550** |
| Output (10 recs with score/rationale/grounded ids) | ~2,000–2,500 |

Cost per run: ≈ **$0.055–$0.063**.

---

## Per-run cost summary

| Scenario | Input tokens | Output tokens | Cost |
|----------|-------------|---------------|------|
| `recommend` run (Calls 3 + 4) | ~12,700 | ~2,600 | **~$0.077** |
| Full profile build (Call 1) | ~14,500 | ~1,800 | **~$0.071** |
| Incremental re-profile (Call 2) | ~5,500 | ~1,800 | **~$0.043** |

At 5 recommend runs + 1 full profile + 2 re-profiles per month (reasonable personal use):
roughly **$0.55/month**. At 1,000 MAU each at that rate: ~$550/month.

---

## Optimization opportunities

### 1. Use Haiku for seed queries — highest ROI, one line of code

The seed query task (Call 3) is low-stakes text generation: read 10 taste traits + 40 loved
books, output 8 search strings. The model doesn't need deep reasoning — it needs to
paraphrase taste signals into catalog search terms.

**Change:** pass `model="claude-haiku-4-5-20251001"` to the `client.messages.create` call
inside `_claude_seed_queries`. The rest of the code is unchanged.

| | Current (Sonnet) | After (Haiku) | Saving |
|-|----------|---------|--------|
| Seed call cost | $0.018 | $0.005 | **$0.013/run (72%)** |
| Total per `recommend` run | $0.077 | $0.064 | **17%** |

Quality risk: seed queries just need to be valid search strings chasing the right traits.
If you ever find the seeds look generic or miss distinguishing traits, flip back to Sonnet
for that one call.

```python
# In recommend._claude_seed_queries:
message = client.messages.create(
    model="claude-haiku-4-5-20251001",   # <-- was settings.model (Sonnet)
    max_tokens=1500,
    ...
)
```

### 2. Prompt caching on the traits + loved-books prefix

Calls 3 and 4 both embed the same data: `signal["traits"]` (~550 tok) and
`signal["loved"][:40]` (~3,200 tok). That 3,750-token prefix is stable within a run and
across runs until the profile is updated.

Marking it with `cache_control` lets a second `recommend` run (or a re-run within the TTL)
skip re-reading those tokens. The default TTL is 5 minutes; with the `prompt-caching-2024-07-31`
beta, you can extend to 1 hour (useful if users run `recommend` more than once in a sitting).

**How to apply:**

Build the shared profile context string once in `recommend()` (before the calls split), then
pass it as a separate content block with `cache_control` in both messages:

```python
profile_context = (
    "TASTE TRAITS (JSON):\n" + json.dumps(signal["traits"], ensure_ascii=False)
    + "\n\nLOVED BOOKS (JSON):\n" + json.dumps(signal["loved"][:_LOVED_SAMPLE], ensure_ascii=False)
)

# In _claude_seed_queries — user message becomes:
messages=[{
    "role": "user",
    "content": [
        {"type": "text", "text": profile_context,
         "cache_control": {"type": "ephemeral"}},   # <-- cacheable prefix
        {"type": "text", "text": f"Propose up to {n_queries} CATALOG SEARCH QUERIES..."}
    ]
}]

# In _claude_rerank — user message becomes:
messages=[{
    "role": "user",
    "content": [
        {"type": "text", "text": profile_context,
         "cache_control": {"type": "ephemeral"}},   # <-- same prefix, different cache keys
        {"type": "text", "text": f"Rank the best {n} candidates...\n\nCANDIDATES:\n" + ...}
    ]
}]
```

Note: because the system prompts differ between the two calls (`_SEED_SYSTEM` vs
`_RANK_SYSTEM`), the cache keys are different — there's no cross-call hit within a single
run. Each call caches its own prefix independently. A **second run** within the TTL
gets hits on both.

| | First run | Repeated run (within TTL) |
|-|-----------|--------------------------|
| Cache write overhead (per call) | +25% on 3,750 tok = +$0.003 | — |
| Cache read savings (per call) | — | −90% on 3,750 tok = −$0.010 |
| Net vs. no caching (per run, 2 calls) | −$0.006 (slightly worse) | **+$0.020 savings** |

Break-even is the second run. For any user who runs `recommend` more than once between
profile updates (and most will — you run it, swipe, run it again), this pays off.

For public distribution with many users re-running recommends, add the `extended-cache-ttl`
beta header to push TTL to 1 hour:

```python
client.messages.create(
    ...,
    extra_headers={"anthropic-beta": "prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11"}
)
```

### 3. Trim `_LOVED_SAMPLE` from 40 to 20

Both the seed and rerank calls include up to 40 loved books for context. The books are
already sorted by `(rating, read_year)` descending, so the top 20 are the strongest
signal. The taste traits already summarize the full library; the loved books list is
supplementary context for the seed query writer and for `grounded_book_ids` citations in
the rerank output.

**Change:** reduce `_LOVED_SAMPLE = 40` to `_LOVED_SAMPLE = 20` (one constant).

Savings per recommend run: 20 books × ~80 tok × 2 calls = ~3,200 tokens → **~$0.010/run (13%)**.

Watch for: the rerank's `grounded_book_ids` might cite a slightly narrower range of books
(only the top 20 will be valid for citation). This is fine — grounded citations from your
highest-rated books are more useful anyway.

### 4. Batch API for profile builds (public distribution only)

Full profile builds (Call 1) are the largest single token spend at ~14,500 input tokens.
The Batch API (50% discount, async, 24-hour window) applies cleanly here because:
- Profile builds are explicitly user-initiated and not time-critical (the banner already
  shows a pending state)
- There's no real-time dependency — the result is committed to the DB asynchronously

The incremental re-profile (Call 2) is already cheap (~$0.043) and interactive; Batch
there is overkill.

**Rough savings at scale:**
- 1,000 MAU × 1 full rebuild/month = 1,000 calls × $0.071 = $71/month
- With Batch API: $35.50/month — saves **$35.50/month**

Implementation requires: sending to `client.messages.batches.create`, storing the
`batch_id`, polling `client.messages.batches.results(batch_id)`, then committing on
completion. The CLI's `reprofile` command would return immediately with a batch ID, and
a new `reprofile --status` subcommand would check completion.

**Not worth the complexity for a personal project. Worth it at public scale.**

---

## What NOT to do

**Don't batch recommend runs.** The seed query and rerank are sequential (seed results
feed catalog lookups which feed the rerank), so they can't be parallelized into a batch.

**Don't cache the system prompts.** At ~55–70 tokens each, they're far below the 1024-token
minimum for caching. The valuable cache targets are the large data payloads (library JSON,
traits, loved books).

**Don't try to merge seed queries + rerank into one call.** The architecture correctly
uses seed query results to populate the candidate pool before the reranker sees it. These
steps are inherently sequential and depend on live catalog lookups between them.

---

## Recommended implementation order

1. **Haiku for seed queries** — one-line change, immediate 17% per-run savings, zero
   quality risk on this low-stakes task. Do this first.

2. **Trim `_LOVED_SAMPLE` to 20** — one constant change, constant 13% input savings
   across every run. Easy to revert if recommendation quality dips.

3. **Prompt caching** — modest refactor to split user messages into two content blocks.
   The payoff is proportional to how often users re-run `recommend`. Add the extended-TTL
   beta header if supporting a multi-user service.

4. **Batch API for profile builds** — only if/when building a multi-user service. Profile
   the actual API costs first to confirm it's worth the async plumbing.
