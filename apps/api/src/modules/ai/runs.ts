import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

/** LEGACY task type of the former per-persona daily drafts (handler only finishes old queued tasks as skipped). */
export const DRAFT_TASK = 'persona-drafts';
/** Task type of the daily AI drafts of one social account (kept here, without the handler, so routes can read runs). */
export const ACCOUNT_DRAFT_TASK = 'account-drafts';

const T = schema.tasks;
const cols = { id: T.id, status: T.status, errorCode: T.errorCode, createdAt: T.createdAt, finishedAt: T.finishedAt, result: T.result, payload: T.payload };
type RunRow = { id: string; status: string; errorCode: string | null; createdAt: Date; finishedAt: Date | null; result: unknown; payload: unknown };

/** A generation task as shown to people: trigger (daily / 立即生成), drafts created (null until it succeeded) or the skip code. */
function runItem({ result, payload, ...r }: RunRow) {
  const res = result as { contentIds?: unknown; skipped?: unknown } | null;
  return {
    ...r, trigger: (payload as { trigger?: unknown } | null)?.trigger === 'manual' ? 'manual' as const : 'schedule' as const,
    created: Array.isArray(res?.contentIds) ? res.contentIds.length : null,
    skipped: typeof res?.skipped === 'string' ? res.skipped : null,
  };
}
export type DraftRun = ReturnType<typeof runItem>;

/** The last `limit` generation tasks (daily and 立即生成) of one social account, newest first (社交号 → AI 草稿). */
export async function accountDraftRuns(accountId: string, limit = 5): Promise<DraftRun[]> {
  const rows = await db.select(cols).from(T)
    .where(and(eq(T.type, ACCOUNT_DRAFT_TASK), eq(T.refType, 'social_account'), eq(T.refId, accountId)))
    .orderBy(desc(T.createdAt)).limit(limit);
  return rows.map(runItem);
}
