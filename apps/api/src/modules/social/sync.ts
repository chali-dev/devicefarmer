import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, SocialAccount } from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { withMutex } from '../../lib/locks.js';
import { assertPlatformEnabled, isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { adb } from '../../services.js';
import { assertInstanceAccess, isAdmin, type AuthUser } from '../auth/rbac.js';
import { getInstance } from '../instances/repo.js';
import { notify } from '../notify/notify.js';
import { isUniqueViolation } from '../proxies/pool.js';
import { recordRiskEvent } from '../risk/events.js';
import { getRiskSettings } from '../risk/settings.js';
import { createTask, registerTaskHandler, type TaskContext } from '../tasks/core.js';
import { CollectorDefer, deviceHalt, deviceHalts, haltDevice, withDevice, type CollectorDevice } from '../tracked/collector.js';
import { approxOf, dumpExcerpt, igDeviceAccounts, readOwnIgProfile } from '../tracked/instagram-device.js';
import { queueFeedAfter } from '../feed/collect.js';
import { queueFollowingAfter } from './following.js';
import { recordCheckResult } from './check.js';
import { platformById } from './platforms.js';
import { assertDeviceRoom, linkLogs, platformAllowed, writeLogs, type LogEntry } from './social.js';

/**
 * 从云手机同步 (owner's base flow 2026-11-18: admin creates a user → assigns a cloud phone → the user logs in to
 * Instagram on it by remote control → the account appears in 社交号 by itself). Task `account-device-sync` (own
 * queue `account-sync`, device-less in the task centre so only its creator and admins see it; the device work is
 * serialised and paced by tracked/collector.ts `withDevice`, like the automatic account check), on one phone:
 *   1. `dumpsys account`: the Instagram accounts (numeric ids) Android knows. None → not_logged_in.
 *   2. `instagram://profile` (the logged-in account's own profile), uiautomator dump: username (action_bar_title),
 *      display name, followers / following / posts (abbreviated → approx). HOME, no dump left. Same reader as
 *      the account check (instagram-device.ts); navigation + screen reads only, never another account's page.
 *   3. applySync: same platform + handle (or, when the phone has exactly one id, the account with that
 *      externalId: renamed on Instagram) owned by the target owner → `updated` (fills externalId, links the phone
 *      if unlinked, display name, handle after a rename); owned by someone else → `taken` (who is never said);
 *      none → `created` (instance_id = the phone, owner, profile URL, externalId). Per-device limit → `limit_reached`.
 *      Today's social_account_stats row (source device) and an account log `synced from device`.
 * Which id is the profile's when the phone has several Instagram accounts (the app's account switcher): the matched
 * account's own externalId if among them, else the only id no social account records yet, else none.
 * 自动发现 (`discoverDeviceAccounts`, hourly, 风控 accountDiscovery, default on): `dumpsys account` only on each
 * running, not halted phone that allows Instagram; ids no social account records → the phone's assigned user (an
 * unassigned phone: the builtin admin) gets a sync task (auto, key per phone + ids + UTC day, so at most one app
 * visit a day for the same ids); legacy several users / a disabled assigned user / no builtin admin → in-app notice
 * `account.discovered` (admins + the phone's users), once a day.
 * Account owner of a manual sync: the phone's assigned user, else the admin who runs it (syncOwner).
 * The 同步 button of an account (`POST /api/social/accounts/:id/sync`, payload.feed) adds step 2: the feed
 * collection of the synced account, queued by this task once step 1 succeeded (syncFeedStep).
 */
export const ACCOUNT_SYNC_TYPE = 'account-device-sync';
export const ACCOUNT_SYNC_REF = 'instance';
const QUEUE = 'account-sync';
const PLATFORM = 'instagram';
const MAX_DEFERRALS = 30;
const IG_HANDLE = /^[a-z0-9._]{1,30}$/i;
const sa = schema.socialAccounts;

export type SyncResult = 'created' | 'updated' | 'taken' | 'limit_reached' | 'platform_disabled'
  | 'not_logged_in' | 'challenge' | 'timeout' | 'offline' | 'app_missing';

const unfinishedSync = async (instanceId: string) => {
  const [t] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
    eq(schema.tasks.type, ACCOUNT_SYNC_TYPE), eq(schema.tasks.refId, instanceId), inArray(schema.tasks.status, ['pending', 'scheduled', 'running']),
  )).limit(1);
  return t ?? null;
};

