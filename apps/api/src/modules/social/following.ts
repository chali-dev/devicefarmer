import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { SocialAccount, Task } from '../../db/schema.js';
import { conflict, HttpError } from '../../lib/errors.js';
import { withMutex } from '../../lib/locks.js';
import type { AuthUser } from '../auth/rbac.js';
import { IgScreenSession } from '../feed/ig-ui.js';
import { getInstance } from '../instances/repo.js';
import { recordRiskEvent } from '../risk/events.js';
import { getRiskSettings } from '../risk/settings.js';
import { createTask, registerTaskHandler, type TaskContext } from '../tasks/core.js';
import { CollectorDefer, deviceHalt, deviceHalts, haltDevice, withDevice, type CollectorDevice } from '../tracked/collector.js';
import { approxOf, classifyIgDump, dumpExcerpt, igDeviceAccounts, requireApp, screenProblem, visitIgScreen, type IgScreen, type UiNode } from '../tracked/instagram-device.js';
import { autoCheckUnsupported } from './check.js';
import { visibleAccount } from './social.js';
import { followingCounter, isFollowList, listSwipe, listTab, parseFollowingScreen, type FollowListKind } from './following-ui.js';

/**
 * 追踪中 (owner decision 2026-11-18): the REAL following list of an own Instagram account, read in the app on the
 * account's own cloud phone. Task `account-following` (own queue `account-following`, device-less in the task
 * centre, 1 attempt, 20 min); the device part runs under tracked/collector.ts `withDevice` (same lock + pace + halt
 * + busy/defer rules as the account check and the feed collection).
 *
 * On the phone: `dumpsys account` (none → logged_out; externalId not among them → wrong_account, app not opened) →
 * `instagram://profile` (own profile; username must equal the handle) → tap the 关注 counter → read the list with
 * uiautomator dumps, scrolling with a fixed swipe left of the row buttons, until the end of the list (suggestions
 * header, or as many rows as the tab count) or FOLLOWING_MAX entries → BACK, HOME, no dump left. Only the counter tap
 * and swipes: never a row's buttons (追踪中 / 发消息 / 更多), never a profile from the list, never follow/unfollow.
 * A challenge screen halts the device (collector.blocked, 风控 → 恢复) + 风控记录; login / wrong account / unreadable
 * screens are written to 风控记录 too.
 *
 * Then, in the same held operation (owner 2026-11-19): the profiles of ≤ PROFILE_VISITS_PER_RUN listed accounts (粉丝
 * first, then 关注 by position; never read or older than 7 days) are opened by their public deep link (visitIgScreen,
 * read only, no taps) for their 粉丝数 / 关注数 / 帖子数 and 不公开 (visitListProfiles).
 *
 * Storage: social_account_following, see schema.ts (gone_at only after a complete run).
 * Schedule: 风控 followingSyncHours (default 24, null = off), hourly, per-account hash offset, key
 * `following:<id>:<slot>`; running not-halted phones only. 同步 = POST /api/social/accounts/:id/following/sync.
 */
export const FOLLOWING_TYPE = 'account-following';
const QUEUE = 'account-following';
const REF = 'social_account';
/** Entries read per run at most (owner: low risk). A capped run never marks entries as gone. */
export const FOLLOWING_MAX = 200;
/** 粉丝: the newest followers read per run at most (owner 2026-11-19 「读名单最多20个」); only the count is complete. */
export const FOLLOWERS_MAX = 20;
/** Instagram loads the list in pages of about this many entries; one page load counts as a screen in the pace. */
const PAGE = 20;
const MAX_DEFERRALS = 30;
const F = schema.socialAccountFollowing;
/**
 * Profiles of listed accounts (关注 + 粉丝 rows) visited per run at most (owner 2026-11-19 「关注号也采集这些数据」): their
 * 粉丝数 / 关注数 / 帖子数 and 不公开, read by opening each public profile by deep link (read only, no taps).
 */
export const PROFILE_VISITS_PER_RUN = 30;
/** A row's profile is read again after this long. */
export const PROFILE_STALE_MS = 7 * 86_400_000;
/** Fixed gap between two profile visits inside the one held device operation (withDevice paces operations, not visits). */
const PROFILE_GAP_MS = 4000;
/** The profile part stops starting new visits after this long (the task timeout must cover lists + this). */
const PROFILE_BUDGET_MS = 12 * 60_000;
/** Consecutive failed visits (timeouts, unreadable) after which the profile part stops. */
const PROFILE_MAX_FAILS = 3;
const TASK_TIMEOUT_MS = 20 * 60_000;
const IG_HANDLE = /^[a-z0-9._]{1,30}$/;

type Payload = { socialAccountId: string; scheduled?: boolean; deferrals?: number };

