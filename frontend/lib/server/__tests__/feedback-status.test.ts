import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  ACTIVE_FEEDBACK_STATUSES,
  DEFAULT_FEEDBACK_STATUS,
  FEEDBACK_STATUSES,
  isFeedbackStatus,
} from '../feedbackStatus';
import { schema } from '../db';
import { makeTestDb } from './helpers/pglite';

describe('feedback status vocabulary', () => {
  test('lists the four statuses in triage order', () => {
    expect(FEEDBACK_STATUSES).toEqual(['open', 'reported', 'in_progress', 'resolved']);
  });

  test('defaults to open', () => {
    expect(DEFAULT_FEEDBACK_STATUS).toBe('open');
  });

  test('active statuses are everything except resolved', () => {
    expect(ACTIVE_FEEDBACK_STATUSES).toEqual(['open', 'reported', 'in_progress']);
  });

  test('accepts every known status', () => {
    for (const s of FEEDBACK_STATUSES) expect(isFeedbackStatus(s)).toBe(true);
  });

  test('rejects unknown values, near-misses, and non-strings', () => {
    for (const v of ['', 'Open', 'in progress', 'done', 0, null, undefined, {}]) {
      expect(isFeedbackStatus(v)).toBe(false);
    }
  });
});

describe('feedback status column', () => {
  test('defaults to open and leaves the github columns null', async () => {
    const { db, close } = await makeTestDb();
    try {
      const [row] = await db
        .insert(schema.feedback)
        .values({ userId: 'u1', category: 'bug', body: 'it broke' })
        .returning();
      expect(row!.status).toBe('open');
      expect(row!.githubIssueNumber).toBeNull();
      expect(row!.githubIssueUrl).toBeNull();

      const [updated] = await db
        .update(schema.feedback)
        .set({ status: 'reported', githubIssueNumber: 42, githubIssueUrl: 'https://x/42' })
        .where(eq(schema.feedback.id, row!.id))
        .returning();
      expect(updated!.status).toBe('reported');
      expect(updated!.githubIssueNumber).toBe(42);
    } finally {
      await close();
    }
  });
});
