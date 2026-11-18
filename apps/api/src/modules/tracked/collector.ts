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
import { getRiskSettings, type RiskDeviceSettings } from '../risk/settings.js';

/**
 * Collector devices for tracked accounts (追踪账号采集设备). Owner decision 2026-11-18: Instagram profiles are
 * read in the Instagram app on one admin-chosen device (navigation + reading the screen only; see
 * instagram-device.ts). This module holds what is device-generic:
 *
 * - Settings key `tracked.collectors`: per platform the device id. A challenge / verification /
 *   rate-limit screen halts the DEVICE (`risk.halts`, see haltDevice) until an admin resumes it on the 风控
 *   page (or PUT with `resume`); every refresh meanwhile ends `tracked.collector_halted`.
 * - `withDevice` (also used by the automatic account checks, modules/social/check.ts): one operation on the
 *   device at a time (Redis lock per device), pace per device from the 风控 settings (risk/settings.ts:
 *   minimum interval between visits, cap per rolling hour; visit times in a Redis sorted set), nothing while
 *   someone views/controls the device. Each of these ends the attempt with `CollectorDefer` (code + time):
 *   the task handler turns it into a new scheduled task, so nothing is dropped and no worker sleeps.
 */
export const COLLECTOR_PLATFORMS = ['instagram'] as const;
export type CollectorPlatform = typeof COLLECTOR_PLATFORMS[number];