/** Why an account's following list can't be read (null = it can): same rule as the automatic check. */
export const followingUnsupported = (acc: Pick<SocialAccount, 'platform' | 'instanceId'>) => autoCheckUnsupported(acc)?.replace('account_check.', 'following.') ?? null;

const unfinished = async (accountId: string) => {
  const [t] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
    eq(schema.tasks.type, FOLLOWING_TYPE), eq(schema.tasks.refId, accountId), inArray(schema.tasks.status, ['pending', 'scheduled', 'running']),
  )).limit(1);
  return t ?? null;
};

const mutexKey = (accountId: string) => `task:${FOLLOWING_TYPE}:${accountId}`;

/** 同步 (追踪中): queues a run now (coded refusals). */
export async function requestFollowingSync(user: AuthUser, acc: SocialAccount) {
  const why = followingUnsupported(acc);
  if (why === 'following.no_device') throw new HttpError(400, '账号未绑定云手机，不能读取追踪列表', why);
  if (why) throw new HttpError(400, '该平台不支持从云手机读取追踪列表', why, { platform: acc.platform });
  if (await deviceHalt(acc.instanceId!)) throw conflict('设备遇到验证/限制页面已暂停自动操作，需管理员在云机管理的设备卡片上恢复', 'following.device_halted');
  // 防并发: checked and created alone per account (also against step 3 of 同步, queueFollowingAfter)
  return withMutex(mutexKey(acc.id), async () => {
    if (await unfinished(acc.id)) throw conflict('该账号的追踪列表已在排队或读取中', 'following.in_progress');
    const { task } = await createTask({
      type: FOLLOWING_TYPE, userId: user.id, label: `${acc.platform} @${acc.handle}`, refType: REF, refId: acc.id,
      payload: { socialAccountId: acc.id } satisfies Payload,
    });
    return task;
  });
}

/**
 * Step 3 of the account's 同步 button (social/sync.ts syncFeedStep): after step 1 created / updated the account,
 * its 追踪中 list is read as its own task (key `after:<step 1 task>`); refusals (no phone, halted, already queued…)
 * are logged with their code instead. Its failure never touches what step 1 wrote.
 */
export async function queueFollowingAfter(accountId: string, userId: string | null, parentTaskId: string, log: TaskContext['log']): Promise<{ taskId: string } | { code: string }> {
  return withMutex(mutexKey(accountId), async () => {
    const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, accountId));
    const code = !acc ? 'following.account_gone'
      : followingUnsupported(acc) ?? ((await deviceHalt(acc.instanceId!)) ? 'following.device_halted' : (await unfinished(acc.id)) ? 'following.in_progress' : null);
    if (code || !acc) {
      await log('info', `following sync not queued: ${code}`, { code });
      return { code: code ?? 'following.account_gone' };
    }
    const { task } = await createTask({
      type: FOLLOWING_TYPE, userId, label: `${acc.platform} @${acc.handle}`, refType: REF, refId: acc.id,
      payload: { socialAccountId: acc.id } satisfies Payload, idempotencyKey: `after:${parentTaskId}`,
    });
    await log('info', 'following sync queued', { taskId: task.id });
    return { taskId: task.id };
  });
}

// ---------------------------------------------------------------- the device part

/** One list as read: entries in app order; complete = reached its end (only then may unseen rows be marked gone). */
export interface ListRead { entries: { handle: string; displayName: string | null }[]; tabCount: number | null; complete: boolean; capped: boolean }
/** The followers part never fails the run: it either read (≤ FOLLOWERS_MAX) or ended with a code. */
export type FollowersPart = ListRead | { code: string; detail?: string; challenge?: boolean };
export interface FollowingRead extends ListRead { screens: number; swipes: number; followers: FollowersPart }

/** Coded failure of a run (kind decides halt / risk record). */
export class FollowingError extends Error {
  constructor(readonly code: string, message: string, readonly kind: 'challenge' | 'logged_out' | 'wrong_account' | 'screen' | 'timeout', readonly detail?: string) { super(message); }
}

const PROBLEM: Record<'challenge' | 'login' | 'not_found', [string, FollowingError['kind']]> = {
  challenge: ['following.challenge', 'challenge'], login: ['following.logged_out', 'logged_out'], not_found: ['following.screen_unexpected', 'screen'],
};
const problemError = (nodes: UiNode[], fallback: string) => {
  const p = screenProblem(nodes);
  const [code, kind] = p ? PROBLEM[p] : [fallback, 'timeout' as const];
  return new FollowingError(code, `following list: ${code}`, kind, dumpExcerpt(nodes));
};
const isProfile = (n: UiNode[]) => { const k = classifyIgDump(n, null).kind; return k === 'profile' || k === 'challenge' || k === 'login'; };

/**
 * Reads the list whose tab is selected on the current screen, scrolling with swipes left of the row buttons, until its
 * end (suggestions header, or as many rows as an exact tab count) or `max` entries (capped) or two swipes without new
 * rows (incomplete). Never taps anything.
 */
