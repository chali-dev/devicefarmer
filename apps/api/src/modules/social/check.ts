import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, SocialAccount } from '../../db/schema.js';
import { conflict, HttpError } from '../../lib/errors.js';
import { withMutex } from '../../lib/locks.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import type { AuthUser } from '../auth/rbac.js';
import { getInstance } from '../instances/repo.js';
import { accountChecked } from '../notify/triggers.js';
import { recordRiskEvent } from '../risk/events.js';
import { getRiskSettings } from '../risk/settings.js';
import { createTask, registerTaskHandler, type TaskContext } from '../tasks/core.js';
import { CollectorDefer, deviceHalt, deviceHalts, haltDevice, withDevice } from '../tracked/collector.js';
import { approxOf, dumpExcerpt, igDeviceAccounts, readOwnIgProfile } from '../tracked/instagram-device.js';
import { platformById } from './platforms.js';
import { visibleAccount, writeLogs, type LogEntry } from './social.js';

/**
 * 社交号自动检测 (owner decision 2026-11-18, replaces the manual "mark checked"): task `account-device-check`
 * (queue `account-check`, device-less in the task centre; the device work is serialised and paced by
 * tracked/collector.ts `withDevice`, the same lock + pace as the tracked-account collector on that phone).
 * For an Instagram account linked to a device, on that device:
 *   1. `dumpsys account`: the Instagram accounts (numeric ids) Android knows. None → logged_out; the
 *      account has an externalId that isn't among them → wrong_account (both without opening the app).
 *   2. `instagram://profile` in the app (opens the logged-in account's own profile), uiautomator dump ≤ 15 s
 *      (instagram-device.ts), title compared with the handle (case-insensitive): equal → ok, else wrong_account
 *      (the username seen is kept as detail); login screen → logged_out; challenge → the device is halted
 *      (collector.blocked alert, resume on the 风控 page) → challenge; nothing recognisable → timeout.
 *   3. ok: followers / following / posts go into social_account_stats (today's UTC row, source `device`,
 *      `approx` = abbreviated by the app), the 账号分析 page's data source. HOME and no dump left behind.
 * Navigation + screen reads only: no taps, no typing. Results: login_status (ok → logged_in, logged_out /
 * wrong_account → logged_out, challenge → needs_verification; offline / timeout / app_missing keep it),
 * last_checked_at, last_check_code/detail; a social_account_logs row when the result or a status changes;
 * a risk_events row for every problem (not for "device offline"); account.problem alerts for definite results.
 * Scheduling: the 风控 setting accountCheckHours (default 6, null = off), hourly tick, per-account hash
 * offset, key `acct-check:<id>:<slot>`; "立即检测" by the owner goes through the same queue.
 */
export const ACCOUNT_CHECK_TYPE = 'account-device-check';
export const ACCOUNT_CHECK_REF = 'social_account';
const QUEUE = 'account-check';
const MAX_DEFERRALS = 30;
const sa = schema.socialAccounts;

export type CheckResult = 'ok' | 'logged_out' | 'wrong_account' | 'challenge' | 'offline' | 'timeout' | 'app_missing';
const LOGIN_BY_RESULT: Partial<Record<CheckResult, SocialAccount['loginStatus']>> = {
  ok: 'logged_in', logged_out: 'logged_out', wrong_account: 'logged_out', challenge: 'needs_verification',
};

/** Why an account can't be checked automatically at all (null = supported). */
export function autoCheckUnsupported(acc: Pick<SocialAccount, 'platform' | 'instanceId'>): string | null {
  if (!platformById(acc.platform)?.deviceCheck || !isPlatformEnabled(acc.platform)) return 'account_check.unsupported_platform';
  if (!acc.instanceId) return 'account_check.no_device';
  return null;
}

const unfinishedCheck = async (accountId: string) => {
  const [t] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
    eq(schema.tasks.type, ACCOUNT_CHECK_TYPE), eq(schema.tasks.refId, accountId), inArray(schema.tasks.status, ['pending', 'scheduled', 'running']),
  )).limit(1);
  return t ?? null;
};

