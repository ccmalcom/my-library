# ShelfSprite — Copilot Agent Instructions

Trust these instructions. Read `CLAUDE.md` before changing behavior, then inspect the relevant
source or focused document.

## Suggesting and reviewing changes

- Keep edits minimal and syntactically self-contained. Include a whole object, array, config
  block, or multi-line construct when changing it; if a complete replacement would be unwieldy,
  describe the change instead of emitting a broken fragment.
- Match the repository's Prettier and ESLint formatting.
- Prefer a focused fix over unrelated refactors or renames.
- Do not call work complete without reporting which validation commands actually ran.
- **Not every bug is a code bug.** Runtime configuration lives in Vercel project settings and in
  the Supabase dashboard. For example, invite links require `FRONTEND_URL` in Vercel and the exact
  `/auth/callback` URL in Supabase Auth -> URL Configuration -> Redirect URLs. A code edit cannot
  repair a missing variable or dashboard allowlist entry; identify the configuration fault.

## Current system

ShelfSprite is one TypeScript/Next.js application under `frontend/`. Vercel hosts both the pages
and same-origin `/api` route handlers. Supabase provides authentication and Postgres; server code
uses drizzle-orm. There is no separate backend service or resident worker.

| Layer          | Technology                                                    |
| -------------- | ------------------------------------------------------------- |
| Application    | Next.js 16, React 18, TypeScript 5                            |
| UI             | Tailwind CSS 3, SWR 2, Framer Motion                          |
| Data           | Supabase Postgres, drizzle-orm, drizzle-kit                   |
| Auth           | Supabase SSR and ES256 bearer verification                    |
| AI and catalog | Anthropic SDK, Open Library, Google Books                     |
| Tests          | Jest for client/shared paths; Vitest for server and API paths |

## Build and validate

Run from `frontend/`:

```bash
npm install
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

The runners are intentionally disjoint: Jest excludes `lib/server/**` and `app/api/**`; Vitest
owns those paths. `npm run build` is required because it catches Next segment-config and prerender
failures. For local development, run `npm run dev`.

## Project layout

```text
frontend/
  app/              Next.js pages and same-origin API route handlers
  components/       application and design-system components
  lib/api.ts        typed browser client; every request uses /api
  lib/server/       auth, database, catalog, enrichment, profile, recommender, admin
  drizzle/          migration SQL and drizzle metadata
  proxy.ts          page-session middleware; deliberately excludes /api
docs/               architecture, frontend, hosting, and conventions
```

## Critical rules

- Tenant-scope every user-owned query with the authenticated `userId`. New user-owned tables must
  also be removed by `deleteAccountRows`.
- Reviews require a rating. Ratings use the 0.5 grid; `0` is only the clear/unrated sentinel.
- Never drop or recreate `books` during a migration. Generate with drizzle-kit, inspect the SQL,
  and apply migrations manually outside the Vercel build.
- The LLM is not the recommender. Deterministic Stage 1 retrieval supplies real catalog books;
  Claude only reranks and explains that bounded pool.
- Unknown-language catalog candidates pass the language filter. Keep recommender tuning constants
  in their owning modules (`recSignal.ts`, `recAssemble.ts`, and `recFilters.ts`), not in callers or
  tests.
- `frontend/proxy.ts` must exclude `api`; route handlers authenticate themselves, and cookieless
  enrichment continuation depends on bypassing page middleware.
- `enrich/start` and `enrich/tick` must each export the literal `maxDuration = 300`; an imported
  value breaks Next's static segment-config analysis.
- `supabaseAdmin.ts` sends the secret using `apikey` only. Keep its message fallback as
  `data.msg || data.message`.
- In TSX, keep non-ASCII characters out of JavaScript string literals, avoid IIFEs in JSX, and use
  `Modal` with `labelId`, `onClose`, and an optional `className`.
- After setup mutations, refresh stats with
  `mutate('stats', api.stats(), { revalidate: false })`; a bare mutation can leave the cache stale.