async function readOpenList(s: IgScreenSession, firstNodes: UiNode[], kind: FollowListKind, max: number, fallbackCount: number | null,
  ctx: Pick<TaskContext, 'log' | 'signal'>, counter: { swipes: number }): Promise<ListRead> {
  let cur = parseFollowingScreen(firstNodes, kind);
  if (!cur.onFollowingTab) throw new FollowingError('following.screen_unexpected', `the ${kind} tab is not the selected one`, 'screen', dumpExcerpt(firstNodes));
  const tabCount = cur.tabCount ?? fallbackCount;
  const seen = new Map<string, { handle: string; displayName: string | null }>();
  let stalls = 0;
  let swipes = 0;
  const maxSwipes = Math.ceil(max / 3) + 5;
  for (;;) {
    const before = seen.size;
    for (const r of cur.rows) if (!seen.has(r.handle) && seen.size < max) seen.set(r.handle, { handle: r.handle, displayName: r.displayName });
    // the tab count only proves completeness while it is exact (≤ max; larger ones may be abbreviated, "1.2万")
    const full = tabCount !== null && tabCount <= max && seen.size >= tabCount;
    if (cur.end || full) return { entries: [...seen.values()], tabCount, complete: true, capped: false };
    if (seen.size >= max) return { entries: [...seen.values()], tabCount, complete: false, capped: true };
    stalls = seen.size === before ? stalls + 1 : 0;
    // nothing new after two swipes and no end marker: stop without claiming the list is complete
    if (stalls >= 2 || swipes >= maxSwipes) {
      await ctx.log('warn', `${kind}: list stopped growing before its end`, { seen: seen.size, tabCount, swipes });
      return { entries: [...seen.values()], tabCount, complete: false, capped: false };
    }
    const sw = listSwipe(cur);
    if (!sw) throw new FollowingError('following.parse_failed', 'list bounds not found', 'screen', dumpExcerpt(firstNodes));
    await s.sh(`input swipe ${sw.x} ${sw.y1} ${sw.x} ${sw.y2} 450`);
    swipes++; counter.swipes++;
    await sleep(1500, undefined, { signal: ctx.signal });
    let nodes = await s.dump();
    if (!isFollowList(nodes)) {
      if (screenProblem(nodes)) throw problemError(nodes, 'following.screen_unexpected');
      throw new FollowingError('following.screen_unexpected', `left the ${kind} list`, 'screen', dumpExcerpt(nodes));
    }
    cur = parseFollowingScreen(nodes, kind);
    if (!cur.onFollowingTab) throw new FollowingError('following.screen_unexpected', `the ${kind} tab is no longer selected`, 'screen', dumpExcerpt(nodes));
    if (!cur.end && !cur.rows.some((r) => !seen.has(r.handle))) {
      // the next page may still be loading
      await sleep(2000, undefined, { signal: ctx.signal });
      nodes = await s.dump();
      if (isFollowList(nodes)) cur = parseFollowingScreen(nodes, kind);
    }
  }
}

/**
 * 粉丝 part of a run (owner 2026-11-19 「读名单最多20个」, NOT probed live): from the following list, one tap on the 粉丝
 * tab title of the same screen; without a tab bar (following 0: still on the profile) one tap on the profile's 粉丝
 * counter. The selected tab must be 粉丝 before anything is read; ≤ `max` rows, swipes only, never a row button (移除 /
 * 回关 / 发消息), never a profile. Any problem ends this part with `followers.<code>` and leaves the following result.
 */
async function readFollowersPart(s: IgScreenSession, onList: boolean, profileCount: number | null, max: number,
  ctx: Pick<TaskContext, 'log' | 'signal'>, counter: { swipes: number }): Promise<FollowersPart> {
  if (profileCount === 0) return { entries: [], tabCount: 0, complete: true, capped: false };
  try {
    let nodes = onList ? await s.dump() : [];
    const tab = onList && isFollowList(nodes) ? listTab(nodes, 'followers') : null;
    if (tab) {
      if (!tab.selected) { await s.tap(tab); s.screens++; }
    } else {
      if (onList) await s.keys(4);
      const prof = await s.waitFor(isProfile, 10_000, onList ? 1500 : 0);
      if (classifyIgDump(prof.nodes, null).kind !== 'profile') throw problemError(prof.nodes, 'following.screen_unexpected');
      const target = followingCounter(prof.nodes, 'followers');
      if (!target) throw new FollowingError('following.parse_failed', 'followers counter not found', 'screen', dumpExcerpt(prof.nodes));
      await s.tap(target);
      s.screens++;
    }
    const first = await s.waitFor((n) => (isFollowList(n) && parseFollowingScreen(n, 'followers').onFollowingTab) || !!screenProblem(n), 12_000, 2000);
    nodes = first.nodes;
    if (!isFollowList(nodes)) throw problemError(nodes, 'following.screen_unexpected');
    return await readOpenList(s, nodes, 'followers', max, profileCount, ctx, counter);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const e = err instanceof FollowingError ? err : null;
    const code = `followers.${(e?.code ?? 'following.screen_unexpected').replace(/^following\./, '')}`;
    const detail = e?.detail ?? (err as Error).message;
    await ctx.log('warn', `followers list skipped: ${code}`, { code, excerpt: detail.slice(0, 300) });
    return { code, detail, ...(e?.kind === 'challenge' ? { challenge: true } : {}) };
  }
}