/** Users assigned to a phone (instance_grants; one by the owner's rule since 2026-11-18, older data may have several). */
export async function phoneUsers(instanceId: string): Promise<{ id: string; disabled: boolean }[]> {
  return db.select({ id: schema.users.id, disabled: schema.users.disabled }).from(schema.instanceGrants)
    .innerJoin(schema.users, eq(schema.users.id, schema.instanceGrants.userId))
    .where(eq(schema.instanceGrants.instanceId, instanceId)).orderBy(schema.users.username);
}

/**
 * Account owner for a sync (owner decision 2026-11-18: phone → user binding): the user the phone is assigned to,
 * else the caller (an admin; a user passed RBAC, so they are the assigned one, or one of them on legacy data). An
 * explicit ownerId must be that owner, else 400 account_sync.owner_mismatch; a legacy phone with several users needs
 * an admin to pick one of them (account_sync.owner_required).
 */
async function syncOwner(user: AuthUser, inst: Pick<Instance, 'id' | 'name'>, ownerId?: string): Promise<string> {
  if (ownerId && ownerId !== user.id) {
    if (!isAdmin(user)) throw forbidden('仅管理员可以为其他用户同步账号', 'social.admin_only');
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerId));
    if (!u) throw badRequest('用户不存在', 'users.not_found');
  }
  if (!isAdmin(user)) return user.id;
  const assigned = (await phoneUsers(inst.id)).map((u) => u.id);
  const mismatch = () => badRequest(`账号归属必须是云手机 ${inst.name} 分配的用户（未分配时为执行同步的管理员）`, 'account_sync.owner_mismatch', { device: inst.name });
  if (assigned.length > 1) {
    if (!ownerId) throw badRequest(`云手机 ${inst.name} 分配给了多个用户，请选择账号归属`, 'account_sync.owner_required', { device: inst.name });
    if (!assigned.includes(ownerId)) throw mismatch();
    return ownerId;
  }
  const derived = assigned[0] ?? user.id;
  if (ownerId && ownerId !== derived) throw mismatch();
  return derived;
}

/** 从云手机同步: queues a sync of the phone's logged-in Instagram account (refused with a code when it can't run). */
export async function requestAccountSync(user: AuthUser, instanceId: string, ownerId?: string, opts: { feed?: boolean } = {}) {
  assertPlatformEnabled(PLATFORM);
  const inst = await getInstance(instanceId);
  if (!inst) throw notFound('设备不存在', 'instances.not_found');
  await assertInstanceAccess(user, inst.id, 'operate');
  const owner = await syncOwner(user, inst, ownerId);
  if (!platformAllowed(inst.allowedPlatforms, PLATFORM)) {
    throw conflict(`设备 ${inst.name} 未开启 Instagram`, 'social.platform_disabled', { device: inst.name, platform: 'Instagram' });
  }
  if (await deviceHalt(inst.id)) throw conflict('设备遇到验证/限制页面已暂停自动操作，需管理员在风控页恢复', 'account_sync.device_halted');
  // 防并发: one sync per phone, checked and created alone (同步 button + dialog, two tabs, two API processes)
  return withMutex(`task:${ACCOUNT_SYNC_TYPE}:${inst.id}`, async () => {
    if (await unfinishedSync(inst.id)) throw conflict('该云手机已有同步在排队或进行中', 'account_sync.in_progress');
    const { task } = await createTask({
      type: ACCOUNT_SYNC_TYPE, userId: user.id, label: inst.name, refType: ACCOUNT_SYNC_REF, refId: inst.id,
      payload: { instanceId: inst.id, ownerId: owner, ...(opts.feed ? { feed: true } : {}) },
    });
    return task;
  });
}

