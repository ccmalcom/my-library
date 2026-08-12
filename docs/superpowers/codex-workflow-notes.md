# Codex-enhanced workflow — running notes

Working notes from folding the `codex` plugin (OpenAI) into the Claude Code loop. Goal: shift
token spend onto the ChatGPT subscription, keep Claude on judgement, and get two-model diversity
on the output. Refine this as we go; graduate settled lessons into the global CLAUDE.md and the
repo's `Claude / Codex split` section.

**Status:** two full cycles complete — wave 4a (2026-08-10) and wave 4b (2026-08-11). 4b is the
first wave to end **live-verified** rather than "implementation-complete, LIVE-UNVERIFIED".

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

Two greps before any delegation changed what wave 4b *is*: `POST /ingest` took a server-side
`csv_path` and `ingestUpload` existed at `frontend/lib/api.ts:505`, but **nothing in `app/`,
`components/`, or `lib/` calls it** — `SetupWizard.tsx:322` and `ImportModal.tsx:91` both went to
`api.importLibrary` at some earlier point. Both ingest routes are also filesystem-bound, which
Vercel's read-only serverless FS cannot host. So they are dead code, and wave 4b deletes them
rather than porting them. Wave 4b subsequently removed both routes and the orphaned client method.
A third grep confirmed `withApi` already returns a raw `Response`
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

## Wave 4c planning session (2026-08-11)

### The review gate fires — first direct observation

`status` now shows short gate jobs interleaved with real ones, each 4–7 seconds, with verdicts like
`ALLOW: The previous Claude turn was only a status check` and `ALLOW: Previous turn only edited a
design specification`. So after two waves of "was it ever actually on?", the answer is **yes, it
runs, it is fast, and it correctly no-ops on non-code turns.**

What is still unanswered is the part that matters: **it has not yet been observed BLOCKing anything,
or saying something `on_stop.py` would not have caught.** Every verdict so far is an ALLOW on a
turn that edited documentation. Judge it during a 4c *execution* session, where turns actually
produce code. Two practical notes: the gate jobs pollute `status` output (filter out summaries
starting `ALLOW:`/`BLOCK:` when hunting for a real job), and they consume quota on every
edit-producing turn, which is the cost side of the ledger.

### An inventory that found dead code — and why that mattered more than the summary

The 4c-1 inventory (1,028 lines) was asked for "the COMPLETE HIGH/MEDIUM/LOW rule set as an
exhaustive condition list rather than a summary." Asking for exhaustiveness instead of a description
is what surfaced this, in `mylibrary/enrich.py`:

```python
if best_sim >= _WEAK_SIM:
    return best, "LOW"
return best, "LOW"
```

**Both branches return LOW**, so the 0.60 weak threshold has no effect on output. Verified against
source before believing it. A second finding from the same deliverable: `_resolve_one` returns HIGH
the instant an ISBN lookup returns anything — no title-similarity, author, or ISBN-confirmation
check. HIGH is pure ISBN trust.

Neither is a bug to fix; both are behavior to reproduce. But both are exactly what a competent
engineer "cleans up" during a port — the dead branch reads as an obvious simplification, and the
unverified HIGH reads as a missing guard. Either edit would silently change the foundation that
locked decision #5 rests on. **Both went into the drafting prompt as named quirks with instructions
to keep the behavior and annotate rather than collapse.**

Generalizable: **ask an inventory for exhaustive conditions, not descriptions, wherever a port must
be behavior-identical.** A summary of scoring rules would have said "LOW when similarity is below
the strong threshold" and the dead branch would have survived into the port as a real threshold.

### The 4c-1 draft's one real defect: it planned to re-port code the repo already had

931 lines, 11 tasks, zero test stubs, expected-RED stated by name with "No failure count is
prescribed" — both wave-4b prompt lessons landed verbatim on the first try. Every constant I checked
was right, including the two `difflib` ratios (`0.85` and `0.8`, verified against real CPython),
`_CONF = {HIGH: 0.95, MEDIUM: 0.70, LOW: 0.30, NONE: 0.0}`, and all four normalization expectations
traced by hand. It also volunteered five quirks I had not named — the best being that a LOW Open
Library candidate beats a LOW Google one regardless of score, because scores are never compared
across catalogs.

