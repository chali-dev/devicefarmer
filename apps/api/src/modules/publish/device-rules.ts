import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';

/**
 * 风控 → 云手机发帖 (settings key `publish.device`, owner decision 2026-11-18): limits of the `device` publish
 * method (modules/publish/device.ts) per social account, and its own test mode switch (separate from the comment
 * test mode: posting live and commenting live are two different decisions).
 *
 * - postsPerDay: device runs (live posts AND test-mode rehearsals) per account per rolling 24 h.
 * - minGapMin: minimum minutes between two device runs of one account.
 * Over a limit the run is deferred to a new round at the allowed time, never dropped.
 * - enabled (default ON): off = every run is handed to an operator as before.
 * - testMode (default ON): the phone goes through the whole flow up to the step before 分享, takes a screenshot,
 *   discards the draft and ends `dry_run`; nothing is posted.
 */
const KEY = 'publish.device';

export const DevicePublishInput = z.object({
  /** Off: every run goes to an operator as before (reason publish.device_disabled). */
  enabled: z.boolean(),
  postsPerDay: z.number().int().min(1).max(50),
  minGapMin: z.number().int().min(0).max(1440),
  testMode: z.boolean(),
}).strict();
export type DevicePublishRules = z.infer<typeof DevicePublishInput>;
export const DEFAULT_DEVICE_PUBLISH: DevicePublishRules = { enabled: true, postsPerDay: 3, minGapMin: 60, testMode: true };

/** Stored values over the defaults; an invalid stored field falls back to its default. */
export async function getDevicePublishRules(): Promise<DevicePublishRules> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof DevicePublishRules>(k: K): DevicePublishRules[K] => {
    const r = DevicePublishInput.shape[k].safeParse(v[k]);
    return r.success ? (r.data as DevicePublishRules[K]) : DEFAULT_DEVICE_PUBLISH[k];
  };
  return { enabled: pick('enabled'), postsPerDay: pick('postsPerDay'), minGapMin: pick('minGapMin'), testMode: pick('testMode') };
}

export async function saveDevicePublishRules(input: Partial<DevicePublishRules>): Promise<DevicePublishRules> {
  const next = { ...(await getDevicePublishRules()), ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) };
  await db.insert(schema.settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return getDevicePublishRules();
}
