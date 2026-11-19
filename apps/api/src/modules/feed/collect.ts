import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, SocialAccount, TrackedAccount } from '../../db/schema.js';
import { conflict, HttpError } from '../../lib/errors.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import type { AuthUser } from '../auth/rbac.js';
import { getInstance } from '../instances/repo.js';
import { recordRiskEvent } from '../risk/events.js';
import { getRiskSettings } from '../risk/settings.js';
import { autoCheckUnsupported } from '../social/check.js';
import { createTask, registerTaskHandler, type TaskContext } from '../tasks/core.js';
import { CollectorDefer, deviceHalt, deviceHalts, haltDevice, withDevice } from '../tracked/collector.js';
import { phonesAllowed, trackedPhoneRefusal } from '../tracked/phone.js';
import { collectIgFeed, FeedScreenError, type FeedResult } from './device.js';

/**
 * 帖子与评论采集 (owner decision 2026-11-18): task `feed-collect` (own queue `feed-collect`, device-less in the
 * task centre; the device part runs under tracked/collector.ts `withDevice`: same lock + pace as the profile
 * visits and the account checks on that phone; the operation counts as 2 + N screens in the hourly cap).
 *
 * - Social account (社交号): Instagram account linked to a cloud phone → read on THAT phone. Posts go into
 *   social_account_posts (source device, externalId = media pk), comments into `comments` (source device,
 *   stable id = ig-ui.ts commentKey), so the 评论互动 page lists them too.
 * - Tracked account (追踪账号, Instagram, schedule on): read on the account's own 采集手机. Posts go into
 *   tracked_posts (source device), comments into tracked_post_comments (read only).
 *
 * The newest `feedPosts` posts (by media pk, so pinned posts don't count as new), the first
 * `feedCommentsPerPost` top-level comments of each (风控 → 采集与检测节奏). Read only: no likes, no follows, no
 * replies. A challenge screen halts the device (collector.blocked alert, 风控 → 恢复); login / unreadable
 * screens are written to 风控记录. Pace / busy / lock → the attempt is re-created at the allowed time
 * (`deferred:<task>`, ≤ 30 deferrals). Schedule: 风控 feedCollectHours (default 24, null = off), hourly tick,
 * per-account hash offset, key `feed:<kind>:<id>:<slot>` (one slot per period, i.e. per day by default).
 */
export const FEED_TYPE = 'feed-collect';
const QUEUE = 'feed-collect';
const MAX_DEFERRALS = 30;
export type FeedKind = 'social' | 'tracked';
type Payload = { kind: FeedKind; accountId: string; scheduled?: boolean; deferrals?: number };
export const feedRef = (kind: FeedKind) => (kind === 'social' ? 'social_account' : 'tracked_account');

const unfinished = async (kind: FeedKind, accountId: string) => {
  const [t] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
    eq(schema.tasks.type, FEED_TYPE), eq(schema.tasks.refType, feedRef(kind)), eq(schema.tasks.refId, accountId),
    inArray(schema.tasks.status, ['pending', 'scheduled', 'running']),
  )).limit(1);
  return t ?? null;
};

/** Why a social account's feed can't be collected (null = it can): same rule as the automatic check. */
export const socialFeedUnsupported = (acc: Pick<SocialAccount, 'platform' | 'instanceId'>) => autoCheckUnsupported(acc)?.replace('account_check.', 'feed.') ?? null;
/** Tracked accounts: Instagram (on the account's 采集手机) only. */
export const trackedFeedUnsupported = (acc: Pick<TrackedAccount, 'platform'>) => (acc.platform === 'instagram' && isPlatformEnabled('instagram') ? null : 'feed.unsupported_platform');

/** Why a collection of this account can't be queued now (an HttpError), else null. */
async function feedRefusal(kind: FeedKind, acc: SocialAccount | TrackedAccount): Promise<HttpError | null> {
  const why = kind === 'social' ? socialFeedUnsupported(acc as SocialAccount) : trackedFeedUnsupported(acc);
  if (why) return new HttpError(400, why === 'feed.no_device' ? '账号未绑定云手机，不能采集' : '该平台不支持云手机采集', why, { platform: acc.platform });
  if (kind === 'tracked') {
    const no = await trackedPhoneRefusal(acc as TrackedAccount);
    if (no && no.code !== 'tracked.collector_halted') return no; // halted: the shared feed.device_halted below
  }
  const instanceId = kind === 'social' ? (acc as SocialAccount).instanceId! : (acc as TrackedAccount).instanceId!;
  if (await deviceHalt(instanceId)) return conflict('设备遇到验证/限制页面已暂停自动操作，需管理员在云机管理的设备卡片上恢复', 'feed.device_halted');
  if (await unfinished(kind, acc.id)) return conflict('该账号已有采集在排队或进行中', 'feed.in_progress');
  return null;
}

