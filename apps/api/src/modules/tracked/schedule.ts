import { and, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { COLLECTOR_PLATFORMS } from './collector.js';
import { capacityPerHour as paceCapacity, getRiskSettings } from '../risk/settings.js';
import { createTask } from '../tasks/core.js';
import { platformDef } from './platforms.js';
import { firstSlot, HOUR_MS as HOUR } from './slots.js';
import { display, pendingRefreshes, REF_TYPE, refreshRefusal } from './tracked.js';

/**
 * 定时采集 (scheduled collection) for tracked accounts. An account with `refresh_interval_hours` gets a
 * `next_refresh_at` slot. The hourly collection tick (`modules/trending/scheduler.ts`) calls
 * `scheduleTrackedRefreshes`, which takes every slot due before the next tick, advances it by the interval
 * (a conditional update, so concurrent ticks claim a slot once) and creates a `tracked-refresh` task with
 * `runAt` = the slot and idempotency key `scheduled:<account>:<slot>` (at most one task per slot, ever).
 * Slots carry a per-account minute offset, so runs are spread over the hour. Accounts refused exactly like
 * a manual refresh (paused, refresh in progress, API not configured, collector device unset / halted) and
 * platforms without a data source are skipped for that slot with a code in `schedule_skip_code` (no task, no
 * alert). No catch-up: missed slots are not replayed. Instagram accounts are read on the collector device:
 * their scheduled tasks go through the same device pace (collector.ts: serial, minimum interval, hourly cap),
 * which defers rather than drops. New Instagram accounts get a 24 h interval by default.
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
 * 采集容量 (capacity hint for the 采集频率 pickers): per collector-device platform, how many accounts of ALL
 * users are on a schedule (not paused, the scheduler skips those) and the scheduled visits per hour they add up
 * to (Σ 1/interval), against what the device pace of the 风控 settings allows per hour (min(maxPerHour,
 * 3600 / minIntervalSec); env TRACKED_DEVICE_* are only the defaults). Aggregates only: no ids, handles or owners. Over the limit nothing
 * is refused: the collector defers visits (collector.ts), so collection queues and runs later.
 */
export async function scheduleCapacity() {
  const pace = await getRiskSettings();
  const { minIntervalSec, maxPerHour } = pace;
  const capacityPerHour = paceCapacity(pace);
  const platforms = COLLECTOR_PLATFORMS.filter((p) => isPlatformEnabled(p));
  const rows = platforms.length ? await db.select({
    platform: ta.platform,
    accounts: sql<number>`count(*)::int`,
    perHour: sql<number>`coalesce(sum(1.0 / ${ta.refreshIntervalHours}), 0)::float8`,
  }).from(ta).where(and(inArray(ta.platform, platforms), isNotNull(ta.refreshIntervalHours), ne(ta.status, 'paused'))).groupBy(ta.platform) : [];
  return {
    pace: { minIntervalSec, maxPerHour, capacityPerHour },
    platforms: platforms.map((platform) => {
      const r = rows.find((x) => x.platform === platform);
      const visitsPerHour = Math.round(Number(r?.perHour ?? 0) * 100) / 100;
      return { platform, scheduledAccounts: r?.accounts ?? 0, visitsPerHour, capacityPerHour, overloaded: visitsPerHour > capacityPerHour };
    }),
  };
}
