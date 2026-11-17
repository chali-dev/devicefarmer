import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

/**
 * Alert kinds (告警类型) and the admin rules (`settings` key `alerts.rules`). A kind declares its severity,
 * what it refers to (for recipients and the UI link) and whether it can recover ("back to normal" notice).
 */
export const ALERT_KINDS = {
  /** Device became error/stopped outside a user action (monitor), or a lifecycle op failed. Params: name, status, reason[, op]. */
  'device.down': { severity: 'error', refType: 'instance', recoverable: true, defaultOn: true },
  /** Account check result is a problem (logged out, needs verification, suspended…, or the check failed). Params: platform, handle, reason[, code]. */
  'account.problem': { severity: 'warning', refType: 'social_account', recoverable: true, defaultOn: true },
  /** Official-API authorisation expired / revoked / missing permission. Params: platform, handle, status[, code]. */
  'connection.expired': { severity: 'error', refType: 'social_account', recoverable: true, defaultOn: true },
  /** A publish run ended failed. Params: platform, handle, title[, code]. */
  'publish.failed': { severity: 'error', refType: 'publish', recoverable: false, defaultOn: true },
  /** Any other task-centre task failed after its last attempt (off by default). Params: type, label[, code]. */
  'task.failed': { severity: 'warning', refType: 'task', recoverable: false, defaultOn: false },
} as const satisfies Record<string, { severity: 'info' | 'warning' | 'error'; refType: string; recoverable: boolean; defaultOn: boolean }>;
export type AlertKind = keyof typeof ALERT_KINDS;
export const ALERT_KIND_IDS = Object.keys(ALERT_KINDS) as AlertKind[];

export interface KindRule { inApp: boolean; telegram: boolean }
export interface AlertRules {
  kinds: Record<AlertKind, KindRule>;
  /** The same kind + object is not delivered again within this many minutes unless it recovered meanwhile. */
  cooldownMinutes: number;
  /** All enabled admins receive every alert (besides the object's owner / granted users). */
  notifyAdmins: boolean;
  /** Send a "recovered" notice when a recoverable problem clears. */
  recovered: boolean;
  /** Read in-app notifications are deleted after this many days (unread ones after max(days, 90)). */
  retentionDays: number;
  /** 号状态监控: periodic official-API check of connected social accounts every N hours; null = off. */
  accountCheckHours: number | null;
}

export const LIMITS = { cooldownMax: 7 * 24 * 60, retentionMax: 365, accountCheckMax: 24 * 7 } as const;
const KEY = 'alerts.rules';

export const defaultRules = (): AlertRules => ({
  kinds: Object.fromEntries(ALERT_KIND_IDS.map((k) => [k, { inApp: ALERT_KINDS[k].defaultOn, telegram: ALERT_KINDS[k].defaultOn }])) as Record<AlertKind, KindRule>,
  cooldownMinutes: 60,
  notifyAdmins: true,
  recovered: true,
  retentionDays: 30,
  accountCheckHours: 24,
});

const int = (v: unknown, min: number, max: number, dflt: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt);

/** Stored rules merged over the defaults (unknown / invalid values fall back), so new kinds get their default. */
export function normalizeRules(raw: unknown): AlertRules {
  const d = defaultRules();
  const v = (raw ?? {}) as Partial<AlertRules> & { kinds?: Record<string, Partial<KindRule>> };
  const kinds = { ...d.kinds };
  for (const k of ALERT_KIND_IDS) {
    const r = v.kinds?.[k];
    if (r) kinds[k] = { inApp: typeof r.inApp === 'boolean' ? r.inApp : d.kinds[k].inApp, telegram: typeof r.telegram === 'boolean' ? r.telegram : d.kinds[k].telegram };
  }
  return {
    kinds,
    cooldownMinutes: int(v.cooldownMinutes, 0, LIMITS.cooldownMax, d.cooldownMinutes),
    notifyAdmins: typeof v.notifyAdmins === 'boolean' ? v.notifyAdmins : d.notifyAdmins,
    recovered: typeof v.recovered === 'boolean' ? v.recovered : d.recovered,
    retentionDays: int(v.retentionDays, 1, LIMITS.retentionMax, d.retentionDays),
    accountCheckHours: v.accountCheckHours === null ? null : int(v.accountCheckHours, 1, LIMITS.accountCheckMax, d.accountCheckHours!),
  };
}

export async function getRules(): Promise<AlertRules & { updatedAt: string | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { ...normalizeRules(row?.value), updatedAt: row?.updatedAt.toISOString() ?? null };
}

/** Partial update: omitted fields keep their stored value. */
export async function saveRules(patch: Partial<Omit<AlertRules, 'kinds'>> & { kinds?: Partial<Record<AlertKind, Partial<KindRule>>> }) {
  const cur = await getRules();
  const kinds = { ...cur.kinds };
  for (const [k, r] of Object.entries(patch.kinds ?? {}) as [AlertKind, Partial<KindRule>][]) kinds[k] = { ...kinds[k], ...r };
  const { updatedAt: _u, ...rest } = cur;
  const value = normalizeRules({ ...rest, ...patch, kinds });
  await db.insert(schema.settings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  return getRules();
}
