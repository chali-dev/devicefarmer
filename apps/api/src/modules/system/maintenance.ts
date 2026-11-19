import { purgeAuditLog } from '../audit/audit.js';
import { purgeNotifications } from '../notify/notify.js';
import { getRules } from '../notify/rules.js';
import { purgeRiskEvents } from '../risk/events.js';
import { sql } from 'drizzle-orm';
import { db, sqlClient } from '../../db/index.js';
import { TASK_FINAL } from '../../db/schema.js';
import { deleteFinishedTasks, getRetention, purgeTasks } from '../tasks/retention.js';
import { failStaleBackups, scheduleBackup } from './backup.js';
import { purgeStatusEvents } from './history.js';
import { clearLogs, listLogFiles, purgeLogFiles } from './logs.js';
import { getSystemSettings } from './settings.js';

/**
 * Hourly system maintenance (called by main.ts with the other hourly jobs): retention of log files, connection
 * history, the audit log and 风控记录 (risk_events) from the `system` settings, crashed backup rows, and the daily
 * backup task (idempotent per local day). Finished tasks and notifications have their own hourly tasks.
 */
export async function systemHourly() {
  const s = await getSystemSettings();
  const [logFilesDeleted, historyDeleted, staleBackups, backup, riskEventsDeleted, auditDeleted] = await Promise.all([
    purgeLogFiles(s.logRetentionDays),
    purgeStatusEvents(s.historyRetentionDays),
    failStaleBackups(),
    scheduleBackup(),
    purgeRiskEvents(s.riskEventsRetentionDays),
    purgeAuditLog(s.auditRetentionDays),
  ]);
  return { logFilesDeleted, historyDeleted, staleBackups, backup, riskEventsDeleted, auditDeleted };
}

/**
 * 立即清理 (POST /api/system/maintenance, 系统配置 → 日志): the hourly maintenance plus the task-centre and
 * notification retention (the same purges their hourly `tasks-cleanup` / `notifications-cleanup` tasks run), now.
 */
export async function runAllPurges() {
  const [sys, retention, rules] = await Promise.all([systemHourly(), getRetention(), getRules()]);
  const [tasks, notes] = await Promise.all([purgeTasks(retention.days), purgeNotifications(rules.retentionDays)]);
  return { ...sys, tasksDeleted: tasks.tasks, taskLogsDeleted: tasks.logs, notificationsDeleted: notes.read + notes.unread };
}

/** 系统配置 → 日志: the kinds of the six rows (retention by days hourly, 清除 = everything now, sizes). */
export const PURGE_KINDS = ['logs', 'history', 'audit', 'tasks', 'risk', 'notifications'] as const;
export type PurgeKind = (typeof PURGE_KINDS)[number];

/** The DB-backed kinds that are emptied whole (TRUNCATE frees the space at once, so the size drops right away). */
const TABLE: Record<Exclude<PurgeKind, 'logs' | 'tasks'>, string> = {
  history: 'instance_status_events', audit: 'audit_logs', risk: 'risk_events', notifications: 'notifications',
};

/**
 * A row's 清除 (owner 2026-11-19 「清除后为 0kb」): everything of that kind now, not only what is past its retention.
 * logs = every daily file (today's truncated) + the in-memory ring; history / audit / risk / notifications = every row
 * (TRUNCATE under a short lock timeout, DELETE if the lock isn't granted in time; no table references them); tasks =
 * every FINISHED task with its logs (unfinished ones and those a keep rule protects stay), then VACUUM FULL of tasks +
 * task_logs so their size shrinks to what is left (skipped when the lock isn't granted within 5 s). The clear itself
 * is audited afterwards, so the audit log holds that one row again.
 */
export async function clearOne(kind: PurgeKind): Promise<{ deleted: number; logs?: number }> {
  if (kind === 'logs') return { deleted: await clearLogs() };
  if (kind === 'tasks') {
    const r = await deleteFinishedTasks(new Date(Date.now() + 1000));
    await vacuumFull(['tasks', 'task_logs']);
    return { deleted: r.tasks, logs: r.logs };
  }
  const table = sql.identifier(TABLE[kind]);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`lock table ${table} in access exclusive mode`);
      const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${table}`);
      await tx.execute(sql`truncate ${table}`);
      return { deleted: Number(row?.n ?? 0) };
    });
  } catch {
    const r = await db.execute(sql`delete from ${table}`);
    return { deleted: r.count ?? 0 };
  }
}

async function vacuumFull(tables: string[]): Promise<void> {
  const conn = await sqlClient.reserve();
  try {
    await conn`set lock_timeout = '5s'`;
    for (const t of tables) await conn.unsafe(`vacuum full ${t}`).catch(() => undefined);
    await conn`reset lock_timeout`;
  } finally { conn.release(); }
}

export interface KindSize { bytes: number; rows?: number; files?: number; unfinished?: number }

/**
 * Current size per kind (GET /api/system/log-sizes): the daily files of LOG_DIR (bytes + count), else
 * pg_total_relation_size (table + indexes + TOAST) of the tables involved with their row counts; tasks = tasks +
 * task_logs, `unfinished` = the rows a 清除 keeps (pending / scheduled / running).
 */
export async function logSizes(): Promise<Record<PurgeKind, KindSize>> {
  const files = await listLogFiles();
  const final = sql.join(TASK_FINAL.map((s) => sql`${s}`), sql`, `);
  const [r] = await db.execute<Record<string, string | number>>(sql`select
    pg_total_relation_size('instance_status_events') as history_b, (select count(*) from instance_status_events)::int as history_n,
    pg_total_relation_size('audit_logs') as audit_b, (select count(*) from audit_logs)::int as audit_n,
    pg_total_relation_size('risk_events') as risk_b, (select count(*) from risk_events)::int as risk_n,
    pg_total_relation_size('notifications') as notifications_b, (select count(*) from notifications)::int as notifications_n,
    pg_total_relation_size('tasks') + pg_total_relation_size('task_logs') as tasks_b, (select count(*) from tasks)::int as tasks_n,
    (select count(*) from tasks where status not in (${final}))::int as tasks_u`);
  const n = (k: string) => Number(r?.[k] ?? 0);
  const row = (k: string): KindSize => ({ bytes: n(`${k}_b`), rows: n(`${k}_n`) });
  return {
    logs: { bytes: files.reduce((a, f) => a + f.size, 0), files: files.length },
    history: row('history'), audit: row('audit'), risk: row('risk'), notifications: row('notifications'),
    tasks: { ...row('tasks'), unfinished: n('tasks_u') },
  };
}
