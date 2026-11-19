import { and, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { ownerPhones } from './phone.js';
import { capacityPerHour as paceCapacity, getRiskSettings } from '../risk/settings.js';
import { createTask } from '../tasks/core.js';
import { PLATFORMS, platformDef } from './platforms.js';
import { firstSlot, HOUR_MS as HOUR } from './slots.js';
import { display, pendingRefreshes, REF_TYPE, refreshRefusal } from './tracked.js';

/**
 * 定时采集 (scheduled collection) for tracked accounts. An account with `refresh_interval_hours` gets a
 * `next_refresh_at` slot. The hourly collection tick (`modules/trending/scheduler.ts`) calls
 * `scheduleTrackedRefreshes`, which takes every slot due before the next tick, advances it by the interval
 * (a conditional update, so concurrent ticks claim a slot once) and creates a `tracked-refresh` task with
 * `runAt` = the slot and idempotency key `scheduled:<account>:<slot>` (at most one task per slot, ever).
 * Slots carry a per-account minute offset, so runs are spread over the hour. Accounts refused exactly like
 * a manual refresh (paused, refresh in progress, API not configured, 采集手机 unset / not the owner's / halted) and
 * platforms without a data source are skipped for that slot with a code in `schedule_skip_code` (no task, no
 * alert). No catch-up: missed slots are not replayed. Instagram accounts are read on their own 采集手机 (phone.ts):
 * their scheduled tasks go through that phone's pace (collector.ts: serial, minimum interval, hourly cap), which
 * defers rather than drops. New Instagram accounts get a 24 h interval by default.
 */
export const SCHEDULE_INTERVALS = [1, 2, 3, 6, 12, 24, 48, 72, 168];
const ta = schema.trackedAccounts;
export { firstSlot };

/** Next slot strictly after `now`, keeping the slot's phase. */
function advance(slot: Date, hours: number, now: Date): Date {
  const step = hours * HOUR;
  const n = Math.max(1, Math.ceil((now.getTime() - slot.getTime() + 1) / step));
  return new Date(slot.getTime() + n * step);
}

export interface ScheduleResult { queued: number; duplicate: number; skipped: { id: string; code: string }[] }

export async function scheduleTrackedRefreshes(now = new Date()): Promise<ScheduleResult> {
  const horizon = new Date(now.getTime() + HOUR);
  const due = await db.select().from(ta).where(and(isNotNull(ta.refreshIntervalHours), lte(ta.nextRefreshAt, horizon)));
  const out: ScheduleResult = { queued: 0, duplicate: 0, skipped: [] };
  if (!due.length) return out;
  const busy = await pendingRefreshes(due.map((a) => a.id));
  for (const acc of due) {
    const slot = acc.nextRefreshAt!;
    const code = !platformDef(acc.platform).source ? 'tracked.schedule_manual_only' : (await refreshRefusal(acc, busy))?.code ?? null;
    const [claimed] = await db.update(ta).set({ nextRefreshAt: advance(slot, acc.refreshIntervalHours!, now), scheduleSkipCode: code })
      .where(and(eq(ta.id, acc.id), eq(ta.nextRefreshAt, slot))).returning({ id: ta.id });
    if (!claimed) continue; // another tick took this slot
    if (code) { out.skipped.push({ id: acc.id, code }); continue; }
    const { created } = await createTask({
      type: 'tracked-refresh', userId: acc.userId, label: display(acc), refType: REF_TYPE, refId: acc.id,
      payload: { trackedAccountId: acc.id, scheduled: true, slot: slot.toISOString() },
      runAt: slot, idempotencyKey: `scheduled:${acc.id}:${slot.toISOString()}`,
    });
    if (created) out.queued++; else out.duplicate++;
  }
  return out;
}

/**
 * 采集容量 (capacity hint for the 采集频率 pickers), per 采集手机: for each phone the owner may pick (`ownerId`, default
 * the caller; users only themselves), how many tracked accounts of ALL users are scheduled on it (not paused, the
 * scheduler skips those) and the scheduled visits per hour they add up to (Σ 1/interval), against what the device
 * pace of the 风控 settings allows per hour (min(maxPerHour, 3600 / minIntervalSec); env TRACKED_DEVICE_* are only the
 * defaults). Aggregates only: no ids, handles or owners of the accounts. Over the limit nothing is refused: the phone
 * defers visits (collector.ts), so collection queues and runs later. Other automatic work on the phone (account
 * checks, feed collection) shares the same pace and is not counted here.
 */
export async function scheduleCapacity(ownerId: string) {
  const pace = await getRiskSettings();
  const { minIntervalSec, maxPerHour } = pace;
  const capacityPerHour = paceCapacity(pace);
  const platforms = PLATFORMS.filter((p) => p.source?.kind === 'device' && isPlatformEnabled(p.id)).map((p) => p.id);
  const phones = await ownerPhones(ownerId);
  const ids = phones.map((p) => p.id);
  const rows = platforms.length && ids.length ? await db.select({
    instanceId: ta.instanceId,
    accounts: sql<number>`count(*)::int`,
    perHour: sql<number>`coalesce(sum(1.0 / ${ta.refreshIntervalHours}), 0)::float8`,
  }).from(ta).where(and(inArray(ta.platform, platforms), inArray(ta.instanceId, ids), isNotNull(ta.refreshIntervalHours), ne(ta.status, 'paused')))
    .groupBy(ta.instanceId) : [];
  return {
    pace: { minIntervalSec, maxPerHour, capacityPerHour },
    phones: phones.map((p) => {
      const r = rows.find((x) => x.instanceId === p.id);
      const visitsPerHour = Math.round(Number(r?.perHour ?? 0) * 100) / 100;
      return { instanceId: p.id, name: p.name, scheduledAccounts: r?.accounts ?? 0, visitsPerHour, capacityPerHour, overloaded: visitsPerHour > capacityPerHour };
    }),
  };
}
