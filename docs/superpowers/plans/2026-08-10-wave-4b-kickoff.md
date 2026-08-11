# Wave 4b — execution kickoff

Plan: `docs/superpowers/plans/2026-08-10-node-backend-wave-4b-import-export.md` (1,120 lines,
9 tasks). Inventory: `docs/superpowers/plans/2026-08-10-node-backend-wave-4b-inventory.md`.

## No hard gate this time

Unlike 4a, there is no Task 0 production remediation. Wave 4b starts cold. The only precondition is
a clean tree and a branch off current `main`.

```bash
cd /home/chase/Documents/Code/my-library
git status --short          # must be clean; stash deliberately if not
```

## Start a fresh session in this repo and paste the block below

```
Execute wave 4b from docs/superpowers/plans/2026-08-10-node-backend-wave-4b-import-export.md.

Follow the plan's REQUIRED EXECUTION PATH header and the Claude / Codex split in CLAUDE.md:
- You own planning, review, and judgement. Do not implement tasks yourself.
- Send each of Tasks 1-9 to Codex verbatim from the plan, one at a time, using
  /codex:rescue --background, and wait for each to land before starting the next.
- Do not explore the repo before delegating. Hand Codex the task text as written.
- After each task returns, review the diff against the plan's Global Constraints yourself, and
  verify its factual claims against the real repo rather than trusting them.
- Run the task's own verification step. Final verification is all five commands, not vitest
  alone: npm test, npm run test:server, npm run type-check, npm run lint, and .venv/bin/pytest.
- Do not commit, merge, push, or deploy. Hand me each reviewed diff and I will commit.

Task order is a real dependency chain, not a preference — Task 1 (CSV layer) and Task 2 (parity
harness) are prerequisites for every route task, and Task 8 (switcher) must come last because the
Jest switcher assertions currently pin these routes to Python and will fail the moment they flip.
Do not reorder.

Two things in this wave have NO precedent in the repo and are therefore the likeliest place for a
plausible-but-wrong implementation: multipart handling in a Next route handler, and returning a
non-JSON Response with attachment headers. There is nothing to copy. Hold Task 2, 4 and 6 to the
plan's stated approach rather than to a pattern found elsewhere.

Append findings to docs/superpowers/codex-workflow-notes.md as you go, especially anything that
should change how we prompt Codex next time.
```

## Session hygiene

Turn the review gate on at the start and off at the end — it is still formally untested after two
waves, so **log whether it fires, what it says, and whether it overlaps `on_stop.py`**:

```
/codex:setup --enable-review-gate      # start of the execution session
/codex:setup --disable-review-gate     # when wave 4b is done
```

Direct-CLI invocation, if used instead of `/codex:rescue` — note `--write` is **not** a companion
default and a thread's sandbox cannot be upgraded after creation:

```bash
CX='node /home/chase/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs'
$CX task --write "$(cat /path/to/task.txt)"
$CX status --json | python3 -c "..."   # see codex-prompt-templates.md §5
$CX cancel <job-id>
```

## Where this wave is most likely to go wrong

1. **Byte-exact export.** The CSV backup is deliberately re-importable by the canonical parser, so
   a wrong quoting rule or line terminator silently breaks a user's restore. Task 6 must prove the
   round-trip, not the shape.
2. **The library is not the parity.** `csv-parse`/`csv-stringify` defaults are not Python's —
   `record_delimiter` alone differs. The pinned option objects in Task 1 are the contract.
3. **Never-clobber.** Locked decision #2. An existing book's `app_rating` / `app_review` /
   `feedback_updated_at` must never be written by import.
4. **The harness extension is real work.** Every prior wave inherited a working parity recorder;
   this one has to extend it before it can record anything.

## When the wave is done

1. `/codex:review`, then `/codex:adversarial-review`, on the branch.
2. Triage findings through `superpowers:receiving-code-review` — skeptically, verifying each claim
   against the repo.
3. Fill in the plan's "Verification record" section with real command output.
4. Live-verify by driving the app: import a CSV through the UI, export both formats, and re-import
   the exported CSV. Never claim it works from tests alone.
5. Update `CLAUDE.md` to mark 4b shipped and note what 4c inherits.
6. Write `wave-4b-verification.md` alongside the other wave verification docs.

## Still blocking wave 4c

Enrichment needs a Node background-execution mechanism that does not exist on Vercel. Options:
`waitUntil`, a cron-driven poller, Redis plus an external worker, or leaving enrichment on Python
through cutover. **This needs a decision from Chase before 4c can be planned** — it is a design
question, not a port.
