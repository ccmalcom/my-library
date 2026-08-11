# Codex-enhanced workflow — running notes

Working notes from folding the `codex` plugin (OpenAI) into the Claude Code loop. Goal: shift
token spend onto the ChatGPT subscription, keep Claude on judgement, and get two-model diversity
on the output. Refine this as we go; graduate settled lessons into the global CLAUDE.md and the
repo's `Claude / Codex split` section.

**Status:** one full cycle complete — wave 4a inventory → plan → execution, 2026-08-10. 17 Codex
jobs in this repo.

**This file is the narrative log.** The operational distillation lives in
`codex-prompt-templates.md` — tested prompts for the three Codex roles, a standing-rules block,
Claude's review checklist, and verified helper commands. When a lesson here stabilizes, graduate it
into the templates and into CLAUDE.md's `Claude / Codex split` section, then leave the story here.

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

## Wave 4a execution session (2026-08-10)

### Plan line-number citations drift — verify the symbol, not the range

Task 0's verification command was `git show origin/main:mylibrary/profile.py | sed -n '542,551p'`
with the instruction "it must contain `if "id" in b`". The guard is real and deployed, but it
lives at **line 552** — the window was ~10 lines short and printed only the comment above it. A
literal reading of the check ("does this window contain the string?") would have failed a gate
that had actually passed.

**Prompt fix:** when a plan needs to prove a fix landed, have it cite a `grep -n '<exact code>'`
rather than a `sed -n 'N,Mp'` range. Line numbers move with every commit between plan-authoring
and plan-execution; the symbol does not. This applies to the plan's own "Verified Facts" table
too, which is entirely line-range citations — treat those ranges as *hints to the right region*,
never as assertions to check literally.

### Task 1 — clean pass, but the plan's FK evidence was wrong

Codex implemented Task 1 in 2m39s, touching exactly the four intended files and nothing else.
7/7 focused tests pass; `type-check` and `prettier --check` clean, all re-run independently rather
than taken from its report. Its three self-reported plan discrepancies all verified true.

**A false "the plan is wrong" finding — grep shape, not plan quality.** Mid-review I claimed V5
cited the wrong file for the enrichment FK, on the strength of `grep -c 'references(' schema.ts`
returning **0**. That was my error, caught by Codex on the next task. Drizzle declares foreign keys
two ways: column-level `.references()` *and* the table-level third-argument form
`foreignKey({ columns, foreignColumns, name })`. This schema uses the latter, at
`schema.ts:146-151` (`enrichment_book_id_fkey`) — squarely inside the `128-151` range V5 cited.
**V5 was correct as written.**

Worth knowing: that is the *only* foreign key in the entire Drizzle schema (one `foreignKey(`, zero
`references(`), which is exactly why enrichment-before-books is the one ordering constraint in the
purge path.

**The real lesson is about verification method, not the plan.** A single-form grep is not proof of
absence for any API with more than one spelling. Before contradicting a plan's citation, either
open the cited range or grep for every form the API allows — "my grep found nothing" and "the fact
is not there" are different claims, and I reported the second while having only established the
first. Codex caught this because it read the range instead of grepping it.

**What did hold up:** the `DbTx` correction was genuine (Task 1 had to add the type), and the
"treat the code blocks as unverified sketches; check every name against the real repo and report
deviations" paragraph earned its place — Codex reported unprompted deviations on all three tasks,
including this correction to me. Keep that paragraph. But note the asymmetry it created: it
primes Codex to *expect* plan errors, and I then fed my own false finding into the Task 2 and
Task 3 prompts as established fact. Propagating a review finding into later prompts is efficient
when right and contaminating when wrong — verify it against the source before it becomes prompt
boilerplate.

**Prettier churn.** `prettier --write` on a touched file reformats pre-existing code: `pglite.ts`
showed 11 deletions that were entirely array reflow, zero semantic change (verified element by
element). Harmless but it pads the diff Chase reviews. Worth knowing the file wasn't
Prettier-clean before this wave.

**`status --json` is unusable raw** — it echoes the entire prompt back, so a Task-1-sized prompt
makes one status check dominate the context window. Pipe it through `python3 -c` and print only
`status/phase/elapsed`; get the report from `result --json` at `.storedJob.result.rawOutput`.

