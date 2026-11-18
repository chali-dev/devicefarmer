import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';

/**
 * 发布任务失败重发 (系统配置 → 发布重发, admin; settings key `publish.retry`): attempts per publish round and the base
 * delay of the exponential retry backoff. The env values PUBLISH_MAX_ATTEMPTS / PUBLISH_RETRY_BACKOFF_MS are the
 * defaults. Read when a round is created (distribution) or started again (retry / reschedule / deferred rounds):
 * a round keeps the values it was created with.
 */
const KEY = 'publish.retry';

export const PublishRetryInput = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  /** Attempt n waits backoffSec · 2^(n-1). */
  backoffSec: z.number().int().min(1).max(3600),
}).strict();
export type PublishRetrySettings = { maxAttempts: number; backoffMs: number };

export const publishRetryDefaults = (): PublishRetrySettings => ({ maxAttempts: config.PUBLISH_MAX_ATTEMPTS, backoffMs: config.PUBLISH_RETRY_BACKOFF_MS });

export async function getPublishRetry(): Promise<PublishRetrySettings & { updatedAt: string | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const d = publishRetryDefaults();
  const r = PublishRetryInput.safeParse(row?.value);
  return r.success
    ? { maxAttempts: r.data.maxAttempts, backoffMs: r.data.backoffSec * 1000, updatedAt: row!.updatedAt.toISOString() }
    : { ...d, updatedAt: null };
}

export async function savePublishRetry(input: z.infer<typeof PublishRetryInput>) {
  await db.insert(schema.settings).values({ key: KEY, value: input })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: input, updatedAt: new Date() } });
  return getPublishRetry();
}

/** API shape: seconds (the env default may be below a second; it is shown rounded up). */
export const publicRetry = (s: PublishRetrySettings & { updatedAt: string | null }) => ({
  maxAttempts: s.maxAttempts, backoffSec: Math.max(1, Math.round(s.backoffMs / 1000)), backoffMs: s.backoffMs, updatedAt: s.updatedAt,
});
