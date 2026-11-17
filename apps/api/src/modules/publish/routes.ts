import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { PUBLISH_STATUSES, type PublishTask } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { accessibleInstanceIds, isAdmin, type AuthUser } from '../auth/rbac.js';
import { mediaItem } from '../content/content.js';
import { enabledPlatforms } from '../social/platforms.js';
import { methodIdsFor } from './methods.js';
import { PUBLISH_CAPABILITIES, capabilityOf, composeText } from './platforms.js';
import { cancelPublish, editPublish, recordOutcome, REF_TYPE, reschedulePublish, retryPublish } from './publish.js';

const pt = schema.publishTasks;
const Id = z.object({ id: z.string().uuid() });
const NONE = '00000000-0000-0000-0000-000000000000';
const idsOf = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].concat(NONE);
const HttpUrl = z.string().trim().max(1000).regex(/^https?:\/\/\S+$/i, 'http(s) URL');

const csv = <E extends z.ZodType<string, string>>(item: E) => z.string().max(500).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(item).max(20));

const ListQuery = z.object({
  status: csv(z.enum(PUBLISH_STATUSES)).optional(),
  platform: z.string().max(32).optional(),
  accountId: z.string().uuid().optional(),
  contentId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  /** scheduled_at range [from, to) (calendar). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['scheduled_asc', 'scheduled_desc', 'updated_desc']).default('scheduled_desc'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function ownerWhere(user: AuthUser, ownerId?: string): SQL | undefined {
  if (isAdmin(user)) return ownerId ? eq(pt.userId, ownerId) : undefined;
  if (ownerId && ownerId !== user.id) throw forbidden('仅管理员可以查看其他用户的发布任务', 'publish.admin_only');
  return eq(pt.userId, user.id);
}

/** 404 unless the caller owns the publish task (or is admin). */
export async function visiblePublishTask(user: AuthUser, id: string): Promise<PublishTask> {
  const [row] = await db.select().from(pt).where(eq(pt.id, id));
  if (!row || (!isAdmin(user) && row.userId !== user.id)) throw notFound('发布任务不存在', 'publish.not_found');
  return row;
}

/** Publish tasks with account, device, content and media summaries. */
export async function toPublishItems(rows: PublishTask[], viewer?: AuthUser) {
  if (!rows.length) return [];
  const [accs, contents, owners, media] = await Promise.all([
    db.select({ id: schema.socialAccounts.id, handle: schema.socialAccounts.handle, displayName: schema.socialAccounts.displayName, platform: schema.socialAccounts.platform,
      loginStatus: schema.socialAccounts.loginStatus, accountStatus: schema.socialAccounts.accountStatus, instanceId: schema.socialAccounts.instanceId })
      .from(schema.socialAccounts).where(inArray(schema.socialAccounts.id, idsOf(rows.map((r) => r.accountId)))),
    db.select({ id: schema.contents.id, title: schema.contents.title, userId: schema.contents.userId }).from(schema.contents).where(inArray(schema.contents.id, idsOf(rows.map((r) => r.contentId)))),
    db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, idsOf(rows.map((r) => r.userId)))),
    db.select().from(schema.mediaAssets).where(inArray(schema.mediaAssets.id, idsOf(rows.flatMap((r) => r.mediaIds)))),
  ]);
  const insts = await db.select({ id: schema.instances.id, name: schema.instances.name, status: schema.instances.status, adbState: schema.instances.adbState })
    .from(schema.instances).where(inArray(schema.instances.id, idsOf(accs.map((a) => a.instanceId))));
  const access = viewer ? await accessibleInstanceIds(viewer) : 'all';
  return rows.map((r) => {
    const acc = accs.find((a) => a.id === r.accountId);
    const inst = insts.find((i) => i.id === acc?.instanceId);
    return {
      ...r,
      text: composeText(r.caption, r.hashtags),
      ownerName: owners.find((o) => o.id === r.userId)?.username ?? null,
      content: contents.find((x) => x.id === r.contentId) ?? null,
      account: acc ? { id: acc.id, handle: acc.handle, displayName: acc.displayName, platform: acc.platform, loginStatus: acc.loginStatus, accountStatus: acc.accountStatus } : null,
      instance: inst ? { ...inst, online: inst.status === 'running' && inst.adbState === 'device', accessible: access === 'all' || access.has(inst.id) } : null,
      media: r.mediaIds.map((id) => media.find((m) => m.id === id)).filter((m) => !!m && !m.deletedAt).map((m) => mediaItem(m!)),
    };
  });
}

/**
 * Publish scheduler (定时发布): calendar / queue / history of publish tasks, and the actions on them
 * (cancel, reschedule, retry, edit, record the outcome of a manual publish).
 */