export async function readFollowingList(dev: CollectorDevice, acc: Pick<SocialAccount, 'handle' | 'externalId'>, ctx: Pick<TaskContext, 'log' | 'signal'>,
  max = FOLLOWING_MAX, followersMax = FOLLOWERS_MAX): Promise<FollowingRead> {
  await requireApp(dev, 'following.app_missing');
  const ids = await igDeviceAccounts(dev);
  if (!ids.length) throw new FollowingError('following.logged_out', 'no Instagram account on the device', 'logged_out', 'no Instagram account on the device');
  if (acc.externalId && !ids.includes(acc.externalId)) throw new FollowingError('following.wrong_account', 'another Instagram account is on the device', 'wrong_account', `account ids on device: ${ids.join(', ')}`);
  const s = new IgScreenSession(dev, ctx.signal);
  const counter = { swipes: 0 };
  try {
    await s.restartApp();
    await s.open('instagram://profile');
    const prof = await s.waitFor(isProfile, 20_000, 2500);
    const screen = classifyIgDump(prof.nodes, null);
    if (screen.kind !== 'profile') throw problemError(prof.nodes, 'following.timeout');
    if (!screen.handle || screen.handle.toLowerCase() !== acc.handle.toLowerCase()) {
      throw new FollowingError('following.wrong_account', 'own profile shows another username', 'wrong_account', `@${screen.handle ?? '?'}`);
    }
    const profileCount = screen.counts.following?.value ?? null;
    const followersCount = screen.counts.followers?.value ?? null;
    await ctx.log('info', 'following: own profile read', { following: profileCount, followers: followersCount });
    let following: ListRead;
    if (profileCount === 0) following = { entries: [], tabCount: 0, complete: true, capped: false };
    else {
      const target = followingCounter(prof.nodes);
      if (!target) throw new FollowingError('following.parse_failed', 'following counter not found', 'screen', dumpExcerpt(prof.nodes));
      await s.tap(target);
      s.screens++;
      const first = await s.waitFor((n) => isFollowList(n) || !!screenProblem(n), 15_000, 2500);
      if (!first.ok || !isFollowList(first.nodes)) throw problemError(first.nodes, 'following.timeout');
      following = await readOpenList(s, first.nodes, 'following', max, profileCount, ctx, counter);
    }
    const followers = followersMax > 0 ? await readFollowersPart(s, profileCount !== 0, followersCount, followersMax, ctx, counter) : { code: 'followers.off' };
    return { ...following, followers, screens: s.screens, swipes: counter.swipes };
  } finally {
    await s.keys(4).catch(() => undefined);
    await s.close();
  }
}

// ---------------------------------------------------------------- profiles of the listed accounts

type VisitRow = { id: string; kind: FollowListKind; handle: string; position: number | null; goneAt: Date | null; profileCheckedAt: Date | null };

/**
 * Which listed accounts get their profile visited in this run: current rows (not gone) never read or read more than
 * PROFILE_STALE_MS ago; 粉丝 rows first (≤ 20), then 关注 rows by list position; one per handle (an account in both
 * lists is visited once, writeProfile updates both rows); at most `max`.
 */
export function pickProfileVisits<R extends VisitRow>(rows: R[], now = new Date(), max = PROFILE_VISITS_PER_RUN): R[] {
  const cut = now.getTime() - PROFILE_STALE_MS;
  const order = (r: VisitRow) => (r.kind === 'followers' ? 0 : 1);
  const seen = new Set<string>();
  return rows
    .filter((r) => r.goneAt === null && (r.profileCheckedAt === null || r.profileCheckedAt.getTime() < cut))
    .sort((a, b) => order(a) - order(b) || (a.position ?? 1e9) - (b.position ?? 1e9) || a.handle.localeCompare(b.handle))
    .filter((r) => !seen.has(r.handle) && !!seen.add(r.handle))
    .slice(0, max);
}

/** One visit's outcome for a row: the profile's data, a coded problem of that row, or a screen that stops the profile part. */
export type ProfileOutcome =
  | { kind: 'profile'; followers: number | null; following: number | null; posts: number | null; approx: string[]; private: boolean; verified: boolean; displayName: string | null }
  | { kind: 'code'; code: 'not_found' | 'timeout' | 'parse_failed' | 'bad_handle' }
  | { kind: 'stop'; code: 'challenge' | 'logged_out'; detail: string };