/** 立即检测: queues a check now (refused with a code when it can't run). */
export async function requestAccountCheck(user: AuthUser, acc: SocialAccount) {
  const why = autoCheckUnsupported(acc);
  if (why === 'account_check.no_device') throw new HttpError(400, '账号未绑定云手机，不能自动检测', why);
  if (why) throw new HttpError(400, '该平台不支持自动检测', why, { platform: acc.platform });
  if (await deviceHalt(acc.instanceId!)) throw conflict('设备遇到验证/限制页面已暂停自动操作，需管理员在云机管理的设备卡片上恢复', 'account_check.device_halted');
  // 防并发: checked and created alone per account (double click, two tabs, two API processes)
  return withMutex(`task:${ACCOUNT_CHECK_TYPE}:${acc.id}`, async () => {
    if (await unfinishedCheck(acc.id)) throw conflict('该账号已有检测在排队或进行中', 'account_check.in_progress');
    const { task } = await createTask({
      type: ACCOUNT_CHECK_TYPE, userId: user.id, label: `${acc.platform} @${acc.handle}`, refType: ACCOUNT_CHECK_REF, refId: acc.id,
      payload: { socialAccountId: acc.id },
    });
    return task;
  });
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export interface CheckOutcome { result: CheckResult; detail?: string | null; externalId?: string | null; counts?: { followers: number | null; following: number | null; posts: number | null; approx: string[] } }

/**
 * Writes the result on the account (+ logs when something changed), stats on ok, risk event + alert. Also used by
 * 从云手机同步 (`via: 'sync'`, sync.ts: the 同步 row action replaced 立即检测 in the UI, 2026-11-18): a synced account
 * gets ok, the phone's linked accounts get logged_out when no Instagram account is logged in; only the log texts differ.
 */
export async function recordCheckResult(acc: SocialAccount, inst: Pick<Instance, 'id' | 'name'>, o: CheckOutcome, userId: string | null, via: 'check' | 'sync' = 'check'): Promise<void> {
  const msg = via === 'sync' ? 'synced from device' : 'automatic check';
  const now = new Date();
  const login = LOGIN_BY_RESULT[o.result];
  let after: SocialAccount | undefined;
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(sa).where(eq(sa.id, acc.id)).for('update');
    if (!cur) return;
    const set: Partial<typeof sa.$inferInsert> = { lastCheckedAt: now, lastCheckCode: o.result, lastCheckDetail: o.detail?.slice(0, 300) ?? null };
    const logs: LogEntry[] = [];
    if (login && login !== cur.loginStatus) {
      set.loginStatus = login;
      logs.push({ accountId: cur.id, action: 'status', field: 'loginStatus', fromValue: cur.loginStatus, toValue: login, message: msg });
    }
    // The recorded error follows the definite results (ok clears an old manual one).
    const err = o.result === 'ok' ? null : o.result === 'wrong_account' ? `wrong account on device: ${o.detail ?? '?'}`.slice(0, 500) : undefined;
    if (err !== undefined && err !== cur.lastError) {
      set.lastError = err;
      logs.push({ accountId: cur.id, action: 'status', field: 'lastError', fromValue: cur.lastError, toValue: err, message: msg });
    }
    if (o.externalId && !cur.externalId) {
      set.externalId = o.externalId;
      logs.push({ accountId: cur.id, action: 'update', field: 'externalId', fromValue: null, toValue: o.externalId, message: msg });
    }
    if (o.result !== cur.lastCheckCode || logs.length) {
      logs.unshift({ accountId: cur.id, action: 'checked', field: null, fromValue: cur.lastCheckCode, toValue: o.result, message: `${via === 'sync' ? 'sync' : 'automatic check'} on ${inst.name}${o.detail ? `: ${o.detail}` : ''}` });
    }
    [after] = await tx.update(sa).set(set).where(eq(sa.id, cur.id)).returning();
    await writeLogs(tx, null, logs);
    if (o.result === 'ok' && o.counts) {
      const v = { followers: o.counts.followers, following: o.counts.following, posts: o.counts.posts, approx: o.counts.approx.length ? o.counts.approx : null, capturedAt: now, source: 'device' as const };
      await tx.insert(schema.socialAccountStats).values({ socialAccountId: cur.id, day: utcDay(now), ...v })
        .onConflictDoUpdate({ target: [schema.socialAccountStats.socialAccountId, schema.socialAccountStats.day], set: v });
    }
  });
  if (!after) return;
  if (o.result !== 'ok' && o.result !== 'offline') {
    await recordRiskEvent({ instance: inst, socialAccountId: acc.id, source: 'account_check', code: `account_check.${o.result}`, detail: o.detail ?? `@${acc.handle}`, userId });
  }
  if (login) await accountChecked(after, o.result === 'wrong_account' ? 'wrong_account' : undefined);
}