// ---------------------------------------------------------------- writing the result (DB only)

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export interface SyncCounts { followers: number | null; following: number | null; posts: number | null; approx: string[] }
export interface SyncInput {
  inst: Pick<Instance, 'id' | 'name' | 'allowedPlatforms'>;
  ownerId: string;
  /** Who asked (log actor); null = 自动发现. */
  actor: AuthUser | null;
  handle: string;
  displayName: string | null;
  /** Instagram account ids on the phone (dumpsys account). */
  deviceIds: string[];
  counts?: SyncCounts | null;
}
export interface SyncOutcome { result: Extract<SyncResult, 'created' | 'updated' | 'taken' | 'limit_reached' | 'platform_disabled'>; accountId?: string; changed?: string[]; externalId?: string | null; linkedElsewhere?: boolean }
const MSG = 'synced from device';

/**
 * Stores what was read on the phone (see the module comment). Pure DB, exported for the no-phone check script.
 * Serialised per handle (advisory lock) and, for links, per (device, platform) by assertDeviceRoom.
 */
export async function applySync(i: SyncInput): Promise<SyncOutcome> {
  const handle = i.handle.replace(/^@+/, '').trim();
  const now = new Date();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`social-sync:${PLATFORM}:${handle.toLowerCase()}`}, 0))`);
      const [byHandle] = await tx.select().from(sa).where(and(eq(sa.platform, PLATFORM), sql`lower(${sa.handle}) = ${handle.toLowerCase()}`)).for('update');
      const known = i.deviceIds.length
        ? await tx.select({ id: sa.id, userId: sa.userId, externalId: sa.externalId }).from(sa).where(and(eq(sa.platform, PLATFORM), inArray(sa.externalId, i.deviceIds)))
        : [];
      let cur: SocialAccount | undefined = byHandle;
      // Renamed on Instagram: the phone's only id belongs to an account with another handle.
      if (!cur && i.deviceIds.length === 1 && known.length === 1) {
        [cur] = await tx.select().from(sa).where(eq(sa.id, known[0]!.id)).for('update');
      }
      if (cur && cur.userId !== i.ownerId) return { result: 'taken' as const };
      const used = new Set(known.map((k) => k.externalId));
      const free = i.deviceIds.filter((x) => !used.has(x));
      const externalId = cur?.externalId && i.deviceIds.includes(cur.externalId) ? cur.externalId
        : i.deviceIds.length === 1 ? i.deviceIds[0]! : free.length === 1 ? free[0]! : null;
      const stats = async (accountId: string) => {
        if (!i.counts) return;
        const v = { followers: i.counts.followers, following: i.counts.following, posts: i.counts.posts, approx: i.counts.approx.length ? i.counts.approx : null, capturedAt: now, source: 'device' as const };
        await tx.insert(schema.socialAccountStats).values({ socialAccountId: accountId, day: utcDay(now), ...v })
          .onConflictDoUpdate({ target: [schema.socialAccountStats.socialAccountId, schema.socialAccountStats.day], set: v });
      };

      if (cur) {
        const set: Partial<typeof sa.$inferInsert> = {};
        const logs: LogEntry[] = [];
        const field = (k: 'handle' | 'displayName' | 'externalId', v: string | null) => {
          if (v === null || v === cur![k]) return;
          set[k] = v;
          logs.push({ accountId: cur!.id, action: 'update', field: k, fromValue: cur![k], toValue: v, message: MSG });
        };
        if (cur.handle.toLowerCase() !== handle.toLowerCase()) {
          field('handle', handle);
          set.profileUrl = platformById(PLATFORM)!.profileUrl(handle);
        }
        if (!cur.externalId) field('externalId', externalId);
        field('displayName', i.displayName);
        let linkedElsewhere = false;
        if (!cur.instanceId) {
          await assertDeviceRoom(tx, i.inst, PLATFORM, cur.id);
          set.instanceId = i.inst.id;
          logs.push(...await linkLogs(tx, cur.id, null, i.inst.id, MSG));
        } else linkedElsewhere = cur.instanceId !== i.inst.id;
        if (Object.keys(set).length) {
          await tx.update(sa).set(set).where(eq(sa.id, cur.id));
        }
        await writeLogs(tx, i.actor, logs);
        await stats(cur.id);
        return { result: 'updated' as const, accountId: cur.id, changed: logs.map((l) => l.field ?? l.action), externalId: set.externalId ?? cur.externalId, linkedElsewhere };
      }

      await assertDeviceRoom(tx, i.inst, PLATFORM);
      const [row] = await tx.insert(sa).values({
        userId: i.ownerId, platform: PLATFORM, handle, displayName: i.displayName, profileUrl: platformById(PLATFORM)!.profileUrl(handle),
        externalId, instanceId: i.inst.id, loginStatus: 'logged_in', lastCheckedAt: now, lastCheckCode: 'ok', createdBy: i.actor?.id ?? null,
      }).returning();
      await writeLogs(tx, i.actor, [
        { accountId: row!.id, action: 'create', field: null, fromValue: null, toValue: `Instagram @${handle}`, message: MSG },
        ...(await linkLogs(tx, row!.id, null, i.inst.id, MSG)),
      ]);
      await stats(row!.id);
      return { result: 'created' as const, accountId: row!.id, externalId };
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'social.device_limit') return { result: 'limit_reached' };
    if (code === 'social.platform_disabled') return { result: 'platform_disabled' };
    // A concurrent sync / create of the same handle won the insert.
    if (isUniqueViolation(err, 'social_accounts_platform_handle')) return { result: 'taken' };
    throw err;
  }
}

// ---------------------------------------------------------------- the device part

type Read =
  | { result: 'not_logged_in' | 'challenge' | 'timeout' | 'app_missing'; detail?: string; ids?: string[] }
  | { result: 'known'; ids: string[] }
  | { result: 'profile'; ids: string[]; handle: string; displayName: string | null; counts: SyncCounts };

/** Inside withDevice. `onlyUnknown` (自动发现): skip the app when every id on the phone is recorded by now. */
async function readOnDevice(dev: CollectorDevice, ctx: Pick<TaskContext, 'log' | 'signal'>, onlyUnknown: boolean): Promise<Read> {
  const ids = await igDeviceAccounts(dev);
  await ctx.log('info', 'account sync: device accounts read', { count: ids.length });
  if (!ids.length) return { result: 'not_logged_in', detail: 'no Instagram account on the device' };
  if (onlyUnknown) {
    const known = await db.select({ externalId: sa.externalId }).from(sa).where(and(eq(sa.platform, PLATFORM), inArray(sa.externalId, ids)));
    if (known.length >= ids.length) return { result: 'known', ids };
  }
  let visit;
  try {
    visit = await readOwnIgProfile(dev, ctx);
  } catch (err) {
    if ((err as { code?: string }).code === 'account_check.app_missing') return { result: 'app_missing', ids };
    throw err;
  }
  const { screen, nodes } = visit;
  switch (screen.kind) {
    case 'profile': {
      if (!screen.handle || !IG_HANDLE.test(screen.handle)) {
        await ctx.log('warn', 'account sync: username not readable', { excerpt: dumpExcerpt(nodes) });
        return { result: 'timeout', detail: 'username not readable', ids };
      }
      const counts = { followers: screen.counts.followers?.value ?? null, following: screen.counts.following?.value ?? null, posts: screen.counts.posts?.value ?? null, approx: approxOf(screen) };
      await ctx.log('info', 'account sync: own profile read', { handle: screen.handle, raw: screen.raw, approx: counts.approx });
      return { result: 'profile', ids, handle: screen.handle, displayName: screen.displayName, counts };
    }
    case 'login':
      await ctx.log('warn', 'account sync: login screen', { excerpt: dumpExcerpt(nodes) });
      return { result: 'not_logged_in', detail: 'login screen', ids };
    case 'challenge':
      await ctx.log('error', 'account sync: challenge screen, device halted', { excerpt: dumpExcerpt(nodes) });
      await haltDevice(dev.inst, { code: 'account_sync.challenge', source: 'account_check', platform: PLATFORM });
      return { result: 'challenge', detail: 'challenge screen', ids };
    default:
      await ctx.log('warn', 'account sync: profile did not show in time', { excerpt: dumpExcerpt(nodes) });
      return { result: 'timeout', ids };
  }
}

/** `feed`: the 同步 button (step 2 = feed collection of the synced account after a created / updated result). */
type Payload = { instanceId: string; ownerId: string; auto?: boolean; feed?: boolean; deferrals?: number };

async function run(ctx: TaskContext<Payload>): Promise<Record<string, unknown>> {
  const p = ctx.payload;
  const skip = async (code: string) => { await ctx.log('info', `account sync skipped: ${code}`, { code }); return { outcome: 'skipped', code }; };
  if (!isPlatformEnabled(PLATFORM)) return skip('platform.disabled');
  const inst = await getInstance(p.instanceId);
  if (!inst) return skip('instances.not_found');
  const [owner] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, p.ownerId));
  if (!owner) return skip('users.not_found');
  if (p.auto && !(await getRiskSettings()).accountDiscovery) return skip('account_sync.discovery_off');
  if (await deviceHalt(inst.id)) return skip('account_sync.device_halted');
  const offline = () => new HttpError(503, `设备 ${inst.name} 不在线`, 'account_sync.offline', { name: inst.name });
  let read: Read | { result: 'offline' };
  try {
    read = await withDevice(inst, ctx.log, offline, (dev) => readOnDevice(dev, ctx, !!p.auto));
  } catch (err) {
    if (err instanceof CollectorDefer) {
      const deferrals = (p.deferrals ?? 0) + 1;
      if (deferrals > MAX_DEFERRALS) throw new HttpError(409, err.message, err.code);
      const { task } = await createTask({
        type: ACCOUNT_SYNC_TYPE, userId: ctx.task.createdBy, label: ctx.task.instanceName, refType: ACCOUNT_SYNC_REF, refId: inst.id,
        payload: { ...p, deferrals }, runAt: err.runAt, idempotencyKey: `deferred:${ctx.task.id}`,
      });
      await ctx.log('info', `deferred: ${err.code}`, { code: err.code, runAt: err.runAt.toISOString(), taskId: task.id });
      return { outcome: 'deferred', code: err.code, runAt: err.runAt.toISOString(), taskId: task.id };
    }
    if ((err as { code?: string }).code !== 'account_sync.offline') throw err;
    read = { result: 'offline' };
  }
  if (read.result === 'known') return skip('account_sync.all_known');
  if (read.result !== 'profile') {
    if (read.result === 'challenge' || read.result === 'timeout' || read.result === 'app_missing') {
      await recordRiskEvent({ instance: inst, source: 'account_check', code: `account_sync.${read.result}`, detail: 'detail' in read ? read.detail ?? null : null, userId: ctx.task.createdBy });
    }
    await ctx.log('warn', `account sync result: ${read.result}`, { result: read.result });
    if (read.result === 'not_logged_in') await recordSyncCheck(inst, { result: 'not_logged_in', detail: read.detail ?? null }, ctx.task.createdBy);
    return { outcome: 'synced', result: read.result };
  }
  const actor = ctx.task.createdBy ? (await db.select({ id: schema.users.id, username: schema.users.username, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, ctx.task.createdBy)))[0] ?? null : null;
  const o = await applySync({ inst, ownerId: p.ownerId, actor, handle: read.handle, displayName: read.displayName, deviceIds: read.ids, counts: read.counts });
  const ok = o.result === 'created' || o.result === 'updated';
  await ctx.log(ok ? 'info' : 'warn', `account sync result: ${o.result}`, { result: o.result, handle: read.handle, ...(o.changed ? { changed: o.changed } : {}) });
  if (o.result === 'updated' && o.accountId) await recordSyncCheck(inst, { result: 'ok', accountId: o.accountId }, ctx.task.createdBy);
  const feed = p.feed ? await syncFeedStep(o, { id: ctx.task.id, createdBy: ctx.task.createdBy }, ctx.log) : undefined;
  const following = p.feed ? await syncFollowingStep(o, { id: ctx.task.id, createdBy: ctx.task.createdBy }, ctx.log) : undefined;
  // `taken`: the handle only (the caller saw it on their own phone), never whose account it is.
  return {
    outcome: 'synced', result: o.result, handle: read.handle, ...(ok ? { accountId: o.accountId, displayName: read.displayName, externalId: o.externalId ?? null, counts: read.counts } : {}),
    ...(o.changed ? { changed: o.changed } : {}), ...(o.linkedElsewhere ? { linkedElsewhere: true } : {}),
    ...(feed ? { feed } : {}), ...(following ? { following } : {}),
  };
}

/**
 * Step 3 of the 同步 button (payload.feed, owner 2026-11-19 「同步时关注的号没同步进去」): same condition as step 2,
 * the account's 追踪中 list is read as its own task (social/following.ts queueFollowingAfter); the phone runs it and the
 * feed collection one after the other (one operation per phone at a time). Exported for the no-phone check script.
 */
export async function syncFollowingStep(o: Pick<SyncOutcome, 'result' | 'accountId' | 'linkedElsewhere'>, task: { id: string; createdBy: string | null }, log: TaskContext['log']): Promise<{ taskId: string } | { code: string } | undefined> {
  if ((o.result !== 'created' && o.result !== 'updated') || !o.accountId) return undefined;
  if (o.linkedElsewhere) {
    await log('info', 'following sync not queued: following.linked_elsewhere', { code: 'following.linked_elsewhere' });
    return { code: 'following.linked_elsewhere' };
  }
  return queueFollowingAfter(o.accountId, task.createdBy, task.id, log);
}

/**
 * Step 2 of the 同步 button (payload.feed): only after step 1 created / updated the account and the account is linked
 * to this phone, the feed collection of it is queued as its own task (feed/collect.ts queueFeedAfter); anything else
 * (taken, limit, not logged in, offline, challenge…) runs no step 2. Exported for the no-phone check script.
 */
export async function syncFeedStep(o: Pick<SyncOutcome, 'result' | 'accountId' | 'linkedElsewhere'>, task: { id: string; createdBy: string | null }, log: TaskContext['log']): Promise<{ taskId: string } | { code: string } | undefined> {
  if ((o.result !== 'created' && o.result !== 'updated') || !o.accountId) return undefined;
  if (o.linkedElsewhere) {
    await log('info', 'feed collection not queued: feed.linked_elsewhere', { code: 'feed.linked_elsewhere' });
    return { code: 'feed.linked_elsewhere' };
  }
  return queueFeedAfter('social', o.accountId, task.createdBy, task.id, log);
}

/**
 * The sync replaces 立即检测 in the UI (owner 2026-11-18), so it writes what the check writes (check.ts
 * recordCheckResult, via 'sync'): the synced (updated) account → ok (logged_in, last_checked_at, last_check_code ok,
 * last_error cleared, account.problem recovered); no Instagram account logged in on the phone → every Instagram
 * account linked to it → logged_out (+ risk record / alert like the check). A created account already starts ok.
 * Exported for the no-phone check script.
 */
export async function recordSyncCheck(inst: Pick<Instance, 'id' | 'name'>, r: { result: 'ok'; accountId: string } | { result: 'not_logged_in'; detail: string | null }, userId: string | null): Promise<number> {
  const accounts = r.result === 'ok'
    ? await db.select().from(sa).where(eq(sa.id, r.accountId))
    : await db.select().from(sa).where(and(eq(sa.instanceId, inst.id), eq(sa.platform, PLATFORM)));
  for (const acc of accounts) {
    await recordCheckResult(acc, inst, r.result === 'ok' ? { result: 'ok' } : { result: 'logged_out', detail: r.detail }, userId, 'sync');
  }
  return accounts.length;
}

// New type on its own queue (a draining old leader never sees it). One attempt, like the account check.
registerTaskHandler<Payload>(ACCOUNT_SYNC_TYPE, { queue: QUEUE, concurrency: 2, timeoutMs: 3 * 60_000, maxAttempts: 1, run });

// ---------------------------------------------------------------- 自动发现

export type DiscoveryAction = { kind: 'sync'; ownerId: string; via: 'assigned' | 'builtin_admin' }
  | { kind: 'notify'; reason: 'multiple_users' | 'user_disabled' | 'no_user' } | null;

/**
 * What 自动发现 does for a phone with these unrecorded ids, its assigned users and the builtin admin (null when
 * missing/disabled), owner decision 2026-11-18: the assigned (enabled) user gets the account; an unassigned phone
 * gives it to the builtin admin (as a manual sync by an admin would); a notice only when neither is possible
 * (legacy phone with several users, the assigned user disabled, no builtin admin).
 */
export const discoveryAction = (unknownIds: string[], assigned: { id: string; disabled: boolean }[], builtinAdminId: string | null): DiscoveryAction => {
  if (!unknownIds.length) return null;
  if (assigned.length > 1) return { kind: 'notify', reason: 'multiple_users' };
  if (assigned.length === 1) return assigned[0]!.disabled ? { kind: 'notify', reason: 'user_disabled' } : { kind: 'sync', ownerId: assigned[0]!.id, via: 'assigned' };
  return builtinAdminId ? { kind: 'sync', ownerId: builtinAdminId, via: 'builtin_admin' } : { kind: 'notify', reason: 'no_user' };
};

/** The builtin admin (ADMIN_USERNAME, flagged by the seed) when it exists and is enabled. */
async function builtinAdmin(): Promise<string | null> {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.builtin, true), eq(schema.users.role, 'admin'), eq(schema.users.disabled, false))).limit(1);
  return u?.id ?? null;
}

/**
 * One phone, given the Instagram ids `dumpsys account` listed on it: compares them with the recorded externalIds and
 * acts (sync task for the assigned user / the builtin admin, or the notice). Exported for the no-phone check script.
 */
export async function discoverOnDevice(inst: Pick<Instance, 'id' | 'name'>, ids: string[], now = new Date()): Promise<{ unknown: string[]; action: DiscoveryAction; taskId?: string; created?: boolean; notified?: boolean }> {
  const known = ids.length ? await db.select({ externalId: sa.externalId }).from(sa).where(and(eq(sa.platform, PLATFORM), inArray(sa.externalId, ids))) : [];
  const unknown = ids.filter((x) => !known.some((k) => k.externalId === x)).sort();
  if (!unknown.length) return { unknown, action: null };
  const action = discoveryAction(unknown, await phoneUsers(inst.id), await builtinAdmin());
  if (!action) return { unknown, action };
  const day = utcDay(now);
  const idsKey = createHash('sha256').update(unknown.join(',')).digest('hex').slice(0, 16);
  if (action.kind === 'sync') {
    const { task, created } = await createTask({
      type: ACCOUNT_SYNC_TYPE, userId: null, label: inst.name, refType: ACCOUNT_SYNC_REF, refId: inst.id,
      payload: { instanceId: inst.id, ownerId: action.ownerId, auto: true }, idempotencyKey: `discover:${inst.id}:${idsKey}:${day}`,
    });
    return { unknown, action, taskId: task.id, created };
  }
  const notified = await notify({
    kind: 'account.discovered', refId: inst.id, key: `${inst.id}:${idsKey}:${day}`,
    params: { name: inst.name, platform: 'Instagram', count: unknown.length, reason: action.reason },
  });
  return { unknown, action, notified };
}

/** Hourly (main.ts) and admin 立即发现: `dumpsys account` on every eligible phone (never opens the app). */
export async function discoverDeviceAccounts(now = new Date()): Promise<{ enabled: boolean; devices: number; read: number; synced: number; notified: number; failed: number }> {
  const out = { enabled: false, devices: 0, read: 0, synced: 0, notified: 0, failed: 0 };
  if (!isPlatformEnabled(PLATFORM) || !(await getRiskSettings(true)).accountDiscovery) return out;
  out.enabled = true;
  const rows = await db.select().from(schema.instances).where(and(eq(schema.instances.status, 'running'), eq(schema.instances.adbState, 'device'), isNotNull(schema.instances.adbPort)));
  const halts = await deviceHalts();
  const states = await adb.states().catch(() => new Map<string, string>());
  for (const inst of rows) {
    if (halts[inst.id] || !platformAllowed(inst.allowedPlatforms, PLATFORM) || states.get(adb.serialFor(inst.adbPort)) !== 'device') continue;
    out.devices++;
    try {
      const ids = await igDeviceAccounts({ inst, adbPort: inst.adbPort });
      out.read++;
      const r = await discoverOnDevice(inst, ids, now);
      if (r.action?.kind === 'sync' && r.created) out.synced++;
      if (r.notified) out.notified++;
    } catch {
      out.failed++;
    }
  }
  return out;
}