---

## Wave 4b planning session (2026-08-10)

### I repeated both documented gotchas inside ten minutes

Gotcha 2 (`task --help` is not a help flag) and gotcha 1 (never pipe a running job through
`tail`/`head`) are both written down in this file, and I hit both anyway — burning a real Codex
turn on `--help`, then backgrounding the inventory through `2>&1 | tail -40`.

That is worth more than an apology, because it says something about the artifact: **a gotcha
written as a prohibition doesn't survive contact with momentum.** I read "don't pipe through tail"
and then reached for the shape I always use for a noisy background command. The fix is not a
sterner warning, it's removing the reconstruction step — the templates should carry a literal,
copy-pasteable invocation line so there is nothing to improvise. Added below.

```bash
CX='node /home/chase/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs'
# Long prompt: write it to a file first, never inline it into the shell.
$CX task "$(cat /path/to/prompt.txt)"          # background this via the harness, NOT via `| tail`
$CX cancel <job-id>                            # verified working — this is the fix for a stray job
```

`cancel <job-id>` works and prints the cancelled job's summary. Use it the moment you notice a
wasted job instead of letting it run to completion on quota.

### Scoping greps are Claude's job — "don't explore before delegating" is about execution

Two greps before any delegation changed what wave 4b *is*: `POST /ingest` takes a server-side
`csv_path` and `ingestUpload` still exists at `frontend/lib/api.ts:505`, but **nothing in `app/`,
`components/`, or `lib/` calls it** — `SetupWizard.tsx:322` and `ImportModal.tsx:91` both went to
`api.importLibrary` at some earlier point. Both ingest routes are also filesystem-bound, which
Vercel's read-only serverless FS cannot host. So they are dead code, and wave 4b deletes them
rather than porting them. A third grep confirmed `withApi` already returns a raw `Response`
(`lib/server/http.ts:37`), which decides how `GET /export` is built.

That is three greps to remove two routes from a wave and settle an architecture question. **The
`CLAUDE.md` rule "do not explore the repo before delegating" is about handing Codex a task it will
explore for itself — it is not a ban on the cheap fact-finding that sets scope.** Scope is
Claude's half of the split, and scope decided from stale docs is exactly what the wave-4 inventory
already proved expensive. Worth stating the distinction in the split section so the rule isn't
read as "never grep."

### New inventory-prompt move: ask for the negative result explicitly

The wave-4b inventory asks, as its own deliverable: *does ANY existing Next route handler accept
multipart/form-data or return a non-JSON Response with attachment headers? If not, say so plainly —
that is the answer I need.*

Previous inventories asked the general "anything with no equivalent yet" question and got a good
list. This is narrower: a yes/no about a specific capability, with explicit permission to answer
"no." The reason it matters is that a plan built on an assumed precedent is worse than one that
knows it is on new ground — the draft prompt can then demand a concretely stated approach instead
of "follow the existing pattern."

**It came back clean — and better than clean.** The answer was a flat "No existing Next route
handler calls `request.formData()`, accepts `multipart/form-data`, or reads a `File`," plus the
same for `Content-Disposition`, *plus* a citation to the nearest near-miss
(`app/api/feedback/dismiss/route.ts:23`, an empty 204) with a note that it is not an attachment
precedent. Naming the closest thing that *isn't* the answer is exactly what makes a negative
trustworthy. **Keep this deliverable shape**: ask the specific yes/no, grant permission to answer
no, and it will volunteer the near-miss unprompted.

### `task` is read-only by default — `--write` lives in the forwarding layer you skipped

The first draft dispatch burned a full exploration turn and produced nothing: *"I couldn't create
the requested file because the workspace is mounted read-only and write approval is disabled."*

`CLAUDE.md` says `codex:codex-rescue` **defaults to `--write`** — and that is true of the *subagent*,
which adds the flag per `skills/codex-cli-runtime/SKILL.md:24`. It is not a property of the
companion CLI. So the note in this file recommending you call `codex-companion.mjs` directly to
skip the Sonnet forwarding layer has a hidden cost: **you skip the flag defaults too.** Calling
`task` by hand is read-only unless you pass `--write` yourself.

