import { failStaleBackups, scheduleBackup } from './backup.js';
import { purgeStatusEvents } from './history.js';
import { purgeLogFiles } from './logs.js';
import { getSystemSettings } from './settings.js';

/**
 * Hourly system maintenance (called by main.ts with the other hourly jobs, and by admins via
 * POST /api/system/maintenance): log file and connection-history retention, crashed backup rows,
 * and the daily backup task (idempotent per local day).
 */
export async function systemHourly() {
  const s = await getSystemSettings();
  const [logFilesDeleted, historyDeleted, staleBackups, backup] = await Promise.all([
    purgeLogFiles(s.logRetentionDays),
    purgeStatusEvents(s.historyRetentionDays),
    failStaleBackups(),
    scheduleBackup(),
  ]);
  return { logFilesDeleted, historyDeleted, staleBackups, backup };
}
