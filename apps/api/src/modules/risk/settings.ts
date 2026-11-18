import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';

/**
 * 风控 → 云手机节奏 (settings key `risk.device`): one pace for every automatic operation on a device
 * (tracked-account collector visits and automatic account checks share it, see tracked/collector.ts
 * `withDevice`), plus the account-check interval. The TRACKED_DEVICE_* env values are the defaults; a saved
 * value wins. Read on every visit with a short in-process cache, so a save takes effect within CACHE_MS
 * everywhere (immediately in the process that saved it).
 */
const KEY = 'risk.device';
const CACHE_MS = 5_000;

export const RiskDeviceInput = z.object({
  /** Minimum seconds between two visits on one device. */
  minIntervalSec: z.number().int().min(5).max(3600),
  /** Visits per device per rolling hour. */
  maxPerHour: z.number().int().min(1).max(600),
  /** Someone views/controls the device: retry after this many seconds. */
  busyRetrySec: z.number().int().min(5).max(86_400),
  /** 社交号自动检测 interval in hours; null = off. */
  accountCheckHours: z.number().int().min(1).max(168).nullable(),
});
export type RiskDeviceSettings = z.infer<typeof RiskDeviceInput>;

export const DEFAULT_ACCOUNT_CHECK_HOURS = 6;
export const riskDefaults = (): RiskDeviceSettings => ({
  minIntervalSec: config.TRACKED_DEVICE_MIN_INTERVAL_SEC,
  maxPerHour: config.TRACKED_DEVICE_MAX_PER_HOUR,
  busyRetrySec: config.TRACKED_DEVICE_BUSY_RETRY_SEC,
  accountCheckHours: DEFAULT_ACCOUNT_CHECK_HOURS,
});

let cache: { at: number; value: RiskDeviceSettings } | null = null;

/** Stored values over the env defaults; an invalid stored field falls back to its default. */
export async function getRiskSettings(fresh = false): Promise<RiskDeviceSettings> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const d = riskDefaults();
  const pick = <K extends keyof RiskDeviceSettings>(k: K): RiskDeviceSettings[K] => {
    if (!(k in stored)) return d[k];
    const r = RiskDeviceInput.shape[k].safeParse(stored[k]);
    return r.success ? (r.data as RiskDeviceSettings[K]) : d[k];
  };
  const value: RiskDeviceSettings = {
    minIntervalSec: pick('minIntervalSec'), maxPerHour: pick('maxPerHour'), busyRetrySec: pick('busyRetrySec'), accountCheckHours: pick('accountCheckHours'),
  };
  cache = { at: Date.now(), value };
  return value;
}

export async function saveRiskSettings(input: Partial<RiskDeviceSettings>): Promise<RiskDeviceSettings> {
  const next = { ...(await getRiskSettings(true)), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  await db.insert(schema.settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  cache = null;
  return getRiskSettings(true);
}

/** Visits per hour one device can do under the pace. */
export const capacityPerHour = (s: Pick<RiskDeviceSettings, 'minIntervalSec' | 'maxPerHour'>) => Math.min(s.maxPerHour, Math.floor(3600 / s.minIntervalSec));
