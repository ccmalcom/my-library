# ShelfSprite

ShelfSprite is a personal, AI-assisted book-analysis and recommendation app. It imports a
Goodreads library, enriches books with Open Library and Google Books metadata, builds an
evidence-backed taste profile, and recommends real catalog books through a two-stage pipeline:
deterministic retrieval followed by Claude reranking and explanation.

> Live at [shelfsprite.app](https://shelfsprite.app). Built under the working name _MyLibrary_;
> rebranded 2026-08-13.

## Architecture

ShelfSprite is a single Next.js application in `frontend/`, deployed on Vercel. Browser calls go
through the typed client in `frontend/lib/api.ts` to same-origin `/api` route handlers. Server code
under `frontend/lib/server/` verifies Supabase sessions, accesses Supabase Postgres through
drizzle-orm, calls catalog providers, and runs the profile and recommendation flows.

```text
Goodreads CSV -> import -> books -> enrichment -> taste profile -> recommendations
                                |          |              |
                  Open Library / Google Books        Claude
```

The recommender never asks Claude to invent titles. Stage 1 retrieves and filters real catalog
candidates; Stage 2 lets Claude rerank and explain only that bounded set.

## Local development

```bash
cd frontend
npm install
npm run dev
```

The app opens at <http://localhost:3000>. `DATABASE_URL` is required for server data access. A
fully unconfigured Supabase auth layer is optional in local development; when neither a Supabase
project URL nor an explicit JWKS URL is configured, requests use the single local user. See
`docs/hosting.md` for the current variable list and deployment notes.

## Validation

Run the complete gate from `frontend/`:

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

Jest and Vitest cover different paths, and `next build` catches failures the other checks cannot,
so a complete validation includes both test runners and the build.

## Documentation

- `CLAUDE.md` — current code map, load-bearing invariants, and commands.
- `docs/architecture.md` — server module map and locked product decisions.
- `docs/frontend.md` — UI, auth, client, and component conventions.
- `docs/hosting.md` — Vercel/Supabase operations, migrations, and retired-service history.
- `docs/conventions.md` — repository gotchas and data invariants.
