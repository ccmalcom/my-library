import { inArray } from 'drizzle-orm';
import { schema, type Db } from './db';
import { tsToIso } from './serialize';

type FeedbackRow = typeof schema.feedback.$inferSelect;

/**
 * The admin feedback wire shape. All three admin feedback routes serialize
 * through here so the list, the status PATCH, and the issue POST cannot drift
 * apart — the client splices a single item straight into the cached list.
 */
export interface AdminFeedbackItem {
  id: number;
  user_id: string;
  email: string | null;
  category: string;
  body: string;
  trigger: string | null;
  run_id: string | null;
  page: string | null;
  app_version: string | null;
  status: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  created_at: string;
}

export function serializeFeedbackRow(row: FeedbackRow, email: string | null): AdminFeedbackItem {
  return {
    id: row.id,
    user_id: row.userId,
    email,
    category: row.category,
    body: row.body,
    trigger: row.trigger,
    run_id: row.runId,
    page: row.page,
    app_version: row.appVersion,
    status: row.status,
    github_issue_number: row.githubIssueNumber,
    github_issue_url: row.githubIssueUrl,
    // `created_at` is NOT NULL in the schema, so tsToIso never returns null here.
    // The client type says `string`; the assertion keeps the two in agreement
    // rather than pushing a null check into every consumer.
    created_at: tsToIso(row.createdAt)!,
  };
}

/** Supabase user id -> invite email, for whichever ids are asked about. */
export async function emailsForUserIds(db: Db, userIds: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return emails;
  const invites = await db
    .select({ sid: schema.invites.supabaseUserId, email: schema.invites.email })
    .from(schema.invites)
    .where(inArray(schema.invites.supabaseUserId, unique));
  for (const i of invites) if (i.sid) emails.set(i.sid, i.email);
  return emails;
}
