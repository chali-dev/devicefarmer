import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { TrackedAccount } from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { assertPlatformEnabled } from '../../lib/platforms-enabled.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { enqueueTask } from '../instances/queue.js';
import { parseProfile, PLATFORM_IDS, platformDef, platformInfo } from './platforms.js';
import { display, getVisibleAccount, pendingRefreshes, REF_TYPE, refreshRefusal, toPublicAccounts } from './tracked.js';
import { SCHEDULE_INTERVALS } from './schedule.js';
import { firstSlot, IG_DEFAULT_INTERVAL_HOURS } from './slots.js';

const ta = schema.trackedAccounts;
const ts = schema.trackedAccountSnapshots;
const tp = schema.trackedPosts;

const Id = z.object({ id: z.string().uuid() });
const HttpUrl = z.string().trim().max(1000).url().refine((u) => /^https?:\/\//i.test(u), 'http(s) URL required');
const Tags = z.array(z.string().trim().min(1).max(32)).max(20);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const Platform = z.enum(PLATFORM_IDS);

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim());
/** Lowercase, trimmed, deduplicated. */
const normTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
const isUnique = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
};

/** Admins see every user's rows (optionally one owner); users only their own. */
function ownerWhere(user: AuthUser, ownerId?: string): SQL | undefined {
  if (isAdmin(user)) return ownerId ? eq(ta.userId, ownerId) : undefined;
  if (ownerId && ownerId !== user.id) throw forbidden('仅管理员可以查看其他用户的追踪账号', 'tracked.admin_only');
  return eq(ta.userId, user.id);
}