**But Task 3 instructed the executor to "implement the Ratcliff/Obershelp matching-block algorithm
used by Python `difflib.SequenceMatcher`" — which wave 3c-1 already shipped.**
`frontend/lib/server/similarity.ts` exports `ratio()`, `STRONG_SIM`, and a `titleSim()` whose
docstring reads *"enrich.\_title\_sim: ratio over the SUBTITLE-STRIPPED normalized titles"* — the
exact function `_score_candidates` needs. The same task invented `normalizeEnrichmentTitle`,
`enrichmentSurname`, and `normalizeEnrichmentFullTitle`, all three of which already exist in
`dedup.ts` under a header saying *"Ports of mylibrary/enrich.py dedup helpers."* The plan never
referenced either module.

Unfixed, that lands a second SequenceMatcher and three duplicate normalizers in a codebase whose
entire discipline is byte-parity — two ports of one Python function, free to drift. Fixed in place
with a review banner on Task 3, corrected imports, repaired proof-of-fix greps (they grepped for a
`STRONG_SIM` redeclaration that must not exist), and a new Global Constraint 23: **`rg` under
`frontend/lib/server/` before implementing any helper.**

**This is a new failure mode, and the most useful thing in this session.** Wave 4a's `DbTx` defect
was a claim about the repo that was false. This is the opposite: everything the draft said about
*Python* was true, and it simply did not know what the *Node* side already contained. An inventory
scoped to "port X" naturally asks what X does, not what has already been ported of it — and I
reinforced that by scoping deliverable 7 to `catalog.ts`/`catalogCache.ts` specifically, which
is exactly where I told it to look and therefore the only place it looked.

**Prompt fix for the next inventory:** add a standing deliverable — *"list every Python function in
scope that ALREADY has a Node port, with its module and exported name."* Phrased as a search across
`frontend/lib/server/`, not as a question about the named modules. Cheap to ask, and it converts the
most expensive class of port defect into a table.

### Design work is Claude's, and it changed the wave

