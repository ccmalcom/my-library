# Node Backend Wave 5a — Admin Surface Port (Design)

**Status:** approved design, not yet planned. The implementation plan is a separate document.
**Date:** 2026-08-12
**Predecessor:** wave 4d (closed wave 4). **Successor:** wave 5b (Python cutover and teardown).

---

## Goal

Move the last seven Python-only HTTP routes — the `/admin/*` surface — onto Node, so that wave 5b
can delete `mylibrary/api.py` and decommission Railway without losing functionality.

Wave 5a does **not** cut over, delete Python, or touch the Railway deployment. Python's admin
routes stay live underneath as a fallback for the whole wave.

## Why this wave exists

Diffing the two route inventories on 2026-08-12 shows the migration is functionally complete
except for admin. Every other Python route has a Node counterpart.

| Route | Purpose | Difficulty |
| --- | --- | --- |
| `GET /admin/me` | is-admin check for the nav and `/admin` page | trivial |
| `GET /admin/users` | invite roster + per-user book counts | trivial |
| `GET /admin/usage` | paginated usage joined to `invites` | trivial |
| `GET /admin/feedback` | paginated feedback joined to `invites` | trivial |
| `POST /admin/invite` | GoTrue invite + pre-provision settings + upsert invite row | **new code** |
| `POST /admin/revoke` | GoTrue delete + purge app data + mark revoked | **new code, irreversible** |
| `POST /admin/backfill` | reconcile dashboard-created users into `invites` | **new code** |

The four reads are near-trivial because **wave 0 already built admin gating**: `lib/server/auth.ts`
has `isAdminEmail()`, returns `isAdmin: true` in local single-user mode, and
`withApi(..., { requireAdmin: true })` enforces it today on `/admin/config`. Python's
`admin.is_admin` / `admin.require_admin` semantics are already mirrored; nothing there needs porting.

The three writes are the real work: roughly 270 lines of Python across `supabase_admin.py` (107)
and `invites.py` (164), including the only route in the application that permanently destroys a
user account.

## Verified Facts

Each confirmed by running it on 2026-08-12. Cite symbols, not line numbers — line numbers drift
between authoring and execution.

| Fact | Evidence |
| --- | --- |
| Exactly seven `/admin/*` routes are Python-only; `/admin/config` is Node-only | route-inventory diff, command Ⓐ below |
| Node's admin gating already exists and mirrors Python | `isAdminEmail` and the local-mode `isAdmin: true` branch in `lib/server/auth.ts`; `requireAdmin` handled in `lib/server/http.ts`; used by `app/api/admin/config/route.ts` |
| `GET /admin/me` is **not** admin-gated in Python — it takes a raw `Authorization` header and returns a bool | `admin_me` in `mylibrary/api.py` has no `AdminId` dependency |
| `revoke_user` is deliberately multi-transaction and commits `revoked` **before** purging | the retry-safety comment in `revoke_user`, `mylibrary/invites.py` |
| `create_invite` calls GoTrue first, then writes settings and the invite row in separate sessions, idempotent on lowercased email | `create_invite`, `mylibrary/invites.py` |
| `invites` already exists in all three Node schema mirrors | present in `lib/server/schema.ts`, the PGlite DDL in `__tests__/helpers/pglite.ts`, and `fixtures/schema-contract.json` |
| Node's production write surface is 12 tables; wave 4d's `WRITTEN_TABLES` guards 5 | command Ⓑ below |
| Node has no `usage_events` INSERT — it only SELECTs and DELETEs | recorded in wave 4d; re-confirmed by the same grep |
| `GET /health` is authenticated and per-user, distinct from the public `/healthz` probe | `health` vs `healthz` in `mylibrary/api.py` |
| `api.health()` is defined in `frontend/lib/api.ts` and called from nowhere | `grep -rn "\.health()\|api\.health" frontend --include=*.ts --include=*.tsx` returns no call sites |
| The parity recorder uses FastAPI `TestClient` and records `empty` / `seeded` scenarios | `scripts/gen_parity_fixtures.py`; top-level keys of `fixtures/parity/python-responses.json` |
| The repo is public | `gh repo view --json visibility` → `PUBLIC` |