**A thread's sandbox is fixed at creation — `--write --resume-last` cannot upgrade it.** The
obvious recovery was to resume the thread that had already done the exploration and just add
`--write`. It failed identically: *"The workspace is still reported as read-only by the execution
environment... the current profile still blocks all writes despite the message saying access was
enabled."*

This is not the companion silently dropping the flag. `codex-companion.mjs:491` really does send
`sandbox: request.write ? "workspace-write" : "read-only"` on the resume path too — I checked the
source before spending another run, and the flag is passed. The server-side thread simply keeps the
policy it was born with. So the sandbox is a property of the **thread**, not of the turn, and
`--resume-last` inherits it along with the conversation.

Consequence: **a read-only thread is a dead end for any work that must write.** There is no
recovery that preserves its exploration — you pay for exploration again on a fresh `--write`
thread. Decide read-vs-write at dispatch time, because that is the only time you can decide it.

Three corollaries for the templates:
- Any direct-CLI plan-drafting or implementation invocation needs an explicit `--write` **on the
  first call**. Only inventory/review runs want the default.
- `--resume-last` is for continuing work of the *same kind*. It cannot change permissions.
- "Skip the forwarding layer to save tokens" and "inherit the forwarding layer's defaults" are in
  tension. Prefer the direct call, but write the flags down.

Cost of learning this: one wasted exploration turn, then a second wasted turn on the resume that
could not have worked. Checking the companion source (one grep) is what stopped it at two instead
of three — worth doing the moment a flag appears not to take effect, rather than re-trying it.

### The inventory overturned an assumption again — second wave running

Wave 4's inventory reshaped the wave by proving purge was the easy part and enrichment the hard
one. Wave 4b's did it again, and the assumption it broke was invisible from the plan docs:
**every previous wave inherited a working parity harness, so nobody thought to check whether this
one could.** It cannot. `scripts/gen_parity_fixtures.py:399` sends only `json=` and always calls
`r.json()` on a nonempty response; `write-parity.ts:106` replays the same way. Neither can record
a multipart request or preserve a non-JSON response body with its headers — and wave 4b is
entirely multipart uploads and a CSV/JSON file download.

That converts a footnote into a prerequisite task ordered before every route task. **The
generalizable lesson: inventory the tooling a wave depends on, not just the code it ports.** The
question "can the harness we always use actually record this wave's traffic?" had never needed
asking before, which is precisely why it nearly went unasked.

### A dependency does not discharge a parity burden