The 4c architecture was a genuine design decision, not a port, so it ran through brainstorming
rather than delegation: Railway is being fully decommissioned (which eliminated "leave it on
Python"), Vercel is on Hobby (which eliminated cron-driven chunking), and enrichment's existing
idempotency made chunk-and-resume nearly free. The result — self-chaining with poll-repair and a
daily janitor — is written up in `docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md`.

Two things worth carrying forward from it. First, **the spec records a deliberate divergence from
Python** (Python has no guard against enrichment spam at all; chaining would make that strictly
worse, so Node gets a DB-enforced single-active-job index). Divergences need writing down at design
time or they read as port bugs later. Second, **wave 4c split into 4c-1 (domain risk: the resolver
and confidence scoring) and 4c-2 (platform risk: the job mechanism)** on the same seam that worked
for 3c — so a resolver bug and a chaining bug cannot arrive in the same diff.

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
- **Does the two-model split catch things a single model wouldn't?** **Wave 4b is the first real
  evidence, and it points at genuine two-way catching rather than one-way review.** Codex caught
  *Claude's* wrong expected-red count and *Claude's* arithmetic, and reported three unprompted plan
  deviations; Claude caught Codex's three confident-but-wrong attributions. Neither direction was
  redundant. **But the underlying mechanism still looks like verification, not model diversity** —
  in nearly every case the catch came from one side actually running something the other had only
  reasoned about. Provisional read: the value is *two independent parties who each run things*, and
  the model difference is incidental. Still worth watching.
- **Verification honesty — held two waves running, and 4b raised the bar.** Both sessions refused
  to over-claim on a fully green suite and enumerated what remained unproven. 4b then went further
  and actually ran the live pass, which found evidence no fixture could produce (byte-identical
  export against a shared live DB with non-ASCII rows). It still declined to claim the one thing it
  could not observe — that a human clicking Download gets a usable file — because a programmatic
  blob download doesn't persist under automation. **That is the exact behavior to protect.** Keep
  watching it: a green suite is the moment over-claiming is easiest, and 4a's live purge checks
  remain outstanding.
- **Review-gate value — firing confirmed, worth still unproven.** Two of the three sub-questions are
  now settled: it is switchable on (`reviewGateEnabled: true` during 4b), and as of 2026-08-11 it
  **demonstrably fires** — short 4–7s jobs interleaved in `status`, with verdicts like
  `ALLOW: Previous turn only edited a design specification`. So it runs and it no-ops correctly on
  non-code turns. What remains unknown is the only part that justifies the cost: **it has never been
  observed BLOCKing, or saying anything `on_stop.py` would not have caught.** Every logged verdict
  is an ALLOW on a documentation turn. Contrast with `on_stop.py`, which demonstrably earned its
  place in 4b by catching the broken `tsc` that neither the gate nor Codex's self-report did.
  **Judge it during 4c execution, where turns produce real code — if it still only ALLOWs, turn it
  off.** Operational note: filter summaries beginning `ALLOW:`/`BLOCK:` out of `status` when hunting
  for a real job.
- **`/codex:transfer`** — untested. Intended as the `/compact` replacement when remaining work is
  mechanical.
- **Quota ceiling.** No visibility yet into how fast the $20 ChatGPT tier burns down under this
  usage pattern, or what happens at the limit mid-wave.
- ~~**Wave 4c architecture**~~ **Decided 2026-08-11** — see
  `docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md`. Chunked, resumable jobs driven
  by self-chaining invocations, with client-poll repair and a daily janitor. Railway is fully
  decommissioned at cutover (killing the "leave it on Python" option) and Vercel is on Hobby
  (killing cron-driven chunking). Wave 4c splits into 4c-1 (resolver + confidence scoring) and 4c-2
  (the job mechanism).

---

## Wave 4b execution findings

### The "verify the plan against the running interpreter" instruction paid off immediately

Task 1's prompt added one instruction beyond the verbatim task text: *run the fixture through
`.venv/bin/python` and report any disagreement rather than adapting either side.* Codex came back
having implemented **nothing** and reporting two byte-significant CPython disagreements plus one
unexported symbol. All three verified true. The plan's golden CSV fixture — the contract the rest
of the wave is built on — was wrong before a single line of code existed.

This is the `migration-plan-prose-vs-source` failure mode caught at the cheapest possible moment.
**Generalize it: when a plan asserts the byte-level output of a library, make Task 1 run the library
rather than trusting the plan's transcription of it.** Plan authors read source and transcribe;
transcription of escape-heavy string literals is exactly where it breaks down.

### The three findings

1. **`\r` forces CSV quotes** (plan was wrong). CPython `excel` is `QUOTE_MINIMAL`, and minimal
   quoting triggers on delimiter, quotechar, *or any character in `lineterminator`* — `\r\n`. So a
   lone `\r` in a field is quoted: `"lone\rreturn"`, not `lone\rreturn`. The plan had it bare in
   **two** places (Task 1's writer fixture and Task 6's export golden). Fixing only the reported one
   would have shipped the same defect three tasks later.
2. **BOM: plan right, Codex wrong — layer mismatch.** Codex correctly showed
   `csv.DictReader(io.StringIO(text))` yields `['﻿a', 'b', 'c']`, then concluded the plan's
   `["a","b","c"]` was wrong. But `api.py:486` decodes `utf-8-sig` in `_decode_upload` *before* the
   text reaches `formats.py:48`, so the pipeline yields `['a','b','c']`. The plan described
   end-to-end behavior; Codex tested one layer in isolation. Both outputs were real; only the
   framing differed.
3. **`pyRound` is module-private** (`serialize.ts:54`, bare `function`). The plan's contrast
   assertion imported it. Resolved by using the already-exported `pyRoundHalfEven`, which *is*
   Python's one-arg `round()`, rather than widening the module surface for a test.

### Lesson: a correct observation can still be a wrong conclusion

Finding 2 is the mirror image of wave 4a's false-FK finding, and more dangerous. Wave 4a's was a
grep that found nothing. This one was a **real, correctly-executed experiment** whose output
genuinely contradicted the plan — it just measured the wrong layer. The standing rules' "treat
citations as unverified sketches" paragraph primes Codex to hunt plan errors, and a primed hunter
reports a layer mismatch as a plan defect.

So the review checklist item "before contradicting a citation, open the cited range" needs a
companion: **before accepting a contradiction, check that the experiment measured the layer the
claim was about.** Ask *where in the pipeline does this transformation happen?* For finding 2 the
answer — decode-time, not parse-time — resolves it in one grep. Had it been accepted at face value,
Node would have preserved a BOM in the first header of every imported CSV.

Practical consequence: **a refusal-with-findings is a good outcome, not a failed task.** It cost one
cheap job and saved a wrong contract propagating through six. But each finding still needs
independent adjudication; two of three were plan bugs, one was a Codex bug, and the wrong call
either way is expensive.

### Review gate — now actually on

`setup --enable-review-gate` reported `reviewGateEnabled: true` for this repo, resolving the
previous wave's open question about whether it was ever switched on. Whether it *fires* and what it
says is still unlogged. Continue tracking.

### The plan's per-task verification steps omit `type-check` and `lint` — add them to every dispatch

Task 1's Step 6 verification is `npx vitest run ... ; grep ... ; npx prettier --write ...`. Every
other task in the wave follows the same shape. `npm run type-check` and `npm run lint` appear only in
Task 9. The consequence showed up immediately: Task 1 shipped **green tests and a broken
`tsc --noEmit`** twice in a row, because nothing in the task's own verification would ever have
caught it. It was `.claude/hooks/on_stop.py` — not the task, not Codex's self-report — that surfaced
it.

Deferring type-check to Task 9 means type errors accumulate silently across eight tasks and then
land as one undifferentiated pile on the task least able to attribute them. **Add
`npm run type-check` (and `npx eslint <touched files>`) to the verification block of every task
prompt in this wave, regardless of what the plan's step says.** Cheap per task; brutal if batched.

Corollary for prompt-writing: **Codex runs the commands you list and no others.** It is not
"forgetting" to type-check — an unlisted command is out of scope. If a gate matters, name it in the
prompt; do not assume the plan's Global Constraints imply it.

### The `on_record` typing trap, and what green tests did not prove

The first fix used `context.columns`, which **does not exist** on csv-parse's `InfoRecord` (only
`error`, `header`, `index`, `raw` + `InfoDataSet`). At runtime it was `undefined`, so the
`?? Object.keys(record)` fallback silently supplied headers from the *record keys* — which is exactly
why header-only input produced no headers. One non-existent property produced a passing test suite
and a wrong primitive.