/** Maps the classified profile screen (instagram-device.ts classifyIgDump, the same reader as the collector) to an outcome. */
export function profileOutcome(screen: IgScreen, nodes: UiNode[]): ProfileOutcome {
  switch (screen.kind) {
    case 'profile': {
      const c = screen.counts;
      if (!c.followers && !c.following && !c.posts) return { kind: 'code', code: 'parse_failed' };
      return {
        kind: 'profile', followers: c.followers?.value ?? null, following: c.following?.value ?? null, posts: c.posts?.value ?? null,
        approx: approxOf(screen), private: screen.private, verified: screen.verified, displayName: screen.displayName,
      };
    }
    case 'challenge': return { kind: 'stop', code: 'challenge', detail: dumpExcerpt(nodes) };
    case 'login': return { kind: 'stop', code: 'logged_out', detail: dumpExcerpt(nodes) };
    // a non-existent user leaves the profile shell empty (verified live on the collector)
    case 'not_found': case 'shell': return { kind: 'code', code: 'not_found' };
    default: return { kind: 'code', code: 'timeout' };
  }
}

/**
 * Stores one visit on the account's rows of that handle (both lists). A read profile or a missing one (not_found / bad_handle) sets profile_checked_at (next
 * visit after PROFILE_STALE_MS); other failures only set the code, so the row is picked again next run. Counts the
 * profile didn't show are stored as null.
 */
export async function writeProfile(accountId: string, handle: string, o: Exclude<ProfileOutcome, { kind: 'stop' }>, now = new Date()): Promise<void> {
  const rowsOf = and(eq(F.socialAccountId, accountId), eq(F.handle, handle.toLowerCase()));
  if (o.kind === 'profile') {
    await db.update(F).set({
      followers: o.followers, following: o.following, posts: o.posts, approx: o.approx, isPrivate: o.private, verified: o.verified,
      displayName: sql`coalesce(${F.displayName}, ${o.displayName})`, profileCheckedAt: now, profileCode: null,
    }).where(rowsOf);
    return;
  }
  const checked = o.code === 'not_found' || o.code === 'bad_handle';
  await db.update(F).set({
    profileCode: o.code,
    ...(checked ? { profileCheckedAt: now, followers: null, following: null, posts: null, approx: null, isPrivate: null } : {}),
  }).where(rowsOf);
}

export interface ProfilesPart { read: number; private: number; failed: number; notFound: number; stopped: string | null }

/**
 * Inside the run's held device operation, after both lists were written: visits the picked rows' public profiles
 * (`https://www.instagram.com/<handle>/` in the app = visitIgScreen: force-stop, deep link, dumps, HOME; no taps), one
 * every PROFILE_GAP_MS. A challenge halts the device (+ 风控记录) and a login screen is recorded: both stop this part;
 * a missing profile marks its row and goes on; PROFILE_MAX_FAILS failures in a row, the time budget or a cancel stop
 * it too. Never throws for a profile: the lists' result stands.
 */
export async function visitListProfiles(dev: CollectorDevice, accountId: string, ctx: Pick<TaskContext, 'log' | 'signal'>,
  onStop: (code: string, detail: string) => Promise<void>, max = PROFILE_VISITS_PER_RUN): Promise<ProfilesPart> {
  const out: ProfilesPart = { read: 0, private: 0, failed: 0, notFound: 0, stopped: null };
  const rows = await db.select({ id: F.id, kind: F.kind, handle: F.handle, position: F.position, goneAt: F.goneAt, profileCheckedAt: F.profileCheckedAt })
    .from(F).where(and(eq(F.socialAccountId, accountId), isNull(F.goneAt)));
  const picked = pickProfileVisits(rows, new Date(), max);
  const until = Date.now() + PROFILE_BUDGET_MS;
  let fails = 0;
  for (const [i, row] of picked.entries()) {
    if (ctx.signal.aborted) { out.stopped = 'cancelled'; break; }
    if (Date.now() >= until) { out.stopped = 'time_budget'; break; }
    if (fails >= PROFILE_MAX_FAILS) { out.stopped = 'failures'; break; }
    if (!IG_HANDLE.test(row.handle)) { await writeProfile(accountId, row.handle, { kind: 'code', code: 'bad_handle' }); out.failed++; continue; }
    try {
      if (i > 0) await sleep(PROFILE_GAP_MS, undefined, { signal: ctx.signal });
      const { screen, nodes } = await visitIgScreen(dev, `https://www.instagram.com/${row.handle}/`, row.handle, { signal: ctx.signal });
      const o = profileOutcome(screen, nodes);
      if (o.kind === 'stop') {
        out.stopped = o.code;
        await onStop(o.code === 'challenge' ? 'following.challenge' : 'following.logged_out', `@${row.handle} · ${o.detail}`.slice(0, 300));
        break;
      }
      await writeProfile(accountId, row.handle, o);
      if (o.kind === 'profile') { out.read++; if (o.private) out.private++; fails = 0; }
      else if (o.code === 'not_found') { out.notFound++; out.failed++; fails = 0; }
      else { out.failed++; fails++; }
    } catch (err) {
      if (ctx.signal.aborted) { out.stopped = 'cancelled'; break; }
      out.failed++; fails++;
      await ctx.log('warn', 'profile visit failed', { handle: row.handle, error: (err as Error).message.slice(0, 200) });
    }
  }
  await ctx.log(out.failed ? 'warn' : 'info', `profiles read: ${out.read} (private ${out.private}, failed ${out.failed})`, { ...out, picked: picked.length });
  return out;
}

