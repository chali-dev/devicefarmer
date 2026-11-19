import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { PUBLISH_UNFINISHED, TASK_FINAL } from '../../db/schema.js';
import { createTask, registerTaskHandler } from './core.js';

/**
 * Task centre retention (任务保留期): finished tasks (success/failed/cancelled) older than the configured
 * number of days are deleted together with their task_logs (FK cascade) by the hourly `tasks-cleanup`
 * task. Never deleted: unfinished tasks (pending/scheduled/running) and tasks still referenced by an
 * unfinished business row (see `registerTaskKeepRule`). `days: null` keeps everything.
 */

const KEY = 'tasks.retention';
export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 3650;
export const CLEANUP_TYPE = 'tasks-cleanup';
const BATCH = 1000;

export interface RetentionSettings { days: number | null; updatedAt: string | null }

export async function getRetention(): Promise<RetentionSettings> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  if (!row) return { days: DEFAULT_RETENTION_DAYS, updatedAt: null };
  const v = (row.value as { days?: unknown }).days;
  return { days: typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null, updatedAt: row.updatedAt.toISOString() };
}

export async function saveRetention(days: number | null): Promise<RetentionSettings> {
  await db.insert(schema.settings).values({ key: KEY, value: { days } })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: { days }, updatedAt: new Date() } });
  return getRetention();
}

/**
 * A keep rule returns a condition that is true for tasks that must be kept even when finished and old
 * (e.g. the task of a publish run that is still awaiting the operator). Modules register their own.
 */
type KeepRule = (taskId: SQL | typeof schema.tasks.id) => SQL;
const keepRules = new Map<string, KeepRule>();
export function registerTaskKeepRule(name: string, rule: KeepRule): void { keepRules.set(name, rule); }

registerTaskKeepRule('publish', (id) => sql`exists (select 1 from ${schema.publishTasks} p where p.task_id = ${id}
  and p.status in (${sql.join(PUBLISH_UNFINISHED.map((s) => sql`${s}`), sql`, `)}))`);

/** Tasks eligible for deletion at `cutoff` (finished before it, final status, no keep rule matches). */
export function eligible(cutoff: Date): SQL {
  const T = schema.tasks;
  return and(
    inArray(T.status, [...TASK_FINAL]),
    sql`coalesce(${T.finishedAt}, ${T.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
    ...[...keepRules.values()].map((rule) => sql`not ${rule(T.id)}`),
  )!;
}

export interface CleanupResult { days: number | null; cutoff: string | null; tasks: number; logs: number }

/** Deletes eligible tasks in batches. Safe to run concurrently (a row is deleted once). */
export async function purgeTasks(days: number | null, now = new Date()): Promise<CleanupResult> {
  if (!days) return { days, cutoff: null, tasks: 0, logs: 0 };
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return { days, cutoff: cutoff.toISOString(), ...(await deleteFinishedTasks(cutoff)) };
}

/** Deletes every eligible task finished before `cutoff` (系统配置 → 日志 清除 passes now: every finished task). */
export async function deleteFinishedTasks(cutoff: Date): Promise<{ tasks: number; logs: number }> {
  let tasks = 0; let logs = 0;
  for (;;) {
    const ids = (await db.select({ id: schema.tasks.id }).from(schema.tasks).where(eligible(cutoff)).limit(BATCH)).map((r) => r.id);
    if (!ids.length) break;
    const [l] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, ids));
    // Re-checks eligibility inside the delete: a row retried or re-referenced meanwhile is kept.
    const deleted = await db.delete(schema.tasks).where(and(inArray(schema.tasks.id, ids), eligible(cutoff))).returning({ id: schema.tasks.id });
    tasks += deleted.length; logs += l?.n ?? 0;
    if (ids.length < BATCH) break;
  }
  return { tasks, logs };
}

registerTaskHandler(CLEANUP_TYPE, {
  queue: 'task-ops',
  concurrency: 1,
  timeoutMs: 10 * 60_000,
  maxAttempts: 1,
  async run(ctx) {
    const { days } = await getRetention();
    const r = await purgeTasks(days);
    await ctx.log('info', days ? `deleted ${r.tasks} finished tasks (${r.logs} log lines) finished before ${r.cutoff}` : 'retention disabled: nothing deleted', { ...r });
    return r;
  },
});

/**
 * Creates the cleanup task. The hourly one is idempotent per hour, so several API processes create it once.
 * `manual` = an admin's "run now" (its own task, owned by that admin).
 */
export async function scheduleTaskCleanup(userId: string | null = null, manual = false) {
  const hour = new Date().toISOString().slice(0, 13);
  return createTask({
    type: CLEANUP_TYPE, userId, payload: {},
    idempotencyKey: manual ? null : `hourly:${hour}`,
  });
}
