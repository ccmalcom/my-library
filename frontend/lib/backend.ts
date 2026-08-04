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
}

/**
 * Routes that default to Node in auto mode. Waves append here as groups flip.
 * Wave 1: every read is Node; writes on the same prefixes stay Python until wave 2/3.
 */
export const NODE_DEFAULT_ROUTES: BackendRule[] = [
  { prefix: '/stats' },
  { prefix: '/books', methods: ['GET'] },
  { prefix: '/profile', methods: ['GET'] },
  { prefix: '/recommendations', methods: ['GET'] },
  { prefix: '/settings', methods: ['GET'] },
  { prefix: '/directive', methods: ['GET'] },
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
      NODE_DEFAULT_ROUTES.some(
        (r) => path.startsWith(r.prefix) && (!r.methods || r.methods.includes(m))
      ));
  return useNode ? '/api' : pythonBase();
}
