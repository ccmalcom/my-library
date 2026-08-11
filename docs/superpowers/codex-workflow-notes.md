# Codex-enhanced workflow — running notes

Working notes from folding the `codex` plugin (OpenAI) into the Claude Code loop. Goal: shift
token spend onto the ChatGPT subscription, keep Claude on judgement, and get two-model diversity
on the output. Refine this as we go; graduate settled lessons into the global CLAUDE.md and the
repo's `Claude / Codex split` section.

**Status:** first real run — Node backend wave 4, started 2026-08-10.

---

## Operational gotchas (learned the hard way)

1. **Never pipe a background Codex job through `tail`/`head`.** The pipe buffers, so the task
   output file stays at 0 bytes until the process exits and the `[codex]` progress stream is lost.
   Looks exactly like a hung job. Use `/codex:status` (reads the job store directly, independent
   of stdout) to watch, and `/codex:result <job-id>` to retrieve the full output afterward.
   Nothing is actually lost — the job store has it — but you can't see progress live.

2. **`task --help` is not a help flag.** The `task` subcommand forwards its entire argument
   string verbatim as the prompt, so `--help` burned a real Codex turn asking Codex what it can
   do. For flags, read the plugin's own command docs under
   `~/.claude/plugins/cache/openai-codex/codex/<version>/commands/*.md`.

3. **Persist results into the repo, don't leave them in the job store.** `/codex:result <id>`
   redirected into a doc under `docs/superpowers/plans/` makes the output durable, reviewable in
   a diff, and — most importantly — available to the *fresh execution session* that has no memory
   of the conversation that produced it. The job store is per-repo and ephemeral-feeling.

4. **`pre_bash.py` does not cover Codex.** The `.env` guard is a Claude Code PreToolUse hook, so
   it only screens Claude's own Bash calls. Codex runs its own shell. Never put `.env` in a task
   prompt or ask Codex to inspect secrets.

5. **Job IDs are worth recording.** Each run prints a Codex session ID and a
   `codex resume <session-id>` line. Keep them with the artifact — that's how you continue a
   thread days later instead of re-paying for the exploration.

---

## Prompt shapes that worked

For a **research/inventory** run:

- Open with `Read-only investigation. Do not edit any file.` — Codex honored it exactly and
  reported "No files were modified."
- Give **numbered, explicit deliverables** (we used 7). Vague asks produce summaries; numbered
  asks produce inventories.
- Say `Output as structured markdown with file:line citations throughout.` The citations are what
  make the output usable as plan input rather than something to re-verify by hand.
- Say `Be exhaustive on specifics, do not summarize away detail.` Left out, it compresses.
- Say `Do not propose a design or write code.` **This one is load-bearing.** Without it the model
  wants to solve the problem instead of mapping it, and you get an opinion where you needed facts.
- Include a "how is an already-ported example structured end to end" item. Asking it to trace one
  known-good precedent (`POST /discover`) is what surfaced the layering convention, transaction
  placement, and parity-test wiring in reusable form.

For a **plan-drafting** run:

- Point it at an existing artifact as the template (`read this file first`) and name the section
  order explicitly. Do not describe the format in the abstract.
- Restate scope boundaries as prohibitions, not just inclusions — "X is wave 4b, do NOT plan it."
- Say the doc "gets executed by an agent in a fresh session with no memory of this conversation."
  It measurably raises the specificity of what gets written down.
- Encode known past failures as numbered requirements with the *reason* attached (see the
  verification-command lesson below). "Do X" gets followed loosely; "Do X because last time not
  doing it left the repo with a failing suite" gets followed precisely.

---

## Division of labor — what this run actually showed