These are written out rather than squeezed into the table because two of them contain `|`, which a
markdown table forces you to escape — and an escaped `\|` reaches `grep -E` as a *literal pipe*,
not alternation, so the pasted command silently stops meaning what it says. Run from the repo root:

```bash
# Ⓐ route-inventory diff (Python side, then Node side)
grep -rhoE '@app\.(get|post|put|patch|delete)\("[^"]+"' mylibrary/ | sed 's/@app\.//' | sort -u
find frontend/app/api -name route.ts | sed 's|frontend/app/api||; s|/route.ts||' | sort

# Ⓑ tables Node writes in production (keeps filenames so the __tests__ filter actually works)
grep -rnoE "\.(insert|update)\(([a-zA-Z]+\.)?[a-zA-Z]+\)" frontend/lib frontend/app --include=*.ts \
  | grep -v "__tests__" | sed -E 's/^[^:]*:[0-9]+://; s/\.(insert|update)\(//; s/^schema\.//; s/\)//' | sort -u

# Ⓒ any email address already checked into a fixture
grep -rlE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' frontend/lib/server/__tests__/fixtures/
```

Ⓑ deserves a warning of its own. The obvious form of this grep uses `-h`, which **suppresses
filenames — so the `grep -v "__tests__"` filter downstream has nothing to match against and
silently passes test-only writes through as production ones.** That is exactly how a first pass at
this fact produced a 14-table answer including `invites`, which no production code writes today.
Two narrower variants also under-reported, missing `enrich_jobs` because `enrichmentJobs.ts`
imports the table directly instead of through `schema.`. Both failure modes are the repo's own
standing warning that a single-form grep is not proof of absence.

Ⓑ prints 13 lines, not 12: one is `ct`, from `decipher.update(ct)` in `lib/server/crypto.ts`. It is
a cipher call, not a table. Discard it — the write surface is the other twelve.
| No fixture currently contains an email address | command Ⓒ below returns nothing |

## Architecture

### New modules

| Module | Ports | Responsibility |
| --- | --- | --- |
| `frontend/lib/server/supabaseAdmin.ts` | `mylibrary/supabase_admin.py` | `inviteUser`, `deleteUser`, `listUsers` against GoTrue. Injectable client for tests, mirroring the wave-3a Anthropic/catalog pattern. |
| `frontend/lib/server/invites.ts` | `mylibrary/invites.py` | `createInvite`, `listRoster`, `backfillFromSupabase`, `revokeUser`. |

`invites.ts` reuses what already exists rather than re-porting it: `purge.ts`'s `deleteAccount`
(wave 4a), the user-settings writers (wave 2), and `crypto.ts` (wave 0).

### New routes

Seven handlers under `frontend/app/api/admin/`, all thin wrappers over the modules above.
`/admin/usage` and `/admin/feedback` port the query logic in `mylibrary/usage.py`'s
`admin_list_usage` and `mylibrary/feedback.py`'s `admin_list_feedback`.

Switcher rules are appended to `NODE_DEFAULT_ROUTES` in `frontend/lib/backend.ts`. `/admin/config`
stays in `NODE_ONLY_PREFIXES`.

### Error handling

`SupabaseAdminError` is ported as-is, including its discipline: the service-role key never appears
in an error message, and arbitrary GoTrue response bodies are never echoed (they may contain PII).
Only GoTrue's short `msg` / `message` field is surfaced.

## The parity details that must not be "improved"

**1. `revokeUser` must not be wrapped in a single transaction.** Every Node write route to date
follows one-transaction-per-request. Revoke cannot, and the reason is load-bearing. Python runs
four phases:

1. read the invite row (own session)
2. call GoTrue `DELETE` — irreversible, un-rollbackable, and outside any transaction
3. commit `status='revoked'` in its **own** transaction
4. call `deleteAccount` to purge app data

