import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Comment, CommentTask, Task } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { createPostComment, createTrackedComment, getRules, replyAccountFor, visibleReply } from '../comments/comments.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { platformById } from '../social/platforms.js';
import { getRiskSettings } from '../risk/settings.js';
import { storageFor } from '../settings/storage.js';
import { visibleAccount } from '../social/social.js';
import { collectorEntry, deviceHalt } from '../tracked/collector.js';
import { getVisibleAccount } from '../tracked/tracked.js';
import { FEED_TYPE, feedRef, requestFeedCollect, socialFeedUnsupported, trackedFeedUnsupported, type FeedKind } from './collect.js';

/**
 * 帖子与评论 (account feed) API. RBAC = the account's module: social accounts (owner + admins, others 404),
 * tracked accounts (owner + admins, others 404). One response per detail drawer: 动态 (activity), 帖子 (posts,
 * paged, each with its first comments) and the collection state; more comments of one post are paged separately.
 */
const Id = z.object({ id: z.string().uuid() });
const PostParams = z.object({ id: z.string().uuid(), postId: z.string().uuid() });
const FeedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  /** Comments returned with each post (more via …/posts/:postId/comments). */
  comments: z.coerce.number().int().min(0).max(100).default(10),
});
const Page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) });
const ACTIVITY_LIMIT = 60;

/** Newest feed-collect tasks of an account (the last one + running state + activity rows). */
async function collectRuns(kind: FeedKind, accountId: string, limit = 20): Promise<Task[]> {
  return db.select().from(schema.tasks).where(and(eq(schema.tasks.type, FEED_TYPE), eq(schema.tasks.refType, feedRef(kind)), eq(schema.tasks.refId, accountId)))
    .orderBy(desc(schema.tasks.createdAt)).limit(limit);
}

const runView = (t: Task | undefined) => (t ? {
  taskId: t.id, status: t.status, at: (t.finishedAt ?? t.runAt ?? t.createdAt), errorCode: t.errorCode,
  result: (t.result ?? null) as Record<string, unknown> | null,
} : null);

/** collection state for the drawer header. */
async function collectState(kind: FeedKind, unsupported: string | null, instanceId: string | null, runs: Task[]) {
  const s = await getRiskSettings();
  const open = runs.find((t) => ['pending', 'scheduled', 'running'].includes(t.status));
  // deferred attempts finish "success" with outcome deferred: the last real result is the newest other one
  const last = runs.find((t) => ['success', 'failed'].includes(t.status) && (t.result as { outcome?: string } | null)?.outcome !== 'deferred');
  return {
    unsupported,
    instanceId,
    halted: instanceId ? !!(await deviceHalt(instanceId)) : false,
    settings: { hours: s.feedCollectHours, posts: s.feedPosts, commentsPerPost: s.feedCommentsPerPost },
    last: runView(last),
    pending: open ? { taskId: open.id, status: open.status, runAt: open.runAt } : null,
    kind,
  };
}

const collectActivity = (runs: Task[]) => runs
  .filter((t) => ['success', 'failed'].includes(t.status) && (t.result as { outcome?: string } | null)?.outcome !== 'deferred')
  .map((t) => {
    const r = (t.result ?? {}) as Record<string, number | string | null>;
    return { type: 'collect' as const, at: (t.finishedAt ?? t.createdAt).toISOString(), status: t.status, errorCode: t.errorCode ?? (typeof r.code === 'string' ? r.code : null), outcome: r.outcome ?? null,
      posts: r.posts ?? null, newPosts: r.newPosts ?? null, comments: r.comments ?? null, newComments: r.newComments ?? null };
  });

type Counters = { followers: number | null; following: number | null; posts: number | null };
/** Counter readings oldest → newest turned into activity rows with the change vs. the previous reading. */
function counterActivity(rows: (Counters & { at: Date; approx: string[] | null; source: string })[]) {
  const out = [];
  let prev: Counters | null = null;
  for (const r of rows) {
    const d = (k: keyof Counters) => (prev && prev[k] !== null && r[k] !== null ? r[k]! - prev[k]! : null);
    out.push({ type: 'stats' as const, at: r.at.toISOString(), followers: r.followers, following: r.following, posts: r.posts, approx: r.approx ?? [], source: r.source,
      delta: { followers: d('followers'), following: d('following'), posts: d('posts') } });
    prev = r;
  }
  return out;
}

const byTimeDesc = <T extends { at: string }>(xs: T[]) => xs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, ACTIVITY_LIMIT);

