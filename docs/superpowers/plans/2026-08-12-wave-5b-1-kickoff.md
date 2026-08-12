# Wave 5b-1 — execution kickoff

Plan: `docs/superpowers/plans/2026-08-12-node-backend-wave-5b-1-production-cutover.md` (8 tasks, 4 batches).
Follow-on: `docs/superpowers/plans/2026-08-12-node-backend-wave-5b-2-python-retirement.md` — **blocked until 5b-1's soak passes. Do not read it during 5b-1.**

The plan has NOT been Codex-reviewed. Whether to run `/codex:review` on it first is Chase's call; the wave is mostly ops rather than code, so a plan review buys less here than it did for 5a.

## What makes this wave different from 5a

**This wave is release engineering, not implementation.** It changes almost no application code. Its risks are a production database migration, a deploy that meets real users, and a rollback that has to work. That inverts the usual split:

- **Codex is a poor fit for nearly every task** and the plan says so per task. There is no file-blind brief for "confirm Fluid compute is enabled." The one sanctioned dispatch is a merge conflict in Task 1, with the hunks pasted in.
- **Most of the wave is Chase-owned**, not because it is sensitive but because it lives behind deploy credentials and a permissions classifier that denies production DB reads.
- The driving session's job is to ask precisely, record answers, verify claims, and refuse to advance on an unanswered precondition.

## One reversal to be aware of

The wave 5a kickoff doc (`2026-08-12-wave-5a-kickoff.md`, "What wave 5b inherits") says to **keep** `db.py`, the SQLAlchemy models, Alembic, the CLI, and the fixture recorders. **Chase reversed that on 2026-08-12:** all of `mylibrary/` goes, and wave 5b-2 transfers schema ownership to drizzle-kit first so that deletion is safe. If the two documents appear to disagree, the 5b-2 plan is current and the 5a kickoff is historical.

None of that affects 5b-1, which deletes nothing.

## Preconditions

```bash
cd /home/chase/Documents/Code/my-library
git --no-pager status --short       # must be clean
git --no-pager log --oneline -1     # expect e29d9a0 or later
git --no-pager branch --show-current # expect feat/node-backend
```

Wave 5a is closed and live-verified, including revoke.

## Start a fresh session in this repo and paste the block below

```
Execute wave 5b-1 from docs/superpowers/plans/2026-08-12-node-backend-wave-5b-1-production-cutover.md.

Use superpowers:subagent-driven-development, and read chase-workflow:controller-budget before you
start — this plan is batched for it.

Read the plan's Global Constraints and Verified Facts sections ONCE, then read ONE task's text per
dispatch. Do not hold the whole plan document resident.

Ownership for this wave is unusual, and the plan marks it per task:
- Tasks 0 and 1 are yours (git, gates, the main merge).
- Tasks 2 and 3 are CHASE-OWNED: deploy configuration and the production migration. Do not attempt
  them, do not read .env files, and do not try to reach the production database yourself. Your job
  is to ask the plan's questions precisely, record his answers in the ledger, and refuse to advance
  while any precondition is unanswered.
- Tasks 4 and 6 are browser verification. You drive; Chase signs in.
- Tasks 5 and 7 are Chase's to execute, yours to prepare and verify.

Do NOT dispatch Codex in this wave unless Task 1's merge conflicts, and then only with the
conflicting hunks pasted into the brief. The plan explains why.

Hand off after each batch: [0,1] then [2,3] then [4,5] then [6,7]. Do not start the next batch in
the same session. Write the ledger after EVERY task, not at the end of a batch — the handoff is
only cheap if .superpowers/sdd/ is the state of record.

Do not commit, merge, push, or deploy. Hand me each reviewed change and I will commit.

Append findings to docs/superpowers/codex-workflow-notes.md as you go.
```

## Session hygiene

Leave the Codex review gate **off** for this wave — it adds a design review of up to 900s on every edit-producing turn, and this wave produces almost no edits.

```
/codex:setup --disable-review-gate
```

## Where this wave is most likely to go wrong

1. **Advancing on an assumption instead of a recorded answer.** Five things are explicitly marked NOT verified: Vercel's production branch, Fluid compute, the ≥300s function ceiling, what database Preview points at, and production's current Alembic revision. Tasks 3 and 5 both open by re-reading recorded answers rather than trusting that the audit happened. A controller that treats "probably `main`" as an answer is the main failure mode here.

2. **The function ceiling.** `FUNCTION_CEILING_SECONDS = 300` is an assumption about the platform, and `CHUNK_BUDGET_MS = 240_000` reserves headroom under it. If the real ceiling is lower, enrichment chunks get killed mid-run and the failure looks like a mysterious stalled job. Task 2 Step 2 gates on this. If it comes back below 300s, stop before Task 5 rather than deploying and hoping.

3. **Running `alembic upgrade` from a `main` checkout.** Migrations 0018 and 0019 exist only on `feat/node-backend`. From `main` the command finds nothing and reports success-shaped output. Task 3 Step 1 checks the branch first for exactly this reason.

4. **Treating the backend switcher as a kill switch.** It writes to `localStorage`, so it is per-browser. It can save one admin's session; it cannot un-break the app for other users. The real rollback is a Vercel instant rollback to the deployment ID recorded in Task 5 Step 2 — recorded *before* the merge, because finding it under pressure is not a plan.

5. **Skipping the rollback drill.** Task 7 Step 1 executes a real rollback and roll-forward with Chase present. It is tempting to skip once production looks healthy. A rollback that has never been run is a hypothesis.

6. **`vercel crons ls` returning nothing.** Cron jobs register only from production deployments, so this cannot be checked before Task 5. If it comes back empty, the likeliest cause is Root Directory: `frontend/vercel.json` is read only because the project's root is `frontend`, and a repo-root `vercel.json` is silently ignored.

## A note on running this controller on Sonnet

The plan is written to be executed literally, which suits a Sonnet controller well. Two places still want care, and both are judgement rather than instruction-following:

- **Task 1's merge, if it conflicts.** Both sides are live code — Python still serves production. The resolution is "take `main`'s fix, re-apply the branch's change on top," not "pick one."
- **Task 3 Step 3's `--sql` review.** The check is that no statement contains `NOT NULL` without a `DEFAULT` and nothing DROPs. Read the output rather than pattern-matching on it looking fine.

If either gets uncomfortable, stop and hand back rather than proceeding — nothing in this wave is time-pressured.

## What this wave does NOT do

5b-1 deletes nothing. `mylibrary/`, `alembic/`, `tests/`, the recorders, the CLI, Railway, and `lib/backend.ts` all survive it. Python stays deployed for the whole soak, because it is the fallback.

## Still open, carried forward past this wave

- **The ShelfSprite rename.** The name is final and `shelfsprite.app` is bought (2026-08-04); the rename was deliberately deferred *to the Node-migration cutover* — which is now. It is not in either 5b plan. Decide whether it lands between 5b-1 and 5b-2, after 5b-2, or as its own wave. Attaching the domain early was already the agreed approach.
- `backfill-descriptions --all-users` has no web equivalent and dies with the CLI in 5b-2. Named in that plan's Task 7 Step 2; no replacement is planned.
- The three destructive purge routes stay unexercised in production by design.
