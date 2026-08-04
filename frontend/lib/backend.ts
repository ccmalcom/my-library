/**
 * Backend switcher (migration scaffolding, removed at cutover).
 * Decides per request whether a path goes to the Python backend on Railway
 * (NEXT_PUBLIC_API_URL) or the Node backend at same-origin /api/*.
 * - 'auto' (default): Python, except path prefixes waves have flipped to Node.
 * - 'python' / 'node': admin override forcing one side (System tab on /admin).
 */
export type BackendChoice = 'python' | 'node' | 'auto';

const STORAGE_KEY = 'mylibrary.backend';

/** Prefixes that default to Node in auto mode. Waves append here as groups flip. */
export const NODE_DEFAULT_PREFIXES: string[] = [];

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

export function baseFor(path: string): string {
  if (NODE_ONLY_PREFIXES.some((p) => path.startsWith(p))) return '/api';
  const choice = getBackendChoice();
  const useNode =
    choice === 'node' ||
    (choice === 'auto' && NODE_DEFAULT_PREFIXES.some((p) => path.startsWith(p)));
  return useNode ? '/api' : pythonBase();
}
