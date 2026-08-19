# Feedback status tracking + GitHub issue integration — design

**Date:** 2026-08-19
**Status:** approved in chat, ready for implementation planning
**Branch:** `feedback-panel-upgrades`

The admin console's Feedback tab is read-only: it lists rows and paginates them. There is no way
to record that a submission has been triaged, and no path from a submission to the issue tracker.
This spec adds a four-state status field to `feedback`, admin controls to move between states, a
one-click "create GitHub issue" flow, and a GitHub webhook that advances status automatically as
the issue is worked.

---

## 1. Preconditions (verified 2026-08-19 against source, not assumed)

| Precondition | Status | How it was verified |
|---|---|---|
| `feedback` has no status or issue-link columns | ✅ | `schema.ts:377-393` — columns are `id, user_id, category, body, trigger, run_id, page, app_version, created_at` |
| The admin feedback API is read-only | ✅ | `app/api/admin/feedback/route.ts` exports `GET` only |
| No GitHub integration exists anywhere | ✅ | `grep -rln github --include=*.ts --include=*.tsx` over `frontend/` returns nothing |
| Origin remote is `ccmalcom/shelfsprite` | ✅ | `git remote -v` |
| `proxy.ts` already excludes `/api` | ✅ | CLAUDE.md load-bearing invariant; the webhook needs no matcher change |
| `withApi` does not consume the request body | ✅ | `http.ts:35-67` — the handler receives `req` untouched, so `req.text()` is available for HMAC |
| Local mode makes the test user an admin | ✅ | `auth.ts:57` returns `{ userId: LOCAL_USER_ID, isAdmin: true }` when Supabase env is absent; `setupTestEnv()` deletes `SUPABASE_URL`, so admin route tests need no JWT |
| `components/ui/Modal.tsx` exists with focus trap + Escape | ✅ | `Modal.tsx:16-70`, props `{ labelId, onClose, confirmClose?, children, className? }` |
| The pglite test helper hand-writes `create table feedback` | ✅ | `helpers/pglite.ts:207-217` — new columns must be added there too or every seeded test breaks |

**Symbols, not line numbers.** Line references locate a region; find code by symbol name.

---

## 2. Scope

**In scope.** A `status` column with four states, two new admin API routes, a GitHub issue-creation
path, a signature-verified GitHub webhook that maps issue events onto status, and the Feedback tab
UI for filtering and changing status.

**Out of scope.**

- Bulk status changes across rows.
- A status-change audit trail (who changed what, when). The current column records state, not history.
- Syncing ShelfSprite → GitHub after creation (comments, closing the issue from the admin console).
  The sync is one-directional after the initial create.
- Creating issues from anything other than a feedback row.

---

## 3. Status model

Four states, ordered but not enforced as a state machine — any status may be set to any other from
the admin UI:

| Status | Meaning |
|---|---|
| `open` | Untriaged. The default for every row, existing and new. |
| `reported` | A GitHub issue exists for this feedback. Set automatically on issue creation. |
| `in_progress` | The issue is being worked. Set by the webhook, or by hand. |
| `resolved` | Done. Set by the webhook when the issue closes, or by hand. |

The literals live in a new **dependency-free** module `lib/server/feedbackStatus.ts`:

```ts
export const FEEDBACK_STATUSES = ['open', 'reported', 'in_progress', 'resolved'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export function isFeedbackStatus(v: unknown): v is FeedbackStatus;
```

`FeedbackTab.tsx` imports this, so the module must stay free of Zod and every other server
dependency — the same constraint that governs `lib/server/rating.ts`, and for the same reason:
anything imported there lands in the browser bundle. Route handlers build their Zod enum from
`FEEDBACK_STATUSES`; the constant is the single source of truth.

---

## 4. Schema and migration

Three columns added to `feedback` in `lib/server/schema.ts`:

```
status              varchar  NOT NULL DEFAULT 'open'
github_issue_number integer  NULL
github_issue_url    varchar  NULL
```

Existing rows adopt `open` through the column default; no data backfill statement is needed.

No index is added. The table is small and the status filter runs alongside an existing sequential
scan; adding an index now would be speculative.

**Migration procedure.** `drizzle-kit generate` diffs `schema.ts` against `drizzle/meta/*.json` and
never reads the live database, so a clean generate proves nothing about production. The generated
SQL is inspected before it is applied, and production column shape is confirmed against
`information_schema.columns` rather than against `schema.ts` comments. Applying to the live
database is Chase's step, not the implementer's.

**Test helper.** `lib/server/__tests__/helpers/pglite.ts` hand-writes `create table feedback`. The
same three columns must be added there or every test that seeds feedback rows fails.

---

## 5. API surface

### 5.1 `GET /api/admin/feedback` (extended)

- New query parameter `status`, comma-separated, mapped to `inArray`. Absent means no status filter.
  An unrecognized value is a `422` with the existing validation-error message shape.
