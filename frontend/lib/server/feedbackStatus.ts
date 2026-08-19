/**
 * Feedback triage vocabulary.
 *
 * Imported by `components/admin/FeedbackTab.tsx` as well as by route handlers, so
 * this module must stay dependency-free: anything imported here (Zod, drizzle,
 * node builtins) lands in the browser bundle. Same constraint, same reason, as
 * `lib/server/rating.ts`.
 */
export const FEEDBACK_STATUSES = ['open', 'reported', 'in_progress', 'resolved'] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Every row starts here, including rows that predate the column. */
export const DEFAULT_FEEDBACK_STATUS: FeedbackStatus = 'open';

/** What the admin tab's default "Open & active" filter selects. */
export const ACTIVE_FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  'open',
  'reported',
  'in_progress',
];

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}
