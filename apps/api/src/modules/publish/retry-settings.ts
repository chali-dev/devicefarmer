import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';

/**
 * 发布任务 (系统配置 → 发布任务, admin): attempts per publish round, the base delay of the exponential retry backoff
 * (settings key `publish.retry` {maxAttempts, backoffSec}) and the timeout of one attempt (key `publish.timeout`
 * {timeoutSec}: a separate key, so an older colour, which parses `publish.retry` strictly, keeps reading it). The env
 * values PUBLISH_MAX_ATTEMPTS / PUBLISH_RETRY_BACKOFF_MS / PUBLISH_TIMEOUT_MS are the defaults. Read when a round's
 * task is created (distribution, retry, reschedule, deferred rounds): a round keeps the values it was created with
 * (the task centre stores them per task: tasks.max_attempts / backoff_ms / timeout_ms).
 */
export const PUBLISH_RETRY_KEY = 'publish.retry';
export const PUBLISH_TIMEOUT_KEY = 'publish.timeout';

const RetryFields = {
  maxAttempts: z.number().int().min(1).max(10),
  /** Attempt n waits backoffSec · 2^(n-1). */
  backoffSec: z.number().int().min(1).max(3600),
};
/** One attempt's timeout (the device flow holds its phone lock for up to 12 min, so values below that can cut it). */
const TimeoutSec = z.number().int().min(60).max(3600);
/** PUT body. `timeoutSec` is optional so an older page (without the field) keeps the stored timeout. */
export const PublishRetryInput = z.object({ ...RetryFields, timeoutSec: TimeoutSec.optional() }).strict();
const StoredRetry = z.object(RetryFields).strict();
const StoredTimeout = z.object({ timeoutSec: TimeoutSec }).strict();

export type PublishRetrySettings = { maxAttempts: number; backoffMs: number; timeoutMs: number };

export const publishRetryDefaults = (): PublishRetrySettings => ({
  maxAttempts: config.PUBLISH_MAX_ATTEMPTS, backoffMs: config.PUBLISH_RETRY_BACKOFF_MS, timeoutMs: config.PUBLISH_TIMEOUT_MS,
});

export async function getPublishRetry(): Promise<PublishRetrySettings & { updatedAt: string | null }> {
  const rows = await db.select().from(schema.settings).where(inArray(schema.settings.key, [PUBLISH_RETRY_KEY, PUBLISH_TIMEOUT_KEY]));
  const retryRow = rows.find((r) => r.key === PUBLISH_RETRY_KEY);
  const timeoutRow = rows.find((r) => r.key === PUBLISH_TIMEOUT_KEY);
  const d = publishRetryDefaults();
  const r = StoredRetry.safeParse(retryRow?.value);
  const tm = StoredTimeout.safeParse(timeoutRow?.value);
  const at = [r.success ? retryRow!.updatedAt : null, tm.success ? timeoutRow!.updatedAt : null].filter((x): x is Date => !!x);
  return {
    maxAttempts: r.success ? r.data.maxAttempts : d.maxAttempts,
    backoffMs: r.success ? r.data.backoffSec * 1000 : d.backoffMs,
    timeoutMs: tm.success ? tm.data.timeoutSec * 1000 : d.timeoutMs,
    updatedAt: at.length ? new Date(Math.max(...at.map((x) => x.getTime()))).toISOString() : null,
  };
}

export async function savePublishRetry(input: z.infer<typeof PublishRetryInput>) {
  await db.transaction(async (tx) => {
    const upsert = (key: string, value: unknown) => tx.insert(schema.settings).values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
    await upsert(PUBLISH_RETRY_KEY, { maxAttempts: input.maxAttempts, backoffSec: input.backoffSec });
    if (input.timeoutSec !== undefined) await upsert(PUBLISH_TIMEOUT_KEY, { timeoutSec: input.timeoutSec });
  });
  return getPublishRetry();
}

/** API shape: seconds (an env default may be below a second; it is shown rounded). */
export const publicRetry = (s: PublishRetrySettings & { updatedAt: string | null }) => ({
  maxAttempts: s.maxAttempts, backoffSec: Math.max(1, Math.round(s.backoffMs / 1000)), backoffMs: s.backoffMs,
  timeoutSec: Math.max(1, Math.round(s.timeoutMs / 1000)), timeoutMs: s.timeoutMs, updatedAt: s.updatedAt,
});