Phase 3 exists so that if phase 4 throws, the row still reads `revoked` and a retry skips
`delete_user` instead of 404ing against an account that no longer exists. A single enclosing
transaction would roll that flag back on a purge failure and strand the user in a state where
every retry fails. **The house convention is wrong for this route.** The plan must state this
loudly enough that neither the executor nor Codex "corrects" it.

**2. `createInvite` is multi-transaction for the same reason.** GoTrue invite first, then display
name, then the encrypted Anthropic key, then the invite-row upsert — each in its own session.
Idempotent on `email.strip().lower()`. Empty email raises before any network call.

**3. `GET /admin/me` is ungated.** It must be `requireAdmin: false` on Node. Gating it would break
the nav for every non-admin user, since the frontend calls it unconditionally to decide whether to
render admin UI at all.

**4. `revokeUser` is idempotent by design.** An already-`revoked` row skips the GoTrue delete
entirely and goes straight to the purge.

## Testing strategy

### Parity fixtures from a synthetic roster

`scripts/gen_parity_fixtures.py` gains a synthetic roster — `reader1@example.com` and similar,
never a real address — and records the four read routes under the existing `empty` and `seeded`
scenarios.

For the three write routes, the recorder monkeypatches `supabase_admin.invite_user`,
`list_users`, and `delete_user` with canned GoTrue payloads. This is the precedent
`gen_claude_fixtures.py` set when it monkeypatched `tracked_create`: the fixture proves the
database effects and response shapes without a single real GoTrue call.

**The repo is public and no fixture currently contains an email address. That must remain true.**
Recording from a synthetic roster keeps it true by construction — there is nothing to redact, and
no way for a later re-record to leak real data.

### Widening wave 4d's schema guard

`WRITTEN_TABLES` in `schema-contract.test.ts` lists five tables. Node's production write surface is
twelve, and 5a makes `invites` the thirteenth.

- **Guarded today:** `books`, `enrichment`, `enrich_jobs`, `feedback`, `usage_events`
- **Written but unguarded:** `feedback_prompt_state`, `profile_meta`, `reader_archetypes`,
  `recommendations`, `taste_signal`, `taste_traits`, `user_directive`, `user_settings`
- **Added by 5a:** `invites`

Widening the list is a one-line change that reuses machinery already paid for. Expect it to find
drift: wave 4d found six divergences in the first table it examined, and none of these eight have
ever been checked. `usage_events` stays in the list despite Node not writing it yet, because 5b is
exactly when Node takes over usage tracking.

Any drift found is fixed in the PGlite mirror and `schema.ts`, never by editing the generated
snapshot, and never by adding a default back to make a fixture pass.

### Gates

Every task runs: `npm run test:server`, `npm test -- --runInBand`, `npm run type-check`,
`npx eslint <touched files>`, `npx prettier --check <touched files>`, and `.venv/bin/pytest`.
Never `npx prettier --write` over a glob — name each file.

The first five are Codex-runnable and belong in each task prompt. **`.venv/bin/pytest` is not** —
Codex's sandbox hangs on it (see Executor notes) — so the driving session runs the Python suite
itself after each task returns. Listing it in a Codex prompt silently burns minutes of that task's
budget on a command that cannot complete.

## Live verification

Run against the **real** Supabase project, by Chase or by Claude driving the app — never accepted
from a model's self-report. This is a deliberate choice: the alternative rigs cannot exercise the
admin surface at all, because the existing throwaway-container setup forces `SUPABASE_*` to `""`,
which puts the app in local single-user mode where `is_admin()` returns `True` unconditionally.

Guardrails, in order:

1. **Snapshot first.** Dump the `invites` roster and the GoTrue user list to a scratch file before
   anything destructive.
2. **Invite `chasecmalcom+wave5a@gmail.com`.** Plus-addressing gives a real, deliverable inbox that
   is unambiguously disposable.
3. Confirm the invite email arrives and the `invites` row lands. Seed that user a book or two so
   the purge has something to destroy.
