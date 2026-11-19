import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { updateSetting } from '../../lib/locks.js';
import type { Instance } from '../../db/schema.js';
import { adb } from '../../services.js';
import { scrcpyActive } from '../control/scrcpy-hub.js';
import { controlSessionCount } from '../control/session.js';
import { getInstance } from '../instances/repo.js';
import { collectorBlocked } from '../notify/triggers.js';
import { getRiskSettings, type RiskDeviceSettings } from '../risk/settings.js';

/**
 * Device rules for every automatic operation on a cloud phone (tracked-account profile visits on the account's
 * 采集手机 (tracked/phone.ts), account checks, feed collection, replies, publishing, 追踪中). Device-generic:
 *
 * - Halts (`risk.halts`, see haltDevice): a challenge / verification / rate-limit screen stops the DEVICE until an
 *   admin resumes it (device card on 云机管理); every refresh on it meanwhile ends `tracked.collector_halted`.
 * - `withDevice`: one operation on the device at a time (Redis lock per device), pace per device from the 风控
 *   settings (risk/settings.ts: minimum interval between visits, cap per rolling hour; visit times in a Redis sorted
 *   set), nothing while someone views/controls the device. Each of these ends the attempt with `CollectorDefer`
 *   (code + time): the task handler turns it into a new scheduled task, so nothing is dropped and no worker sleeps.
 */
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
const lockKey = (instanceId: string) => `tracked:collector:lock:${instanceId}`;
const visitsKey = (instanceId: string) => `tracked:collector:visits:${instanceId}`;
const lastKey = (instanceId: string) => `tracked:collector:last:${instanceId}`;
const HOUR_MS = 3600_000;
/** A visit takes ≤ ~30 s; the lock outlives a crashed worker by at most this (longer operations pass `lockMs`). */
const LOCK_MS = 120_000;

/** Visits in the last hour (oldest first, ms) after dropping older ones. */
async function recentVisits(instanceId: string, now = Date.now()): Promise<number[]> {
  await redis.zremrangebyscore(visitsKey(instanceId), 0, now - HOUR_MS);
  return (await redis.zrangebyscore(visitsKey(instanceId), '-inf', '+inf', 'WITHSCORES')).filter((_, i) => i % 2 === 1).map(Number);
}

/**
 * Earliest time the next operation may start (pace rules), or null = now. `weight` = screens the operation
 * opens (a feed collection opens the profile, the grid and N posts); all of them must fit under the hourly cap.
 */
function nextAllowed(visits: number[], now: number, pace: Pick<RiskDeviceSettings, 'minIntervalSec' | 'maxPerHour'>, weight = 1): number | null {
  let t = 0;
  if (visits.length) t = visits[visits.length - 1]! + pace.minIntervalSec * 1000;
  const over = visits.length + Math.min(weight, pace.maxPerHour) - pace.maxPerHour;
  if (over > 0) t = Math.max(t, visits[over - 1]! + HOUR_MS);
  return t > now ? t : null;
}

// ---------------------------------------------------------------- device halts (风控)

/**
 * A device stopped by a challenge / verification / rate-limit screen (profile visit, account check, feed…).
 * Settings key `risk.halts`, per device id. Until an admin resumes it (device card on 云机管理), no automatic
 * operation runs on it: tracked refreshes end `tracked.collector_halted`, account checks `account_check.device_halted`.
 */
const HALTS_KEY = 'risk.halts';
export interface DeviceHalt {
  at: string;
  code: string;
  source: 'collector' | 'account_check' | 'feed' | 'reply' | 'publish' | 'following';
  platform: string;
  socialAccountId?: string | null;
  trackedAccountId?: string | null;
}

async function storedHalts(): Promise<Record<string, DeviceHalt>> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, HALTS_KEY));
  return { ...((row?.value as Record<string, DeviceHalt> | undefined) ?? {}) };
}

export const deviceHalts = (): Promise<Record<string, DeviceHalt>> => storedHalts();
export const deviceHalt = async (instanceId: string): Promise<DeviceHalt | null> => (await deviceHalts())[instanceId] ?? null;

/** Stops automatic work on the device and raises collector.blocked (admins + device grants, channels). */
export async function haltDevice(inst: Pick<Instance, 'id' | 'name'>, halt: Omit<DeviceHalt, 'at'>): Promise<void> {
  // one device's entry merged under the row's lock: halts / resumes of other devices at the same time all survive
  await updateSetting(HALTS_KEY, (stored) => ({ ...((stored as Record<string, DeviceHalt> | undefined) ?? {}), [inst.id]: { ...halt, at: new Date().toISOString() } }));
  await collectorBlocked(inst, halt.platform, true, halt.code);
}

/**
 * Called after a device was resumed (e.g. comments re-queue the replies parked while it was halted). Modules
 * register at import time; collector.ts never imports them (no cycle). A failing hook never fails the resume.
 */
const resumeHooks: ((instanceId: string) => Promise<unknown>)[] = [];
export const onDeviceResumed = (fn: (instanceId: string) => Promise<unknown>) => { resumeHooks.push(fn); };

