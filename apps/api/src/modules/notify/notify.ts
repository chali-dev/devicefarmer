import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Notification } from '../../db/schema.js';
import { events } from '../../lib/events.js';
import { createTask, registerTaskHandler } from '../tasks/core.js';
import { ALERT_KINDS, getRules, type AlertKind, type AlertRules } from './rules.js';
import { enqueueChannels, matchingChannels } from './channels.js';

/**
 * Notifications (告警通知): the one entry point other modules use (through ./triggers.ts).
 *
 * - `notify()` raises an alert for an object; `recover()` clears it. An alert is delivered when its
 *   (kind, key) state is not active or was last delivered before the cooldown; so a persisting problem is
 *   repeated at most once per cooldown, and a problem that recovered in between is reported again at once.
 *   The claim is a single upsert, so concurrent callers deliver once.
 * - Recipients: every enabled admin (rule `notifyAdmins`) plus the object's people: device → users granted
 *   on it; social account → its owner; publish task → its owner; task → its creator + users granted on its
 *   device; alert channel → admins only (always).
 * - In-app rows per kind (rule `inApp`, pushed to exactly those users over /api/events), plus one
 *   `notify-<type>` task per matching enabled alert channel (channels.ts; never awaited by the caller).
 *   De-dup / cooldown is per alert, before the fan-out. Never throws: alerting must not break the caller.
 */
const S = schema.alertStates;
const N = schema.notifications;
export type AlertParams = Record<string, string | number | null | undefined>;

export interface AlertInput {
  kind: AlertKind;
  refId: string;
  /** De-duplication key (default refId), e.g. per publish round. */
  key?: string;
  /** Short identifiers / codes only (truncated); never secrets or external free text. */
  params: AlertParams;
  /** Skip the external alert channels (e.g. for a failed channel delivery itself). */
  inAppOnly?: boolean;
}

const clean = (p: AlertParams): Record<string, string | number> =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : v as number]));

/** Users who receive alerts about an object (without admins). */
async function peopleOf(refType: string, refId: string): Promise<string[]> {
  const grants = (instanceId: string) => db.select({ id: schema.instanceGrants.userId }).from(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, instanceId));
  if (refType === 'instance') return (await grants(refId)).map((r) => r.id);
  if (refType === 'alert_channel') return (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, 'admin'))).map((r) => r.id);
  if (refType === 'social_account') return (await db.select({ id: schema.socialAccounts.userId }).from(schema.socialAccounts).where(eq(schema.socialAccounts.id, refId))).map((r) => r.id);
  if (refType === 'publish') return (await db.select({ id: schema.publishTasks.userId }).from(schema.publishTasks).where(eq(schema.publishTasks.id, refId))).map((r) => r.id);
  if (refType === 'task') {
    const [t] = await db.select({ createdBy: schema.tasks.createdBy, instanceId: schema.tasks.instanceId }).from(schema.tasks).where(eq(schema.tasks.id, refId));
    if (!t) return [];
    return [...(t.createdBy ? [t.createdBy] : []), ...(t.instanceId ? (await grants(t.instanceId)).map((r) => r.id) : [])];
  }
  return [];
}

export async function recipientsOf(kind: AlertKind, refId: string, rules: Pick<AlertRules, 'notifyAdmins'>): Promise<string[]> {
  const ids = new Set(await peopleOf(ALERT_KINDS[kind].refType, refId));
  if (rules.notifyAdmins) {
    for (const a of await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.role, 'admin'), eq(schema.users.disabled, false)))) ids.add(a.id);
  }
  if (!ids.size) return [];
  // Disabled users get nothing.
  return (await db.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, [...ids]), eq(schema.users.disabled, false)))).map((r) => r.id);
}

async function deliver(a: AlertInput, recovered: boolean, rules: AlertRules, channels: Awaited<ReturnType<typeof matchingChannels>>): Promise<void> {
  const def = ALERT_KINDS[a.kind];
  const rule = rules.kinds[a.kind];
  const params = clean(a.params);
  if (rule.inApp) {
    const users = await recipientsOf(a.kind, a.refId, rules);
    if (users.length) {
      const rows = await db.insert(N).values(users.map((userId) => ({
        userId, kind: a.kind, severity: recovered ? 'info' as const : def.severity, recovered, params, refType: def.refType, refId: a.refId,
      }))).returning();
      for (const n of rows) events.publish({ type: 'notification.created', userId: n.userId, notification: n });
    }
  }
  await enqueueChannels(channels, { kind: a.kind, recovered, params, refType: def.refType, refId: a.refId });
}

