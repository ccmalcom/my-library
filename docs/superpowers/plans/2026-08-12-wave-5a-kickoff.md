# Wave 5a — execution kickoff

Plan: `docs/superpowers/plans/2026-08-12-node-backend-wave-5a-admin-port.md` (11 tasks, 69 steps).
Design: `docs/superpowers/specs/2026-08-12-node-backend-wave-5a-admin-port-design.md`.

**The plan has already been reviewed by Codex** (read-only, against the repo) and four findings
were verified and folded in at commit `0b10520`. Do not re-run a plan review; go straight to
execution.

## Preconditions

Wave 5a starts cold. No Task 0 remediation, no migration to apply.

```bash
cd /home/chase/Documents/Code/my-library
git --no-pager status --short       # must be clean
git --no-pager log --oneline -1     # expect 0b10520 or later
```

Wave 4d is committed and pushed (`7fa70ad`). Wave 4 is closed.

## Start a fresh session in this repo and paste the block below

```
Execute wave 5a from docs/superpowers/plans/2026-08-12-node-backend-wave-5a-admin-port.md.

Use superpowers:subagent-driven-development. Follow the Claude / Codex split in CLAUDE.md:
- You own planning, review, and judgement. Do not implement the Codex-owned tasks yourself.
- Send Tasks 1, 3, 4, 5, 6, 7, 8 and 9 to Codex verbatim from the plan, one at a time, using
  /codex:rescue --background, and wait for each to land before starting the next.
- Tasks 0, 2 and 10 are DRIVING-SESSION-OWNED and are marked as such in the plan. Do not dispatch
  them. Task 0 and Task 2 run pytest and the fixture recorder, both of which hang Codex's sandbox.
  Task 10 is live verification against the real Supabase project and is Chase's call to run.
- Do not explore the repo before delegating. Hand Codex the task text as written.
- After each task returns, review the diff against the plan's Global Constraints yourself, and
  verify its factual claims against the real repo rather than trusting them. Codex's observations
  are reliable; its attributions need checking.
- Run every gate the task names. The Node five are npm run test:server, npm test -- --runInBand,
  npm run type-check, npx eslint <touched>, npx prettier --check <touched>. You run
  .venv/bin/pytest yourself after each task; never list it in a Codex prompt.
- Do not commit, merge, push, or deploy. Hand me each reviewed diff and I will commit.

Task order is a real dependency chain, not a preference:
- Task 1 (widen the schema guard) MUST precede Task 2, because any mirror drift it finds changes
  the DDL that Task 2's fixtures get recorded against. Finding it afterwards means recording twice.
- Task 2 (record fixtures) MUST precede Tasks 3-8, which replay those fixtures.
- Task 9 (switcher) MUST come last: the Jest switcher assertions currently pin /admin/* to Python
  and will fail the moment they flip.
Do not reorder.

Append findings to docs/superpowers/codex-workflow-notes.md as you go, especially anything that
should change how we prompt Codex next time.
```

## Session hygiene

```
/codex:setup --enable-review-gate      # start of the execution session
/codex:setup --disable-review-gate     # when wave 5a is done
```

## Where this wave is most likely to go wrong

1. **`revokeUser` gets "fixed" into a transaction.** This is the single highest-risk item. Every
   other Node write route wraps its work in `db.transaction`; this one must not, because Python
   commits `status='revoked'` *before* purging so a retry skips the irreversible GoTrue delete.
   The plan gives it a dedicated section and a Step 6 that wraps it deliberately and confirms the
   retry-safety test fails. **Do not skip that step** — it is the only thing standing between this
   convention violation and a future reviewer silently reverting it.

   Note the distinction the plan spells out: "not transactional" means no single transaction
   spanning the GoTrue delete, the revoked-flag commit, and the purge. The purge itself is
   transactional — `deleteAccountRows` takes a `DbTx`.

2. **The recorder's monkeypatch targets the wrong module.** `invites.py` does
   `from .supabase_admin import ...`, binding those names at import time. Patching
   `mylibrary.supabase_admin` is a silent no-op that would record **real GoTrue calls** against the
   live project. The patch must land on `mylibrary.invites`. Task 2 says so; verify it held by
   checking the recorded fixture contains the fake `sb-` ids.

3. **`invites` must join `SEQ_TABLES`.** The seed inserts explicit ids 1-3, which does not advance
   the serial sequence, so Task 6's first `INSERT` collides on `id=1`. Task 2 Step 6 covers it and
   Step 6b proves it. This will present as a confusing duplicate-key failure three tasks later if
   missed.

4. **Task 1 may be the slowest task in the wave.** It widens wave 4d's guard from 5 tables to 14.
   Eight of those have never been checked, and 4d found six drifts in the first table it examined.
   Budget for real remediation work before the admin port even starts.

5. **PII in a public repo.** Every fixture address must be `@example.com`. Task 2 Step 7 has the
   grep that proves it. This repo is public and currently has zero email addresses in fixtures —
   keep it that way.

## What this wave does NOT do

Wave 5a ports and flips admin only. Python stays live and unmodified (except the recorder). The
cutover — deleting `api.py` and `worker.py`, decommissioning Railway, removing the switcher — is
wave 5b and needs its own plan.

## When the wave is done

1. `/codex:review`, then `/codex:adversarial-review`, on the branch.
2. Triage findings through `superpowers:receiving-code-review` — skeptically, verifying each claim
   against the repo.
3. Run Task 10's live verification against the real Supabase project, with the guardrails as
   written. The revoke step asserts the target's email equals `chasecmalcom+wave5a@gmail.com`
   before issuing the DELETE. **Never accept this from a model's self-report.**
4. Fill in the plan's Verification Record with real command output, including anything skipped.
5. Add `SUPABASE_SERVICE_ROLE_KEY` to Vercel **Production only** — never Preview, never Development.
6. Update `CLAUDE.md` to mark 5a shipped and note what 5b inherits.
7. Write `wave-5a-verification.md` alongside the other wave verification docs.

## What wave 5b inherits

- Delete `api.py` and `worker.py` (arq was never the production path); decommission Railway; remove
  `lib/backend.ts`.
- **Keep** `db.py`, the SQLAlchemy models, Alembic, the CLI, and the fixture recorders — wave 4d
  made the models the schema oracle and they outlive the HTTP layer.
- Delete Python's dead `GET /health` (wave 5a already removed the unused `api.health()` client
  method; see the plan's Task 9 Step 4).
- Still open and carried forward: apply `0019_add_enrich_job_leases` in the same release window as
  the switcher flip, supply `CRON_SECRET`, confirm Vercel Fluid compute and the ~300s ceiling, run
  `vercel crons ls` after a production deploy, import a genuine large Goodreads export (open since
  wave 4d), and decide the ShelfSprite rename timing.