const ListQuery = z.object({
  platform: Platform.optional(),
  /** exact category, or 'none' for uncategorized */
  category: z.string().trim().max(50).optional(),
  tag: z.string().trim().max(32).optional(),
  favorite: z.enum(['true', 'false']).optional(),
  status: z.enum(['active', 'paused', 'error']).optional(),
  q: z.string().trim().max(100).optional(),
  ownerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const CreateBody = z.object({
  input: z.string().trim().min(1).max(500),
  platform: Platform.optional(),
  displayName: optText(200),
  category: optText(50),
  tags: Tags.optional(),
  favorite: z.boolean().optional(),
  notes: optText(1000),
});

const UpdateBody = z.object({
  displayName: optText(200),
  avatarUrl: HttpUrl.nullable().optional(),
  bio: optText(2000),
  category: optText(50),
  tags: Tags.optional(),
  favorite: z.boolean().optional(),
  /** 'error' is set by refreshes only. */
  status: z.enum(['active', 'paused']).optional(),
  notes: optText(1000),
  /** 定时采集 interval in hours; null = off. Only for platforms with a data source (API or collector device). */
  refreshIntervalHours: z.number().int().refine((n) => SCHEDULE_INTERVALS.includes(n), 'unsupported interval').nullable().optional(),
});

/**
 * Tracked accounts (追踪账号): external public profiles a user observes, with follower history and
 * public posts. Data comes from official APIs (YouTube) or the collector device (Instagram, read in the app;
 * owner decision 2026-11-18). Manual entry of snapshots/posts was removed (old rows stay readable/deletable).
 */
export const trackedRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/tracked-accounts/platforms', async () => ({ platforms: await platformInfo() }));

  /** Normalises a URL/handle without saving (add form preview). */
  app.post('/api/tracked-accounts/parse', {
    schema: { body: z.object({ input: z.string().trim().min(1).max(500), platform: Platform.optional() }) },
  }, async (req) => ({ profile: parseProfile(req.body.input, req.body.platform) }));

  app.get('/api/tracked-accounts', { schema: { querystring: ListQuery } }, async (req) => {
    const q = req.query;
    const where: (SQL | undefined)[] = [ownerWhere(req.user, q.ownerId)];
    if (q.platform) where.push(eq(ta.platform, q.platform));
    if (q.category === 'none') where.push(isNull(ta.category));
    else if (q.category) where.push(eq(ta.category, q.category));
    if (q.tag) where.push(sql`${ta.tags} @> array[${q.tag.toLowerCase()}]::text[]`);
    if (q.favorite) where.push(eq(ta.favorite, q.favorite === 'true'));
    if (q.status) where.push(eq(ta.status, q.status));
    if (q.q) {
      const l = like(q.q);
      where.push(or(ilike(ta.handle, l), ilike(ta.displayName, l), ilike(ta.notes, l), ilike(ta.externalId, l))!);
    }
    const cond = and(...where);
    const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(ta).where(cond);
    const rows = await db.select().from(ta).where(cond).orderBy(desc(ta.favorite), desc(ta.createdAt), desc(ta.id))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: await toPublicAccounts(rows), total, page: q.page, pageSize: q.pageSize };
  });

  /** Categories and tags in use (filter suggestions). */
  app.get('/api/tracked-accounts/facets', { schema: { querystring: z.object({ ownerId: z.string().uuid().optional() }) } }, async (req) => {
    const cond = ownerWhere(req.user, req.query.ownerId);
    const [cats, tags] = await Promise.all([
      db.selectDistinct({ c: ta.category }).from(ta).where(and(cond, sql`${ta.category} is not null`)).orderBy(asc(ta.category)).limit(500),
      db.selectDistinct({ t: sql<string>`unnest(${ta.tags})` }).from(ta).where(cond).orderBy(sql`1`).limit(500),
    ]);
    return { categories: cats.map((c) => c.c!), tags: tags.map((t) => t.t) };
  });

  app.post('/api/tracked-accounts', { schema: { body: CreateBody } }, async (req, reply) => {
    const b = req.body;
    const p = parseProfile(b.input, b.platform);
    if (req.audit) req.audit.target = display(p);
    // Instagram (read on the collector device) is collected on a schedule by default (24 h; changeable / off per account).
    const id = randomUUID();
    const interval = p.platform === 'instagram' ? IG_DEFAULT_INTERVAL_HOURS : null;
    const [row] = await db.insert(ta).values({
      id, userId: req.user.id, platform: p.platform, handle: p.handle, profileUrl: p.profileUrl, externalId: p.externalId,
      displayName: blankToNull(b.displayName) ?? null, category: blankToNull(b.category) ?? null, tags: normTags(b.tags ?? []),
      favorite: b.favorite ?? false, notes: blankToNull(b.notes) ?? null,
      refreshIntervalHours: interval, nextRefreshAt: interval ? firstSlot(id) : null,
    }).returning().catch((err) => {
      if (isUnique(err)) throw conflict(`已在追踪 ${display(p)}`, 'tracked.duplicate', { account: display(p) });
      throw err;
    });
    if (req.audit) req.audit.extra = { id: row!.id, platform: p.platform, handle: p.handle };
    reply.code(201);
    return { account: (await toPublicAccounts([row!]))[0] };
  });

  app.get('/api/tracked-accounts/:id', { schema: { params: Id } }, async (req) => ({
    account: (await toPublicAccounts([await getVisibleAccount(req.user, req.params.id)]))[0],
  }));

  app.patch('/api/tracked-accounts/:id', { schema: { params: Id, body: UpdateBody } }, async (req) => {
    const cur = await getVisibleAccount(req.user, req.params.id);
    const b = req.body;
    const set: Partial<typeof ta.$inferInsert> = {};
    for (const k of ['displayName', 'bio', 'category', 'notes'] as const) {
      const v = blankToNull(b[k]);
      if (v !== undefined) set[k] = v;
    }
    if (b.avatarUrl !== undefined) set.avatarUrl = b.avatarUrl;
    if (b.tags !== undefined) set.tags = normTags(b.tags);
    if (b.favorite !== undefined) set.favorite = b.favorite;
    if (b.status !== undefined) set.status = b.status;
    if (b.refreshIntervalHours !== undefined && b.refreshIntervalHours !== cur.refreshIntervalHours) {
      if (b.refreshIntervalHours !== null) assertPlatformEnabled(cur.platform);
      if (b.refreshIntervalHours !== null && !platformDef(cur.platform).source) {
        throw badRequest('该平台没有数据来源，无法定时采集', 'tracked.schedule_manual_only');
      }
      set.refreshIntervalHours = b.refreshIntervalHours;
      set.nextRefreshAt = b.refreshIntervalHours === null ? null : firstSlot(cur.id);
      set.scheduleSkipCode = null;
    }
    if (!Object.keys(set).length) throw badRequest('nothing to update', 'common.nothing_to_update');
    const [row] = await db.update(ta).set(set).where(eq(ta.id, cur.id)).returning();
    return { account: (await toPublicAccounts([row!]))[0] };
  });

  /** Snapshots and posts cascade. */
  app.delete('/api/tracked-accounts/:id', { schema: { params: Id } }, async (req, reply) => {
    const cur = await getVisibleAccount(req.user, req.params.id);
    await db.delete(ta).where(eq(ta.id, cur.id));
    reply.code(204);
  });

  // ------------------------------------------------------------ snapshots (follower history)
  app.get('/api/tracked-accounts/:id/snapshots', {
    schema: { params: Id, querystring: z.object({ limit: z.coerce.number().int().min(1).max(2000).default(500) }) },
  }, async (req) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    // Newest N, returned oldest first (chart order).
    const rows = await db.select().from(ts).where(eq(ts.trackedAccountId, acc.id)).orderBy(desc(ts.capturedAt), desc(ts.id)).limit(req.query.limit);
    return { snapshots: rows.reverse() };
  });

  app.delete('/api/tracked-accounts/:id/snapshots/:snapshotId', {
    schema: { params: z.object({ id: z.string().uuid(), snapshotId: z.string().uuid() }) },
  }, async (req, reply) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const del = await db.delete(ts).where(and(eq(ts.id, req.params.snapshotId), eq(ts.trackedAccountId, acc.id))).returning({ id: ts.id });
    if (!del.length) throw notFound('记录不存在', 'tracked.snapshot_not_found');
    reply.code(204);
  });

  // ------------------------------------------------------------ posts (content update history)
  app.get('/api/tracked-accounts/:id/posts', {
    schema: {
      params: Id,
      querystring: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }),
    },
  }, async (req) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(tp).where(eq(tp.trackedAccountId, acc.id));
    const rows = await db.select().from(tp).where(eq(tp.trackedAccountId, acc.id))
      .orderBy(sql`${tp.publishedAt} desc nulls last`, desc(tp.firstSeenAt), desc(tp.id))
      .limit(req.query.pageSize).offset((req.query.page - 1) * req.query.pageSize);
    return { posts: rows, total, page: req.query.page, pageSize: req.query.pageSize };
  });

  app.delete('/api/tracked-accounts/:id/posts/:postId', {
    schema: { params: z.object({ id: z.string().uuid(), postId: z.string().uuid() }) },
  }, async (req, reply) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const del = await db.delete(tp).where(and(eq(tp.id, req.params.postId), eq(tp.trackedAccountId, acc.id))).returning({ id: tp.id });
    if (!del.length) throw notFound('内容不存在', 'tracked.post_not_found');
    reply.code(204);
  });

  // ------------------------------------------------------------ refresh (official API / collector device, async task)
  const enqueueRefresh = (acc: TrackedAccount, userId: string) => enqueueTask('tracked-refresh', { trackedAccountId: acc.id }, userId, {
    refType: REF_TYPE, refId: acc.id, label: display(acc),
  });

  app.post('/api/tracked-accounts/:id/refresh', { schema: { params: Id } }, async (req, reply) => {
    const acc = await getVisibleAccount(req.user, req.params.id);
    const no = await refreshRefusal(acc, await pendingRefreshes([acc.id]));
    if (no) throw new HttpError(no.status, no.message, no.code, no.params);
    const taskId = await enqueueRefresh(acc, req.user.id);
    reply.code(202);
    return { taskId, manualOnly: !platformDef(acc.platform).source };
  });

  /** Batch refresh; accounts that can't be refreshed now are skipped with a code. */
  app.post('/api/tracked-accounts/refresh', {
    schema: { body: z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }) },
  }, async (req, reply) => {
    const ids = [...new Set(req.body.ids)];
    const vis = ownerWhere(req.user);
    const rows = await db.select().from(ta).where(and(inArray(ta.id, ids), vis));
    const busy = await pendingRefreshes(rows.map((r) => r.id));
    const queued: { id: string; taskId: string; manualOnly: boolean }[] = [];
    const skipped: { id: string; code: string }[] = ids.filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ id, code: 'tracked.not_found' }));
    for (const acc of rows) {
      const no = await refreshRefusal(acc, busy);
      if (no) { skipped.push({ id: acc.id, code: no.code }); continue; }
      queued.push({ id: acc.id, taskId: await enqueueRefresh(acc, req.user.id), manualOnly: !platformDef(acc.platform).source });
    }
    reply.code(202);
    return { queued, skipped };
  });
};
