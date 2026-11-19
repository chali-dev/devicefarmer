import { purgeAuditLog } from '../audit/audit.js';
import { purgeNotifications } from '../notify/notify.js';
import { getRules } from '../notify/rules.js';
import { purgeRiskEvents } from '../risk/events.js';
import { getRetention, purgeTasks } from '../tasks/retention.js';
import { failStaleBackups, scheduleBackup } from './backup.js';
import { purgeStatusEvents } from './history.js';
import { purgeLogFiles } from './logs.js';
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
