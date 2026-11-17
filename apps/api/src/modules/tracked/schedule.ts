import { createHash } from 'node:crypto';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { createTask } from '../tasks/core.js';
import { platformDef } from './platforms.js';
import { display, pendingRefreshes, REF_TYPE, refreshRefusal } from './tracked.js';

/**
 * 定时采集 (scheduled collection) for tracked accounts. An account with `refresh_interval_hours` gets a
 * `next_refresh_at` slot. The hourly collection tick (`modules/trending/scheduler.ts`) calls
 * `scheduleTrackedRefreshes`, which takes every slot due before the next tick, advances it by the interval
 * (a conditional update, so concurrent ticks claim a slot once) and creates a `tracked-refresh` task with
 * `runAt` = the slot and idempotency key `scheduled:<account>:<slot>` (at most one task per slot, ever).
 * Slots carry a per-account minute offset, so runs are spread over the hour. Accounts refused exactly like
 * a manual refresh (paused, refresh in progress, API not configured) and manual-only platforms are skipped
 * for that slot with a code in `schedule_skip_code`. No catch-up: missed slots are not replayed.
 */
export const SCHEDULE_INTERVALS = [1, 2, 3, 6, 12, 24, 48, 72, 168];
const HOUR = 3600_000;
const ta = schema.trackedAccounts;

/** Stable 0–59 minute offset per account (spreads the API calls). */
const offsetMinutes = (id: string) => createHash('sha256').update(id).digest().readUInt16BE(0) % 60;

/** First slot after enabling: within the next hour, at the account's minute offset. */
export function firstSlot(id: string, now = new Date()): Date {
  const hourStart = Math.floor(now.getTime() / HOUR) * HOUR;
  let t = hourStart + offsetMinutes(id) * 60_000;
  if (t <= now.getTime()) t += HOUR;
  return new Date(t);
}

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