Chase chose to add `csv-parse ^7.0.2` / `csv-stringify ^6.8.3` over my recommendation to hand-roll
~100 lines against CPython's `excel` dialect. Fine either way — but the draft prompt now carries an
explicit constraint that the library **does not** remove the obligation to prove CPython behavior,
it only moves where the code comes from. These libraries' defaults are not Python's (the record
delimiter alone: Python's excel dialect is `\r\n`, the library default is `\n`), so the plan must
pin the exact option objects and still test the distinguishing edge cases — embedded comma, quote
and newline, lone `\r`, ragged rows, BOM, trailing empty line.

Worth generalizing: when a decision swaps custom code for a dependency, the *verification* scope
is unchanged. The risk just moves from "did we implement it right" to "did we configure it right,"
which is harder to see in a diff.

### The drafted 4b plan — review verdict

1,120 lines against 4a's 954, structure matching the template exactly, and `git status` clean apart
from the one intended file. Task order encodes the real dependency chain (CSV layer → harness →
shared core → routes → switcher) with a stated reason per edge.

**"WRITE THE TEST BODIES" worked on the first pass.** This is the headline result. Wave 4a needed a
second scoped prompt to close 11 prose-in-a-comment stubs; wave 4b asked up front and got **45
assertions across 14 tests, with zero stub patterns** — `grep -nE "^\s*//\s*(\.\.\.|Also|etc|TODO)"`
returns nothing, as does a TBD/placeholder scan. The open question "is test code a second-prompt
problem or a capability limit?" is now fully answered: **it is a prompt problem, and asking in the
first prompt costs one paragraph and saves a round trip.**

Quality, not just quantity — the never-clobber test asserts
`toEqual({...book, <only the changed fields>})`, so any unexpected mutation of `appRating` or
`appReview` fails, and title-never-updates plus null-preserves-stored fall out of the same
assertion for free.

**The `grep -n` instruction also stuck:** 21 `grep -n` proof checks, zero `sed -n 'N,Mp'` ranges.
Two waves running, an explicitly-reasoned prompt rule has changed the artifact.

**What Claude review caught this time: one imprecise citation, and it is the inverse of 4a's
defect.** Constraint 9 said the schema declares `date(..., { mode: 'string' })`; the schema actually
declares bare `date("date_read")`. But the *conclusion* was right — drizzle's `date()` overload
returns `PgDateStringBuilderInitial` unless mode is explicitly `'date'`, so bare already is string
mode. Where 4a's `DbTx` was a claim that was wrong and would not compile, this was a claim that was
right but described its evidence in a form the repo does not literally contain.

That distinction matters because of the failure mode it invites: an executor greps
`schema.ts` for `mode: 'string'`, finds it on the *timestamp* columns but not the date ones, and
reports "the plan is wrong" — the exact grep-shape false finding this file already documents from
4a. Fixed in place by citing `grep -n 'dateRead: date'`, stating that the bare form is correct, and
adding an explicit "do not conclude the plan is wrong when grepping for one."

**Generalizable:** a correct conclusion with a mis-shaped citation is more dangerous than an
obviously wrong one, because it survives review and detonates during execution. When verifying a
plan's facts, check the *evidence form* as well as the claim.

**A two-model data point.** Codex independently re-verified the inventory against source rather
than trusting it, and reported that `DbTx` now exists — the very type whose absence was 4a's main
defect. The "treat citations as unverified sketches" paragraph keeps earning its place, and this is
the first time it produced a *confirmation* rather than a correction.

All other spot-checked facts held: V13/V14 (`DictWriter` + `CANONICAL_FIELDS`), V17
(`json.dumps(..., indent=2)` at `api.py:554`), V18 (`strftime("%Y%m%d")`, 422 detail string), V20,
V21, V22, V24, V25, and V3's mapping key order against `MAPPING_FIELDS`. The subtlest one is also
correct: `formats.py:86` uses `parse_int(...) or 0` for Goodreads (truncating via `int(float(s))`)
while the other three parsers use half-up `parse_rating`, so `4.9` really does become `4` in
Goodreads and `5` everywhere else.

## Open questions

- ~~Does a Codex-drafted plan hold up to Claude-drafted quality?~~ **Answered** — yes for
  structure and implementation code, no for test code. See the verdict section above.
- ~~Is missing test code a Codex capability limit?~~ **Fully answered in wave 4b — it is a prompt
  problem.** Asking for complete runnable test bodies in the *first* drafting prompt produced 45
  assertions across 14 tests with zero stubs, no follow-up round needed. Always include the
  paragraph.
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
- **Verification honesty held up — keep watching it.** The execution session recorded
  "implementation-complete but LIVE-UNVERIFIED" and enumerated what remained unproven instead of
  reporting done. That is the behavior this workflow most needs and most easily loses. Wave 4a's
  live purge checks are still outstanding (deferred to Chase post-merge), so the plan's "Done when"
  criteria are formally unmet.
- **Review-gate value — still unanswered after a full wave.** The plan's header instructed enabling
  it, but `setup --json` now reports `reviewGateEnabled: false` and the execution session logged no
  gate findings, so it was either never switched on or switched off without being exercised. Not
  guessing which. **Next wave: turn it on, and log whether it fires, what it says, and whether it
  overlaps `on_stop.py`.** Until then treat "the gate helps" as untested.
- **`/codex:transfer`** — untested. Intended as the `/compact` replacement when remaining work is
  mechanical.
- **Quota ceiling.** No visibility yet into how fast the $20 ChatGPT tier burns down under this
  usage pattern, or what happens at the limit mid-wave.
- **Wave 4c architecture (project-specific, but blocks the workflow test):** Vercel has no
  equivalent of FastAPI `BackgroundTasks` or a persistent arq worker. Options are `waitUntil`, a
  cron-driven poller, Redis + external worker, or leaving enrichment on Python through cutover.
  Needs a decision from Chase.
