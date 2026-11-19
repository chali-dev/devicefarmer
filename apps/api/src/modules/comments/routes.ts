import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { COMMENT_REPLY_STATUSES, COMMENT_STATUSES, type Comment, type CommentTask } from '../../db/schema.js';
import { badRequest, forbidden, HttpError } from '../../lib/errors.js';
import { accessibleInstanceIds, isAdmin, type AuthUser } from '../auth/rbac.js';
import { visibleAccount } from '../social/social.js';
import { getVisibleAccount } from '../tracked/tracked.js';
import {
  assertTemplateWritable, cancelReply, createManualComment, createReply, deleteDraft, deleteManualComment, editReply, getRules, recordReplyOutcome,
  REPLY_REF, saveRules, setCommentStatus, submitReply, visibleComment, visibleReply, visibleTemplate,
} from './comments.js';
import { exampleWhere, MAX_EXAMPLES } from './persona-style.js';
import { assertPersonaFor } from './personas.js';

const C = schema.comments;
const R = schema.commentTasks;
const TPL = schema.commentTemplates;
const Id = z.object({ id: z.string().uuid() });
const NONE = '00000000-0000-0000-0000-000000000000';
const idsOf = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].concat(NONE);
const HttpUrl = z.string().trim().max(1000).regex(/^https?:\/\/\S+$/i, 'http(s) URL');
const csv = <E extends z.ZodType<string, string>>(item: E) => z.string().max(500).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(item).max(20));
const ReplyText = z.string().max(5000);
const When = z.string().datetime({ offset: true }).nullable().optional();
const at = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : new Date(s));
const like = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

function ownerWhere(col: typeof C.userId | typeof R.userId, user: AuthUser, ownerId?: string): SQL | undefined {
  if (isAdmin(user)) return ownerId ? eq(col, ownerId) : undefined;
  if (ownerId && ownerId !== user.id) throw forbidden('仅管理员可以查看其他用户的数据', 'comment.admin_only');
  return eq(col, user.id);
}

/** Replies with comment, account (+ device link) and per-viewer flags. */
export async function toReplyItems(rows: CommentTask[], viewer: AuthUser) {
  if (!rows.length) return [];
  const [comments, accs] = await Promise.all([
    db.select({ id: C.id, text: C.text, authorName: C.authorName, authorHandle: C.authorHandle, source: C.source, status: C.status, externalPostId: C.externalPostId,
      postUrl: C.postUrl, publishedAt: C.publishedAt, parentExternalId: C.parentExternalId }).from(C).where(inArray(C.id, idsOf(rows.map((r) => r.commentId)))),
    db.select({ id: schema.socialAccounts.id, handle: schema.socialAccounts.handle, platform: schema.socialAccounts.platform, instanceId: schema.socialAccounts.instanceId,
      userId: schema.socialAccounts.userId, personaId: schema.socialAccounts.personaId }).from(schema.socialAccounts).where(inArray(schema.socialAccounts.id, idsOf(rows.map((r) => r.accountId)))),
  ]);
  const posts = rows.some((r) => r.postId) ? await db.select({ id: schema.socialAccountPosts.id, caption: schema.socialAccountPosts.caption, permalink: schema.socialAccountPosts.permalink,
    publishedAt: schema.socialAccountPosts.publishedAt }).from(schema.socialAccountPosts).where(inArray(schema.socialAccountPosts.id, idsOf(rows.map((r) => r.postId)))) : [];
  // 评论追踪账号的帖子: the tracked post (+ its account's handle) and the tracked comment replied to
  const TP = schema.trackedPosts;
  const TK = schema.trackedPostComments;
  const tposts = rows.some((r) => r.trackedPostId) ? await db.select({ id: TP.id, trackedAccountId: TP.trackedAccountId, caption: TP.title, permalink: TP.url,
    publishedAt: TP.publishedAt, handle: schema.trackedAccounts.handle, platform: schema.trackedAccounts.platform })
    .from(TP).innerJoin(schema.trackedAccounts, eq(schema.trackedAccounts.id, TP.trackedAccountId)).where(inArray(TP.id, idsOf(rows.map((r) => r.trackedPostId)))) : [];
  const tcomments = rows.some((r) => r.trackedCommentId) ? await db.select({ id: TK.id, authorHandle: TK.authorHandle, text: TK.text })
    .from(TK).where(inArray(TK.id, idsOf(rows.map((r) => r.trackedCommentId)))) : [];
  const [insts, owners] = await Promise.all([
    db.select({ id: schema.instances.id, name: schema.instances.name, status: schema.instances.status, adbState: schema.instances.adbState })
      .from(schema.instances).where(inArray(schema.instances.id, idsOf(accs.map((a) => a.instanceId)))),
    db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, idsOf(rows.map((r) => r.userId)))),
  ]);
  const access = await accessibleInstanceIds(viewer);
  return rows.map((r) => {
    const acc = accs.find((a) => a.id === r.accountId);
    const inst = insts.find((i) => i.id === acc?.instanceId);
    return {
      ...r,
      textHash: undefined,
      // evidence: the storage key stays server-side; the screenshot is served by GET …/evidence
      evidence: r.evidence ? { at: r.evidence.at, inputText: r.evidence.inputText ?? null, excerpt: r.evidence.excerpt ?? null } : null,
      hasEvidence: !!r.evidence?.key,
      ownerName: owners.find((o) => o.id === r.userId)?.username ?? null,
      comment: comments.find((c) => c.id === r.commentId) ?? null,
      post: posts.find((p) => p.id === r.postId) ?? null,
      trackedPost: tposts.find((p) => p.id === r.trackedPostId) ?? null,
      /** null with `trackedCommentId` set = the comment is gone (a reply, never a post comment) */
      trackedComment: tcomments.find((c) => c.id === r.trackedCommentId) ?? null,
      account: acc ? { id: acc.id, handle: acc.handle, platform: acc.platform, personaId: acc.personaId } : null,
      instance: inst ? { ...inst, online: inst.status === 'running' && inst.adbState === 'device', accessible: access === 'all' || access.has(inst.id) } : null,
      canEdit: r.status === 'draft',
    };
  });
}