Useful facts for anyone touching this file (read from `node_modules`, csv-parse 7.0.2):

- `parse<T = unknown, U = T>(input, options: OptionsWithColumns<T, U>): T[]` — output and input record
  types are both controllable via explicit generics. The mismatch that broke tsc was `on_record`
  taking `Record<string, string>` while returning `CsvRecord` (whose index signature admits `null`
  and `string[]`) with no generics supplied.
- `CsvError` declares `[key: string]: unknown`, so `context.error?.record` needs **no** cast; the
  `as unknown as { record?: unknown }` double cast in the delivered code was unnecessary.
- `Options<T = string[], U = T>` at `index.d.ts:276`.

Wider lesson, and the second time this wave: **a passing test suite proves the specified case works,
not that the primitive is correct.** Task 1's edge-matrix fixture is one rich input *with* data rows,
so it structurally could not exercise the zero-data-row path. When reviewing, ask what input shape
the test file cannot express — that is where to probe. Both real Task 1 defects lived there.

### `--background` is a Claude-side flag and never reaches `task` — every Codex job has a ~10 min cap

`commands/rescue.md:19` is explicit: "`--background` and `--wait` are execution flags for Claude Code.
Do not forward them to `task`." So `/codex:rescue --background` backgrounds the *subagent*, while the
companion's `task` call still runs foreground with a ~10-minute limit. Wave 4a and this wave's Task 1
never noticed because every job finished in 1-4 minutes. Task 2 hit the wall and was killed
mid-flight, leaving 3 applied file changes and no fixtures.