| Step | Ran on | Verdict |
|---|---|---|
| Repo inventory / exploration | Codex | **Clear win.** ~6 min wall time, 438 lines, precise citations. This is the expensive part and it belongs on Codex. |
| Scope + task decomposition | Claude | **Kept.** The inventory *changed* the plan; deciding what that meant was the judgement step. |
| Plan doc drafting | Codex | **Good, with one systematic gap** — see below. |
| Reviewing the drafted plan | Claude | **Non-negotiable.** Found two real defects. |
| Reading the carry-forward notes | Claude | Cheap and worth it; these are short and dense with decisions. |

**The most valuable single result so far was evidence overturning a stale doc.** Both prior plans
assigned purge to wave 4; `wave-3-verification.md` recommended deferring it to wave 5 as the risky
piece. The inventory showed purge is the *easiest* piece (self-contained, DB-only, no new infra)
and that the real risk is enrichment jobs, which need a Node background-execution mechanism that
does not exist. Neither existing doc said that. Delegating exploration paid for itself here.

Corollary: **let the inventory land before committing to scope.** Deciding scope from the older
docs would have produced a wrong plan.

### Codex-drafted plan quality — the verdict

Draft was 763 lines against the wave-3c-3 bar of 1,895 (fair, since 4a is a smaller scope with no
prompt-parity fixtures). Structure matched the template exactly. What it got genuinely right:

- 14 numbered global constraints, encoding every requirement passed in **plus** ones it inferred
  from `CLAUDE.md` on its own — that Chase commits by hand, that destructive tests must use PGlite,
  that live `DELETE /account` verification needs a disposable account and explicit confirmation.
- A V1–V14 "Verified Facts" table, every row carrying a `file:line` citation.
- Correct, complete implementation code: the load-bearing enrichment-before-books FK ordering
  marked `LOAD-BEARING`, an `if (bookIds.length)` guard before `inArray`, exact response shapes,
  and an explicit "there must be no delete against feedback/invites".
- It flagged its own unverified assumption rather than asserting it ("Confirm `DbTx` is the
  existing exported type; if it differs, use the repo's established type rather than inventing
  `any`"). That hedge is what led straight to defect 1.

**The systematic gap: it writes implementation code but describes test code.** Every one of the
11 stub points was a test body reduced to prose-in-a-comment — `countFor` was an empty function,
`seedUser` trailed off into `// Also insert profileMeta, readerArchetypes, ...`, and all five
`purge primitives` cases were comments. Implementation was complete throughout. Treat this as
expected behavior and **ask for test bodies explicitly and separately**; do not assume "follow the
template" covers them.

### Defects Claude review caught (both would have cost an execution session)

1. **`DbTx` does not exist.** `db.ts` exports only `Db`; every caller uses
   `import { schema, type Db } from './db'`, and the repo convention is `db.transaction(async (tx)
   => ...)` with `tx` inferred inline — no helper had ever needed a transaction *parameter* type.
   `purge.ts` as drafted would not compile. Fixed in place by adding a derived
   `export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];` to `db.ts` and listing
   that file under Modified files.
2. **Test bodies missing** (above), sent back to Codex as a scoped follow-up.

**Verify the plan's factual claims, don't spot-check them.** Its npm script names, the
`pglite.ts` helper path, `max: 1` in `db.ts`, and every schema export it cited all checked out —
but `DbTx` did not, and that one was invisible without actually grepping. The claims are
high-accuracy but not perfect, and the failures are the expensive kind: plausible, specific, and
only discoverable by running against the real repo.

### The loop that works

`Codex explores → Claude decides scope → Codex drafts → Claude verifies against the real repo →
Codex fills gaps`. Claude's two turns are cheap (reading + grepping, not generating), and they are
where all the errors got caught.

---

## Cost shape

- Claude's remaining big-ticket item in this loop is **the plan doc** (~1,900–2,500 lines for a
  wave in this repo). That dwarfs everything else Claude does. Delegating the draft to Codex and
  reviewing it is the main lever left.
- Background dispatch + notification works cleanly: fire the job, keep doing Claude-side work,
  get re-invoked on completion. No polling needed.
