/**
 * Beta-feedback trigger-eligibility state machine. Direct port of mylibrary/feedback.py.
 *
 * Triggers:
 *   - post-setup           one-time, shown after the setup wizard completes
 *   - post-first-profile   one-time, shown after the first taste profile is built
 *   - post-recs            repeatable, shown after each recommend run
 *   - null / general       user manually opened the feedback modal
 *
 * State flow:
 *   ask_later -> submitted | dont_ask
 *   (no state) -> submitted | dont_ask | ask_later
 */
import { and, eq, gt } from 'drizzle-orm';
import { schema, type Db } from './db';
import { utcnowTs } from './serialize';

// Triggers that fire exactly once per user (keyed on run_id='').
export const ONE_TIME_TRIGGERS = ['post-setup', 'post-first-profile'];
// Trigger that fires once per recommend run.
export const REPEATABLE_TRIGGER = 'post-recs';
// Python emits sorted(VALID_CATEGORIES) in the 422 — this array IS that sorted order.
export const VALID_CATEGORIES = ['bug', 'confusing', 'idea', 'praise', 'targeted'];

/** Empty-string env counts as unset (wave-1 convention). */
function promptsEnabled(): boolean {
  const v = process.env.FEEDBACK_PROMPTS_ENABLED;
  if (v === undefined || v === '') return true;
  return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
}
function snoozeHours(): number {
  const v = process.env.FEEDBACK_SNOOZE_HOURS;
  if (v === undefined || v === '') return 72;
  return parseInt(v, 10);
}

/** Insert or update the (user_id, trigger, run_id) FeedbackPromptState row. */
export async function upsertPromptState(
  db: Db,
  args: { userId: string; trigger: string; runId: string; status: string; snoozeUntil?: string | null }
): Promise<void> {
  const rows = await db.select().from(schema.feedbackPromptState).where(and(
    eq(schema.feedbackPromptState.userId, args.userId),
    eq(schema.feedbackPromptState.trigger, args.trigger),
    eq(schema.feedbackPromptState.runId, args.runId),
  ));
  if (rows[0]) {
    await db.update(schema.feedbackPromptState)
      .set({ status: args.status, snoozeUntil: args.snoozeUntil ?? null, updatedAt: utcnowTs() })
      .where(eq(schema.feedbackPromptState.id, rows[0].id));
  } else {
    await db.insert(schema.feedbackPromptState).values({
      userId: args.userId, trigger: args.trigger, runId: args.runId,
      status: args.status, snoozeUntil: args.snoozeUntil ?? null,
    });
  }
}

/** Return true iff the feedback prompt should be shown to userId for this trigger/run. */
export async function checkPromptEligibility(
  db: Db, userId: string, trigger: string, runId: string | null
): Promise<boolean> {
  if (!promptsEnabled()) return false;
  const now = utcnowTs();

  if (ONE_TIME_TRIGGERS.includes(trigger)) {
    const rows = await db.select().from(schema.feedbackPromptState).where(and(
      eq(schema.feedbackPromptState.userId, userId),
      eq(schema.feedbackPromptState.trigger, trigger),
      eq(schema.feedbackPromptState.runId, ''),
    ));
    const row = rows[0];
    if (!row) return true;
    if (row.status === 'ask_later') {
      return row.snoozeUntil !== null && row.snoozeUntil <= now; // lexicographic, same format
    }
    return false; // submitted or dont_ask
  }

  if (trigger === REPEATABLE_TRIGGER) {
    const rid = runId ?? '';
    const globalDontAsk = await db.select().from(schema.feedbackPromptState).where(and(
      eq(schema.feedbackPromptState.userId, userId),
      eq(schema.feedbackPromptState.trigger, REPEATABLE_TRIGGER),
      eq(schema.feedbackPromptState.runId, ''),
      eq(schema.feedbackPromptState.status, 'dont_ask'),
    ));
    if (globalDontAsk[0]) return false;
    const fbRows = await db.select().from(schema.feedback).where(and(
      eq(schema.feedback.userId, userId),
      eq(schema.feedback.trigger, REPEATABLE_TRIGGER),
      eq(schema.feedback.runId, rid),
    ));
    if (fbRows[0]) return false;
    const snooze = await db.select().from(schema.feedbackPromptState).where(and(
      eq(schema.feedbackPromptState.userId, userId),
      eq(schema.feedbackPromptState.trigger, REPEATABLE_TRIGGER),
      eq(schema.feedbackPromptState.runId, rid),
      eq(schema.feedbackPromptState.status, 'ask_later'),
      gt(schema.feedbackPromptState.snoozeUntil, now),
    ));
    return !snooze[0];
  }

  return false; // unknown trigger — don't show
}

/** Record the user's dismiss decision (mode already validated by the route). */
export async function dismissPrompt(
  db: Db, userId: string, trigger: string, runId: string | null, mode: string
): Promise<void> {
  let stateRunId: string;
  let snoozeUntil: string | null;
  if (mode === 'dont_ask') {
    stateRunId = '';
    snoozeUntil = null;
  } else { // 'ask_later' — mode already validated by the route
    stateRunId = ONE_TIME_TRIGGERS.includes(trigger) ? '' : (runId ?? '');
    snoozeUntil = new Date(Date.now() + snoozeHours() * 3_600_000)
      .toISOString().replace('T', ' ').replace('Z', '');
  }
  await upsertPromptState(db, { userId, trigger, runId: stateRunId, status: mode, snoozeUntil });
}
