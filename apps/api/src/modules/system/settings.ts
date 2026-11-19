import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';

/**
 * System management settings (admin, settings key `system`): backup schedule and the retention of log files, connection
 * history, the audit log (env AUDIT_RETENTION_DAYS = default only) and 风控记录 (risk_events).
 */
const KEY = 'system';

export const BackupSchedule = z.object({
  enabled: z.boolean(),
  /** Local hour (API host time zone) from which the daily backup runs; once per local day. */
  hour: z.number().int().min(0).max(23),
  /** Successful backups kept; older ones are deleted after each successful backup. */
  keep: z.number().int().min(1).max(365),
});
export const SystemSettings = z.object({
  backup: BackupSchedule,
  logRetentionDays: z.number().int().min(1).max(365),
  historyRetentionDays: z.number().int().min(1).max(90),
  auditRetentionDays: z.number().int().min(1).max(3650),
  riskEventsRetentionDays: z.number().int().min(1).max(3650),
});
export type SystemSettingsT = z.infer<typeof SystemSettings>;

export const SYSTEM_DEFAULTS: SystemSettingsT = {
  backup: { enabled: false, hour: 3, keep: 7 }, logRetentionDays: 14, historyRetentionDays: 7,
  auditRetentionDays: Math.min(config.AUDIT_RETENTION_DAYS, 3650), riskEventsRetentionDays: 90,
};

export async function getSystemSettings(): Promise<SystemSettingsT & { updatedAt: string | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const v = (row?.value ?? {}) as Partial<SystemSettingsT>;
  // Each part falls back to its default on its own, so a stored older shape stays usable.
  const part = <T>(s: z.ZodType<T>, x: unknown, d: T): T => { const r = s.safeParse(x); return r.success ? r.data : d; };
  return {
    backup: part(BackupSchedule, v.backup, SYSTEM_DEFAULTS.backup),
    logRetentionDays: part(SystemSettings.shape.logRetentionDays, v.logRetentionDays, SYSTEM_DEFAULTS.logRetentionDays),
    historyRetentionDays: part(SystemSettings.shape.historyRetentionDays, v.historyRetentionDays, SYSTEM_DEFAULTS.historyRetentionDays),
    auditRetentionDays: part(SystemSettings.shape.auditRetentionDays, v.auditRetentionDays, SYSTEM_DEFAULTS.auditRetentionDays),
    riskEventsRetentionDays: part(SystemSettings.shape.riskEventsRetentionDays, v.riskEventsRetentionDays, SYSTEM_DEFAULTS.riskEventsRetentionDays),
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Partial update: omitted parts keep their current value. */
export async function saveSystemSettings(input: Partial<SystemSettingsT>) {
  const { updatedAt: _u, ...cur } = await getSystemSettings();
  const value = { ...cur, ...input };
  await db.insert(schema.settings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  return getSystemSettings();
}