**Consequence to design around: a Codex task must fit in ~10 minutes of wall clock, including its own
exploration.** Prefer several narrow tasks over one broad one. Check for partial application after any
killed run — `git status` — because file changes already applied are NOT rolled back.

### git's pager hangs the Codex shell, and the hang gets misattributed

The Task 2 run died because it invoked `git diff -- <paths>`, which hung and exited 130. It then
reported that `scripts/gen_parity_fixtures.py` "did not complete after roughly ten minutes and
produced no fixture output." That generator runs in **1.8 seconds**. The wrong component was blamed
for the entire lost budget.

Two rules from this:

- **Always pass `GIT_PAGER=cat` or use `git --no-pager`** in Codex prompts that inspect diffs.
- **When a run reports "X is too slow", verify X directly before believing it.** This is the third
  instance this wave of a confidently-reported, plausible, *wrong* conclusion drawn from a real
  observation (after the BOM layer mismatch and the `context.columns` phantom). The pattern is
  consistent enough to treat as the default expectation: Codex's *observations* are reliable, its
  *attributions* need checking.

### Generated fixtures must be Prettier-ignored, and the plan said the opposite

`.prettierignore` already carried the rule and the reasoning for `fixtures/claude/`: the generator
writes `json.dumps(indent=1)`, Prettier wants 2-space, so "formatting them is undone by the very next
re-record." `fixtures/parity/` — written by the sibling generator, same `indent=1` — was never added.
Nothing surfaced it until a re-record touched those files and the stop-time `prettier --check` fired.

Note the plan's Task 2 Step 6 explicitly instructs `npx prettier --write ... write-scenarios.json`,
which **contradicts the repo's own documented convention** and would have produced thousands of lines
of churn reverted by the next re-record. Verified that all three parity fixtures were already
non-Prettier-clean at HEAD before concluding this. Fix was to extend the existing rule to the missed
directory, not to format generated output.

Generalizable: when a gate fires on a generated file, check whether the repo already has a policy for
its sibling. The convention usually exists and was just applied incompletely.

### Recorded fixtures that embed a clock reading expire silently