const feedTask = (kind: FeedKind, acc: SocialAccount | TrackedAccount, userId: string | null, idempotencyKey?: string) => createTask({
  type: FEED_TYPE, userId, label: `${acc.platform} @${acc.handle}`, refType: feedRef(kind), refId: acc.id,
  payload: { kind, accountId: acc.id } satisfies Payload, ...(idempotencyKey ? { idempotencyKey } : {}),
});

/** 立即采集 (API only since the merged 同步 button): queues a collection now (coded refusals). */
export async function requestFeedCollect(user: AuthUser, kind: FeedKind, acc: SocialAccount | TrackedAccount) {
  const no = await feedRefusal(kind, acc);
  if (no) throw no;
  return (await feedTask(kind, acc, user.id)).task;
}

/**
 * 同步 = step 1 (social: 从云手机同步 sync.ts, tracked: the profile refresh) then step 2 (this collection). Called by
 * the step-1 task once it succeeded: queues the collection now (key `after:<step-1 task>`, so a redelivery never
 * queues it twice) or, when it can't run (no phone, 采集手机 unset / not the owner's, halted, already queued…), logs why. Step 2
 * runs as its own task: its failure never undoes step 1.
 */
export async function queueFeedAfter(kind: FeedKind, accountId: string, userId: string | null, parentTaskId: string, log: TaskContext['log']): Promise<{ taskId: string } | { code: string }> {
  const [acc]: (SocialAccount | TrackedAccount)[] = kind === 'social'
    ? await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, accountId))
    : await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, accountId));
  const code = !acc ? 'feed.account_gone' : (await feedRefusal(kind, acc))?.code;
  if (code || !acc) {
    await log('info', `feed collection not queued: ${code}`, { code });
    return { code: code ?? 'feed.account_gone' };
  }
  const { task } = await feedTask(kind, acc, userId, `after:${parentTaskId}`);
  await log('info', 'feed collection queued', { taskId: task.id });
  return { taskId: task.id };
}

// ---------------------------------------------------------------- writes

interface Written { posts: number; newPosts: number; comments: number; newComments: number }

async function writeSocial(acc: SocialAccount, r: FeedResult, now: Date): Promise<Written> {
  const out: Written = { posts: 0, newPosts: 0, comments: 0, newComments: 0 };
  const P = schema.socialAccountPosts;
  const C = schema.comments;
  await db.transaction(async (tx) => {
    for (const p of r.posts) {
      const set = {
        source: 'device' as const, caption: p.caption, permalink: p.url, mediaType: p.mediaType, publishedAt: p.publishedAt,
        likes: p.likes, comments: p.comments, approx: p.approx.length ? p.approx : null, fetchedAt: now,
        ...(p.commentRows ? { commentsFetchedAt: now } : {}),
      };
      const [row] = await tx.insert(P).values({ socialAccountId: acc.id, platform: acc.platform, externalId: p.pk, ...set })
        .onConflictDoUpdate({ target: [P.socialAccountId, P.externalId], set })
        .returning({ id: P.id, inserted: sql<boolean>`(xmax = 0)` });
      out.posts++;
      if (row?.inserted) out.newPosts++;
      for (const c of p.commentRows ?? []) {
        const [cr] = await tx.insert(C).values({
          userId: acc.userId, accountId: acc.id, platform: acc.platform, source: 'device', externalId: c.key, externalPostId: p.pk, postUrl: p.url,
          authorName: c.author, authorHandle: c.author, text: c.text, likeCount: c.likes, replyCount: c.replyCount, publishedAt: c.publishedAt, fetchedAt: now,
        }).onConflictDoUpdate({
          target: [C.accountId, C.externalId],
          set: { likeCount: c.likes, replyCount: sql`coalesce(${c.replyCount}, ${C.replyCount})`, fetchedAt: now, postUrl: p.url },
        }).returning({ inserted: sql<boolean>`(xmax = 0)` });
        out.comments++;
        if (cr?.inserted) out.newComments++;
      }
    }
    // Same link as entered comments: comments of a post the scheduler published (same external id).
    await tx.execute(sql`
      update comments c set publish_task_id = p.id from publish_tasks p
      where c.account_id = ${acc.id} and c.publish_task_id is null and c.external_post_id is not null
        and p.account_id = c.account_id and p.external_id = c.external_post_id and p.status = 'published'`);
  });
  return out;
}

