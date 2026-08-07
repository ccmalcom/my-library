# Wave 0 verification record

Plan: `docs/superpowers/plans/2026-08-03-node-backend-wave-0.md`
Branch: `feat/node-backend` (12 commits, pushed to origin)

## Automated verification (done)

- `npm test` (jest): 31 passed
- `npm run test:server` (vitest): 44 passed
- `npm run type-check`: clean
- `npm run lint`: clean
- `python -m pytest`: 355 passed (unaffected by wave 0)
- Alembic migration `0018_node_wave0_tables`: up/down/up cycle verified against a throwaway SQLite DB, then applied to the dev Supabase DB (`alembic current` → `0018_node_wave0_tables (head)`)
- `drizzle-kit pull` introspection: 18 tables (17 app tables + `alembic_version`), fidelity-checked (JSON vs JSONB split, `usage_events.cost_usd` as double, `rate_limits` composite PK all correct). One drizzle-kit rendering bug found and hand-fixed: an empty-string column default (`feedback_prompt_state.run_id`) was emitted as invalid TypeScript (`.default(')`) — documented in a comment at the top of `frontend/lib/server/schema.ts`.

## Local isolated end-to-end verification (done, via curl)

Ran an isolated Python backend (throwaway SQLite, port 8010) and an isolated Next.js dev server (port 3000) pointed at the real dev Supabase `DATABASE_URL` for the Node side only (server-side Supabase auth vars stripped so the Node backend also runs in local-admin mode, matching Python). Chrome extension wasn't connected, so this was curl-driven rather than an interactive click-through of the System tab UI.

- `GET /api/healthz` → `{"status":"ok","backend":"node"}`
- `GET /api/admin/config` (no auth header, local mode) → `{"debug_mode":false}`
- `PUT /api/admin/config {"debug_mode":true}` → `{"debug_mode":true}`
- `GET /api/healthz` with debug on → `Server-Timing: total;dur=0.3` header present
- `PUT /api/admin/config {"debug_mode":false}` → header disappears on next `/api/healthz` call (cache invalidated immediately, no 30s wait needed)
- `PUT /api/admin/config {"debug_mode":"yes"}` → 422 with `{"detail":"validation error: ..."}`
- Confirmed `debug_mode` left `false` in the dev DB afterward.

Gap found in `.claude/skills/isolated-local-env`: it doesn't mention `REDIS_URL` — `mylibrary.cli serve` fails at startup trying to reach the real Upstash Redis unless `REDIS_URL=` is also set to empty alongside the other isolation vars. Worth fixing in that skill.

## Vercel preview deploy (build done; live checks pending — need Chase)

- Pushed `feat/node-backend`, Vercel built `dpl_BmRsmYaJQT5c6dUzjQ5Cpiy9pZii` → `READY`.
- Preview alias: `https://my-library-git-feat-node-backend-ccmalcoms-projects.vercel.app`
- The project has Vercel Authentication (SSO) enabled for all non-custom-domain deployments, which blocks both direct curl and the Vercel MCP `web_fetch_vercel_url` tool from reaching the preview unauthenticated. This can only be checked from Chase's logged-in browser (or by adding a Protection Bypass for Automation secret, which wasn't set up here since it's an account/security setting change).

**Still needed from Chase:**
1. Add 4 server-side env vars to the Vercel project (Preview + Production), same values as Railway: `DATABASE_URL` (Supabase **pooler** URL, not direct), `SUPABASE_URL`, `ENCRYPTION_KEY`, `ADMIN_EMAILS`.
2. In a logged-in browser, on the preview URL above:
   - `curl` (or visit) `/api/healthz` → expect `{"status":"ok","backend":"node"}`
   - `/admin` → System tab: Python badge up, Node badge up
   - Toggle debug on → `curl -i .../api/healthz` shows `Server-Timing`; toggle off → header gone (≤30s)
   - Confirm normal app flows (library, profile, recommendations) still work — they ride the Python backend in `auto` mode; wave 0 should be invisible to normal use.
