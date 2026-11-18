import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { Instance } from '../../db/schema.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { adb } from '../../services.js';
import { scrcpyActive } from '../control/scrcpy-hub.js';
import { controlSessionCount } from '../control/session.js';
import { getInstance } from '../instances/repo.js';
import { collectorBlocked } from '../notify/triggers.js';

/**
 * Collector devices for tracked accounts (追踪账号采集设备). Owner decision 2026-11-18: Instagram profiles are
 * read in the Instagram app on one admin-chosen device (navigation + reading the screen only; see
 * instagram-device.ts). This module holds what is device-generic:
 *
 * - Settings key `tracked.collectors`: per platform the device id, plus a halt marker. A challenge /
 *   verification / rate-limit screen halts the platform's collection until an admin resumes it (PUT with
 *   `resume`, or picking another device); every refresh meanwhile ends `tracked.collector_halted`.
 * - `withCollector`: one visit on the device at a time (Redis lock per device), pace per device
 *   (TRACKED_DEVICE_MIN_INTERVAL_SEC between visits, TRACKED_DEVICE_MAX_PER_HOUR per rolling hour; visit
 *   times in a Redis sorted set), no visit while someone views/controls the device. Each of these ends the
 *   attempt with `CollectorDefer` (code + time): the task handler turns it into a new scheduled refresh,
 *   so nothing is dropped and no worker sleeps.
 */
export const COLLECTOR_PLATFORMS = ['instagram'] as const;
export type CollectorPlatform = typeof COLLECTOR_PLATFORMS[number];

const KEY = 'tracked.collectors';
interface CollectorEntry {
  instanceId: string | null;
  /** Set when a challenge screen stopped collection (ISO time); cleared by an admin resume. */
  haltedAt?: string | null;
  haltCode?: string | null;
}
type Collectors = Partial<Record<CollectorPlatform, CollectorEntry>>;