- Don't have Claude explore before delegating. `codex:codex-rescue` is deliberately forbidden from
  reading files for this reason; calling `codex-companion.mjs` directly from Bash skips even the
  Sonnet forwarding layer.

---

## Run log

Keep session IDs — `codex resume <session-id>` continues a thread instead of re-paying for the
exploration behind it.

| Date | Job ID | Codex session | Task | Wall time | Outcome |
|---|---|---|---|---|---|
| 2026-08-10 | — | `019fee7c-e2ab-7b62-8cb5-c7149b7e9fcb` | Accidental `task --help` | ~30s | Wasted turn; see gotcha 2 |
| 2026-08-10 | `task-mso03vq3-19wyhb` | `019fee81-6517-7450-88ca-4c28d2953652` | Wave 4 read-only inventory | ~6 min | 438 lines, precise citations, read-only honored. Reshaped the wave scope |
| 2026-08-10 | `task-mso0bqs4-moq0fx` | `019fee86-fe0b-71f2-abb5-2f3e67bd9bfe` | Draft wave 4a purge plan | ~4 min | 763 lines, correct structure, complete impl code, all test bodies stubbed. One-file constraint honored |
| 2026-08-10 | `bahk9ib1h` | — | Fill in wave 4a test bodies | ~3 min | 763 → 954 lines. All 11 stubs closed with runnable code; every column verified real. Preserved the review correction rather than reverting it |

**Scoped follow-ups work.** Pointing Codex at named line locations plus numbered requirements
produced a surgical edit: it filled the stubs, left completed sections alone, and — notably —
respected an explicit "do not revert this" instruction about the `DbTx` correction a human had
made to its own draft since. It did slightly exceed scope by adding an execution-path header (it
had read the new `Claude / Codex split` section in `CLAUDE.md` and encoded it), which was useful
but introduced one naming inconsistency (`_deleteProfileRows` vs the actual `deleteProfileRows`).
**Re-review anything it adds beyond what you asked for** — the additions are usually good, but
they're the parts nobody specified and therefore nobody checked.

Observed job phases: `running` → `verifying` → done. Codex self-verifies before returning, which
is part of why a research run takes minutes rather than seconds.

---

## Open questions

- ~~Does a Codex-drafted plan hold up to Claude-drafted quality?~~ **Answered** — yes for
  structure and implementation code, no for test code. See the verdict section above.
- ~~Does the gap-filling follow-up actually close it?~~ **Answered — yes, completely.** A scoped
  second pass naming the exact stub locations and the five requirements produced fully runnable
  test code: `countFor` implemented against real columns, enrichment counted via `innerJoin`
  through books, invites scoped by `supabaseUserId` (correct — invites aren't `userId`-owned),
  whole-object `toEqual` assertions, and `makeTestDb()` used with exactly the destructuring
  convention of existing tests. All 13 referenced schema columns verified to exist; zero defects
  this pass. **So test code is a second-prompt problem, not a Codex capability limit.** Ask for it
  explicitly; don't assume the template implies it.
- **Does the two-model split catch things a single model wouldn't?** So far the errors Claude
  caught were verifiable-against-repo facts, not judgement calls — which suggests the value is
  *verification against ground truth*, not model diversity per se. Worth watching whether that
  holds.
- **Review-gate value.** Set to per-execution-session toggle, not yet exercised. Unknown whether
  it duplicates `on_stop.py` in practice or genuinely catches design issues.
- **`/codex:transfer`** — untested. Intended as the `/compact` replacement when remaining work is
  mechanical.
- **Quota ceiling.** No visibility yet into how fast the $20 ChatGPT tier burns down under this
  usage pattern, or what happens at the limit mid-wave.
- **Wave 4c architecture (project-specific, but blocks the workflow test):** Vercel has no
  equivalent of FastAPI `BackgroundTasks` or a persistent arq worker. Options are `waitUntil`, a
  cron-driven poller, Redis + external worker, or leaving enrichment on Python through cutover.
  Needs a decision from Chase.