4. **Revoke only that user.** Assert the target row's email equals that exact string immediately
   before issuing the DELETE; abort on mismatch. This is the only irreversible step in the wave.
5. Confirm the row reads `revoked`, the app data is purged, and the GoTrue user is gone.
6. Run backfill against the reconciled roster and confirm `added: 0` — non-destructive by
   construction.
7. Record the result in the plan under a Verification Record heading, with exact commands and
   output. A failure is the finding; report it rather than retrying until it passes.

## Deployment

`SUPABASE_SERVICE_ROLE_KEY` must be added to Vercel in the **Production environment only**. On
preview and development the admin routes fail closed with the same "Supabase admin not configured"
error Python already raises. Preview deployments must never carry a key that can permanently delete
real auth users, and `vercel env pull` must never put one on a laptop's disk.

## Rollback

5a is fully reversible. The switcher rules can be reverted, or the admin can force `python` from
the System tab on `/admin`. Python's admin routes remain live and unmodified for the whole wave.

## Executor notes (Sonnet driving Codex)

This plan will be executed by a Sonnet session delegating to Codex, so its form matters as much as
its content:

- **Write test bodies out in full.** Codex reliably writes complete implementation code and reduces
  test code to prose-in-comments. It is a second-prompt problem, not a capability limit.
- **Name every gate in every task**, including `type-check` and `eslint`. An unlisted gate is out of
  scope, not forgotten.
- **State expected-red by test name, never by count.**
- **Cite symbols, not line ranges.**
- **Say what Codex cannot run.** It cannot execute pytest at all (`tests/conftest.py` imports
  FastAPI's `TestClient`, which hangs its sandbox), cannot `npm install`, and cannot run the fixture
  recorders. The driving session owns `scripts/gen_parity_fixtures.py` and the Python suite.
- **Budget ~10 minutes per Codex task**, including its own exploration. Prefer several narrow
  dispatches to one broad one.
- **Never hand Codex a task whose text names `.env`** — the pre-bash hook does not screen Codex's
  shell. Use `.env.example` for variable names.
- Always pass `GIT_PAGER=cat` or `git --no-pager`; a paged git command hangs the shell.

## Decisions recorded

- **`GET /health` is not ported.** It is authenticated and per-user (distinct from the public
  `/healthz` probe), it reads `settings.db_path.name` — a SQLite-era vestige — and `api.health()`
  in `frontend/lib/api.ts` is called from nowhere. Wave 4b set the precedent by deleting the dead
  `POST /ingest` routes rather than porting them. 5a removes the unused client method; 5b deletes
  the Python route along with the rest of `api.py`.
- **Admin verification runs against the real Supabase project**, not a throwaway one, with the
  guardrails above.
- **Wave 5 is split.** 5a ports admin; 5b cuts over and tears down. This matches how waves 3c and 4
  were split and keeps the irreversible user-delete port away from the irreversible infra teardown.

## Out of scope

- Python cutover, `api.py` deletion, Railway teardown, switcher removal — all wave 5b.
- `mylibrary/worker.py` (arq) deletion — wave 5b. It is already dead weight: wave 4c-2 gave Node
  its own job system, and arq was never the production path.
- The ShelfSprite rename, still deferred to the cutover.
- Redis, QStash, queue ports, cross-user catalog rate coordination.

## Wave 5b will inherit

- Delete `api.py` and `worker.py`; decommission Railway; remove `lib/backend.ts` and its rules.
- **Keep** `db.py`, the SQLAlchemy models, Alembic, the CLI, and the fixture recorders. Wave 4d made
  the models the authoritative schema oracle; they outlive the HTTP layer.
- Carryover already on the list: apply migration `0019_add_enrich_job_leases` in the same release
  window as the switcher flip, supply `CRON_SECRET`, confirm Vercel Fluid compute and the ~300s
  ceiling, run `vercel crons ls` after a production deploy, and import a genuine large Goodreads
  export (still untested after wave 4d).