- Each item gains `status`, `github_issue_number`, `github_issue_url`.
- The envelope gains `github_configured: boolean` — whether `GITHUB_TOKEN` is present. `GITHUB_REPO`
  is not part of the check because it resolves through a default and is therefore never absent. The
  UI uses the flag to decide whether to offer issue creation at all, so a missing token produces a
  hidden button rather than a 500 on click.

### 5.2 `PATCH /api/admin/feedback/[id]`

`requireAdmin: true`. Body `{ status: <enum> }`.

- `422` on a malformed body or an unknown status, using the same message shape as sibling routes.
- `404` when no row has that id.
- `200` with the updated item, serialized identically to a list item — including the `email`
  resolved from `invites` — so the client can splice it straight into the cached list.

All three routes share one `serializeFeedbackRow(row, emails)` helper extracted from the existing
inline mapping in the `GET` handler. Three independent copies of the wire shape would drift.

### 5.3 `POST /api/admin/feedback/[id]/github-issue`

`requireAdmin: true`. Body `{ title: string (1..256), body: string }` — the values the admin
confirmed in the modal, not values derived server-side. Deriving them server-side would discard the
admin's edits.

Behavior:
1. `404` if the feedback row does not exist.
2. `409` if `github_issue_number` is already set. Prevents duplicate issues from a double-click or
   a stale tab.
3. `503` if GitHub is not configured (`GITHUB_TOKEN` missing).
4. Create the issue. On any GitHub failure, `502` — matching the `SupabaseAdminError → 502`
   precedent in `app/api/admin/revoke/route.ts`.
5. On success, store `github_issue_number` + `github_issue_url` and set `status = 'reported'` in a
   single update, then return the updated item.

The write happens after the GitHub call because the call is the irreversible half; if the database
update fails afterwards the issue still exists and the `409` guard is what a retry hits. This
ordering is deliberate and mirrors the reasoning already recorded for `createInvite` in
`lib/server/invites.ts`.

### 5.4 `POST /api/github/webhook`

`requireAuth: false` — GitHub cannot present a Supabase bearer token. The route performs its own
authentication, exactly as `GET /api/admin/me` performs its own admin check.

1. Read the **raw body** with `await req.text()` before any parsing. HMAC is computed over the exact
   bytes GitHub signed; re-serializing parsed JSON produces a different digest.
2. Compute `sha256=` HMAC of the raw body with `GITHUB_WEBHOOK_SECRET` and compare against the
   `x-hub-signature-256` header using `crypto.timingSafeEqual` on equal-length buffers. A missing,
   malformed, or mismatched signature is `401`.
3. If `GITHUB_WEBHOOK_SECRET` is unset, `503` — an unset secret must never be treated as "skip
   verification".
4. `x-github-event: ping` returns `200`. Any event other than `issues` returns `200 { ignored: true }`
   without touching the database; GitHub retries and disables endpoints that error.
5. For `issues` events, match rows on `github_issue_number = payload.issue.number` **and**
   `payload.repository.full_name === GITHUB_REPO`. Without the repository check, a webhook from any
   other repository could move rows by number collision.
6. Map the action to a status and update matched rows. Unmapped actions are a `200` no-op.

| `payload.action` | New status |
|---|---|
| `closed` | `resolved` |
| `reopened` | `in_progress` |
| `assigned` | `in_progress` |
| `labeled`, where the added label equals `GITHUB_IN_PROGRESS_LABEL` | `in_progress` |

The mapping is intentionally small. `opened` is absent because the app itself just set `reported`;
`unlabeled` and `unassigned` are absent because reversing a status on label removal guesses at
intent.

---

## 6. `lib/server/github.ts`

A single module owning every outbound GitHub concern and every environment read:

- `githubConfig()` → `{ repo, token, webhookSecret, inProgressLabel }` read from the environment on
  each call. Not cached at module scope: a module-level constant is captured at import time and is
  invisible to per-test environment mutation, which the `setupTestEnv` pattern depends on.
- `isGithubConfigured()` → token present (`repo` always resolves through its default).
- `createIssue({ title, body })` → `POST https://api.github.com/repos/{repo}/issues` with
  `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, and a pinned
  `X-GitHub-Api-Version`. Returns `{ number, url }` (`html_url`, the browser-facing link). Throws
  `GitHubError` carrying GitHub's status and message on any non-2xx or transport failure.
- `verifyWebhookSignature(rawBody, header)` → boolean, timing-safe.
- `class GitHubError extends Error`.

**Environment keys** (names only; Chase supplies the values, and none are read by this work):

| Key | Purpose |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT scoped to `ccmalcom/shelfsprite`, Issues: read & write |
| `GITHUB_REPO` | `owner/name`; defaults to `ccmalcom/shelfsprite` |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for `x-hub-signature-256` |
| `GITHUB_IN_PROGRESS_LABEL` | Label that means "in progress"; defaults to `in progress` |

All four are added to `ENV_KEYS` in `lib/server/__tests__/helpers/testEnv.ts` so a developer with
them exported locally cannot change test behavior — the same hazard that guidance already documents
for `MYLIBRARY_MODEL` and `GOOGLE_BOOKS_API_KEY`.

**Manual GitHub-side setup** (Chase's step, documented in `docs/hosting.md`): repository webhook
pointing at `https://shelfsprite.app/api/github/webhook`, content type `application/json`, the
secret above, and the "Issues" event only.

