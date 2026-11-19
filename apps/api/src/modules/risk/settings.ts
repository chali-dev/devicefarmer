import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { updateSetting } from '../../lib/locks.js';

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
  /** 帖子与评论采集 (modules/feed): interval in hours per account (social + scheduled tracked IG accounts); null = off. */
  feedCollectHours: z.number().int().min(1).max(168).nullable(),
  /** Newest posts read per account. */
  feedPosts: z.number().int().min(1).max(10),
  /** Top-level comments read per post (0 = counts only). */
  feedCommentsPerPost: z.number().int().min(0).max(100),
  /**
   * 自动发现 (social/sync.ts): the hourly tick reads `dumpsys account` on running phones; an Instagram account
   * not yet recorded is synced for the phone's only assigned user (else a notice). false = off.
   */
  accountDiscovery: z.boolean(),
  /** 追踪中 (social/following.ts): interval in hours of reading each own Instagram account's following list on its phone; null = off. */
  followingSyncHours: z.number().int().min(1).max(168).nullable(),
});
export type RiskDeviceSettings = z.infer<typeof RiskDeviceInput>;

export const DEFAULT_ACCOUNT_CHECK_HOURS = 6;
export const riskDefaults = (): RiskDeviceSettings => ({
  minIntervalSec: config.TRACKED_DEVICE_MIN_INTERVAL_SEC,
  maxPerHour: config.TRACKED_DEVICE_MAX_PER_HOUR,
  busyRetrySec: config.TRACKED_DEVICE_BUSY_RETRY_SEC,
  accountCheckHours: DEFAULT_ACCOUNT_CHECK_HOURS,
  feedCollectHours: 24,
  feedPosts: 3,
  feedCommentsPerPost: 30,
  accountDiscovery: true,
  followingSyncHours: 24,
});

let cache: { at: number; value: RiskDeviceSettings } | null = null;

/** Stored values over the env defaults; an invalid stored field falls back to its default. */
export async function getRiskSettings(fresh = false): Promise<RiskDeviceSettings> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const value = parseRisk(row?.value);
  cache = { at: Date.now(), value };
  return value;
}

function parseRisk(raw: unknown): RiskDeviceSettings {
  const stored = (raw ?? {}) as Record<string, unknown>;
  const d = riskDefaults();
  const pick = <K extends keyof RiskDeviceSettings>(k: K): RiskDeviceSettings[K] => {
    if (!(k in stored)) return d[k];
    const r = RiskDeviceInput.shape[k].safeParse(stored[k]);
    return r.success ? (r.data as RiskDeviceSettings[K]) : d[k];
  };
  return Object.fromEntries((Object.keys(d) as (keyof RiskDeviceSettings)[]).map((k) => [k, pick(k)])) as RiskDeviceSettings;
}

export async function saveRiskSettings(input: Partial<RiskDeviceSettings>): Promise<RiskDeviceSettings> {
  await updateSetting(KEY, (stored) => ({ ...parseRisk(stored), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }));
  cache = null;
  return getRiskSettings(true);
}

/** Visits per hour one device can do under the pace. */
export const capacityPerHour = (s: Pick<RiskDeviceSettings, 'minIntervalSec' | 'maxPerHour'>) => Math.min(s.maxPerHour, Math.floor(3600 / s.minIntervalSec));
