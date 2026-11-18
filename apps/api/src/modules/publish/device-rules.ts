import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';

/**
 * 风控 → 云手机发帖 (settings key `publish.device`, owner decision 2026-11-18): limits of the `device` publish
 * method (modules/publish/device.ts) per social account. The former `testMode` switch was removed (owner decision
 * 2026-11-18: content is a draft until a person distributes / schedules it, then the phone really posts); a stored
 * `testMode` is ignored and dropped on the next save, and a PUT that still sends it is accepted with it ignored.
 *
 * - postsPerDay: device runs per account per rolling 24 h.
 * - minGapMin: minimum minutes between two device runs of one account.
 * Over a limit the run is deferred to a new round at the allowed time, never dropped.
 * - enabled (default ON): off = every run is handed to an operator as before.
 */
const KEY = 'publish.device';

export const DevicePublishInput = z.object({
  /** Off: every run goes to an operator as before (reason publish.device_disabled). */
  enabled: z.boolean(),
  postsPerDay: z.number().int().min(1).max(50),
  minGapMin: z.number().int().min(0).max(1440),
});
export type DevicePublishRules = z.infer<typeof DevicePublishInput>;
/** PUT body: partial; `testMode` of an older page is accepted and ignored (removed setting), anything else unknown is refused. */
export const DevicePublishBody = DevicePublishInput.partial().extend({ testMode: z.boolean().optional() }).strict()
  .transform(({ testMode: _removed, ...rest }) => rest);
export const DEFAULT_DEVICE_PUBLISH: DevicePublishRules = { enabled: true, postsPerDay: 3, minGapMin: 60 };

/** Stored values over the defaults; an invalid stored field falls back to its default. */
export async function getDevicePublishRules(): Promise<DevicePublishRules> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof DevicePublishRules>(k: K): DevicePublishRules[K] => {
    const r = DevicePublishInput.shape[k].safeParse(v[k]);
    return r.success ? (r.data as DevicePublishRules[K]) : DEFAULT_DEVICE_PUBLISH[k];
  };
  return { enabled: pick('enabled'), postsPerDay: pick('postsPerDay'), minGapMin: pick('minGapMin') };
}

export async function saveDevicePublishRules(input: Partial<DevicePublishRules>): Promise<DevicePublishRules> {
  const next = { ...(await getDevicePublishRules()), ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) };
  await db.insert(schema.settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return getDevicePublishRules();
}
