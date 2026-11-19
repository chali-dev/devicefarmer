import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';

/**
 * 发布任务 (系统配置 → 发布任务, admin): the timeout of a publish round's single attempt (settings key `publish.timeout`
 * {timeoutSec}; env PUBLISH_TIMEOUT_MS is the default). Read when a round's task is created (distribution, reschedule,
 * deferred / resumed rounds); the task centre stores it per task (tasks.timeout_ms).
 *
 * There are no automatic publish retries (owner decision 2026-11-18): every round is ONE attempt; after a failure the
 * person edits the content and publishes it again (a new publish task).
 */
export const PUBLISH_TIMEOUT_KEY = 'publish.timeout';

/** One attempt's timeout (the device flow holds its phone lock for up to 12 min, so values below that can cut it). */
const TimeoutSec = z.number().int().min(60).max(3600);
/** PUT body; `timeoutSec` is optional, so a body without it changes nothing. */
export const PublishTimeoutInput = z.object({ timeoutSec: TimeoutSec.optional() }).strict();
const StoredTimeout = z.object({ timeoutSec: TimeoutSec }).strict();

export const publishTimeoutDefault = () => config.PUBLISH_TIMEOUT_MS;

export async function getPublishTimeout(): Promise<{ timeoutMs: number; updatedAt: string | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, PUBLISH_TIMEOUT_KEY));
  const tm = StoredTimeout.safeParse(row?.value);
  return { timeoutMs: tm.success ? tm.data.timeoutSec * 1000 : publishTimeoutDefault(), updatedAt: tm.success ? row!.updatedAt.toISOString() : null };
}

export async function savePublishTimeout(input: z.infer<typeof PublishTimeoutInput>) {
  if (input.timeoutSec !== undefined) {
    const value = { timeoutSec: input.timeoutSec };
    await db.insert(schema.settings).values({ key: PUBLISH_TIMEOUT_KEY, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  }
  return getPublishTimeout();
}

/** API shape: seconds (an env default may be below a second; it is shown rounded). */
export const publicTimeout = (s: { timeoutMs: number; updatedAt: string | null }) => ({
  timeoutSec: Math.max(1, Math.round(s.timeoutMs / 1000)), timeoutMs: s.timeoutMs, updatedAt: s.updatedAt,
});
