/**
 * Backend switcher (migration scaffolding, removed at cutover).
 * Decides per request whether a path goes to the Python backend on Railway
 * (NEXT_PUBLIC_API_URL) or the Node backend at same-origin /api/*.
 * - 'auto' (default): Python, except path prefixes waves have flipped to Node.
 * - 'python' / 'node': admin override forcing one side (System tab on /admin).
 */
export type BackendChoice = 'python' | 'node' | 'auto';

const STORAGE_KEY = 'mylibrary.backend';

export interface BackendRule {
  prefix: string;
  /** When set, only these methods route to Node; otherwise all methods do. */
  methods?: string[];
  /** When true, the path must equal prefix exactly (no sub-paths). */
  exact?: boolean;
}

/**
 * Routes that default to Node in auto mode. Waves append here as groups flip.
 * Wave 1: every read is Node; writes on the same prefixes stay Python until wave 2/3.
 * Wave 2: the write routes ported in tasks 1-12 flip too. `/books` and `/directive`
 * need `exact` on their write rules because wave-3 Python routes share the same
 * prefix (`POST /directive/draft`).
 * Wave 3c-2: `POST /books/{id}/similar` (ephemeral "more like this") flips to Node.
 * Wave 3b: `POST /profile` and `POST /profile/update` (full and incremental re-profile) flip to Node.
 * Wave 3c-1: `POST /recommend` (the two-stage recommender) flips to Node.
 * Wave 3c-3: `POST /discover` (natural-language discovery) flips to Node, completing wave 3c.
 * Wave 4a: destructive library, profile, and account purges flip to Node.
 * Wave 4b: multipart import preview/import and attachment export flip to Node.
 */
export const NODE_DEFAULT_ROUTES: BackendRule[] = [
  { prefix: '/stats' },
  { prefix: '/books', methods: ['GET', 'PATCH', 'DELETE'] },
  // Wave 3c-2: `exact` dropped so POST /books/{id}/similar follows POST /books to
  // Node. Safe because those are the ONLY two POST routes Python serves under
  // /books (verified against mylibrary/api.py). A future Python POST /books/*
  // route would be captured by this rule -- re-add `exact` and give it its own
  // entry if that ever happens.
  { prefix: '/books', methods: ['POST'] },
  { prefix: '/catalog/search' },
  { prefix: '/profile/archetype', methods: ['POST'], exact: true },
  { prefix: '/profile/reveal-lines', methods: ['POST'], exact: true },
  { prefix: '/directive/draft', methods: ['POST'], exact: true },
  { prefix: '/profile', methods: ['POST'], exact: true }, // wave 3b: full build. exact keeps it off /profile/* sub-paths
  { prefix: '/profile/update', methods: ['POST'], exact: true }, // wave 3b: incremental re-profile
  // Wave 3c-1: the two-stage recommender. `exact` is LOAD-BEARING -- '/recommendations'
  // starts with '/recommend', so a prefix rule here would capture that group too.
  { prefix: '/recommend', methods: ['POST'], exact: true },
  // Wave 3c-3: natural-language discovery. `exact` because /discover has no
  // sub-paths today and a future one should be an explicit decision.
  { prefix: '/discover', methods: ['POST'], exact: true },
  { prefix: '/profile', methods: ['GET', 'PATCH'] },
  { prefix: '/recommendations', methods: ['GET', 'PATCH'] },
  { prefix: '/settings', methods: ['GET', 'PUT', 'DELETE'] },
  { prefix: '/directive', methods: ['GET', 'PUT', 'DELETE'], exact: true }, // exact ensures this rule doesn't match /directive/draft POST (which has its own rule)
  { prefix: '/feedback' },
  { prefix: '/taste-signal' },
  // Wave 4a: destructive purges. Exact + method-specific so existing profile
  // GET/PATCH/POST rules and any future sibling routes cannot broaden the flip.
  { prefix: '/library', methods: ['DELETE'], exact: true },
  { prefix: '/profile', methods: ['DELETE'], exact: true },
  { prefix: '/account', methods: ['DELETE'], exact: true },
  // Wave 4b: multipart import and attachment export. Exact + method-specific;
  // /import is a prefix of /import/preview, so each route is independently locked.
  { prefix: '/import/preview', methods: ['POST'], exact: true },
  { prefix: '/import', methods: ['POST'], exact: true },
  { prefix: '/export', methods: ['GET'], exact: true },
];

/** Routes that only exist on the Node backend. */
export const NODE_ONLY_PREFIXES: string[] = ['/admin/config'];

export function getBackendChoice(): BackendChoice {
  if (typeof window === 'undefined') return 'auto';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'python' || v === 'node' ? v : 'auto';
}

export function setBackendChoice(choice: BackendChoice): void {
  if (typeof window === 'undefined') return;
  if (choice === 'auto') window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, choice);
}

export function pythonBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';
}

export function baseFor(path: string, method: string = 'GET'): string {
  if (NODE_ONLY_PREFIXES.some((p) => path.startsWith(p))) return '/api';
  const choice = getBackendChoice();
  const m = method.toUpperCase();
  const useNode =
    choice === 'node' ||
    (choice === 'auto' &&
      NODE_DEFAULT_ROUTES.some((r) => {
        const pathOnly = path.split('?')[0];
        const matches = r.exact ? pathOnly === r.prefix : pathOnly.startsWith(r.prefix);
        return matches && (!r.methods || r.methods.includes(m));
      }));
  return useNode ? '/api' : pythonBase();
}
