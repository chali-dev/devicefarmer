import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { COMMENT_REPLY_STATUSES, COMMENT_STATUSES, type Comment, type CommentTask } from '../../db/schema.js';
import { forbidden, HttpError } from '../../lib/errors.js';
import { accessibleInstanceIds, isAdmin, type AuthUser } from '../auth/rbac.js';
import { platformCapabilities } from '../platforms/service.js';
import { visibleAccount } from '../social/social.js';
import {
  approveReply, assertTemplateWritable, cancelReply, createManualComment, createReply, deleteManualComment, editReply, getRules, readMode, recordReplyOutcome,
  rejectReply, REPLY_REF, replyMode, saveRules, setCommentStatus, startSync, submitReply, visibleComment, visibleReply, visibleTemplate,
} from './comments.js';

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
      userId: schema.socialAccounts.userId }).from(schema.socialAccounts).where(inArray(schema.socialAccounts.id, idsOf(rows.map((r) => r.accountId)))),
  ]);
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
      ownerName: owners.find((o) => o.id === r.userId)?.username ?? null,
      comment: comments.find((c) => c.id === r.commentId) ?? null,
      account: acc ? { id: acc.id, handle: acc.handle, platform: acc.platform } : null,
      instance: inst ? { ...inst, online: inst.status === 'running' && inst.adbState === 'device', accessible: access === 'all' || access.has(inst.id) } : null,
      canReview: r.status === 'pending_review' && (isAdmin(viewer) || r.authorId !== viewer.id),
      canEdit: r.status === 'draft' || (r.status === 'pending_review' && (isAdmin(viewer) || r.authorId === viewer.id)),
    };
  });
}

/** Latest reply of each comment. */
async function latestReplies(commentIds: string[]) {
  if (!commentIds.length) return new Map<string, CommentTask>();
  const rows = await db.select().from(R).where(inArray(R.commentId, commentIds)).orderBy(desc(R.createdAt));
  const out = new Map<string, CommentTask>();
  for (const r of rows) if (!out.has(r.commentId)) out.set(r.commentId, r);
  return out;
}

const replySummary = (r: CommentTask | undefined) => (r ? {
  id: r.id, status: r.status, text: r.text, method: r.method, errorCode: r.errorCode, error: r.error, authorName: r.authorName, sentAt: r.sentAt, updatedAt: r.updatedAt,
} : null);

