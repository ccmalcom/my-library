import { createHmac, timingSafeEqual } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_REPO = 'ccmalcom/shelfsprite';
const DEFAULT_IN_PROGRESS_LABEL = 'in progress';

export class GitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GithubConfig {
  repo: string;
  token: string | null;
  webhookSecret: string | null;
  inProgressLabel: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

/**
 * Read on every call rather than captured in a module-level constant: a constant
 * is frozen at import time and invisible to the per-test environment mutation the
 * `setupTestEnv` pattern relies on. `||` rather than `??` so an empty-string value
 * falls through to the default — the rule already recorded for supabaseAdmin.ts.
 */
export function githubConfig(): GithubConfig {
  return {
    repo: process.env.GITHUB_REPO || DEFAULT_REPO,
    token: process.env.GITHUB_TOKEN || null,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || null,
    inProgressLabel: process.env.GITHUB_IN_PROGRESS_LABEL || DEFAULT_IN_PROGRESS_LABEL,
  };
}

/** `repo` always resolves through its default, so the token is the only real question. */
export function isGithubConfigured(): boolean {
  return githubConfig().token !== null;
}

export async function createIssue(input: { title: string; body: string }): Promise<CreatedIssue> {
  const { repo, token } = githubConfig();
  if (!token) throw new GitHubError('GitHub is not configured');

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: input.title, body: input.body }),
    });
  } catch (err) {
    throw new GitHubError(`GitHub request failed: ${(err as Error).message}`);
  }

  const data = (await res.json().catch(() => null)) as {
    number?: number;
    html_url?: string;
    message?: string;
  } | null;

  if (!res.ok) {
    throw new GitHubError(data?.message || `GitHub returned ${res.status}`, res.status);
  }
  if (typeof data?.number !== 'number' || typeof data.html_url !== 'string') {
    throw new GitHubError('GitHub response is missing the issue number or url', res.status);
  }
  return { number: data.number, url: data.html_url };
}

/**
 * `rawBody` must be the exact bytes GitHub signed. Re-serializing parsed JSON
 * produces a different digest and a permanently failing webhook.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null): boolean {
  const { webhookSecret } = githubConfig();
  if (!webhookSecret || !header) return false;
  const expected = `sha256=${createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  // timingSafeEqual throws on a length mismatch, so lengths are compared first.
  // Length is not a secret; the digest is.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