const channelsFor = (a: AlertInput) => (a.inAppOnly ? Promise.resolve([]) : matchingChannels(a.kind));

/** Raises an alert. Returns true when it was delivered (false: kind off in-app and no channel takes it, or within the cooldown). */
export async function notify(a: AlertInput): Promise<boolean> {
  try {
    const rules = await getRules();
    const rule = rules.kinds[a.kind];
    if (!rule) return false;
    const channels = await channelsFor(a);
    if (!rule.inApp && !channels.length) return false;
    const [claimed] = await db.insert(S).values({ kind: a.kind, key: a.key ?? a.refId, active: true, lastAlertAt: sql`now()` })
      .onConflictDoUpdate({
        target: [S.kind, S.key],
        set: { active: true, lastAlertAt: sql`now()`, updatedAt: sql`now()` },
        setWhere: sql`${S.active} = false or ${S.lastAlertAt} < now() - make_interval(mins => ${rules.cooldownMinutes}::int)`,
      }).returning({ kind: S.kind });
    if (!claimed) return false;
    await deliver(a, false, rules, channels);
    return true;
  } catch (err) {
    console.warn('[notify] alert failed', a.kind, a.refId, err);
    return false;
  }
}

/** Clears an active alert; sends a "recovered" notice when the kind recovers and the rule asks for it. */
export async function recover(a: AlertInput): Promise<boolean> {
  try {
    const [cleared] = await db.update(S).set({ active: false, updatedAt: sql`now()` })
      .where(and(eq(S.kind, a.kind), eq(S.key, a.key ?? a.refId), eq(S.active, true))).returning({ kind: S.kind });
    if (!cleared) return false;
    const rules = await getRules();
    if (!rules.recovered || !ALERT_KINDS[a.kind].recoverable) return false;
    await deliver(a, true, rules, await channelsFor(a));
    return true;
  } catch (err) {
    console.warn('[notify] recovery failed', a.kind, a.refId, err);
    return false;
  }
}

// ---------------------------------------------------------------- reading (REST)

export async function unreadCount(userId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(N).where(and(eq(N.userId, userId), sql`${N.readAt} is null`));
  return r?.n ?? 0;
}

export async function markRead(userId: string, id: string): Promise<Notification | undefined> {
  const [row] = await db.update(N).set({ readAt: sql`coalesce(${N.readAt}, now())` }).where(and(eq(N.id, id), eq(N.userId, userId))).returning();
  return row;
}

export async function markAllRead(userId: string): Promise<number> {
  const rows = await db.update(N).set({ readAt: sql`now()` }).where(and(eq(N.userId, userId), sql`${N.readAt} is null`)).returning({ id: N.id });
  return rows.length;
}

// ---------------------------------------------------------------- retention

export const NOTIFY_CLEANUP_TASK = 'notifications-cleanup';
/** Unread notifications are kept at least this long. */
const UNREAD_MIN_DAYS = 90;
const STATE_DAYS = 30;

export async function purgeNotifications(days: number): Promise<{ read: number; unread: number; states: number }> {
  const read = await db.delete(N).where(sql`${N.readAt} is not null and ${N.createdAt} < now() - make_interval(days => ${days}::int)`).returning({ id: N.id });
  const unread = await db.delete(N).where(sql`${N.readAt} is null and ${N.createdAt} < now() - make_interval(days => ${Math.max(days, UNREAD_MIN_DAYS)}::int)`).returning({ id: N.id });
  const states = await db.delete(S).where(sql`${S.updatedAt} < now() - make_interval(days => ${STATE_DAYS}::int) and ${S.lastAlertAt} < now() - make_interval(days => ${STATE_DAYS}::int)`).returning({ kind: S.kind });
  return { read: read.length, unread: unread.length, states: states.length };
}

registerTaskHandler(NOTIFY_CLEANUP_TASK, {
  queue: 'task-ops',
  concurrency: 1,
  timeoutMs: 5 * 60_000,
  maxAttempts: 1,
  async run(ctx) {
    const { retentionDays } = await getRules();
    const r = await purgeNotifications(retentionDays);
    await ctx.log('info', `deleted ${r.read} read and ${r.unread} unread notifications, ${r.states} alert states`, { ...r, retentionDays });
    return r;
  },
});

/** Hourly, idempotent per hour (several API processes create it once). */
export function scheduleNotifyCleanup() {
  return createTask({ type: NOTIFY_CLEANUP_TASK, payload: {}, idempotencyKey: `hourly:${new Date().toISOString().slice(0, 13)}` });
}