async function toCommentItems(rows: Comment[]) {
  const accs = rows.length ? await db.select({ id: schema.socialAccounts.id, handle: schema.socialAccounts.handle, platform: schema.socialAccounts.platform })
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
  source: z.enum(['api', 'manual']).optional(),
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
  ownerId: z.string().uuid().optional(),
  /** Only replies the caller may review (review queue). */
  reviewable: z.coerce.boolean().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Comments & engagement (评论互动): received comments (sync / manual entry), reply tasks with review,
 * anti-abuse rules, history, templates. Users see their own accounts' data only (404 otherwise).
 */
export const commentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // ------------------------------------------------------------ rules
  app.get('/api/comments/settings', async () => ({ rules: await getRules() }));
  app.put('/api/comments/settings', {
    schema: {
      body: z.object({
        requireApproval: z.boolean().optional(),
        duplicateMax: z.number().int().min(1).max(100).optional(),
        duplicateWindowHours: z.number().int().min(1).max(24 * 30).optional(),
        sendsPerHour: z.number().int().min(1).max(500).optional(),
      }).strict(),
    },
  }, async (req) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以修改评论规则', 'comment.admin_only');
    return { rules: await saveRules(req.body) };
  });

  // ------------------------------------------------------------ accounts (filters, sync status, modes)
  app.get('/api/comments/accounts', async (req) => {
    const accs = await db.select().from(schema.socialAccounts)
      .where(isAdmin(req.user) ? undefined : eq(schema.socialAccounts.userId, req.user.id)).orderBy(asc(schema.socialAccounts.platform), asc(schema.socialAccounts.handle));
    const ids = idsOf(accs.map((a) => a.id));
    const [states, counts] = await Promise.all([
      db.select().from(schema.commentSyncStates).where(inArray(schema.commentSyncStates.accountId, ids)),
      db.select({ accountId: C.accountId, n: count() }).from(C).where(and(inArray(C.accountId, ids), eq(C.status, 'new'))).groupBy(C.accountId),
    ]);
    const tasks = await db.select({ id: schema.tasks.id, status: schema.tasks.status, errorCode: schema.tasks.errorCode, finishedAt: schema.tasks.finishedAt })
      .from(schema.tasks).where(inArray(schema.tasks.id, idsOf(states.map((s) => s.lastTaskId))));
    const caps = new Map<string, Awaited<ReturnType<typeof platformCapabilities>>>();
    for (const p of new Set(accs.map((a) => a.platform))) caps.set(p, await platformCapabilities(p));
    return {
      accounts: await Promise.all(accs.map(async (a) => {
        const st = states.find((s) => s.accountId === a.id);
        const read = await readMode(a);
        const reply = await replyMode(a, { source: 'api' });
        return {
          id: a.id, platform: a.platform, handle: a.handle, displayName: a.displayName, userId: a.userId, instanceId: a.instanceId,
          commentsRead: !!caps.get(a.platform)?.commentsRead, commentsReply: !!caps.get(a.platform)?.commentsReply,
          readMode: read.mode, readReason: read.reason, replyMode: reply.mode, replyReason: reply.reason,
          newCount: counts.find((c) => c.accountId === a.id)?.n ?? 0,
          sync: st ? { lastSyncedAt: st.lastSyncedAt, lastFetched: st.lastFetched, lastNew: st.lastNew, lastError: st.lastError, lastErrorCode: st.lastErrorCode,
            task: tasks.find((t) => t.id === st.lastTaskId) ?? null } : null,
        };
      })),
    };
  });

  app.post('/api/comments/accounts/:id/sync', { schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const { task, created } = await startSync(req.user, acc);
    if (req.audit) req.audit.extra = { taskId: task.id, created };
    reply.code(202);
    return { taskId: task.id, created, status: task.status };
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
    const [replies, logs, acc] = await Promise.all([
      db.select().from(R).where(eq(R.commentId, c.id)).orderBy(desc(R.createdAt)),
      db.select().from(schema.commentLogs).where(eq(schema.commentLogs.commentId, c.id)).orderBy(asc(schema.commentLogs.at)).limit(1000),
      visibleAccount(req.user, c.accountId),
    ]);
    return {
      comment: (await toCommentItems([c]))[0], thread: await toCommentItems(thread), replies: await toReplyItems(replies, req.user), logs,
      replyMode: await replyMode(acc, c),
    };
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

  /** Write a reply to ONE comment (there is no bulk reply). */
  app.post('/api/comments/:id/replies', {
    schema: { params: Id, body: z.object({ text: ReplyText, templateId: z.string().uuid().nullable().optional(), submit: z.boolean().optional(), scheduledAt: When }) },
  }, async (req, reply) => {
    const c = await visibleComment(req.user, req.params.id);
    const r = await createReply(req.user, c, { ...req.body, scheduledAt: at(req.body.scheduledAt) });
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
    if (q.reviewable) {
      base.push(eq(R.status, 'pending_review'));
      if (!isAdmin(req.user)) base.push(sql`${R.authorId} is distinct from ${req.user.id}`);
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

  app.post('/api/comment-replies/:id/submit', { schema: { params: Id, body: z.object({ scheduledAt: When }).nullish() } }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    const next = await submitReply(req.user, r, at(req.body?.scheduledAt));
    if (req.audit) req.audit.extra = { status: next.status, taskId: next.taskId };
    return { reply: (await toReplyItems([next], req.user))[0] };
  });

  app.post('/api/comment-replies/:id/approve', { schema: { params: Id, body: z.object({ note: z.string().trim().max(500).nullable().optional() }).nullish() } }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    const next = await approveReply(req.user, r, req.body?.note);
    if (req.audit) req.audit.extra = { status: next.status, taskId: next.taskId };
    return { reply: (await toReplyItems([next], req.user))[0] };
  });

  /** Batch approval: each reply was written individually and is checked individually. */
  app.post('/api/comment-replies/approve', {
    schema: { body: z.object({ ids: z.array(z.string().uuid()).min(1).max(50), note: z.string().trim().max(500).nullable().optional() }) },
  }, async (req) => {
    const results: { id: string; ok: boolean; status?: string; code?: string; error?: string }[] = [];
    for (const id of [...new Set(req.body.ids)]) {
      try {
        const r = await visibleReply(req.user, id);
        const next = await approveReply(req.user, r, req.body.note);
        results.push({ id, ok: true, status: next.status });
      } catch (err) {
        results.push({ id, ok: false, code: err instanceof HttpError ? err.code : 'comment.failed', error: (err as Error).message });
      }
    }
    if (req.audit) req.audit.extra = { approved: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).map((r) => ({ id: r.id, code: r.code })) };
    return { results };
  });

  app.post('/api/comment-replies/:id/reject', { schema: { params: Id, body: z.object({ reason: z.string().trim().min(1).max(1000) }) } }, async (req) => {
    const r = await visibleReply(req.user, req.params.id);
    return { reply: (await toReplyItems([await rejectReply(req.user, r, req.body.reason)], req.user))[0] };
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
    /** exact persona, or 'none' for templates without one */
    persona: z.string().trim().max(50).optional(),
    tag: z.string().trim().max(32).optional(),
    /** shared = 公共, own = the caller's 个人, all-users = every 个人 template the caller can see (admins: all users') */
    scope: z.enum(['own', 'shared', 'all-users']).optional(),
    q: z.string().trim().max(100).optional(),
  });
  const templateWhere = (user: AuthUser, q: Partial<z.infer<typeof TemplateQuery>>): SQL | undefined => and(
    isAdmin(user) ? undefined : or(isNull(TPL.userId), eq(TPL.userId, user.id)),
    q.kind && q.kind !== 'all' ? eq(TPL.kind, q.kind) : undefined,
    q.persona === 'none' ? isNull(TPL.persona) : q.persona ? eq(TPL.persona, q.persona) : undefined,
    q.tag ? sql`${TPL.tags} @> array[${q.tag.toLowerCase()}]::text[]` : undefined,
    q.scope === 'shared' ? isNull(TPL.userId) : q.scope === 'own' ? eq(TPL.userId, user.id) : q.scope === 'all-users' ? isNotNull(TPL.userId) : undefined,
    q.q ? or(ilike(TPL.name, like(q.q)), ilike(TPL.text, like(q.q))) : undefined,
  );
  app.get('/api/comment-templates', { schema: { querystring: TemplateQuery } }, async (req) => {
    const rows = await db.select({ t: TPL, owner: schema.users.username }).from(TPL).leftJoin(schema.users, eq(schema.users.id, TPL.userId))
      .where(templateWhere(req.user, req.query)).orderBy(asc(TPL.name));
    return { templates: rows.map((r) => ({ ...r.t, shared: r.t.userId === null, ownerName: r.owner ?? null, writable: r.t.userId !== null || isAdmin(req.user) })) };
  });

  /** Personas and tags in use among visible templates (filter suggestions). */
  app.get('/api/comment-templates/facets', { schema: { querystring: TemplateQuery.pick({ kind: true, scope: true }) } }, async (req) => {
    const cond = templateWhere(req.user, req.query);
    const [personas, tags] = await Promise.all([
      db.selectDistinct({ p: TPL.persona }).from(TPL).where(and(cond, sql`${TPL.persona} is not null`)).orderBy(asc(TPL.persona)).limit(500),
      db.selectDistinct({ t: sql<string>`unnest(${TPL.tags})` }).from(TPL).where(cond).orderBy(sql`1`).limit(500),
    ]);
    return { personas: personas.map((p) => p.p!), tags: tags.map((t) => t.t) };
  });

  const normTags = (tags: string[]) => [...new Set(tags.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const TemplateBody = z.object({
    name: z.string().trim().min(1).max(100), text: z.string().trim().min(1).max(5000),
    kind: z.enum(['comment', 'post']).optional(),
    persona: z.string().trim().max(50).nullable().optional().transform((v) => (v === '' ? null : v)),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).transform(normTags).optional(),
  });
  app.post('/api/comment-templates', { schema: { body: TemplateBody.extend({ shared: z.boolean().optional() }) } }, async (req, reply) => {
    const { shared, ...b } = req.body;
    if (shared && !isAdmin(req.user)) throw forbidden('只有管理员可以创建共享模板', 'comment.admin_only');
    const [row] = await db.insert(TPL).values({ ...b, userId: shared ? null : req.user.id, createdBy: req.user.id }).returning();
    if (req.audit) req.audit.extra = { id: row!.id, kind: row!.kind };
    reply.code(201);
    return { template: { ...row!, shared: row!.userId === null } };
  });

  app.put('/api/comment-templates/:id', { schema: { params: Id, body: TemplateBody.partial() } }, async (req) => {
    const t = await visibleTemplate(req.user, req.params.id);
    assertTemplateWritable(req.user, t);
    const set = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) throw new HttpError(400, 'nothing to update', 'common.nothing_to_update');
    const [row] = await db.update(TPL).set(set).where(eq(TPL.id, t.id)).returning();
    return { template: { ...row!, shared: row!.userId === null } };
  });

  app.delete('/api/comment-templates/:id', { schema: { params: Id } }, async (req, reply) => {
    const t = await visibleTemplate(req.user, req.params.id);
    assertTemplateWritable(req.user, t);
    await db.delete(TPL).where(eq(TPL.id, t.id));
    reply.code(204);
  });
};