Task 2's recording captured two values derived from "now": `content-disposition:
attachment; filename="mylibrary-backup-20260811.csv"` (compared with an exact `toEqual`, not routed
through `maskVolatile`) and `exported_at`, whose first mask normalized the time but *captured and
preserved* the date. Both would have gone red on the first replay after a UTC date rollover — during
Task 6 or later, with no code change, looking exactly like a real parity break.

The fix worth reusing: **mask the value, assert the format.** Replace the whole timestamp with a fixed
literal only when it matches `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00` exactly, so a
3-fractional-digit or `Z`-suffixed value is left unmasked and still fails — which is the entire point,
since that is precisely the Python-vs-JS difference Constraint 7 exists to catch. Normalize only the
8 digits of the filename stamp, symmetrically on both sides, keeping the rest of the header exact.
And **prove date-independence with a test that crosses the boundary** (23:59:59 vs 00:00:01 the next
day) rather than asserting the regex handles it.

**Ask of any new fixture: does this value come from a clock?** If yes it needs masking, and the mask
needs its own test.

### Codex's sandbox cannot run FastAPI `TestClient` — fixture recording is Claude's job

Task 4 needed one new recorded fixture. Codex ran `.venv/bin/python scripts/gen_parity_fixtures.py`,
which hung; it then reduced to a minimal in-process `TestClient` request, which also hung (exit 130
both times). It correctly refused to hand-write the fixture and reported the blocker instead of
faking it. I ran the same generator from Claude's shell: **1.68 seconds, exit 0.**

So this is a sandbox restriction on whatever `TestClient` does (socket/thread setup), not a slow
generator. Combined with the earlier `npm install` failure, the rule is:

**Codex writes the recorder scenario; Claude runs the recorder.** Put the scenario addition in the
Codex task, and explicitly tell it NOT to run `gen_parity_fixtures.py` — otherwise it burns minutes
of its ~10-minute budget hanging on a command that cannot succeed. Claude regenerates afterward and
verifies the recorded body.

Second-order benefit: this keeps the "never fabricate a golden" rule structurally enforceable. The
agent that cannot record is also told not to invent — and it has now twice reported a blocker rather
than inventing, which is the behavior to protect.

### Codex corrected *my* arithmetic, and it was right

I told Task 4 to expect "exactly 2 remaining failures" after it landed. Codex pushed back: `/export`
is three separate Vitest cases (`export-csv`, `export-json`, `export-invalid-format`), so Tasks 5-6
account for four failing *tests*, not two. Verified — the real count is 4. I had conflated route
groups with test cases.

Worth recording because the asymmetry runs both ways: the standing rules prime Codex to treat my
instructions as unverified sketches, and here that produced a correct challenge to a number I had
stated confidently. Expected-red counts are exactly the kind of thing to state as "these test names"
rather than "this many failures" — a count is a claim that can silently drift as test topology
changes, and a wrong one trains the executor to ignore the gate.

### Probing the real app before dispatching keeps finding plan bugs

Before Tasks 4 and 5 I ran the actual FastAPI app and measured every error body the task would have
to reproduce. Both times this found something the plan got wrong or omitted:

- **Task 4:** the plan asserted `{detail: "Field required: file"}` for a missing upload. Nothing
  produces that — a missing form field is FastAPI's own request-validation error, so the body is a
  *list*: `{"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required","input":null}]}`.
  This is the first place in the migration where that shape matters; every other recorded 422 is a
  `{"detail": "<string>"}` from an explicit raise.
- **Task 4:** the 10 MiB / 413 limit has **no** Python counterpart (`grep` for `MAX_*BYTES`,
  `content_length`, `max_size`, `10485760` across `mylibrary/` finds nothing). It is new behavior
  Constraint 10 introduces for serverless. That needs stating in both directions: no parity fixture
  can exist for it, *and* nobody should later "restore parity" by deleting it.
- **Task 5:** the plan cites line ranges for the mapping/format errors but not their **precedence**.
  Measured: a request with both a bad suffix and bad mapping returns `Uploaded file must be a .csv`,
  because `_decode_upload` runs before mapping parsing. Ordering is observable behavior and a plan
  that only lists the strings does not pin it.

Generalizing: **a plan's cited error strings are transcriptions; its error *ordering* is usually
unstated.** When several validations can fail on one request, measure which one wins before handing
the task off, because an executor will pick an order that looks reasonable and be wrong ~half the time.

### Wave 4b outcome, and the one technique that carried it

Nine plan tasks became **thirteen Codex dispatches** (Tasks 1 and 3 split; Tasks 1, 2 and 6 needed
follow-up fixes). Final state: Jest 38/38, Vitest 62 files / 408 tests, `tsc` clean, `eslint .` clean,
pytest 360 passed, all three routes flipped, dead ingest gone.

**Six plan defects and four helper-level divergences were found before or during execution. Every single
one was found by running something, and not one by reading code.** The pattern, in order of value:

1. **Differential-test the port against the original.** Run every ported helper against its Python
   counterpart over a shared input matrix and diff the output. This found four divergences in
   `import-csv.ts` (unpadded dates, mixed date separators, hex/octal/binary literals, underscore
   separators) that 11 passing hand-written tests had missed, and later proved the JSON escaper
   byte-identical to `json.dumps` across 22 cases. Cheap, mechanical, and it does not depend on guessing
   which cases matter — which is exactly the thing hand-written tests get wrong.
2. **Probe the live app for every error body the task must reproduce, before dispatching.** This found
   the invented missing-file 422 and the unstated error precedence. A plan's error *strings* are
   transcriptions; its error *ordering* is usually never stated at all.
3. **Run the actual library when the plan asserts its byte-level output.** Task 1's CPython check found
   a wrong golden before any code existed, in two places.

**The corollary is the real lesson: a green suite proves the specified cases work, not that the port is
faithful.** Every defect this wave lived in an input shape the test file could not express — a
zero-data-row CSV, an unpadded date, a hex-looking cell, a non-ASCII title, a taste signal (the seed has
none). When reviewing a port, ask what the tests *cannot* say, then go measure that.

### Verification honesty held again — and the green suite is the moment it's most at risk

The wave ends with every gate green, which is precisely when "done" is easiest to over-claim. It is not
done: nothing was exercised in a browser, the 10 MiB rejection never saw a real HTTP request, and
export→re-import was proven only at the parser level, never by downloading a file from the app and
feeding it back. The plan's own "Done when" list is therefore **not** fully met, and the verification
record says so explicitly rather than implying the suite settles it.

Same shape as wave 4a's outstanding live purge checks. Two waves running, the pattern is consistent
enough to state as a rule: **for this project a wave ends "implementation-complete, LIVE-UNVERIFIED",
and the live pass is Chase's** — because the write paths hit real dev Postgres and an agent must not
run destructive writes there unattended.

### Division of labour, now settled

Codex cannot: `npm install` (no network), `gen_parity_fixtures.py` / any FastAPI `TestClient` (sandbox
hang — and `tests/conftest.py` imports it, so **the whole pytest suite is off-limits**, not just the API
tests). Claude does those. Say so in the prompt: an unrunnable command silently eats minutes of a
~10-minute budget, and Task 2 lost an entire run that way.

The split turns out to be load-bearing rather than annoying: the agent that cannot record a golden is
also the one told never to invent one, and across three opportunities it reported the blocker instead of
fabricating. Keep it that way.

### Prompt-writing rules earned this wave

- **State expected-red by test NAME, never by count.** I said "expect exactly 2 failures"; the real
  number was 4 because `/export` is three separate cases. Codex caught it. A count is a claim that
  drifts with test topology, and a wrong one teaches the executor to ignore the gate.
- **List every gate you want run.** Codex runs the commands you name and no others. `type-check` and
  `lint` appear only in the plan's Task 9, so Task 1 shipped a broken `tsc` twice. Add them to every task.
- **When the plan says to edit something, allow for it not being there.** Task 7 told me to fix `/ingest`
  wording in `wave-3-verification.md`; my grep found nothing. Instead of dropping it or letting Codex
  invent an edit, I asked it to locate the wording and report plainly if absent. It found the real thing
  at lines 82-83 that my pattern had missed — both halves of that instruction mattered.
- **Pre-empt the "unused import" trap when the executor cannot run the suite.** Task 7 deleted two
  handlers and their now-orphaned imports. `get_settings` looked orphaned but was still used by surviving
  handlers, and with pytest unavailable to Codex nothing mechanical would have caught a wrong deletion.

### Wave 4b WAS live-verified — and the live pass found things the suite could not

Unlike waves 2, 3 and 4a, Chase asked for a full browser verification, so wave 4b ends
**live-verified** rather than "LIVE-UNVERIFIED". Run against the isolated `mylib-w3b-verify`
container, never dev Supabase; safety was confirmed before any write by checking the Node API served
the container's 4 seeded books.

Everything the parity suite already asserted held up in the real UI. The genuinely *new* evidence:

- **The strongest parity proof available is running Python against the same live database and diffing
  bytes.** With real non-ASCII rows in the library (`Café Extraordinaire`, `日本語の本`), Python's
  `export_csv` and `json.dumps(export_json(...), indent=2)` were run against the same container and
  diffed against what the Node route had just served: **byte-identical, both formats.** That closes a
  gap no fixture could — `seed.json` is pure ASCII, so the recorded goldens never exercised
  `ensure_ascii` escaping at all. **Generalize: when a port has a live original, diff the two against
  one shared database. It beats any fixture, because it needs no recording step and no masking.**
- **Locked decision #2 verified against a real database**, not PGlite: an existing book's
  `goodreads_rating` moved 5 → 4 on re-import while `app_rating`, `app_review`,
  `feedback_updated_at` *and* `source` stayed untouched.
- **Round-trip re-importability confirmed for real** — exporting and re-importing the app's own CSV
  matched all 6 books with **zero duplicates**, including the non-ASCII titles, which proves the
  decode and the dedup normalization both handle them.

**The environment gotcha that cost the most time, and the lesson in it:** browsing `127.0.0.1` instead
of `localhost` silently breaks the app. Next 16 blocks cross-origin dev resources, so hydration never
completes — the page renders, but no click fires and no client fetch happens. I spent several round
trips treating a dead modal as an app bug, checking console (empty) and network (static only), before
the dev-server log gave it away. **The lesson: when the UI is inert but the API is healthy, suspect the
harness before the code — and read the dev server's own log early.** It had said so all along.

Also worth knowing: a programmatic blob download does not persist to disk under automation, so
"a human clicking Download gets a usable file" stayed explicitly unverified rather than being claimed.
Both facts are now in the [[node-route-live-verification]] memory.

## Wave 4c-2 live verification — two defects no suite could have caught (2026-08-11)

Wave 4c-2 was signed off with all five gates green. Thirty minutes of driving the real app found
two defects, and the shape of both is worth generalizing.

**1. The test database was more forgiving than the real one.** `POST /enrich/start` 500'd on its
first real request: `enrich_jobs.progress`/`total` are `NOT NULL` with no server default, the
insert omitted them, drizzle emitted SQL `default`, Postgres refused. It passed 493 tests because
the hand-written PGlite mirror declared `not null default 0` for those columns. **A hand-written
mirror of a migration-owned schema is a second source of truth, and it will drift toward whatever
makes tests pass.** Worse, `tsc` cannot save you here: drizzle's `$inferInsert` treats a
`notNull()` column with no `.default()` as optional, so the only signal is a runtime constraint
violation against a database that has the real DDL.

The generalizable guard — derive the contract from the SQLAlchemy models (the Alembic baseline is
`Base.metadata.create_all()`, so the models *are* the schema) and assert the mirror against it —
is Task 2 of the wave 4d plan.

**2. The port rejected the input the feature exists to accept.** `POST /api/import` cannot parse a
real Goodreads export: Goodreads Excel-escapes ISBNs as `="9780441172719"`, Python's `csv` accepts
a quote that is not at field start, `csv-parse` throws `Invalid Opening Quote`. The repo's own
`tests/sample_goodreads.csv` has this shape on all six rows — the fixture was right there and the
Node tests simply never fed it through the parser. **When porting a parser, the first test should
be the real-world artifact the parser exists for, not a synthetic minimal case.**

**The meta-lesson, and it is the same one both times:** a green suite proves the specified cases
work. It says nothing about cases nobody specified, and *less than nothing* when the test harness
itself is the thing that diverged. Both defects were on the happy path of the primary user flow.
Neither needed a clever test — they needed one real request.

Two process notes from the same session:

- **Never `npx prettier --write` over a glob.** `lib/server/__tests__/*.test.ts` reformatted twelve
  committed files I had not touched. Name every file explicitly; check `git status` after.
- **A verification run that changes a constant must change it back and re-verify.** Proving the
  `after()` continuation needed `CHUNK_BUDGET_MS` at 1500 instead of 240000; the final run was
  repeated at the production value so the evidence matches what ships.