/** Latest reply of each comment. */
async function latestReplies(commentIds: string[]) {
  if (!commentIds.length) return new Map<string, CommentTask>();
  const rows = await db.select().from(R).where(inArray(R.commentId, commentIds)).orderBy(desc(R.createdAt));
  const out = new Map<string, CommentTask>();
  for (const r of rows) if (r.commentId && !out.has(r.commentId)) out.set(r.commentId, r);
  return out;
}

const replySummary = (r: CommentTask | undefined) => (r ? {
  id: r.id, status: r.status, text: r.text, method: r.method, errorCode: r.errorCode, error: r.error, authorName: r.authorName, sentAt: r.sentAt, updatedAt: r.updatedAt,
} : null);

async function toCommentItems(rows: Comment[]) {
  const accs = rows.length ? await db.select({ id: schema.socialAccounts.id, handle: schema.socialAccounts.handle, platform: schema.socialAccounts.platform, personaId: schema.socialAccounts.personaId })
    .from(schema.socialAccounts).where(inArray(schema.socialAccounts.id, idsOf(rows.map((r) => r.accountId)))) : [];
  const pubs = rows.some((r) => r.publishTaskId)
    ? await db.select({ id: schema.publishTasks.id, url: schema.publishTasks.url, title: schema.contents.title }).from(schema.publishTasks)
      .leftJoin(schema.contents, eq(schema.contents.id, schema.publishTasks.contentId)).where(inArray(schema.publishTasks.id, idsOf(rows.map((r) => r.publishTaskId))))
    : [];
  const replies = await latestReplies(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    account: accs.find((a) => a.id === r.accountId) ?? null,
    publishTask: pubs.find((p) => p.id === r.publishTaskId) ?? null,
    reply: replySummary(replies.get(r.id)),
  }));
}