// ---------------------------------------------------------------- social: comments of posts

const C = schema.comments;
const R = schema.commentTasks;

const replySummary = (r: CommentTask | undefined) => (r ? {
  id: r.id, status: r.status, text: r.text, method: r.method, scheduledAt: r.scheduledAt, sentAt: r.sentAt, handedAt: r.handedAt,
  errorCode: r.errorCode, error: r.error, authorName: r.authorName, hasEvidence: !!r.evidence?.key, updatedAt: r.updatedAt,
} : null);

/** Top-level comments of one post (newest first) with their replies (threads) and the latest reply task of each. */
async function socialPostComments(accountId: string, externalPostId: string, limit: number, offset: number) {
  const cond = and(eq(C.accountId, accountId), eq(C.externalPostId, externalPostId), isNull(C.parentExternalId), sql`${C.status} <> 'hidden'`);
  const [rows, [total]] = await Promise.all([
    db.select().from(C).where(cond).orderBy(desc(sql`coalesce(${C.publishedAt}, ${C.createdAt})`), asc(C.id)).limit(limit).offset(offset),
    db.select({ n: count() }).from(C).where(cond),
  ]);
  const children = rows.length ? await db.select().from(C).where(and(eq(C.accountId, accountId), inArray(C.parentExternalId, rows.map((r) => r.externalId))))
    .orderBy(asc(sql`coalesce(${C.publishedAt}, ${C.createdAt})`)) : [];
  const all = [...rows, ...children];
  const replies = all.length ? await db.select().from(R).where(inArray(R.commentId, all.map((c) => c.id))).orderBy(desc(R.createdAt)) : [];
  const latest = new Map<string, CommentTask>();
  for (const r of replies) if (r.commentId && !latest.has(r.commentId)) latest.set(r.commentId, r);
  const view = (c: Comment) => ({
    id: c.id, source: c.source, authorName: c.authorName, authorHandle: c.authorHandle, text: c.text, likeCount: c.likeCount, replyCount: c.replyCount,
    publishedAt: c.publishedAt, status: c.status, fetchedAt: c.fetchedAt, reply: replySummary(latest.get(c.id)),
  });
  return {
    items: rows.map((r) => ({ ...view(r), children: children.filter((k) => k.parentExternalId === r.externalId).map(view) })),
    total: total?.n ?? 0,
  };
}

// ---------------------------------------------------------------- tracked: comments of posts

const K = schema.trackedPostComments;
/**
 * Own replies on a tracked account's posts the viewer may see: users only their own accounts' (the tracked account is
 * theirs, but an admin may have used another user's account on it: that account stays hidden), admins all.
 */
const ownReplies = (viewer: AuthUser) => (isAdmin(viewer) ? undefined : eq(R.userId, viewer.id));

async function trackedPostComments(viewer: AuthUser, postId: string, limit: number, offset: number) {
  const [rows, [total]] = await Promise.all([
    db.select().from(K).where(eq(K.trackedPostId, postId)).orderBy(asc(sql`coalesce(${K.position}, 1000000)`), asc(K.firstSeenAt), asc(K.id)).limit(limit).offset(offset),
    db.select({ n: count() }).from(K).where(eq(K.trackedPostId, postId)),
  ]);
  const replies = rows.length ? await db.select().from(R).where(and(inArray(R.trackedCommentId, rows.map((c) => c.id)), ownReplies(viewer))).orderBy(desc(R.createdAt)) : [];
  const latest = new Map<string, CommentTask>();
  for (const r of replies) if (r.trackedCommentId && !latest.has(r.trackedCommentId)) latest.set(r.trackedCommentId, r);
  return {
    items: rows.map((c) => ({ id: c.id, authorHandle: c.authorHandle, text: c.text, likeCount: c.likes, replyCount: c.replyCount, publishedAt: c.publishedAt, firstSeenAt: c.firstSeenAt,
      lastSeenAt: c.lastSeenAt, reply: replySummary(latest.get(c.id)) })),
    total: total?.n ?? 0,
  };
}

/** Body of a comment / reply on a tracked post: which own account sends it, the text, when (null = now). */
const TrackedCommentBody = z.object({ accountId: z.string().uuid(), text: z.string().max(2200), scheduledAt: z.string().datetime({ offset: true }).nullable().optional() });
const TrackedCommentParams = PostParams.extend({ commentId: z.string().uuid() });

