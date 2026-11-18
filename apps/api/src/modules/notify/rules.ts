import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

/**
 * Alert kinds (告警类型) and the admin rules (`settings` key `alerts.rules`). A kind declares its severity,
 * what it refers to (for recipients and the UI link), whether it can recover ("back to normal" notice) and
 * whether external alert channels may receive it (`channel`; which ones is per channel, see channels.ts).
 */
export const ALERT_KINDS = {
  /** Device became error/stopped outside a user action (monitor), or a lifecycle op failed. Params: name, status, reason[, op]. */
  'device.down': { severity: 'error', refType: 'instance', recoverable: true, defaultOn: true, channel: true },
  /** Manual account check ("mark checked") found a problem (logged out, needs verification, suspended…). Params: platform, handle, reason. */
  'account.problem': { severity: 'warning', refType: 'social_account', recoverable: true, defaultOn: true, channel: true },
  /** A publish run ended failed. Params: platform, handle, title[, code]. */
  'publish.failed': { severity: 'error', refType: 'publish', recoverable: false, defaultOn: true, channel: true },
  /** Any other task-centre task failed after its last attempt (off by default). Params: type, label[, code]. */
  'task.failed': { severity: 'warning', refType: 'task', recoverable: false, defaultOn: false, channel: true },
  /**
   * The tracked-account collector device (追踪账号采集设备) hit a challenge / verification / rate-limit screen:
   * collection on it stopped until an admin resumes it. Recovered by the resume or the next successful read.
   * Params: name (device), platform[, code].
   */
  'collector.blocked': { severity: 'error', refType: 'instance', recoverable: true, defaultOn: true, channel: true },
  /**
   * An alert channel failed to deliver (final failure of its notify-<type> task); recovered by its next
   * successful delivery or test. In-app only and to admins only, so a broken channel never alerts itself.
   * Params: name[, code].
   */
  /**
   * 自动发现 (social/sync.ts) found an Instagram account on a cloud phone that no social account records, and
   * the phone is assigned to several users or to nobody (with exactly one it is synced for that user instead).
   * In-app only (admins + the phone's users). Params: name (device), platform, count, reason multiple_users|no_user.
   */
  'account.discovered': { severity: 'info', refType: 'instance', recoverable: false, defaultOn: true, channel: false },
  'channel.failed': { severity: 'warning', refType: 'alert_channel', recoverable: true, defaultOn: true, channel: false },
} as const satisfies Record<string, { severity: 'info' | 'warning' | 'error'; refType: string; recoverable: boolean; defaultOn: boolean; channel: boolean }>;
export type AlertKind = keyof typeof ALERT_KINDS;
export const ALERT_KIND_IDS = Object.keys(ALERT_KINDS) as AlertKind[];
/** Kinds an external channel can receive. */
export const CHANNEL_KIND_IDS = ALERT_KIND_IDS.filter((k) => ALERT_KINDS[k].channel);

/** In-app (bell) switch per kind. External channels choose their kinds themselves (alert_channels.kinds). */
export interface KindRule { inApp: boolean }
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
}

export const LIMITS = { cooldownMax: 7 * 24 * 60, retentionMax: 365 } as const;
const KEY = 'alerts.rules';

export const defaultRules = (): AlertRules => ({
  kinds: Object.fromEntries(ALERT_KIND_IDS.map((k) => [k, { inApp: ALERT_KINDS[k].defaultOn }])) as Record<AlertKind, KindRule>,
  cooldownMinutes: 60,
  notifyAdmins: true,
  recovered: true,
  retentionDays: 30,
});

const int = (v: unknown, min: number, max: number, dflt: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt);

/** Stored rules merged over the defaults (unknown / invalid values fall back), so new kinds get their default. */
export function normalizeRules(raw: unknown): AlertRules {
  const d = defaultRules();
  const v = (raw ?? {}) as Partial<AlertRules> & { kinds?: Record<string, Partial<KindRule>> };
  const kinds = { ...d.kinds };
  for (const k of ALERT_KIND_IDS) {
    const r = v.kinds?.[k];
    if (r) kinds[k] = { inApp: typeof r.inApp === 'boolean' ? r.inApp : d.kinds[k].inApp };
  }
  return {
    kinds,
    cooldownMinutes: int(v.cooldownMinutes, 0, LIMITS.cooldownMax, d.cooldownMinutes),
    notifyAdmins: typeof v.notifyAdmins === 'boolean' ? v.notifyAdmins : d.notifyAdmins,
    recovered: typeof v.recovered === 'boolean' ? v.recovered : d.recovered,
    retentionDays: int(v.retentionDays, 1, LIMITS.retentionMax, d.retentionDays),
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