---

## 7. Client and UI

### 7.1 `lib/api.ts`

`AdminFeedbackItem` gains `status`, `github_issue_number`, `github_issue_url`;
`AdminFeedbackList` gains `github_configured`. `listAdminFeedback` accepts `status?: string`. Two
new functions follow the existing `patch`/`post` helper style:

```ts
updateAdminFeedbackStatus(id: number, status: FeedbackStatus): Promise<AdminFeedbackItem>
createFeedbackGithubIssue(id: number, req: { title: string; body: string }): Promise<AdminFeedbackItem>
```

### 7.2 `components/admin/FeedbackTab.tsx`

- A status filter beside the existing category filter. Default selection is **Open & active**,
  which sends `status=open,reported,in_progress`. Other options: All (sends nothing), and each
  status individually. Changing it resets `offset` to 0, as the category filter already does.
- The SWR key gains the status value so the two filters cache independently.
- Each row gains: a status `Badge`, an inline `<select>` to change status, a linked `#123` badge
  when an issue exists, and a **Create GitHub issue** button when no issue exists and
  `github_configured` is true.
- Status changes are optimistic through SWR `mutate`, rolled back on rejection, with the failure
  surfaced through the existing `Toast` primitive rather than swallowed.
- Badge variants: `open` → `warning`, `reported` → `accent`, `in_progress` → `default`,
  `resolved` → `success`. `CATEGORY_VARIANT` already establishes this mapping pattern.

### 7.3 Issue modal (new `components/admin/FeedbackIssueModal.tsx`)

Built on `components/ui/Modal.tsx`. Opens prefilled and fully editable:

- **Title:** `[feedback] ` + the first ~60 characters of the body, trimmed at a word boundary.
- **Body:** a metadata block (category, submitter email or user id, page, trigger, app version,
  ShelfSprite feedback id) followed by the original submission as a blockquote.

Submitting calls `createFeedbackGithubIssue`. Errors render in the modal and leave it open with the
admin's edits intact — a `502` from GitHub must not discard typed text. On success the modal closes
and the row re-renders with its issue link and `reported` status.

The component is separate from `FeedbackTab.tsx` because that file is already carrying the list,
the filters, and the row; adding a modal with its own form state would push it past the point where
it can be read in one pass.

---

## 8. Testing

**Vitest** (`lib/server/**`, `app/api/**` — the only runner that owns these paths):

- `GET /api/admin/feedback`: single-status filter, multi-status filter, unknown status → 422,
  `github_configured` true and false.
- `PATCH`: each valid status, unknown status → 422, malformed body → 422, missing row → 404.
- `POST .../github-issue`: happy path writes number, URL, and `reported`; already-linked → 409;
  unconfigured → 503; GitHub non-2xx → 502 with the row left untouched.
- Webhook: valid signature accepted; wrong signature → 401; absent header → 401; unset secret → 503;
  `ping` → 200; non-`issues` event → 200 no-op; each mapped action sets the right status; a matching
  issue number from a different repository changes nothing; an unmapped action is a no-op.
- `github.ts`: `createIssue` request shape (URL, headers, JSON body) against a mocked `fetch`,
  and `verifyWebhookSignature` against a known-good digest.

**Jest** (everything else): a `FeedbackTab` test covering the default filter value, the status
`<select>` firing the update, and the button hiding when `github_configured` is false. No admin
component tests exist today, so this establishes the file.

**Full gate.** `npm run test:server`, `npm test`, `npm run type-check`, `npm run lint`,
`npm run format:check`, `npm run build` — running one runner is not a pass, and `build` is the only
gate that catches Next segment-config failures.

**Live verification.** Tests alone do not close this out. The Feedback tab is exercised in a
browser: filter, change status, open the modal, create a real issue. The webhook is exercised with
a `curl` carrying a correctly computed `x-hub-signature-256`, plus a negative case with a bad
signature.

---

## 9. Risks

- **A public unauthenticated endpoint is new surface for this app.** Mitigated by mandatory
  signature verification, a hard `503` when the secret is unset, and the repository-name check.
  The route reads a single integer and writes one enum column; it has no other reach.
- **Issue creation is not transactional with the database write.** Accepted, with the `409` guard
  as the retry-safety mechanism. The alternative — writing first and creating the issue after —
  leaves rows claiming an issue that does not exist, which is worse.
- **Status can drift from GitHub** if a webhook delivery is missed. Accepted: status is editable by
  hand, and GitHub's delivery log makes a miss visible and redeliverable.