/** The device part of one check (inside withDevice: lock + pace held). */
async function checkOnDevice(acc: SocialAccount, dev: { inst: Instance; adbPort: number }, ctx: Pick<TaskContext, 'log' | 'signal'>): Promise<CheckOutcome> {
  const ids = await igDeviceAccounts(dev);
  await ctx.log('info', 'account check: device accounts read', { count: ids.length });
  if (!ids.length) return { result: 'logged_out', detail: 'no Instagram account on the device' };
  if (acc.externalId && !ids.includes(acc.externalId)) return { result: 'wrong_account', detail: `account ids on device: ${ids.join(', ')}` };
  let visit;
  try {
    visit = await readOwnIgProfile(dev, ctx);
  } catch (err) {
    if ((err as { code?: string }).code === 'account_check.app_missing') return { result: 'app_missing' };
    throw err;
  }
  const { screen, nodes } = visit;
  switch (screen.kind) {
    case 'profile': {
      if (!screen.handle) {
        await ctx.log('warn', 'account check: username not readable', { excerpt: dumpExcerpt(nodes) });
        return { result: 'timeout', detail: 'username not readable' };
      }
      if (screen.handle.toLowerCase() !== acc.handle.toLowerCase()) return { result: 'wrong_account', detail: `@${screen.handle}` };
      const counts = { followers: screen.counts.followers?.value ?? null, following: screen.counts.following?.value ?? null, posts: screen.counts.posts?.value ?? null, approx: approxOf(screen) };
      await ctx.log('info', 'account check: own profile read', { raw: screen.raw, approx: counts.approx });
      return { result: 'ok', detail: null, externalId: ids.length === 1 ? ids[0] : null, counts };
    }
    case 'login':
      await ctx.log('warn', 'account check: login screen', { excerpt: dumpExcerpt(nodes) });
      return { result: 'logged_out', detail: 'login screen' };
    case 'challenge':
      await ctx.log('error', 'account check: challenge screen, device halted', { excerpt: dumpExcerpt(nodes) });
      await haltDevice(dev.inst, { code: 'account_check.challenge', source: 'account_check', platform: acc.platform, socialAccountId: acc.id });
      return { result: 'challenge', detail: 'challenge screen' };
    default:
      await ctx.log('warn', 'account check: profile did not show in time', { excerpt: dumpExcerpt(nodes) });
      return { result: 'timeout' };
  }
}

type Payload = { socialAccountId: string; scheduled?: boolean; deferrals?: number };

