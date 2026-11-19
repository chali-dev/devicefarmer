import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { updateSetting } from '../../lib/locks.js';

/**
 * 风控 → 云手机发帖 (settings key `publish.device`, owner decision 2026-11-18): limits of the `device` publish
 * method (modules/publish/device.ts) per social account. The former `testMode` switch was removed (owner decision
 * 2026-11-18: content is a draft until a person distributes / schedules it, then the phone really posts); a stored
 * `testMode` is ignored and dropped on the next save, and a PUT that still sends it is accepted with it ignored.
 *
 * - postsPerDay: device runs per account per rolling 24 h.
 * - minGapMin: minimum minutes between two device runs of one account.
 * Over a limit the run is deferred to a new round at the allowed time, never dropped.
 * The former `enabled` switch was removed too (owner decision 2026-11-18: cloud-phone posting is always on); a stored
 * `enabled` (also false) is ignored and dropped on the next save, a PUT that still sends it is accepted with it ignored.
 * An old colour reading a stored value without `enabled` falls back to its own default (on).
 */
const KEY = 'publish.device';

export const DevicePublishInput = z.object({
  postsPerDay: z.number().int().min(1).max(50),
  minGapMin: z.number().int().min(0).max(1440),
});
export type DevicePublishRules = z.infer<typeof DevicePublishInput>;
/** PUT body: partial; `testMode` / `enabled` of an older page are accepted and ignored (removed settings), anything else unknown is refused. */
export const DevicePublishBody = DevicePublishInput.partial()
  .extend({ testMode: z.boolean().optional(), enabled: z.boolean().optional() }).strict()
  .transform(({ testMode: _t, enabled: _e, ...rest }) => rest);
export const DEFAULT_DEVICE_PUBLISH: DevicePublishRules = { postsPerDay: 3, minGapMin: 60 };

/** Stored values over the defaults; an invalid stored field falls back to its default. */
export async function getDevicePublishRules(): Promise<DevicePublishRules> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return parseRules(row?.value);
}

function parseRules(stored: unknown): DevicePublishRules {
  const v = (stored ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof DevicePublishRules>(k: K): DevicePublishRules[K] => {
    const r = DevicePublishInput.shape[k].safeParse(v[k]);
    return r.success ? (r.data as DevicePublishRules[K]) : DEFAULT_DEVICE_PUBLISH[k];
  };
  return { postsPerDay: pick('postsPerDay'), minGapMin: pick('minGapMin') };
}

export async function saveDevicePublishRules(input: Partial<DevicePublishRules>): Promise<DevicePublishRules> {
  await updateSetting(KEY, (stored) => ({ ...parseRules(stored), ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) }));
  return getDevicePublishRules();
}
