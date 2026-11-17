import { createTask, registerTaskHandler } from '../tasks/core.js';
import { scheduleTrackedRefreshes } from '../tracked/schedule.js';
import { purgeTrending, scheduleTrending } from './trending.js';

/**
 * Collection tick (定时采集): one hourly `collection-schedule` task (idempotent per hour, so several API
 * processes create it once) that enqueues due tracked-account refreshes, the trending refreshes of the
 * current slot, and purges trending snapshots past retention. The result summarises what it did.
 */
export const COLLECTION_TYPE = 'collection-schedule';

registerTaskHandler(COLLECTION_TYPE, {
  queue: 'task-ops',
  concurrency: 1,
  timeoutMs: 5 * 60_000,
  maxAttempts: 1,
  async run(ctx) {
    const now = new Date();
    const tracked = await scheduleTrackedRefreshes(now);
    const trending = await scheduleTrending(now);
    const purged = await purgeTrending(now);
    await ctx.log('info', `collection: ${tracked.queued} tracked refreshes queued, ${tracked.skipped.length} skipped; ${trending.queued} trending refreshes queued; ${purged} old trending snapshots deleted`, {
      tracked: { queued: tracked.queued, duplicate: tracked.duplicate, skipped: tracked.skipped.length }, trending, purged,
    });
    return { tracked, trending, purged };
  },
});

/** `manual` = an admin's "run now" (own task, no idempotency key). */
export async function scheduleCollection(userId: string | null = null, manual = false) {
  const hour = new Date().toISOString().slice(0, 13);
  return createTask({ type: COLLECTION_TYPE, userId, payload: {}, idempotencyKey: manual ? null : `hourly:${hour}` });
}