async function run(ctx: TaskContext<Payload>): Promise<Record<string, unknown>> {
  const id = ctx.payload.socialAccountId ?? ctx.task.refId!;
  const [acc] = await db.select().from(sa).where(eq(sa.id, id));
  if (!acc) { await ctx.log('warn', 'account no longer exists'); return { outcome: 'gone' }; }
  const skip = async (code: string) => { await ctx.log('info', `account check skipped: ${code}`, { code }); return { outcome: 'skipped', code }; };
  const unsupported = autoCheckUnsupported(acc);
  if (unsupported) return skip(unsupported);
  if (ctx.payload.scheduled && (await getRiskSettings()).accountCheckHours === null) return skip('account_check.schedule_off');
  if (await deviceHalt(acc.instanceId!)) return skip('account_check.device_halted');
  const inst = await getInstance(acc.instanceId!);
  if (!inst) return skip('account_check.no_device');
  const offline = () => new HttpError(503, `设备 ${inst.name} 不在线`, 'account_check.offline', { name: inst.name });
  let o: CheckOutcome;
  try {
    o = await withDevice(inst, ctx.log, offline, (dev) => checkOnDevice(acc, dev, ctx), { what: 'check' });
  } catch (err) {
    if (err instanceof CollectorDefer) {
      const deferrals = (ctx.payload.deferrals ?? 0) + 1;
      if (deferrals > MAX_DEFERRALS) throw new HttpError(409, err.message, err.code);
      const { task } = await createTask({
        type: ACCOUNT_CHECK_TYPE, userId: ctx.task.createdBy, label: ctx.task.instanceName, refType: ACCOUNT_CHECK_REF, refId: acc.id,
        payload: { ...ctx.payload, deferrals }, runAt: err.runAt, idempotencyKey: `deferred:${ctx.task.id}`,
      });
      await ctx.log('info', `deferred: ${err.code}`, { code: err.code, runAt: err.runAt.toISOString(), taskId: task.id });
      return { outcome: 'deferred', code: err.code, runAt: err.runAt.toISOString(), taskId: task.id };
    }
    if ((err as { code?: string }).code !== 'account_check.offline') throw err;
    o = { result: 'offline', detail: inst.name };
  }
  await recordCheckResult(acc, inst, o, ctx.task.createdBy);
  await ctx.log(o.result === 'ok' ? 'info' : 'warn', `account check result: ${o.result}`, { result: o.result, ...(o.detail ? { detail: o.detail } : {}), ...(o.counts ? { counts: o.counts } : {}) });
  return { outcome: 'checked', result: o.result, detail: o.detail ?? null, ...(o.counts ? { counts: o.counts } : {}) };
}

// New type on its own queue (a draining old leader never sees it, see CLAUDE.md). One attempt: a failed
// screen read is not helped by an automatic retry; the next scheduled check or 立即检测 runs again.
registerTaskHandler<Payload>(ACCOUNT_CHECK_TYPE, {
  queue: QUEUE, concurrency: 2, timeoutMs: 3 * 60_000, maxAttempts: 1, run,
  // Retry (task centre) replays the stored payload: re-check what the request checked, as the caller (the account may
  // have moved to another user with its phone since the task was created).
  async beforeRetry(task, user) { await visibleAccount(user, (task.payload as Payload | null)?.socialAccountId ?? task.refId ?? ''); },
});

/**
 * Periodic checks (风控 accountCheckHours, null = off): every Instagram account linked to a running device
 * that is not halted, once per period at its own fixed offset (hash of its id), so checks spread out.
 * Hourly; creates the checks falling into the next ~hour as scheduled tasks, key `acct-check:<id>:<slot>`.
 */
export async function scheduleAccountDeviceChecks(now = new Date(), windowMs = 65 * 60_000): Promise<{ hours: number | null; accounts: number; created: number; skipped: number }> {
  const { accountCheckHours: hours } = await getRiskSettings(true);
  if (!hours) return { hours, accounts: 0, created: 0, skipped: 0 };
  const period = hours * 3600_000;
  const platforms = ['instagram'].filter((p) => platformById(p)?.deviceCheck && isPlatformEnabled(p));
  if (!platforms.length) return { hours, accounts: 0, created: 0, skipped: 0 };
  const rows = await db.select({ id: sa.id, userId: sa.userId, platform: sa.platform, handle: sa.handle, instanceId: sa.instanceId, status: schema.instances.status })
    .from(sa).innerJoin(schema.instances, eq(schema.instances.id, sa.instanceId))
    .where(and(inArray(sa.platform, platforms), isNotNull(sa.instanceId)));
  const halts = await deviceHalts();
  const from = now.getTime() - 5 * 60_000;
  let created = 0; let skipped = 0;
  for (const acc of rows) {
    if (acc.status !== 'running' || halts[acc.instanceId!]) { skipped++; continue; }
    const offset = createHash('sha256').update(acc.id).digest().readUInt32BE(0) % period;
    for (let slot = Math.ceil((from - offset) / period); slot * period + offset < now.getTime() + windowMs; slot++) {
      const r = await createTask({
        type: ACCOUNT_CHECK_TYPE, userId: null, label: `${acc.platform} @${acc.handle}`, refType: ACCOUNT_CHECK_REF, refId: acc.id,
        payload: { socialAccountId: acc.id, scheduled: true }, runAt: new Date(slot * period + offset), idempotencyKey: `acct-check:${acc.id}:${slot}`,
      });
      if (r.created) created++;
    }
  }
  return { hours, accounts: rows.length, created, skipped };
}
