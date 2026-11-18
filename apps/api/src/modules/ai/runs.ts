import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

/** Task type of 人设每日草稿 (kept here, without the task handler, so the persona list can read runs without importing it). */
export const DRAFT_TASK = 'persona-drafts';

const T = schema.tasks;
const cols = { id: T.id, refId: T.refId, status: T.status, errorCode: T.errorCode, createdAt: T.createdAt, finishedAt: T.finishedAt, payload: T.payload, result: T.result };
type RunRow = { id: string; refId: string | null; status: string; errorCode: string | null; createdAt: Date; finishedAt: Date | null; payload: unknown; result: unknown };

/** A generation task as shown to people: trigger (schedule|manual) and the number of drafts created (null until it succeeded). */
function runItem({ payload, result, refId: _r, ...r }: RunRow) {
  return {
    ...r, trigger: (payload as { trigger?: string } | null)?.trigger ?? null,
    created: Array.isArray((result as { contentIds?: unknown } | null)?.contentIds) ? (result as { contentIds: string[] }).contentIds.length : null,
  };
}
export type DraftRun = ReturnType<typeof runItem>;

const ofPersonas = (ids: string[]) => and(eq(T.type, DRAFT_TASK), eq(T.refType, 'persona'), inArray(T.refId, ids));

/** The last `limit` generation tasks of one persona, newest first (persona form). */
export async function personaDraftRuns(personaId: string, limit = 5): Promise<DraftRun[]> {
  const rows = await db.select(cols).from(T).where(ofPersonas([personaId])).orderBy(desc(T.createdAt)).limit(limit);
  return rows.map(runItem);
}