/** Clears the device's halt and recovers its alert. Returns whether it was halted. */
export async function resumeDevice(instanceId: string): Promise<boolean> {
  // under the row's lock: of two parallel resumes only one sees the halt (one recovery, one audit-worthy change)
  let halt = null as DeviceHalt | null;
  await updateSetting(HALTS_KEY, (stored) => {
    const cur = { ...((stored as Record<string, DeviceHalt> | undefined) ?? {}) };
    halt = cur[instanceId] ?? null;
    if (!halt) return undefined;
    delete cur[instanceId];
    return cur;
  });
  if (halt) {
    const inst = await getInstance(instanceId);
    if (inst) await collectorBlocked(inst, halt.platform, false);
  }
  for (const fn of resumeHooks) await fn(instanceId).catch(() => undefined);
  return !!halt;
}

/** A successful read clears an alert left from an earlier halt (no-op otherwise). */
export async function collectorWorked(platform: string, inst: Pick<Instance, 'id' | 'name'>): Promise<void> {
  await collectorBlocked(inst, platform, false);
}

/** Ends this attempt and asks the task handler for a new refresh at `runAt` (pace, device busy). */
export class CollectorDefer extends Error {
  constructor(readonly code: string, message: string, readonly runAt: Date) { super(message); }
}

export interface CollectorDevice { inst: Instance; adbPort: number }
type Log = (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => Promise<void>;

/** Visits on the device in the last hour and its last visit (风控 page / settings). */
export async function deviceUsage(instanceId: string): Promise<{ visitsLastHour: number; lastVisitAt: string | null }> {
  const [visits, last] = await Promise.all([recentVisits(instanceId), redis.get(lastKey(instanceId))]);
  const lastMs = Math.max(last ? Number(last) : 0, visits.length ? visits[visits.length - 1]! : 0);
  return { visitsLastHour: visits.length, lastVisitAt: lastMs ? new Date(lastMs).toISOString() : null };
}

/**
 * Runs one automatic operation (a profile visit, an account check) on `inst` under the shared device rules:
 * online (else `offline()`), nobody viewing/controlling it, one operation at a time (Redis lock), the pace of
 * the 风控 settings (minimum interval, hourly cap). The rules are per device, so the profile visits and the
 * account checks on one phone share one pace and one lock. Throws CollectorDefer for "not now".
 */
export interface DeviceOpOptions {
  /** Lock lifetime for operations longer than one visit (default LOCK_MS). */
  lockMs?: number;
  /** Screens the operation opens (counted in the hourly cap; default 1). */
  weight?: number;
  /** What the operation does, shown as the device's 忙 state on 云机管理 (stored in the lock value). */
  what?: DeviceOpKind;
}
export type DeviceOpKind = 'collect' | 'check' | 'feed' | 'reply' | 'publish' | 'following';

/**
 * Automatic operations running now (the device lock is held), per device id: what and since when. Read only (one
 * MGET); a lock written by an older version (bare token) reads as `auto`.
 */
export async function deviceBusy(instanceIds: string[]): Promise<Map<string, { what: DeviceOpKind | 'auto'; since: string | null }>> {
  const out = new Map<string, { what: DeviceOpKind | 'auto'; since: string | null }>();
  if (!instanceIds.length) return out;
  const vals = await redis.mget(...instanceIds.map(lockKey));
  vals.forEach((v, i) => {
    if (!v) return;
    const [, what, at] = v.split('|');
    const ok = ['collect', 'check', 'feed', 'reply', 'publish', 'following'].includes(what ?? '');
    out.set(instanceIds[i]!, { what: ok ? (what as DeviceOpKind) : 'auto', since: at && Number(at) ? new Date(Number(at)).toISOString() : null });
  });
  return out;
}

export async function withDevice<T>(inst: Instance, log: Log, offline: () => Error, fn: (dev: CollectorDevice) => Promise<T>, opts: DeviceOpOptions = {}): Promise<T> {
  if (inst.status !== 'running' || inst.adbState !== 'device') throw offline();
  if ((await adb.states().catch(() => new Map<string, string>())).get(adb.serialFor(inst.adbPort)) !== 'device') throw offline();
  const pace = await getRiskSettings();
  const now = Date.now();
  if (controlSessionCount(inst.id) > 0 || scrcpyActive(inst.adbPort)) {
    throw new CollectorDefer('tracked.collector_busy', `设备 ${inst.name} 正在被远程查看/控制，稍后再执行`, new Date(now + pace.busyRetrySec * 1000));
  }
  const token = randomBytes(8).toString('hex');
  const lockVal = `${token}|${opts.what ?? 'auto'}|${now}`;
  if ((await redis.set(lockKey(inst.id), lockVal, 'PX', opts.lockMs ?? LOCK_MS, 'NX')) !== 'OK') {
    throw new CollectorDefer('tracked.collector_queued', '设备正在执行其他自动操作', new Date(now + pace.minIntervalSec * 1000));
  }
  try {
    const weight = Math.max(1, Math.min(opts.weight ?? 1, pace.maxPerHour));
    const at = nextAllowed(await recentVisits(inst.id, now), now, pace, weight);
    if (at) throw new CollectorDefer('tracked.collector_paced', '设备节奏限制：稍后再访问', new Date(at));
    const m = redis.multi();
    for (let i = 0; i < weight; i++) m.zadd(visitsKey(inst.id), now, `${now}:${token}:${i}`);
    await m.pexpire(visitsKey(inst.id), HOUR_MS + 60_000).set(lastKey(inst.id), String(now)).exec();
    await log('info', 'collector: visit started', { device: inst.name, at: new Date(now).toISOString() });
    return await fn({ inst, adbPort: inst.adbPort });
  } finally {
    // Release only our own lock.
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey(inst.id), lockVal).catch(() => undefined);
  }
}
