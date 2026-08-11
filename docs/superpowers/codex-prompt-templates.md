# Codex prompt templates

Battle-tested prompt shapes, distilled from 17 Codex jobs across wave 4a (inventory → plan →
execution). Copy a template, fill the brackets, delete what doesn't apply. The rationale for every
rule here lives in `codex-workflow-notes.md`; this file is the operational version.

Companion path used throughout:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"
```

---

## Standing rules — paste into every prompt

```
Treat every code block and file:line citation you are given as an UNVERIFIED SKETCH. Check every
symbol, type, column, and function name against the real repo before using it, and report any
deviation you find rather than silently adapting. Do not invent `any` to work around a type that
does not exist.

Do not run git commit, cherry-pick, merge, push, or deploy. Chase does all of those by hand.
Run `npx prettier --write` only on files you touched. Never format the repo.
```

The "unverified sketch" paragraph earned its place — Codex reported unprompted, correct deviations
on all three execution tasks. **But note the asymmetry it creates:** it primes Codex to expect plan
errors, which makes it more likely to accept a *wrong* correction you hand it. See the review
checklist below.

---

## 1. Research / inventory run

Read-only. Use before committing to any scope.

```
Read-only investigation. Do not edit any file.

Context: [2-3 sentences. Where the project is, what already shipped, what this is for.]

Produce a precise inventory I can turn into an implementation plan:

1. [deliverable]
2. [deliverable]
...
N. How an already-ported/already-working example is structured end to end: pick [KNOWN GOOD
   EXAMPLE] and list every file involved, the layering convention, where the transaction wrapper
   goes, and how its tests are wired.
N+1. Anything in scope with NO equivalent yet that would need new infrastructure.

Output as a structured markdown report with file:line citations throughout. Be exhaustive on
specifics, do not summarize away detail. Do not propose a design or write code.
```

Why each line matters:

- **`Do not propose a design or write code`** is load-bearing. Without it you get an opinion where
  you needed facts.
- **Numbered deliverables** produce inventories; vague asks produce summaries.
- **`file:line` citations** make the output usable as plan input instead of something to re-verify.
- **The known-good-precedent item** is what surfaces layering conventions in reusable form. It was
  the single highest-value item in the wave 4 inventory.
- **The infrastructure-gap item** is what catches "this isn't a port, it's a design problem" before
  you plan it as a port.

Persist the result into the repo immediately — `result <job-id> > docs/.../inventory.md`. The
execution session has no memory of the conversation that produced it.

---

## 2. Plan-drafting run

```
Write ONE new file: [PATH]
Do not modify any other file. No source changes.

Follow the EXACT structure and level of detail of [EXISTING PLAN PATH] — read it first. Its
section order is: [list sections]. Match its voice and density: real code in the steps, exact
file paths.

