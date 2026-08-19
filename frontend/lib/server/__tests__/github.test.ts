import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  GitHubError,
  createIssue,
  githubConfig,
  isGithubConfigured,
  verifyWebhookSignature,
} from '../github';

const saved: Record<string, string | undefined> = {};
const KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_IN_PROGRESS_LABEL'];

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('githubConfig', () => {
  test('falls back to the shelfsprite repo and the default label', () => {
    const cfg = githubConfig();
    expect(cfg.repo).toBe('ccmalcom/shelfsprite');
    expect(cfg.inProgressLabel).toBe('in progress');
    expect(cfg.token).toBeNull();
    expect(cfg.webhookSecret).toBeNull();
  });

  test('an empty string falls through to the default, like supabaseAdmin', () => {
    process.env.GITHUB_REPO = '';
    expect(githubConfig().repo).toBe('ccmalcom/shelfsprite');
  });

  test('reads the environment on every call, not at import time', () => {
    expect(isGithubConfigured()).toBe(false);
    process.env.GITHUB_TOKEN = 'ghp_test';
    expect(isGithubConfigured()).toBe(true);
  });
});

describe('createIssue', () => {
  test('posts to the configured repo with the pinned api version', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    process.env.GITHUB_REPO = 'owner/name';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ number: 7, html_url: 'https://github.com/owner/name/issues/7' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const issue = await createIssue({ title: 'T', body: 'B' });

    expect(issue).toEqual({ number: 7, url: 'https://github.com/owner/name/issues/7' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/owner/name/issues');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer ghp_test');
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(JSON.parse(init.body)).toEqual({ title: 'T', body: 'B' });
  });

  test('throws GitHubError carrying githubs message on a non-2xx', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 })
    );
    await expect(createIssue({ title: 'T', body: 'B' })).rejects.toMatchObject({
      name: 'GitHubError',
      message: 'Validation Failed',
      status: 422,
    });
  });

  test('throws GitHubError when fetch itself rejects', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(createIssue({ title: 'T', body: 'B' })).rejects.toBeInstanceOf(GitHubError);
  });

  test('throws when called without a token', async () => {
    await expect(createIssue({ title: 'T', body: 'B' })).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 's3cret';
  const body = '{"action":"closed"}';
  const good = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  test('accepts a correct digest', () => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    expect(verifyWebhookSignature(body, good)).toBe(true);
  });

  test('rejects a wrong digest, a wrong body, a missing header, and a missing secret', () => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    expect(verifyWebhookSignature(body, `sha256=${'0'.repeat(64)}`)).toBe(false);
    expect(verifyWebhookSignature('{"action":"opened"}', good)).toBe(false);
    expect(verifyWebhookSignature(body, null)).toBe(false);
    expect(verifyWebhookSignature(body, 'garbage')).toBe(false);
    delete process.env.GITHUB_WEBHOOK_SECRET;
    expect(verifyWebhookSignature(body, good)).toBe(false);
  });
});