const CommentQuery = z.object({
  accountId: z.string().uuid().optional(),
  platform: z.string().max(32).optional(),
  status: csv(z.enum(COMMENT_STATUSES)).optional(),
  source: z.enum(['api', 'manual', 'device']).optional(),
  postId: z.string().max(200).optional(),
  ownerId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const ReplyQuery = z.object({
  status: csv(z.enum(COMMENT_REPLY_STATUSES)).optional(),
  accountId: z.string().uuid().optional(),
  commentId: z.string().uuid().optional(),
  /** Replies on this tracked account's posts (追踪账号详情 · 回复记录); the tracked account must be visible (404). */
  trackedAccountId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Comments & engagement (评论互动): received comments (manual entry), reply tasks (no approval step since 2026-11-18),
 * anti-abuse rules, history, templates. Users see their own accounts' data only (404 otherwise).
 */
export const commentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // ------------------------------------------------------------ rules
  app.get('/api/comments/settings', async () => ({ rules: await getRules() }));
  app.put('/api/comments/settings', {
    schema: {
      body: z.object({
        duplicateMax: z.number().int().min(1).max(100).optional(),
        duplicateWindowHours: z.number().int().min(1).max(24 * 30).optional(),
        sendsPerHour: z.number().int().min(1).max(500).optional(),
        sendsPerDay: z.number().int().min(1).max(2000).optional(),
        minGapSec: z.number().int().min(0).max(86_400).optional(),
        /** Removed (test mode, 2026-11-18): an older page may still send it; accepted and ignored. */
        testMode: z.boolean().optional(),
      }).strict(),
    },
  }, async (req) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以修改评论规则', 'comment.admin_only');
    const { testMode: _removed, ...rules } = req.body;
    return { rules: await saveRules(rules) };
  });

  // ------------------------------------------------------------ accounts (filters, new-comment counts)
  app.get('/api/comments/accounts', async (req) => {
    const accs = await db.select().from(schema.socialAccounts)
      .where(isAdmin(req.user) ? undefined : eq(schema.socialAccounts.userId, req.user.id)).orderBy(asc(schema.socialAccounts.platform), asc(schema.socialAccounts.handle));
    const counts = await db.select({ accountId: C.accountId, n: count() }).from(C)
      .where(and(inArray(C.accountId, idsOf(accs.map((a) => a.id))), eq(C.status, 'new'))).groupBy(C.accountId);
    return {
      accounts: accs.map((a) => ({
        id: a.id, platform: a.platform, handle: a.handle, displayName: a.displayName, userId: a.userId, instanceId: a.instanceId,
        newCount: counts.find((c) => c.accountId === a.id)?.n ?? 0,
      })),
    };
  });

  /** Posts that have comments (filter), with the linked published content when known. */
  app.get('/api/comments/posts', { schema: { querystring: z.object({ accountId: z.string().uuid() }) } }, async (req) => {
    const acc = await visibleAccount(req.user, req.query.accountId);
    const rows = await db.select({ postId: C.externalPostId, postUrl: sql<string | null>`max(${C.postUrl})`, n: count(), latest: sql<Date>`max(${C.publishedAt})`,
      publishTaskId: sql<string | null>`(array_agg(${C.publishTaskId}) filter (where ${C.publishTaskId} is not null))[1]` })
      .from(C).where(and(eq(C.accountId, acc.id), sql`${C.externalPostId} is not null`)).groupBy(C.externalPostId).orderBy(desc(sql`max(${C.publishedAt})`)).limit(200);
    const pubs = await db.select({ id: schema.publishTasks.id, title: schema.contents.title }).from(schema.publishTasks)
      .leftJoin(schema.contents, eq(schema.contents.id, schema.publishTasks.contentId)).where(inArray(schema.publishTasks.id, idsOf(rows.map((r) => r.publishTaskId))));
    return { posts: rows.map((r) => ({ ...r, title: pubs.find((p) => p.id === r.publishTaskId)?.title ?? null })) };
  });

  // ------------------------------------------------------------ comments
  /** Threads: top-level comments (paginated) with their replies; filters match the thread's comments. */
  app.get('/api/comments', { schema: { querystring: CommentQuery } }, async (req) => {
    const q = req.query;
    const base: (SQL | undefined)[] = [ownerWhere(C.userId, req.user, q.ownerId)];
    if (q.accountId) base.push(eq(C.accountId, q.accountId));
    if (q.platform) base.push(eq(C.platform, q.platform));
    if (q.source) base.push(eq(C.source, q.source));
    if (q.postId) base.push(eq(C.externalPostId, q.postId));
    // Top level, or a reply whose parent was never fetched (shown as its own thread).
    base.push(sql`(${C.parentExternalId} is null or not exists (select 1 from comments p where p.account_id = ${C.accountId} and p.external_id = ${C.parentExternalId}))`);
    const filters: SQL[] = [];
    if (q.status?.length) {
      const list = sql.join(q.status.map((s) => sql`${s}`), sql`, `);
      filters.push(sql`(${C.status} in (${list}) or exists (select 1 from comments k where k.account_id = ${C.accountId} and k.parent_external_id = ${C.externalId} and k.status in (${list})))`);
    }
    if (q.q) {
      const l = like(q.q);
      filters.push(sql`(${C.text} ilike ${l} or ${C.authorName} ilike ${l} or ${C.authorHandle} ilike ${l}
        or exists (select 1 from comments k where k.account_id = ${C.accountId} and k.parent_external_id = ${C.externalId} and (k.text ilike ${l} or k.author_name ilike ${l})))`);
    }
    const cond = and(...base, ...filters);
    const [rows, [total], byStatus] = await Promise.all([
      db.select().from(C).where(cond).orderBy(desc(sql`coalesce(${C.publishedAt}, ${C.createdAt})`), desc(C.id)).limit(q.limit).offset(q.offset),
      db.select({ n: count() }).from(C).where(cond),
      db.select({ k: C.status, n: count() }).from(C).where(and(ownerWhere(C.userId, req.user, q.ownerId), q.accountId ? eq(C.accountId, q.accountId) : undefined)).groupBy(C.status),
    ]);
    const children = rows.length ? await db.select().from(C).where(or(...rows.map((r) => and(eq(C.accountId, r.accountId), eq(C.parentExternalId, r.externalId))))!)
      .orderBy(asc(sql`coalesce(${C.publishedAt}, ${C.createdAt})`)).limit(2000) : [];
    const all = await toCommentItems([...rows, ...children]);
    const items = all.slice(0, rows.length).map((r) => ({ ...r, children: all.slice(rows.length).filter((c) => c.accountId === r.accountId && c.parentExternalId === r.externalId) }));
    return { items, total: total?.n ?? 0, byStatus: Object.fromEntries(COMMENT_STATUSES.map((s) => [s, byStatus.find((x) => x.k === s)?.n ?? 0])) };
  });

  app.post('/api/comments', {
    schema: {
      body: z.object({
        accountId: z.string().uuid(),
        text: z.string().trim().min(1).max(10000),
        authorName: z.string().trim().min(1).max(200),
        authorHandle: z.string().trim().max(200).nullable().optional(),
        externalId: z.string().trim().max(200).nullable().optional(),
        parentId: z.string().uuid().nullable().optional(),
        externalPostId: z.string().trim().max(200).nullable().optional(),
        postUrl: HttpUrl.nullable().optional(),
        publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
      }),
    },
  }, async (req, reply) => {
    const c = await createManualComment(req.user, { ...req.body, publishedAt: at(req.body.publishedAt) ?? null });
    reply.code(201);
    return { comment: (await toCommentItems([c]))[0] };
  });

  /** Detail: the comment, its whole thread, every reply (history) and the log. */
  app.get('/api/comments/:id', { schema: { params: Id } }, async (req) => {
    const c = await visibleComment(req.user, req.params.id);
    const rootExt = c.parentExternalId ?? c.externalId;
    const thread = await db.select().from(C).where(and(eq(C.accountId, c.accountId), or(eq(C.externalId, rootExt), eq(C.parentExternalId, rootExt))))
      .orderBy(asc(sql`coalesce(${C.publishedAt}, ${C.createdAt})`)).limit(1000);
    const [replies, logs] = await Promise.all([
      db.select().from(R).where(eq(R.commentId, c.id)).orderBy(desc(R.createdAt)),
      db.select().from(schema.commentLogs).where(eq(schema.commentLogs.commentId, c.id)).orderBy(asc(schema.commentLogs.at)).limit(1000),
    ]);
    return { comment: (await toCommentItems([c]))[0], thread: await toCommentItems(thread), replies: await toReplyItems(replies, req.user), logs };
  });

  app.patch('/api/comments/:id', { schema: { params: Id, body: z.object({ status: z.enum(['new', 'read', 'hidden', 'ignored']) }) } }, async (req) => {
    const c = await visibleComment(req.user, req.params.id);
    return { comment: (await toCommentItems([await setCommentStatus(req.user, c, req.body.status)]))[0] };
  });

  app.delete('/api/comments/:id', { schema: { params: Id } }, async (req, reply) => {
    const c = await visibleComment(req.user, req.params.id);
    await deleteManualComment(req.user, c);
    reply.code(204);
  });

  /**
   * Write a reply to ONE comment (there is no bulk reply). Always saved as a draft (draft first, 2026-11-18): `submit`
   * of an older page is accepted and ignored; 排程 is POST /api/comment-replies/:id/submit.
   */
  app.post('/api/comments/:id/replies', {
    schema: { params: Id, body: z.object({ text: ReplyText, templateId: z.string().uuid().nullable().optional(), submit: z.boolean().optional(), scheduledAt: When }) },
  }, async (req, reply) => {
    const c = await visibleComment(req.user, req.params.id);
    const r = await createReply(req.user, c, { text: req.body.text, templateId: req.body.templateId, scheduledAt: at(req.body.scheduledAt) });
    if (req.audit) req.audit.extra = { replyId: r.id, status: r.status };
    reply.code(201);
    return { reply: (await toReplyItems([r], req.user))[0] };
  });

  // ------------------------------------------------------------ replies
  app.get('/api/comment-replies', { schema: { querystring: ReplyQuery } }, async (req) => {
    const q = req.query;
    const base: (SQL | undefined)[] = [ownerWhere(R.userId, req.user, q.ownerId)];
    if (q.accountId) base.push(eq(R.accountId, q.accountId));
    if (q.commentId) base.push(eq(R.commentId, q.commentId));
    if (q.trackedAccountId) {
      const ta = await getVisibleAccount(req.user, q.trackedAccountId);
      base.push(sql`${R.trackedPostId} in (select id from tracked_posts where tracked_account_id = ${ta.id})`);
    }
    if (q.q) {
      const l = like(q.q);
      base.push(or(ilike(R.text, l), ilike(R.authorName, l), ilike(R.reviewerName, l), ilike(R.error, l),
        sql`exists (select 1 from social_accounts s where s.id = ${R.accountId} and s.handle ilike ${l})`)!);
    }
    const cond = and(...base, q.status?.length ? inArray(R.status, q.status) : undefined);
    const [rows, [total], byStatus] = await Promise.all([
      db.select().from(R).where(cond).orderBy(desc(R.updatedAt), desc(R.id)).limit(q.limit).offset(q.offset),
      db.select({ n: count() }).from(R).where(cond),
      db.select({ k: R.status, n: count() }).from(R).where(and(...base)).groupBy(R.status),
    ]);
    return {
      items: await toReplyItems(rows, req.user), total: total?.n ?? 0,
      byStatus: Object.fromEntries(COMMENT_REPLY_STATUSES.map((s) => [s, byStatus.find((x) => x.k === s)?.n ?? 0])),
    };
  });

  app.get('/api/comment-replies/:id', { schema: { params: Id } }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    const [logs, runs] = await Promise.all([
      db.select().from(schema.commentLogs).where(eq(schema.commentLogs.commentTaskId, r.id)).orderBy(asc(schema.commentLogs.at)).limit(1000),
      db.select({ id: schema.tasks.id, status: schema.tasks.status, attempts: schema.tasks.attempts, maxAttempts: schema.tasks.maxAttempts, runAt: schema.tasks.runAt,
        idempotencyKey: schema.tasks.idempotencyKey, error: schema.tasks.error, errorCode: schema.tasks.errorCode, result: schema.tasks.result,
        createdAt: schema.tasks.createdAt, startedAt: schema.tasks.startedAt, finishedAt: schema.tasks.finishedAt })
        .from(schema.tasks).where(and(eq(schema.tasks.refType, REPLY_REF), eq(schema.tasks.refId, r.id))).orderBy(asc(schema.tasks.createdAt)),
    ]);
    return { reply: (await toReplyItems([r], req.user))[0], logs, runs };
  });

  app.patch('/api/comment-replies/:id', {
    schema: { params: Id, body: z.object({ text: ReplyText.optional(), templateId: z.string().uuid().nullable().optional(), scheduledAt: When }) },
  }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    return { reply: (await toReplyItems([await editReply(req.user, r, { ...req.body, scheduledAt: at(req.body.scheduledAt) })], req.user))[0] };
  });

  /** 排程: draft → scheduled at `scheduledAt` (null / past = now); the cloud phone (or an operator) sends it then. */
  app.post('/api/comment-replies/:id/submit', { schema: { params: Id, body: z.object({ scheduledAt: When }).nullish() } }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    const next = await submitReply(req.user, r, at(req.body?.scheduledAt));
    if (req.audit) req.audit.extra = { status: next.status, taskId: next.taskId };
    return { reply: (await toReplyItems([next], req.user))[0] };
  });

  /** Deletes a draft (only drafts: anything scheduled is cancelled instead, so its history stays). */
  app.delete('/api/comment-replies/:id', { schema: { params: Id } }, async (req, reply) => {
    const r = await visibleReply(req.user, req.params.id);
    await deleteDraft(req.user, r);
    reply.code(204);
  });

  app.post('/api/comment-replies/:id/cancel', { schema: { params: Id } }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    return { reply: (await toReplyItems([await cancelReply(req.user, r)], req.user))[0] };
  });

  app.post('/api/comment-replies/:id/outcome', {
    schema: { params: Id, body: z.object({ result: z.enum(['sent', 'failed']), reason: z.string().trim().max(1000).nullable().optional(), externalReplyId: z.string().trim().max(200).nullable().optional() }) },
  }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    return { reply: (await toReplyItems([await recordReplyOutcome(req.user, r, req.body)], req.user))[0] };
  });

  // ------------------------------------------------------------ templates (话术库: kind comment = reply templates, post = captions)
  /** Visible templates: own + shared (admins: all). `kind` defaults to comment so the reply composer is unchanged; `all` lists both. */
  const TemplateQuery = z.object({
    kind: z.enum(['comment', 'post', 'all']).default('comment'),
    /** persona id, or 'none' for templates without one */
    personaId: z.union([z.string().uuid(), z.literal('none')]).optional(),
    tag: z.string().trim().max(32).optional(),
    /** shared = 公共, own = the caller's 个人, all-users = every 个人 template the caller can see (admins: all users') */
    scope: z.enum(['own', 'shared', 'all-users']).optional(),
    q: z.string().trim().max(100).optional(),
  });
  const templateWhere = (user: AuthUser, q: Partial<z.infer<typeof TemplateQuery>>): SQL | undefined => and(
    isAdmin(user) ? undefined : or(isNull(TPL.userId), eq(TPL.userId, user.id)),
    q.kind && q.kind !== 'all' ? eq(TPL.kind, q.kind) : undefined,
    q.personaId === 'none' ? isNull(TPL.personaId) : q.personaId ? eq(TPL.personaId, q.personaId) : undefined,
    q.tag ? sql`${TPL.tags} @> array[${q.tag.toLowerCase()}]::text[]` : undefined,
    q.scope === 'shared' ? isNull(TPL.userId) : q.scope === 'own' ? eq(TPL.userId, user.id) : q.scope === 'all-users' ? isNotNull(TPL.userId) : undefined,
    q.q ? or(ilike(TPL.name, like(q.q)), ilike(TPL.text, like(q.q))) : undefined,
  );
  const P = schema.personas;
  /** Template row for the client: the persona as {id, name, description, ownerType, ownerId}; the legacy text is never returned. */
  const templateItem = (t: typeof TPL.$inferSelect, p: typeof P.$inferSelect | null, extra: Record<string, unknown> = {}) => {
    const { persona: _legacy, ...rest } = t;
    return { ...rest, shared: t.userId === null, persona: p ? { id: p.id, name: p.name, description: p.description, ownerType: p.ownerType, ownerId: p.ownerId } : null, ...extra };
  };
  app.get('/api/comment-templates', { schema: { querystring: TemplateQuery } }, async (req) => {
    const rows = await db.select({ t: TPL, p: P, owner: schema.users.username }).from(TPL).leftJoin(schema.users, eq(schema.users.id, TPL.userId))
      .leftJoin(P, eq(P.id, TPL.personaId)).where(templateWhere(req.user, req.query)).orderBy(asc(TPL.name));
    return { templates: rows.map((r) => templateItem(r.t, r.p, { ownerName: r.owner ?? null, writable: r.t.userId !== null || isAdmin(req.user) })) };
  });

  /** Tags in use among visible templates (filter suggestions; personas come from /api/personas). */
  app.get('/api/comment-templates/facets', { schema: { querystring: TemplateQuery.pick({ kind: true, scope: true }) } }, async (req) => {
    const tags = await db.selectDistinct({ t: sql<string>`unnest(${TPL.tags})` }).from(TPL).where(templateWhere(req.user, req.query)).orderBy(sql`1`).limit(500);
    return { tags: tags.map((t) => t.t) };
  });
  const personaOf = async (id: string | null | undefined) => (id ? (await db.select().from(P).where(eq(P.id, id)))[0] ?? null : null);

  const normTags = (tags: string[]) => [...new Set(tags.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const TemplateBody = z.object({
    name: z.string().trim().min(1).max(100), text: z.string().trim().min(1).max(5000),
    kind: z.enum(['comment', 'post']).optional(),
    /** required on create, null refused (`template.persona_required`); must fit the template's scope (assertPersonaFor) */
    personaId: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).transform(normTags).optional(),
  });
  /**
   * Every template belongs to a persona (owner decision 2026-11-18: the 话术库 page is gone, templates are the 范例 of
   * personas, edited in the persona form): no persona → 400 `template.persona_required`. At most `MAX_EXAMPLES` (20) per
   * persona and kind in the persona's own scope → 400 `persona.examples_full` (checked under a lock on the persona row).
   */
  const assertExampleRoom = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], personaId: string, kind: 'post' | 'comment', userId: string | null, exceptId?: string) => {
    const [p] = await tx.select().from(P).where(eq(P.id, personaId)).for('update');
    // 防并发: deleted since assertPersonaFor (人设 delete at the same time) → the same refusal instead of an FK error
    if (!p) throw badRequest('人设不存在或不能用于这条话术', 'persona.not_allowed');
    if (p.ownerType === 'public' ? userId !== null : userId !== p.ownerId) return; // not one of its 范例
    const [n] = await tx.select({ n: count() }).from(TPL).where(and(exampleWhere(p, kind), exceptId ? ne(TPL.id, exceptId) : undefined));
    if ((n?.n ?? 0) >= MAX_EXAMPLES) throw badRequest(`每个人设最多 ${MAX_EXAMPLES} 条${kind === 'post' ? '发文' : '评论'}范例`, 'persona.examples_full', { max: MAX_EXAMPLES, kind });
  };
  const personaRequired = () => badRequest('话术必须属于一个人设', 'template.persona_required');
  /** `ownerId` (admin): a private template of another user, e.g. an example (范例) of that user's personal persona. */
  app.post('/api/comment-templates', { schema: { body: TemplateBody.extend({ shared: z.boolean().optional(), ownerId: z.string().uuid().optional() }) } }, async (req, reply) => {
    const { shared, ownerId, ...b } = req.body;
    if ((shared || (ownerId && ownerId !== req.user.id)) && !isAdmin(req.user)) throw forbidden('只有管理员可以创建共享模板', 'comment.admin_only');
    if (!b.personaId) throw personaRequired();
    const personaId = b.personaId;
    const userId = shared ? null : ownerId ?? req.user.id;
    const p = await assertPersonaFor(userId, personaId);
    const row = await db.transaction(async (tx) => {
      await assertExampleRoom(tx, personaId, b.kind ?? 'comment', userId);
      return (await tx.insert(TPL).values({ ...b, userId, createdBy: req.user.id }).returning())[0]!;
    });
    if (req.audit) req.audit.extra = { id: row.id, kind: row.kind, persona: p.name };
    reply.code(201);
    return { template: templateItem(row, p) };
  });

  app.put('/api/comment-templates/:id', { schema: { params: Id, body: TemplateBody.partial() } }, async (req) => {
    const t = await visibleTemplate(req.user, req.params.id);
    assertTemplateWritable(req.user, t);
    const set: Partial<typeof TPL.$inferInsert> = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) throw new HttpError(400, 'nothing to update', 'common.nothing_to_update');
    if (req.body.personaId === null) throw personaRequired();
    if (req.body.personaId) await assertPersonaFor(t.userId, req.body.personaId);
    if (req.body.personaId !== undefined) set.persona = null; // legacy text, see persona-data-migration.ts
    const personaId = req.body.personaId ?? t.personaId;
    const kind = req.body.kind ?? t.kind;
    const moves = personaId !== t.personaId || kind !== t.kind;
    const row = await db.transaction(async (tx) => {
      if (moves && personaId) await assertExampleRoom(tx, personaId, kind, t.userId, t.id);
      return (await tx.update(TPL).set(set).where(eq(TPL.id, t.id)).returning())[0]!;
    });
    const p = await personaOf(row.personaId);
    if (req.audit && req.body.personaId !== undefined) req.audit.extra = { persona: p?.name ?? null };
    return { template: templateItem(row, p) };
  });

  app.delete('/api/comment-templates/:id', { schema: { params: Id } }, async (req, reply) => {
    const t = await visibleTemplate(req.user, req.params.id);
    assertTemplateWritable(req.user, t);
    await db.delete(TPL).where(eq(TPL.id, t.id));
    reply.code(204);
  });
};