Source material already in the repo:
- [inventory path] — [what's in it]
- [source-of-truth files]
- CLAUDE.md — project conventions

SCOPE — this wave is [X] ONLY:
- [what's in]
- [what's out] is wave [Y]. Do NOT plan it. State the boundary in Global Constraints.

Requirements the plan must encode:
1. [requirement] — because [what went wrong last time it wasn't done].
...

WRITE THE TEST BODIES. Every test must be complete runnable code against real schema columns —
not a describe block with comments explaining what to assert. Assertions compare whole objects
so that supersets fail.

PROOF-OF-FIX CHECKS: when a step must prove something landed, cite `grep -n '<exact code>'`, never
`sed -n 'N,Mp'`. Line numbers drift between plan-authoring and plan-execution; symbols do not.

This doc gets executed by an agent in a fresh session with no memory of this conversation.
```

Two rules here were paid for in defects:

- **`WRITE THE TEST BODIES`** — Codex reliably writes complete implementation code and reduces
  test code to prose-in-comments. This is a second-prompt problem, not a capability limit; asking
  explicitly fixes it entirely.
- **`grep -n` not `sed -n`** — wave 4a's Task 0 gate cited a `542,551p` window for a guard that had
  moved to line 552. A literal reading would have failed a gate that actually passed.

Encode past failures **with the reason attached**. "Do X" gets followed loosely; "do X because last
time not doing it left the repo with a failing suite" gets followed precisely.

---

## 3. Task-execution run

One task at a time, `--background`, task text lifted verbatim from the plan.

```
Execute Task [N] of [PLAN PATH] exactly as written. Read the plan's Global Constraints first.

[PASTE THE TASK TEXT VERBATIM]

[standing rules block]

When done, report: files touched, commands run with their actual output, and any place the plan
disagreed with the real repo.
```

Do **not** explore the repo before delegating. Hand it the task text as written — Codex does its
own exploration, and Claude reading files first is exactly the token spend this workflow exists to
avoid.

---

## 4. Claude's review checklist for Codex output

Run this on every returned task. This is where the workflow's errors actually get caught.

- [ ] **Verify factual claims, don't spot-check them.** In wave 4a every npm script name, helper
      path, and schema export checked out — but `DbTx` did not exist, and that was invisible
      without grepping.
- [ ] **Before contradicting a citation, open the cited range.** A single-form grep is not proof of
      absence for any API with more than one spelling. Wave 4a produced a false "the plan is wrong"
      finding because `grep -c 'references('` returned 0 while the schema declared its only FK via
      the table-level `foreignKey({...})` form. *"My grep found nothing" and "the fact is not
      there" are different claims.*
- [ ] **Never propagate an unverified review finding into later prompts.** That false FK finding
      got fed into two subsequent task prompts as established fact. Propagation is efficient when
      right and contaminating when wrong.
- [ ] **Re-run verification independently.** Don't accept the job's own report that tests passed.
- [ ] **Re-review anything Codex added beyond what you asked for.** The additions are usually good,
      but they're the parts nobody specified and therefore nobody checked. Wave 4a's unrequested
      header block introduced a naming inconsistency.
- [ ] **Check the diff for formatting churn.** `prettier --write` on a touched file reformats
      pre-existing code; wave 4a saw 11 purely cosmetic deletions in `pglite.ts`.
- [ ] **Confirm scope.** `git status --short --untracked-files=all` — did it touch only the
      intended files?

---

## 5. Useful commands

**Canonical invocation — copy this, don't improvise it.** Both of the gotchas below were hit again
during wave 4b planning *by someone who had just read them*, because each one required
reconstructing a command instead of pasting one.

```bash
CX='node /home/chase/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs'

# Long prompt: write it to a file first. Never inline a multi-paragraph prompt into the shell.
$CX task "$(cat /path/to/prompt.txt)"            # READ-ONLY — inventory and review runs
$CX task --write "$(cat /path/to/prompt.txt)"    # anything that must create or edit a file
$CX task --write --resume-last "<delta only>"    # continue a thread that was ALREADY --write
$CX cancel <job-id>                              # kill a stray job the moment you notice it
```

**`--write` is not a companion default, and it must be on the FIRST call.** `codex:codex-rescue`
adds it (`codex-cli-runtime/SKILL.md:24`); the CLI does not. Calling `task` directly to skip the
forwarding layer also skips its flag defaults — a plan-drafting run without `--write` explores, then
fails with "the workspace is mounted read-only."

**You cannot rescue that thread.** A thread's sandbox is fixed when it is created, so
`--write --resume-last` fails the same way even though `codex-companion.mjs:491` genuinely sends
`sandbox: "workspace-write"` on resume. A read-only thread is a dead end for any work that writes:
start fresh with `--write` and re-pay the exploration. Decide read-vs-write at dispatch, because
that is the only moment you can.

- **Never pipe a running job through `tail`/`head`** — the pipe buffers, the output file stays
  empty, and it looks exactly like a hang. Watch with `status` instead; nothing is lost either way
  because the job store has the full output.
- **`status --json` is unusable raw** — it echoes the entire prompt back, so one status check on a
  large task can dominate the context window. Filter it:

```bash
$CX status --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
for label in ('running','recent'):
    for j in d.get(label) or []:
        print(f\"[{label}] {j['id']} {j['status']}/{j.get('phase') or '-'} \"
              f\"{j.get('elapsed') or j.get('duration') or ''} :: {(j.get('summary') or '')[:60]}\")
"
```

Verified 2026-08-10. The top-level keys are `running`, `recent`, `latestFinished`, `needsReview`,
`config`, `sessionRuntime`, `workspaceRoot` — **there is no `activeJobs` key**, and `title` is
always the literal string `"Codex Task"`, so filter on `summary`. `recent` is scoped to the current
session; add `--all` to see jobs from earlier sessions in this repo.

- Full result payload: `$CX result <job-id> --json` → `.storedJob.result.rawOutput`
- Persist a result: `$CX result <job-id> > docs/superpowers/plans/<name>.md`
- Resume a thread days later: `codex resume <session-id>` (session IDs are in the run log)
- `task --help` is **not** a help flag — `task` forwards its whole argument string as the prompt.
  Read `~/.claude/plugins/cache/openai-codex/codex/<version>/commands/*.md` for flags.