async function writeTracked(acc: TrackedAccount, r: FeedResult, now: Date): Promise<Written> {
  const out: Written = { posts: 0, newPosts: 0, comments: 0, newComments: 0 };
  const P = schema.trackedPosts;
  const K = schema.trackedPostComments;
  await db.transaction(async (tx) => {
    for (const p of r.posts) {
      const set = {
        source: 'device' as const, url: p.url, title: p.caption, publishedAt: p.publishedAt, likes: p.likes, comments: p.comments, mediaType: p.mediaType,
        approx: p.approx.length ? p.approx : null, lastSeenAt: now, ...(p.commentRows ? { commentsFetchedAt: now } : {}),
      };
      const [row] = await tx.insert(P).values({ trackedAccountId: acc.id, externalId: p.pk, ...set })
        .onConflictDoUpdate({ target: [P.trackedAccountId, P.externalId], set })
        .returning({ id: P.id, inserted: sql<boolean>`(xmax = 0)` });
      out.posts++;
      if (row?.inserted) out.newPosts++;
      for (const c of p.commentRows ?? []) {
        const [cr] = await tx.insert(K).values({
          trackedPostId: row!.id, trackedAccountId: acc.id, externalId: c.key, authorHandle: c.author, text: c.text, likes: c.likes,
          replyCount: c.replyCount, position: c.position, publishedAt: c.publishedAt, firstSeenAt: now, lastSeenAt: now,
        }).onConflictDoUpdate({
          target: [K.trackedPostId, K.externalId],
          set: { likes: c.likes, replyCount: sql`coalesce(${c.replyCount}, ${K.replyCount})`, position: c.position, lastSeenAt: now },
        }).returning({ inserted: sql<boolean>`(xmax = 0)` });
        out.comments++;
        if (cr?.inserted) out.newComments++;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------- the task

async function run(ctx: TaskContext<Payload>): Promise<Record<string, unknown>> {
  const { kind } = ctx.payload;
  const id = ctx.payload.accountId ?? ctx.task.refId!;
  const skip = async (code: string) => { await ctx.log('info', `feed collection skipped: ${code}`, { code }); return { outcome: 'skipped', code }; };
  const settings = await getRiskSettings(true);
  if (ctx.payload.scheduled && settings.feedCollectHours === null) return skip('feed.schedule_off');

  let acc: SocialAccount | TrackedAccount | undefined;
  let inst: Instance | undefined;
  if (kind === 'social') {
    [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
    if (!acc) return skip('feed.account_gone');
    const why = socialFeedUnsupported(acc as SocialAccount);
    if (why) return skip(why);
    inst = await getInstance((acc as SocialAccount).instanceId!);
  } else {
    [acc] = await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, id));
    if (!acc) return skip('feed.account_gone');
    const why = trackedFeedUnsupported(acc);
    if (why) return skip(why);
    if ((acc as TrackedAccount).status === 'paused' && ctx.payload.scheduled) return skip('tracked.paused');
    const no = await trackedPhoneRefusal(acc as TrackedAccount);
    if (no && no.code !== 'tracked.collector_halted') return skip(no.code!);
    inst = await getInstance((acc as TrackedAccount).instanceId!);
  }
  if (!inst) return skip('feed.no_device');
  if (await deviceHalt(inst.id)) return skip('feed.device_halted');

  const risk = (code: string, detail?: string | null) => recordRiskEvent({
    instance: inst!, ...(kind === 'social' ? { socialAccountId: acc!.id } : { trackedAccountId: acc!.id }), source: 'feed', code, detail: detail ?? `@${acc!.handle}`, userId: ctx.task.createdBy,
  });
  const offline = () => new HttpError(503, `设备 ${inst!.name} 不在线`, 'feed.offline', { name: inst!.name });
  let r: FeedResult;
  try {
    r = await withDevice(inst, ctx.log, offline, (dev) => collectIgFeed(dev, acc!.handle, {
      posts: settings.feedPosts, commentsPerPost: settings.feedCommentsPerPost, log: ctx.log, signal: ctx.signal,
    }), { lockMs: 15 * 60_000, weight: settings.feedPosts + 2, what: 'feed' });
  } catch (err) {
    if (err instanceof CollectorDefer) {
      const deferrals = (ctx.payload.deferrals ?? 0) + 1;
      if (deferrals > MAX_DEFERRALS) throw new HttpError(409, err.message, err.code);
      const { task } = await createTask({
        type: FEED_TYPE, userId: ctx.task.createdBy, label: ctx.task.instanceName, refType: feedRef(kind), refId: acc.id,
        payload: { ...ctx.payload, deferrals }, runAt: err.runAt, idempotencyKey: `deferred:${ctx.task.id}`,
      });
      await ctx.log('info', `deferred: ${err.code}`, { code: err.code, runAt: err.runAt.toISOString(), taskId: task.id });
      return { outcome: 'deferred', code: err.code, runAt: err.runAt.toISOString(), taskId: task.id };
    }
    if (err instanceof FeedScreenError) {
      await ctx.log(err.kind === 'challenge' ? 'error' : 'warn', `feed collection failed: ${err.code}`, { code: err.code, ...(err.excerpt ? { excerpt: err.excerpt } : {}) });
      if (err.kind === 'challenge') {
        await haltDevice(inst, { code: err.code ?? 'feed.challenge', source: 'feed', platform: acc.platform, ...(kind === 'social' ? { socialAccountId: acc.id } : { trackedAccountId: acc.id }) });
      }
      if (err.kind !== 'unavailable') await risk(err.code ?? 'feed.failed');
    } else if ((err as { code?: string }).code === 'feed.app_missing') await risk('feed.app_missing');
    throw err;
  }
  const now = new Date();
  const w = kind === 'social' ? await writeSocial(acc as SocialAccount, r, now) : await writeTracked(acc as TrackedAccount, r, now);
  const result = { outcome: 'collected', ...w, postsOnProfile: r.postsCount, private: r.private, screens: r.screens, skipped: r.skipped };
  await ctx.log('info', `feed collected: ${w.posts} posts (${w.newPosts} new), ${w.comments} comments (${w.newComments} new)`, result);
  return result;
}

// New type on its own queue (a draining old leader never sees it). One attempt: the next slot or 立即采集 runs again.
registerTaskHandler<Payload>(FEED_TYPE, { queue: QUEUE, concurrency: 2, timeoutMs: 15 * 60_000, maxAttempts: 1, run });

/**
 * Hourly: every Instagram social account on a running, not halted phone and every scheduled (refresh on, not
 * paused) Instagram tracked account whose 采集手机 (set, the owner's) is running and not halted, once per feedCollectHours at a
 * fixed per-account offset; creates the slots falling into the next ~hour, key `feed:<kind>:<id>:<slot>`.
 */
export async function scheduleFeedCollects(now = new Date(), windowMs = 65 * 60_000): Promise<{ hours: number | null; created: number; skipped: number }> {
  const { feedCollectHours: hours } = await getRiskSettings(true);
  if (!hours || !isPlatformEnabled('instagram')) return { hours, created: 0, skipped: 0 };
  const period = hours * 3600_000;
  const halts = await deviceHalts();
  let skipped = 0;
  const sa = schema.socialAccounts;
  const social = await db.select({ id: sa.id, platform: sa.platform, handle: sa.handle, instanceId: sa.instanceId, status: schema.instances.status })
    .from(sa).innerJoin(schema.instances, eq(schema.instances.id, sa.instanceId))
    .where(and(eq(sa.platform, 'instagram'), isNotNull(sa.instanceId)));
  const ta = schema.trackedAccounts;
  const trackedRows = await db.select({ id: ta.id, platform: ta.platform, handle: ta.handle, userId: ta.userId, instanceId: ta.instanceId, status: schema.instances.status })
    .from(ta).innerJoin(schema.instances, eq(schema.instances.id, ta.instanceId))
    .where(and(eq(ta.platform, 'instagram'), isNotNull(ta.refreshIntervalHours), sql`${ta.status} <> 'paused'`));
  const allowed = await phonesAllowed(trackedRows);
  const tracked = trackedRows.filter((a) => {
    const ok = a.status === 'running' && !halts[a.instanceId!] && allowed.has(`${a.userId}:${a.instanceId}`);
    if (!ok) skipped++;
    return ok;
  });
  const from = now.getTime() - 5 * 60_000;
  let created = 0;
  const items: { kind: FeedKind; id: string; label: string }[] = [
    ...social.filter((a) => { const ok = a.status === 'running' && !halts[a.instanceId!]; if (!ok) skipped++; return ok; }).map((a) => ({ kind: 'social' as const, id: a.id, label: `${a.platform} @${a.handle}` })),
    ...tracked.map((a) => ({ kind: 'tracked' as const, id: a.id, label: `${a.platform} @${a.handle}` })),
  ];
  for (const it of items) {
    const offset = createHash('sha256').update(`feed:${it.id}`).digest().readUInt32BE(0) % period;
    for (let slot = Math.ceil((from - offset) / period); slot * period + offset < now.getTime() + windowMs; slot++) {
      const r = await createTask({
        type: FEED_TYPE, userId: null, label: it.label, refType: feedRef(it.kind), refId: it.id,
        payload: { kind: it.kind, accountId: it.id, scheduled: true } satisfies Payload, runAt: new Date(slot * period + offset), idempotencyKey: `feed:${it.kind}:${it.id}:${slot}`,
      });
      if (r.created) created++;
    }
  }
  return { hours, created, skipped };
}
