# Wave 4a — execution kickoff

## Before you start a session: Task 0 (you, by hand)

Wave 4a will not begin until this is deployed. It is overdue production remediation, not
migration work — a live `POST /profile` 500 for any user with a rejected recommendation carrying
a note.

```bash
cd /home/chase/Documents/Code/my-library
git status --short                     # must be clean; stash deliberately if not
git switch main
git pull --ff-only origin main
git cherry-pick 2c231f8
.venv/bin/pytest tests/test_profile_feedback.py -q
git push origin main
```

Then confirm the deploy goes green and that `origin/main` really has it:

```bash
git fetch origin main
git show origin/main:mylibrary/profile.py | sed -n '542,551p'   # must contain: if "id" in b
```

Verified in advance: `main` still carries the buggy comprehension, `mylibrary/profile.py` has
diverged by only 24 lines so the cherry-pick should apply cleanly, and `main` already has
`Recommendation.user_note`, so the cherry-picked regression test will run there.

---

## Then: start a fresh session in this repo and paste the block below

```
Execute wave 4a from docs/superpowers/plans/2026-08-10-node-backend-wave-4a-purge.md.

Task 0 is already done — the valid_ids hotfix is deployed on main. Verify that claim before
anything else by running:
  git fetch origin main && git show origin/main:mylibrary/profile.py | sed -n '542,551p'
It must contain `if "id" in b`. If it does not, stop and tell me.

Follow the plan's REQUIRED EXECUTION PATH header and the Claude / Codex split in CLAUDE.md:
- You own planning, review, and judgement. Do not implement tasks yourself.
- Send each of Tasks 1-5 to Codex verbatim from the plan, one at a time, using
  /codex:rescue --background, and wait for each to land before starting the next.
- Do not explore the repo before delegating. Hand Codex the task text as written.
- After each task returns, review the diff against the plan's constraints yourself, and verify
  its factual claims against the real repo rather than trusting them. Last time this produced a
  reference to a `DbTx` type that did not exist.
- Run the task's own verification step. Final verification is all five commands, not vitest
  alone: npm test, npm run test:server, npm run type-check, npm run lint, and .venv/bin/pytest.
- Do not commit, merge, push, or deploy. Hand me each reviewed diff and I will commit.

Task 3 (DELETE /account) is the highest-blast-radius route in the app. Its live verification
needs a disposable account and my explicit go-ahead before you run it — ask me first.

Append findings to docs/superpowers/codex-workflow-notes.md as you go, especially anything that
should change how we prompt Codex next time.
```

---

## Session hygiene

Turn the review gate on at the start and off at the end:

```
/codex:setup --enable-review-gate      # start of the execution session
/codex:setup --disable-review-gate     # when wave 4a is done
```

Useful during the run:

- `/codex:status` — watch background jobs (works even when stdout is piped/buffered)
- `/codex:result <job-id>` — full output of a finished job
- `/codex:cancel <job-id>` — stop a runaway job
- `/codex:review` then `/codex:adversarial-review` — before opening the PR
- `/codex:transfer` — if the session gets long and the remaining work is mechanical, move it into
  a resumable Codex thread instead of `/compact`

## When the wave is done

1. `/codex:review`, then `/codex:adversarial-review`, on the branch.
2. Triage findings through `superpowers:receiving-code-review` — skeptically, verifying each claim
   against the repo.
3. Fill in the plan's "Verification record" section with real command output.
4. Update `CLAUDE.md` to mark 4a shipped and note what 4b inherits.
5. Write `wave-4a-verification.md` alongside the other wave verification docs.