async function trackedPostOf(user: AuthUser, id: string, postId: string) {
  const acc = await getVisibleAccount(user, id);
  const [p] = await db.select().from(schema.trackedPosts).where(and(eq(schema.trackedPosts.id, postId), eq(schema.trackedPosts.trackedAccountId, acc.id)));
  if (!p) throw notFound('帖子不存在', 'feed.post_not_found');
  return { acc, post: p };
}

export const feedRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // ------------------------------------------------------------ social accounts (社交号)
  app.get('/api/social/accounts/:id/feed', { schema: { params: Id, querystring: FeedQuery } }, async (req) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const q = req.query;
    const P = schema.socialAccountPosts;
    const [runs, rules, posts, [ptotal], stats, newPosts, replies] = await Promise.all([
      collectRuns('social', acc.id),
      getRules(),
      db.select().from(P).where(eq(P.socialAccountId, acc.id)).orderBy(desc(sql`coalesce(${P.publishedAt}, ${P.firstSeenAt})`), desc(P.id)).limit(q.limit).offset(q.offset),
      db.select({ n: count() }).from(P).where(eq(P.socialAccountId, acc.id)),
      db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, acc.id)).orderBy(desc(schema.socialAccountStats.day)).limit(30),
      db.select({ id: P.id, caption: P.caption, publishedAt: P.publishedAt, firstSeenAt: P.firstSeenAt, permalink: P.permalink }).from(P)
        .where(eq(P.socialAccountId, acc.id)).orderBy(desc(P.firstSeenAt)).limit(20),
      db.select().from(R).where(and(eq(R.accountId, acc.id), inArray(R.status, ['sent', 'dry_run', 'failed']))).orderBy(desc(R.updatedAt)).limit(20),
    ]);
    const items = await Promise.all(posts.map(async (p) => {
      const [comments, postReplies] = await Promise.all([
        q.comments > 0 ? socialPostComments(acc.id, p.externalId, q.comments, 0) : socialPostComments(acc.id, p.externalId, 1, 0).then((x) => ({ items: [], total: x.total })),
        db.select().from(R).where(eq(R.postId, p.id)).orderBy(desc(R.createdAt)).limit(10),
      ]);
      return {
        id: p.id, externalId: p.externalId, source: p.source, permalink: p.permalink, caption: p.caption, mediaType: p.mediaType, productType: p.productType,
        publishedAt: p.publishedAt, likes: p.likes, comments: p.comments, approx: p.approx ?? [], firstSeenAt: p.firstSeenAt, fetchedAt: p.fetchedAt,
        commentsFetchedAt: p.commentsFetchedAt, commentRows: comments.items, commentsTotal: comments.total, postComments: postReplies.map(replySummary),
      };
    }));
    const activity = byTimeDesc([
      ...counterActivity(stats.reverse().map((s) => ({ at: s.capturedAt, followers: s.followers, following: s.following, posts: s.posts, approx: s.approx, source: s.source }))),
      ...newPosts.map((p) => ({ type: 'post' as const, at: p.firstSeenAt.toISOString(), postId: p.id, caption: p.caption, publishedAt: p.publishedAt, permalink: p.permalink })),
      ...collectActivity(runs),
      ...replies.map((r) => ({ type: 'reply' as const, at: (r.sentAt ?? r.handedAt ?? r.updatedAt).toISOString(), status: r.status, text: r.text, errorCode: r.errorCode, replyId: r.id })),
    ]);
    const unsupported = socialFeedUnsupported(acc);
    return {
      account: { id: acc.id, platform: acc.platform, handle: acc.handle, instanceId: acc.instanceId, userId: acc.userId },
      collect: await collectState('social', unsupported, acc.instanceId, runs),
      send: { testMode: rules.testMode, deviceCapable: !unsupported },
      activity,
      posts: { items, total: ptotal?.n ?? 0 },
    };
  });

  app.get('/api/social/accounts/:id/posts/:postId/comments', { schema: { params: PostParams, querystring: Page } }, async (req) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const [p] = await db.select().from(schema.socialAccountPosts).where(and(eq(schema.socialAccountPosts.id, req.params.postId), eq(schema.socialAccountPosts.socialAccountId, acc.id)));
    if (!p) throw notFound('帖子不存在', 'feed.post_not_found');
    return socialPostComments(acc.id, p.externalId, req.query.limit, req.query.offset);
  });

  /** 评论 directly under one of the account's posts: written by a person, scheduled (default now), sent from the cloud phone. */
  app.post('/api/social/accounts/:id/posts/:postId/comments', {
    schema: { params: PostParams, body: z.object({ text: z.string().max(2200), scheduledAt: z.string().datetime({ offset: true }).nullable().optional() }) },
  }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const r = await createPostComment(req.user, acc, req.params.postId, { text: req.body.text, scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : null });
    if (req.audit) req.audit.extra = { replyId: r.id, status: r.status };
    reply.code(201);
    return { reply: replySummary(r) };
  });

  app.post('/api/social/accounts/:id/collect', { schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const task = await requestFeedCollect(req.user, 'social', acc);
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  // ------------------------------------------------------------ tracked accounts (追踪账号, read only)
  app.get('/api/tracked-accounts/:id/feed', { schema: { params: Id, querystring: FeedQuery } }, async (req) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const q = req.query;
    const P = schema.trackedPosts;
    const [runs, posts, [ptotal], snaps, newPosts, rules, replies] = await Promise.all([
      collectRuns('tracked', acc.id),
      db.select().from(P).where(eq(P.trackedAccountId, acc.id)).orderBy(desc(sql`coalesce(${P.publishedAt}, ${P.firstSeenAt})`), desc(P.id)).limit(q.limit).offset(q.offset),
      db.select({ n: count() }).from(P).where(eq(P.trackedAccountId, acc.id)),
      db.select().from(schema.trackedAccountSnapshots).where(eq(schema.trackedAccountSnapshots.trackedAccountId, acc.id)).orderBy(desc(schema.trackedAccountSnapshots.capturedAt)).limit(30),
      db.select({ id: P.id, title: P.title, publishedAt: P.publishedAt, firstSeenAt: P.firstSeenAt, url: P.url }).from(P)
        .where(eq(P.trackedAccountId, acc.id)).orderBy(desc(P.firstSeenAt)).limit(20),
      getRules(),
      db.select({ r: R }).from(R).innerJoin(P, eq(P.id, R.trackedPostId))
        .where(and(eq(P.trackedAccountId, acc.id), inArray(R.status, ['sent', 'dry_run', 'failed']), ownReplies(req.user))).orderBy(desc(R.updatedAt)).limit(20),
    ]);
    const items = await Promise.all(posts.map(async (p) => {
      const [comments, postReplies] = await Promise.all([
        trackedPostComments(req.user, p.id, q.comments, 0),
        db.select().from(R).where(and(eq(R.trackedPostId, p.id), isNull(R.trackedCommentId), ownReplies(req.user))).orderBy(desc(R.createdAt)).limit(10),
      ]);
      return {
        id: p.id, externalId: p.externalId, source: p.source, permalink: p.url, caption: p.title, mediaType: p.mediaType, publishedAt: p.publishedAt,
        likes: p.likes, comments: p.comments, views: p.views, approx: p.approx ?? [], firstSeenAt: p.firstSeenAt, fetchedAt: p.lastSeenAt,
        commentsFetchedAt: p.commentsFetchedAt, commentRows: comments.items, commentsTotal: comments.total, postComments: postReplies.map(replySummary),
      };
    }));
    const activity = byTimeDesc([
      ...counterActivity(snaps.reverse().map((s) => ({ at: s.capturedAt, followers: s.followers, following: s.following, posts: s.posts, approx: s.approx, source: s.source }))),
      ...newPosts.map((p) => ({ type: 'post' as const, at: p.firstSeenAt.toISOString(), postId: p.id, caption: p.title, publishedAt: p.publishedAt, permalink: p.url })),
      ...collectActivity(runs),
      ...replies.map(({ r }) => ({ type: 'reply' as const, at: (r.sentAt ?? r.handedAt ?? r.updatedAt).toISOString(), status: r.status, text: r.text, errorCode: r.errorCode, replyId: r.id })),
    ]);
    const unsupported = trackedFeedUnsupported(acc);
    return {
      account: { id: acc.id, platform: acc.platform, handle: acc.handle, userId: acc.userId },
      collect: await collectState('tracked', unsupported, (await collectorEntry('instagram'))?.instanceId ?? null, runs),
      // 评论 / 回复 with an own account's cloud phone (platforms the phone can send on)
      send: { testMode: rules.testMode, deviceCapable: !!platformById(acc.platform)?.deviceCheck && isPlatformEnabled(acc.platform) },
      activity,
      posts: { items, total: ptotal?.n ?? 0 },
    };
  });

  app.get('/api/tracked-accounts/:id/posts/:postId/comments', { schema: { params: PostParams, querystring: Page } }, async (req) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const [p] = await db.select({ id: schema.trackedPosts.id }).from(schema.trackedPosts).where(and(eq(schema.trackedPosts.id, req.params.postId), eq(schema.trackedPosts.trackedAccountId, acc.id)));
    if (!p) throw notFound('帖子不存在', 'feed.post_not_found');
    return trackedPostComments(req.user, p.id, req.query.limit, req.query.offset);
  });

  /**
   * Own accounts that may comment on this tracked account's posts: the caller's (admins: everyone's, with the owner),
   * same platform, linked to a cloud phone. `halted` = the phone is paused by 风控 (replies wait until resumed).
   */
  app.get('/api/tracked-accounts/:id/reply-accounts', { schema: { params: Id } }, async (req) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const S = schema.socialAccounts;
    if (!platformById(acc.platform)?.deviceCheck || !isPlatformEnabled(acc.platform)) return { items: [] };
    const rows = await db.select({ s: S, inst: { id: schema.instances.id, name: schema.instances.name, status: schema.instances.status, adbState: schema.instances.adbState }, owner: schema.users.username })
      .from(S).innerJoin(schema.instances, eq(schema.instances.id, S.instanceId)).leftJoin(schema.users, eq(schema.users.id, S.userId))
      .where(and(eq(S.platform, acc.platform), isAdmin(req.user) ? undefined : eq(S.userId, req.user.id)))
      .orderBy(asc(schema.users.username), asc(S.handle));
    return {
      items: await Promise.all(rows.map(async ({ s, inst, owner }) => ({
        id: s.id, platform: s.platform, handle: s.handle, displayName: s.displayName, accountStatus: s.accountStatus, loginStatus: s.loginStatus,
        userId: s.userId, ownerName: owner ?? null, own: s.userId === req.user.id,
        instance: { id: inst.id, name: inst.name, online: inst.status === 'running' && inst.adbState === 'device', halted: !!(await deviceHalt(inst.id)) },
      }))),
    };
  });

  /** 评论 under a tracked account's post with one own account (sent from that account's cloud phone, default now). */
  app.post('/api/tracked-accounts/:id/posts/:postId/comments', { schema: { params: PostParams, body: TrackedCommentBody } }, async (req, reply) => {
    const { acc, post } = await trackedPostOf(req.user, req.params.id, req.params.postId);
    const own = await replyAccountFor(req.user, req.body.accountId, acc.platform);
    const r = await createTrackedComment(req.user, own, post, null, { text: req.body.text, scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : null });
    if (req.audit) req.audit.extra = { replyId: r.id, status: r.status };
    reply.code(201);
    return { reply: replySummary(r) };
  });

  /** 回复 one (top-level) comment under a tracked account's post with one own account. */
  app.post('/api/tracked-accounts/:id/posts/:postId/comments/:commentId/replies', { schema: { params: TrackedCommentParams, body: TrackedCommentBody } }, async (req, reply) => {
    const { acc, post } = await trackedPostOf(req.user, req.params.id, req.params.postId);
    const [comment] = await db.select().from(K).where(and(eq(K.id, req.params.commentId), eq(K.trackedPostId, post.id)));
    if (!comment) throw notFound('评论不存在', 'comment.not_found');
    const own = await replyAccountFor(req.user, req.body.accountId, acc.platform);
    const r = await createTrackedComment(req.user, own, post, comment, { text: req.body.text, scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : null });
    if (req.audit) req.audit.extra = { replyId: r.id, status: r.status };
    reply.code(201);
    return { reply: replySummary(r) };
  });

  app.post('/api/tracked-accounts/:id/collect', { schema: { params: Id } }, async (req, reply) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const task = await requestFeedCollect(req.user, 'tracked', acc);
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  // ------------------------------------------------------------ evidence of a device send / test run
  app.get('/api/comment-replies/:id/evidence', { schema: { params: Id } }, async (req, reply) => {
    const r = await visibleReply(req.user, req.params.id);
    const ev = r.evidence;
    if (!ev?.key || (ev.storage !== 'local' && ev.storage !== 's3')) throw notFound('没有截图', 'comment.no_evidence');
    const stream = await (await storageFor(ev.storage)).getStream(ev.key).catch(() => { throw notFound('截图已不存在', 'comment.no_evidence'); });
    reply.header('content-type', 'image/png').header('cache-control', 'private, no-store');
    return reply.send(stream);
  });
};