// ---------------------------------------------------------------- writes

/** Upserts what a run saw of one list (`kind`); a complete read marks the others of that list gone. Returns counts. */
export async function writeFollowing(accountId: string, r: Pick<ListRead, 'entries' | 'complete'>, now = new Date(), kind: FollowListKind = 'following'): Promise<{ seen: number; added: number; returned: number; gone: number }> {
  let added = 0; let returned = 0; let gone = 0;
  await db.transaction(async (tx) => {
    const wasGone = new Set((await tx.select({ handle: F.handle }).from(F).where(and(eq(F.socialAccountId, accountId), eq(F.kind, kind), isNotNull(F.goneAt)))).map((x) => x.handle));
    for (const [i, e] of r.entries.entries()) {
      const handle = e.handle.toLowerCase();
      const [row] = await tx.insert(F).values({ socialAccountId: accountId, kind, handle, displayName: e.displayName, position: i, firstSeenAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [F.socialAccountId, F.kind, F.handle],
          set: { displayName: sql`coalesce(excluded.display_name, ${F.displayName})`, position: i, lastSeenAt: now, goneAt: null },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (row?.inserted) added++;
      else if (wasGone.has(handle)) returned++;
    }
    if (r.complete) {
      const g = await tx.update(F).set({ goneAt: now }).where(and(eq(F.socialAccountId, accountId), eq(F.kind, kind), isNull(F.goneAt), lt(F.lastSeenAt, now))).returning({ id: F.id });
      gone = g.length;
    }
  });
  return { seen: r.entries.length, added, returned, gone };
}

// ---------------------------------------------------------------- the task

async function run(ctx: TaskContext<Payload>): Promise<Record<string, unknown>> {
  const id = ctx.payload.socialAccountId ?? ctx.task.refId!;
  const skip = async (code: string) => { await ctx.log('info', `following sync skipped: ${code}`, { code }); return { outcome: 'skipped', code }; };
  if (ctx.payload.scheduled && (await getRiskSettings(true)).followingSyncHours === null) return skip('following.schedule_off');
  const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
  if (!acc) return skip('following.account_gone');
  const why = followingUnsupported(acc);
  if (why) return skip(why);
  if (await deviceHalt(acc.instanceId!)) return skip('following.device_halted');
  const inst = await getInstance(acc.instanceId!);
  if (!inst) return skip('following.no_device');
  const risk = (code: string, detail?: string | null) => recordRiskEvent({ instance: inst, socialAccountId: acc.id, source: 'following', code, detail: detail ?? `@${acc.handle}`, userId: ctx.task.createdBy });
  const offline = () => new HttpError(503, `设备 ${inst.name} 不在线`, 'following.offline', { name: inst.name });
  // weight = screens: profile + list + the list pages expected from the last known following count
  const [last] = await db.select({ following: schema.socialAccountStats.following }).from(schema.socialAccountStats)
    .where(and(eq(schema.socialAccountStats.socialAccountId, acc.id), isNotNull(schema.socialAccountStats.following)))
    .orderBy(desc(schema.socialAccountStats.day)).limit(1);
  // + 2 for the followers part (tab switch + ≤ 20 rows = about one more page) + the profile visits expected: the rows
  // due now, or for an account never read the lists' size
  const [due] = await db.select({
    n: sql<number>`count(*) filter (where ${F.profileCheckedAt} is null or ${F.profileCheckedAt} < ${new Date(Date.now() - PROFILE_STALE_MS).toISOString()}::timestamptz)`, all: count(),
  }).from(F).where(and(eq(F.socialAccountId, acc.id), isNull(F.goneAt)));
  const visits = Math.min(PROFILE_VISITS_PER_RUN, Number(due?.all ?? 0) ? Number(due?.n ?? 0) : (last?.following ?? PAGE) + FOLLOWERS_MAX);
  const weight = 4 + Math.ceil(Math.min(last?.following ?? PAGE, FOLLOWING_MAX) / PAGE) + visits;
  const now = new Date();
  let r: FollowingRead;
  let w: Awaited<ReturnType<typeof writeFollowing>>;
  let followers: Record<string, unknown>;
  let profiles: ProfilesPart | { skipped: string };
  try {
    // lists → written → the listed accounts' profiles, all inside the one held device operation
    ({ r, w, followers, profiles } = await withDevice(inst, ctx.log, offline, async (dev) => {
      const read = await readFollowingList(dev, acc, ctx);
      const lw = await writeFollowing(acc.id, read, now);
      await ctx.log('info', `following list read: ${lw.seen} accounts (${lw.added} new, ${lw.gone} gone)`, { ...lw, tabCount: read.tabCount, complete: read.complete, capped: read.capped });
      const fr = read.followers;
      let fol: Record<string, unknown>;
      if ('code' in fr) {
        // already logged by the reader; a challenge still halts the phone, every code is a 风控记录
        if (fr.challenge) await haltDevice(inst, { code: fr.code, source: 'following', platform: acc.platform, socialAccountId: acc.id });
        if (fr.code !== 'followers.off') await risk(fr.code, fr.detail);
        fol = { code: fr.code };
      } else {
        const fw = await writeFollowing(acc.id, fr, now, 'followers');
        fol = { ...fw, tabCount: fr.tabCount, complete: fr.complete, capped: fr.capped };
        await ctx.log('info', `followers list read: ${fw.seen} accounts (${fw.added} new, ${fw.gone} gone)`, fol);
      }
      // never after a challenge on the followers part (the phone is halted now)
      const prof = 'code' in fr && fr.challenge ? { skipped: 'followers.challenge' } : await visitListProfiles(dev, acc.id, ctx, async (code, detail) => {
        if (code === 'following.challenge') await haltDevice(inst, { code, source: 'following', platform: acc.platform, socialAccountId: acc.id });
        await risk(code, detail);
      });
      return { r: read, w: lw, followers: fol, profiles: prof };
    }, { lockMs: TASK_TIMEOUT_MS, weight, what: 'following' }));
  } catch (err) {
    if (err instanceof CollectorDefer) {
      const deferrals = (ctx.payload.deferrals ?? 0) + 1;
      if (deferrals > MAX_DEFERRALS) throw new HttpError(409, err.message, err.code);
      const { task } = await createTask({
        type: FOLLOWING_TYPE, userId: ctx.task.createdBy, label: ctx.task.instanceName, refType: REF, refId: acc.id,
        payload: { ...ctx.payload, deferrals }, runAt: err.runAt, idempotencyKey: `deferred:${ctx.task.id}`,
      });
      await ctx.log('info', `deferred: ${err.code}`, { code: err.code, runAt: err.runAt.toISOString(), taskId: task.id });
      return { outcome: 'deferred', code: err.code, runAt: err.runAt.toISOString(), taskId: task.id };
    }
    if (err instanceof FollowingError) {
      await ctx.log(err.kind === 'challenge' ? 'error' : 'warn', `following sync failed: ${err.code}`, { code: err.code, ...(err.detail ? { excerpt: err.detail.slice(0, 300) } : {}) });
      if (err.kind === 'challenge') await haltDevice(inst, { code: err.code, source: 'following', platform: acc.platform, socialAccountId: acc.id });
      await risk(err.code, err.detail);
      throw new HttpError(err.kind === 'challenge' ? 409 : 502, err.message, err.code);
    }
    if ((err as { code?: string }).code === 'following.app_missing') await risk('following.app_missing');
    throw err;
  }
  return { outcome: 'synced', ...w, tabCount: r.tabCount, complete: r.complete, capped: r.capped, screens: r.screens, swipes: r.swipes, followers, profiles };
}

// New type on its own queue (a draining old leader never sees it). One attempt: the next slot or 同步 runs again.
registerTaskHandler<Payload>(FOLLOWING_TYPE, {
  queue: QUEUE, concurrency: 2, timeoutMs: TASK_TIMEOUT_MS, maxAttempts: 1, run,
  // Retry (task centre) replays the stored payload: re-check what the request checked, as the caller (the account may
  // have moved to another user with its phone since the task was created).
  async beforeRetry(task, user) { await visibleAccount(user, (task.payload as Payload | null)?.socialAccountId ?? task.refId ?? ''); },
});

/**
 * Hourly: every Instagram social account on a running, not halted phone, once per followingSyncHours at a fixed
 * per-account offset; creates the slots falling into the next ~hour, key `following:<id>:<slot>`.
 */
export async function scheduleFollowingSyncs(now = new Date(), windowMs = 65 * 60_000): Promise<{ hours: number | null; created: number; skipped: number }> {
  const { followingSyncHours: hours } = await getRiskSettings(true);
  if (!hours) return { hours, created: 0, skipped: 0 };
  const period = hours * 3600_000;
  const sa = schema.socialAccounts;
  const rows = await db.select({ id: sa.id, platform: sa.platform, handle: sa.handle, instanceId: sa.instanceId, status: schema.instances.status })
    .from(sa).innerJoin(schema.instances, eq(schema.instances.id, sa.instanceId))
    .where(and(eq(sa.platform, 'instagram'), isNotNull(sa.instanceId)));
  const halts = await deviceHalts();
  const from = now.getTime() - 5 * 60_000;
  let created = 0; let skipped = 0;
  for (const acc of rows) {
    if (followingUnsupported(acc) || acc.status !== 'running' || halts[acc.instanceId!]) { skipped++; continue; }
    const offset = createHash('sha256').update(`following:${acc.id}`).digest().readUInt32BE(0) % period;
    for (let slot = Math.ceil((from - offset) / period); slot * period + offset < now.getTime() + windowMs; slot++) {
      const r = await createTask({
        type: FOLLOWING_TYPE, userId: null, label: `${acc.platform} @${acc.handle}`, refType: REF, refId: acc.id,
        payload: { socialAccountId: acc.id, scheduled: true } satisfies Payload, runAt: new Date(slot * period + offset), idempotencyKey: `following:${acc.id}:${slot}`,
      });
      if (r.created) created++;
    }
  }
  return { hours, created, skipped };
}

// ---------------------------------------------------------------- read API

const runView = (t: Task | undefined) => (t ? {
  taskId: t.id, status: t.status, at: t.finishedAt ?? t.runAt ?? t.createdAt, errorCode: t.errorCode ?? ((t.result as { code?: string } | null)?.code ?? null),
  result: (t.result ?? null) as Record<string, unknown> | null,
} : null);

export type ListState = 'all' | 'current' | 'gone';
const esc = (x: string) => x.replace(/[%_\\]/g, '\\$&');

/**
 * GET …/following and …/followers/list: one list of the account (current first, then gone), `state` all | current |
 * gone (default current), search on handle / name, counts, the last run + pending run (both lists are read by the
 * same task).
 */
export async function listFollowing(acc: SocialAccount, q: { limit: number; offset: number; q?: string; state?: ListState }, kind: FollowListKind = 'following') {
  const state = q.state ?? 'current';
  const mine = and(eq(F.socialAccountId, acc.id), eq(F.kind, kind));
  const where = and(
    mine,
    state === 'current' ? isNull(F.goneAt) : state === 'gone' ? isNotNull(F.goneAt) : undefined,
    q.q?.trim() ? or(ilike(F.handle, `%${esc(q.q.trim())}%`), ilike(F.displayName, `%${esc(q.q.trim())}%`)) : undefined,
  );
  const [items, [tot], [cur], [goneN], runs] = await Promise.all([
    db.select().from(F).where(where).orderBy(sql`${F.goneAt} is not null`, asc(F.position), asc(F.handle)).limit(q.limit).offset(q.offset),
    db.select({ n: count() }).from(F).where(where),
    db.select({ n: count() }).from(F).where(and(mine, isNull(F.goneAt))),
    db.select({ n: count() }).from(F).where(and(mine, isNotNull(F.goneAt))),
    db.select().from(schema.tasks).where(and(eq(schema.tasks.type, FOLLOWING_TYPE), eq(schema.tasks.refType, REF), eq(schema.tasks.refId, acc.id)))
      .orderBy(desc(schema.tasks.createdAt)).limit(20),
  ]);
  const open = runs.find((t) => ['pending', 'scheduled', 'running'].includes(t.status));
  const last = runs.find((t) => ['success', 'failed'].includes(t.status) && (t.result as { outcome?: string } | null)?.outcome !== 'deferred');
  const lastSynced = runs.find((t) => t.status === 'success' && (t.result as { outcome?: string } | null)?.outcome === 'synced');
  const s = await getRiskSettings();
  return {
    kind,
    items: items.map((r) => ({
      id: r.id, handle: r.handle, displayName: r.displayName, verified: r.verified, position: r.position, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, goneAt: r.goneAt,
      followers: r.followers, following: r.following, posts: r.posts, approx: r.approx ?? [], private: r.isPrivate, profileCheckedAt: r.profileCheckedAt, profileCode: r.profileCode,
    })),
    total: tot?.n ?? 0,
    /** current entries of this list (also as `following` for the following list, the older field name) */
    current: cur?.n ?? 0,
    ...(kind === 'following' ? { following: cur?.n ?? 0 } : {}),
    gone: goneN?.n ?? 0,
    unsupported: followingUnsupported(acc),
    halted: acc.instanceId ? !!(await deviceHalt(acc.instanceId)) : false,
    settings: { hours: s.followingSyncHours, max: kind === 'following' ? FOLLOWING_MAX : FOLLOWERS_MAX },
    last: runView(last),
    lastSynced: runView(lastSynced),
    pending: open ? { taskId: open.id, status: open.status, runAt: open.runAt } : null,
  };
}