const KEY = 'tracked.collectors';
interface CollectorEntry {
  instanceId: string | null;
  /** LEGACY (written by older code): halt marker of the entry; halts are per device now (`risk.halts`, deviceHalts). */
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

export async function collectorEntry(platform: CollectorPlatform): Promise<(CollectorEntry & { instanceId: string }) | null> {
  const e = (await load()).value[platform];
  return e?.instanceId ? { ...e, instanceId: e.instanceId } : null;
}

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

const deviceView = (inst: Instance | undefined) => (inst ? { id: inst.id, name: inst.name, status: inst.status, adbState: inst.adbState, external: !!inst.sourceId } : null);

// ---------------------------------------------------------------- device halts (风控)

/**
 * A device stopped by a challenge / verification / rate-limit screen (collector visit or account check).
 * Settings key `risk.halts`, per device id. Until an admin resumes it (风控 page, or the collector setting's
 * `resume`), no automatic operation runs on it: collector refreshes end `tracked.collector_halted`, account
 * checks `account_check.device_halted`. Halts written by older code (fields on the `tracked.collectors`
 * entry) are read as a halt of that entry's device and cleared by the same resume.
 */
const HALTS_KEY = 'risk.halts';
export interface DeviceHalt {
  at: string;
  code: string;
  source: 'collector' | 'account_check' | 'feed' | 'reply' | 'publish';
  platform: string;
  socialAccountId?: string | null;
  trackedAccountId?: string | null;
}

async function storedHalts(): Promise<Record<string, DeviceHalt>> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, HALTS_KEY));
  return { ...((row?.value as Record<string, DeviceHalt> | undefined) ?? {}) };
}
async function storeHalts(next: Record<string, DeviceHalt>): Promise<void> {
  await db.insert(schema.settings).values({ key: HALTS_KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
}

export async function deviceHalts(): Promise<Record<string, DeviceHalt>> {
  const [halts, { value: collectors }] = await Promise.all([storedHalts(), load()]);
  for (const [platform, e] of Object.entries(collectors)) {
    if (e?.instanceId && e.haltedAt && !halts[e.instanceId]) halts[e.instanceId] = { at: e.haltedAt, code: e.haltCode ?? 'tracked.collector_challenge', source: 'collector', platform };
  }
  return halts;
}
export const deviceHalt = async (instanceId: string): Promise<DeviceHalt | null> => (await deviceHalts())[instanceId] ?? null;

/** Stops automatic work on the device and raises collector.blocked (admins + device grants, channels). */
export async function haltDevice(inst: Pick<Instance, 'id' | 'name'>, halt: Omit<DeviceHalt, 'at'>): Promise<void> {
  await storeHalts({ ...(await storedHalts()), [inst.id]: { ...halt, at: new Date().toISOString() } });
  await collectorBlocked(inst, halt.platform, true, halt.code);
}

/**
 * Called after a device was resumed (e.g. comments re-queue the replies parked while it was halted). Modules
 * register at import time; collector.ts never imports them (no cycle). A failing hook never fails the resume.
 */
const resumeHooks: ((instanceId: string) => Promise<unknown>)[] = [];
export const onDeviceResumed = (fn: (instanceId: string) => Promise<unknown>) => { resumeHooks.push(fn); };

/** Clears the device's halt (also a legacy collector-entry halt) and recovers its alert. Returns whether it was halted. */
export async function resumeDevice(instanceId: string): Promise<boolean> {
  const halt = await deviceHalt(instanceId);
  const cur = await storedHalts();
  if (cur[instanceId]) { delete cur[instanceId]; await storeHalts(cur); }
  const { value } = await load();
  let legacy = false;
  for (const p of COLLECTOR_PLATFORMS) {
    const e = value[p];
    if (e?.instanceId === instanceId && e.haltedAt) { value[p] = { ...e, haltedAt: null, haltCode: null }; legacy = true; }
  }
  if (legacy) await store(value);
  if (halt) {
    const inst = await getInstance(instanceId);
    if (inst) await collectorBlocked(inst, halt.platform, false);
  }
  for (const fn of resumeHooks) await fn(instanceId).catch(() => undefined);
  return !!halt;
}

// ---------------------------------------------------------------- collector setting

/** Admin view (settings page): device, halt state and the pace counters per platform. */
export async function collectorSettings() {
  const [{ value, updatedAt }, halts, pace] = await Promise.all([load(), deviceHalts(), getRiskSettings()]);
  const collectors = await Promise.all(COLLECTOR_PLATFORMS.map(async (platform) => {
    const e = value[platform];
    const inst = e?.instanceId ? await getInstance(e.instanceId) : undefined;
    const usage = inst ? await deviceUsage(inst.id).catch(() => ({ visitsLastHour: 0, lastVisitAt: null })) : { visitsLastHour: 0, lastVisitAt: null };
    const h = inst ? halts[inst.id] : undefined;
    return {
      platform,
      instanceId: e?.instanceId ?? null,
      device: deviceView(inst),
      halted: h ? { at: h.at, code: h.code } : null,
      ...usage,
    };
  }));
  return {
    collectors, updatedAt,
    pace: { minIntervalSec: pace.minIntervalSec, maxPerHour: pace.maxPerHour, busyRetrySec: pace.busyRetrySec },
  };
}

/** Collector devices → their platforms (风控 page). */
export async function collectorDevices(): Promise<Map<string, CollectorPlatform[]>> {
  const out = new Map<string, CollectorPlatform[]>();
  for (const [p, e] of Object.entries((await load()).value)) if (e?.instanceId) out.set(e.instanceId, [...(out.get(e.instanceId) ?? []), p as CollectorPlatform]);
  return out;
}

/**
 * Sets the platform's collector device (null = none) and/or resumes it after a halt. A resume clears the
 * halt of the (new) collector device and recovers its alert; the 风控 page resumes any device the same way.
 * Halts belong to devices: picking another device leaves the old one halted.
 */
export async function saveCollector(platform: CollectorPlatform, input: { instanceId?: string | null; resume?: boolean }) {
  const { value } = await load();
  const cur = value[platform] ?? { instanceId: null };
  let instanceId = cur.instanceId;
  if (input.instanceId !== undefined && input.instanceId !== cur.instanceId) {
    if (input.instanceId && !(await getInstance(input.instanceId))) throw notFound('设备不存在', 'tracked.collector_device_not_found');
    instanceId = input.instanceId;
  }
  if (instanceId !== cur.instanceId && cur.instanceId && cur.haltedAt) {
    // a legacy entry halt moves to the device it belongs to before the entry changes
    await storeHalts({ ...(await storedHalts()), [cur.instanceId]: { at: cur.haltedAt, code: cur.haltCode ?? 'tracked.collector_challenge', source: 'collector', platform } });
  }
  await store({ ...value, [platform]: instanceId === cur.instanceId ? cur : { instanceId } });
  if (input.resume && instanceId) await resumeDevice(instanceId);
  return collectorSettings();
}

/** A challenge screen on the collector: stop that device until an admin resumes it, and alert. */
export async function haltCollector(platform: CollectorPlatform, inst: Pick<Instance, 'id' | 'name'>, code: string, trackedAccountId?: string | null): Promise<void> {
  const e = (await load()).value[platform];
  if (!e || e.instanceId !== inst.id) return;
  await haltDevice(inst, { code, source: 'collector', platform, trackedAccountId: trackedAccountId ?? null });
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
  if (await deviceHalt(e.instanceId)) throw new HttpError(409, '采集设备遇到验证/限制页面，采集已停止，需管理员在风控页恢复', 'tracked.collector_halted');
  return e;
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
 * the 风控 settings (minimum interval, hourly cap). The rules are per device, so the collector and the
 * account checks on one phone share one pace and one lock. Throws CollectorDefer for "not now".
 */
export interface DeviceOpOptions {
  /** Lock lifetime for operations longer than one visit (default LOCK_MS). */
  lockMs?: number;
  /** Screens the operation opens (counted in the hourly cap; default 1). */
  weight?: number;
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
  if ((await redis.set(lockKey(inst.id), token, 'PX', opts.lockMs ?? LOCK_MS, 'NX')) !== 'OK') {
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
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey(inst.id), token).catch(() => undefined);
  }
}

/**
 * Runs one profile visit on the platform's collector device under the rules above. `fn` is the visit
 * itself (navigation + screen reads only). Throws coded HttpErrors (unset, halted, offline) or CollectorDefer.
 */
export async function withCollector<T>(platform: CollectorPlatform, log: Log, fn: (dev: CollectorDevice) => Promise<T>): Promise<T> {
  const entry = await requireCollector(platform);
  const inst = await getInstance(entry.instanceId);
  if (!inst) throw new HttpError(400, '采集设备已不存在，请重新选择', 'tracked.collector_unset');
  return withDevice(inst, log, () => new HttpError(503, `采集设备 ${inst.name} 不在线`, 'tracked.collector_offline', { name: inst.name }), fn);
}