export const publishRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /** Capability table + available methods per platform. */
  app.get('/api/publish/platforms', async () => ({
    platforms: enabledPlatforms().map((p) => ({ id: p.id, name: p.name, capability: capabilityOf(p.id), methods: methodIdsFor(p.id), known: p.id in PUBLISH_CAPABILITIES })),
  }));

  app.get('/api/publish/tasks', { schema: { querystring: ListQuery } }, async (req) => {
    const q = req.query;
    const base: (SQL | undefined)[] = [ownerWhere(req.user, q.ownerId)];
    if (q.platform) base.push(eq(pt.platform, q.platform));
    if (q.accountId) base.push(eq(pt.accountId, q.accountId));
    if (q.contentId) base.push(eq(pt.contentId, q.contentId));
    if (q.from) base.push(gte(pt.scheduledAt, q.from));
    if (q.to) base.push(lt(pt.scheduledAt, q.to));
    if (q.q) {
      const l = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      base.push(or(ilike(pt.caption, l), ilike(pt.title, l), ilike(pt.error, l),
        sql`exists (select 1 from contents x where x.id = ${pt.contentId} and x.title ilike ${l})`,
        sql`exists (select 1 from social_accounts s where s.id = ${pt.accountId} and s.handle ilike ${l})`)!);
    }
    const cond = and(...base, q.status?.length ? inArray(pt.status, q.status) : undefined);
    const order = q.sort === 'scheduled_asc' ? [asc(pt.scheduledAt), asc(pt.id)] : q.sort === 'updated_desc' ? [desc(pt.updatedAt), desc(pt.id)] : [desc(pt.scheduledAt), desc(pt.id)];
    const [rows, [total], byStatus] = await Promise.all([
      db.select().from(pt).where(cond).orderBy(...order).limit(q.limit).offset(q.offset),
      db.select({ n: count() }).from(pt).where(cond),
      db.select({ k: pt.status, n: count() }).from(pt).where(and(...base)).groupBy(pt.status),
    ]);
    return {
      items: await toPublishItems(rows, req.user), total: total?.n ?? 0,
      byStatus: Object.fromEntries(PUBLISH_STATUSES.map((s) => [s, byStatus.find((r) => r.k === s)?.n ?? 0])),
    };
  });

  /** Detail: the task, its business log and every scheduling round (task-centre tasks). */
  app.get('/api/publish/tasks/:id', { schema: { params: Id } }, async (req) => {
    const row = await visiblePublishTask(req.user, req.params.id);
    const [item] = await toPublishItems([row], req.user);
    const [logs, runs] = await Promise.all([
      db.select().from(schema.publishLogs).where(eq(schema.publishLogs.publishTaskId, row.id)).orderBy(asc(schema.publishLogs.at)).limit(1000),
      db.select({ id: schema.tasks.id, status: schema.tasks.status, attempts: schema.tasks.attempts, maxAttempts: schema.tasks.maxAttempts, runAt: schema.tasks.runAt,
        idempotencyKey: schema.tasks.idempotencyKey, retryOf: schema.tasks.retryOf, error: schema.tasks.error, errorCode: schema.tasks.errorCode, result: schema.tasks.result,
        createdAt: schema.tasks.createdAt, startedAt: schema.tasks.startedAt, finishedAt: schema.tasks.finishedAt })
        .from(schema.tasks).where(and(eq(schema.tasks.refType, REF_TYPE), eq(schema.tasks.refId, row.id))).orderBy(asc(schema.tasks.createdAt)),
    ]);
    return { task: item, logs, runs };
  });

  app.post('/api/publish/tasks/:id/cancel', { schema: { params: Id } }, async (req) => {
    const row = await visiblePublishTask(req.user, req.params.id);
    return { task: (await toPublishItems([await cancelPublish(req.user, row)], req.user))[0] };
  });

  app.post('/api/publish/tasks/:id/reschedule', {
    schema: { params: Id, body: z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable() }) },
  }, async (req) => {
    const row = await visiblePublishTask(req.user, req.params.id);
    const next = await reschedulePublish(req.user, row, req.body.scheduledAt ? new Date(req.body.scheduledAt) : null);
    if (req.audit) req.audit.extra = { taskId: next.taskId, attemptNo: next.attemptNo };
    return { task: (await toPublishItems([next], req.user))[0] };
  });

  app.post('/api/publish/tasks/:id/retry', {
    schema: { params: Id, body: z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable().optional() }) },
  }, async (req, reply) => {
    const row = await visiblePublishTask(req.user, req.params.id);
    const next = await retryPublish(req.user, row, req.body.scheduledAt ? new Date(req.body.scheduledAt) : null);
    if (req.audit) req.audit.extra = { taskId: next.taskId, attemptNo: next.attemptNo };
    reply.code(202);
    return { task: (await toPublishItems([next], req.user))[0] };
  });

  app.patch('/api/publish/tasks/:id', {
    schema: {
      params: Id,
      body: z.object({
        title: z.string().trim().max(100).nullable().optional(),
        caption: z.string().max(5000).optional(),
        hashtags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
        options: z.object({ privacy: z.string().max(20).optional() }).strict().optional(),
      }),
    },
  }, async (req) => {
    const row = await visiblePublishTask(req.user, req.params.id);
    return { task: (await toPublishItems([await editPublish(req.user, row, req.body)], req.user))[0] };
  });

  /** Manual method: the operator's outcome (published with a link/ID, or failed with a reason). */
  app.post('/api/publish/tasks/:id/outcome', {
    schema: {
      params: Id,
      body: z.object({
        result: z.enum(['published', 'failed']),
        url: HttpUrl.nullable().optional(),
        externalId: z.string().trim().min(1).max(200).nullable().optional(),
        reason: z.string().trim().max(1000).nullable().optional(),
      }),
    },
  }, async (req) => {
    const row = await visiblePublishTask(req.user, req.params.id);
    return { task: (await toPublishItems([await recordOutcome(req.user, row, req.body)], req.user))[0] };
  });
};