async function load(): Promise<{ value: Collectors; updatedAt: Date | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { value: (row?.value as Collectors | undefined) ?? {}, updatedAt: row?.updatedAt ?? null };
}
async function store(value: Collectors): Promise<void> {
  await db.insert(schema.settings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export async function collectorEntry(platform: CollectorPlatform): Promise<CollectorEntry | null> {
  const e = (await load()).value[platform];
  return e?.instanceId ? e : null;
}

const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
const lockKey = (instanceId: string) => `tracked:collector:lock:${instanceId}`;
const visitsKey = (instanceId: string) => `tracked:collector:visits:${instanceId}`;
const HOUR_MS = 3600_000;
/** A visit takes ≤ ~30 s; the lock outlives a crashed worker by at most this. */
const LOCK_MS = 120_000;

/** Visits in the last hour (oldest first, ms) after dropping older ones. */
async function recentVisits(instanceId: string, now = Date.now()): Promise<number[]> {
  await redis.zremrangebyscore(visitsKey(instanceId), 0, now - HOUR_MS);
  return (await redis.zrangebyscore(visitsKey(instanceId), '-inf', '+inf', 'WITHSCORES')).filter((_, i) => i % 2 === 1).map(Number);
}

/** Earliest time the next visit may start (pace rules), or null = now. */
function nextAllowed(visits: number[], now: number): number | null {
  let t = 0;
  if (visits.length) t = visits[visits.length - 1]! + config.TRACKED_DEVICE_MIN_INTERVAL_SEC * 1000;
  if (visits.length >= config.TRACKED_DEVICE_MAX_PER_HOUR) t = Math.max(t, visits[visits.length - config.TRACKED_DEVICE_MAX_PER_HOUR]! + HOUR_MS);
  return t > now ? t : null;
}

const deviceView = (inst: Instance | undefined) => (inst ? { id: inst.id, name: inst.name, status: inst.status, adbState: inst.adbState, external: !!inst.sourceId } : null);

/** Admin view (settings page): device, halt state and the pace counters per platform. */
export async function collectorSettings() {
  const { value, updatedAt } = await load();
  const collectors = await Promise.all(COLLECTOR_PLATFORMS.map(async (platform) => {
    const e = value[platform];
    const inst = e?.instanceId ? await getInstance(e.instanceId) : undefined;
    const visits = inst ? await recentVisits(inst.id).catch(() => []) : [];
    return {
      platform,
      instanceId: e?.instanceId ?? null,
      device: deviceView(inst),
      halted: e?.haltedAt ? { at: e.haltedAt, code: e.haltCode ?? null } : null,
      visitsLastHour: visits.length,
      lastVisitAt: visits.length ? new Date(visits[visits.length - 1]!).toISOString() : null,
    };
  }));
  return {
    collectors, updatedAt,
    pace: { minIntervalSec: config.TRACKED_DEVICE_MIN_INTERVAL_SEC, maxPerHour: config.TRACKED_DEVICE_MAX_PER_HOUR, busyRetrySec: config.TRACKED_DEVICE_BUSY_RETRY_SEC },
  };
}

/**
 * Sets the platform's collector device (null = none) and/or resumes it after a halt. A new device or a
 * resume clears the halt and recovers its alert.
 */
export async function saveCollector(platform: CollectorPlatform, input: { instanceId?: string | null; resume?: boolean }) {
  const { value } = await load();
  const cur = value[platform] ?? { instanceId: null };
  const next: CollectorEntry = { ...cur };
  if (input.instanceId !== undefined && input.instanceId !== cur.instanceId) {
    if (input.instanceId && !(await getInstance(input.instanceId))) throw notFound('设备不存在', 'tracked.collector_device_not_found');
    next.instanceId = input.instanceId;
    next.haltedAt = null; next.haltCode = null;
  }
  if (input.resume) { next.haltedAt = null; next.haltCode = null; }
  if (cur.haltedAt && !next.haltedAt && cur.instanceId) {
    const old = await getInstance(cur.instanceId);
    if (old) await collectorBlocked(old, platform, false);
  }
  await store({ ...value, [platform]: next });
  return collectorSettings();
}

/** A challenge screen: stop the platform's collection until an admin resumes it, and alert. */
export async function haltCollector(platform: CollectorPlatform, inst: Pick<Instance, 'id' | 'name'>, code: string): Promise<void> {
  const { value } = await load();
  const cur = value[platform];
  if (!cur || cur.instanceId !== inst.id) return;
  await store({ ...value, [platform]: { ...cur, haltedAt: new Date().toISOString(), haltCode: code } });
  await collectorBlocked(inst, platform, true, code);
}

/** A successful read clears an alert left from an earlier halt (no-op otherwise). */
export async function collectorWorked(platform: CollectorPlatform, inst: Pick<Instance, 'id' | 'name'>): Promise<void> {
  await collectorBlocked(inst, platform, false);
}

/** Ends this attempt and asks the task handler for a new refresh at `runAt` (pace, device busy). */
export class CollectorDefer extends Error {
  constructor(readonly code: string, message: string, readonly runAt: Date) { super(message); }
}

/** Throws the coded "can't collect" error for a missing / halted collector (also used before queueing). */
export async function requireCollector(platform: CollectorPlatform): Promise<CollectorEntry & { instanceId: string }> {
  const e = await collectorEntry(platform);
  if (!e) throw new HttpError(400, '未设置采集设备（管理员可在设置 → 追踪账号中选择）', 'tracked.collector_unset');
  if (e.haltedAt) throw new HttpError(409, '采集设备遇到验证/限制页面，采集已停止，需管理员处理后恢复', 'tracked.collector_halted');
  return e as CollectorEntry & { instanceId: string };
}

export interface CollectorDevice { inst: Instance; adbPort: number }
type Log = (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => Promise<void>;

/**
 * Runs one profile visit on the platform's collector device under the rules above. `fn` is the visit
 * itself (navigation + screen reads only). Throws coded HttpErrors (unset, halted, offline) or CollectorDefer.
 */
export async function withCollector<T>(platform: CollectorPlatform, log: Log, fn: (dev: CollectorDevice) => Promise<T>): Promise<T> {
  const entry = await requireCollector(platform);
  const inst = await getInstance(entry.instanceId);
  if (!inst) throw new HttpError(400, '采集设备已不存在，请重新选择', 'tracked.collector_unset');
  const offline = () => new HttpError(503, `采集设备 ${inst.name} 不在线`, 'tracked.collector_offline', { name: inst.name });
  if (inst.status !== 'running' || inst.adbState !== 'device') throw offline();
  if ((await adb.states().catch(() => new Map<string, string>())).get(adb.serialFor(inst.adbPort)) !== 'device') throw offline();
  const now = Date.now();
  if (controlSessionCount(inst.id) > 0 || scrcpyActive(inst.adbPort)) {
    throw new CollectorDefer('tracked.collector_busy', `采集设备 ${inst.name} 正在被远程查看/控制，稍后再采集`, new Date(now + config.TRACKED_DEVICE_BUSY_RETRY_SEC * 1000));
  }
  const token = randomBytes(8).toString('hex');
  if ((await redis.set(lockKey(inst.id), token, 'PX', LOCK_MS, 'NX')) !== 'OK') {
    throw new CollectorDefer('tracked.collector_queued', '采集设备正在采集其他账号', new Date(now + config.TRACKED_DEVICE_MIN_INTERVAL_SEC * 1000));
  }
  try {
    const at = nextAllowed(await recentVisits(inst.id, now), now);
    if (at) throw new CollectorDefer('tracked.collector_paced', '采集节奏限制：稍后再访问主页', new Date(at));
    await redis.multi().zadd(visitsKey(inst.id), now, `${now}:${token}`).pexpire(visitsKey(inst.id), HOUR_MS + 60_000).exec();
    await log('info', 'collector: visit started', { device: inst.name, at: new Date(now).toISOString() });
    return await fn({ inst, adbPort: inst.adbPort });
  } finally {
    // Release only our own lock.
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey(inst.id), token).catch(() => undefined);
  }
}
