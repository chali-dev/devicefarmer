import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { assertPlatformEnabled } from '../../lib/platforms-enabled.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { isUniqueViolation } from '../proxies/pool.js';
import { accountChecked } from '../notify/triggers.js';
import { PLATFORM_IDS, platformById } from './platforms.js';
import {
  assertLinkable, EXCEPTION_SQL, getLimits, groupForOwner, instanceNames, linkLogs, MAX_LIMIT, platformsWithLimits, sameTags, saveLimits,
  setAccountTags, tagsOf, toItems, visibleAccount, writeLogs, type LogEntry, type Tx,
} from './social.js';

const sa = schema.socialAccounts;
const sg = schema.socialAccountGroups;

const Id = z.object({ id: z.string().uuid() });
const LOGIN = ['unknown', 'logged_in', 'logged_out', 'needs_verification'] as const;
const ACCOUNT = ['active', 'limited', 'suspended', 'disabled'] as const;
const opt = (max: number) => z.string().trim().max(max).nullable().optional();
/** Platform handle without the leading @: letters, digits, '.', '_' and '-'. */
const Handle = z.string().trim().transform((s) => s.replace(/^@+/, '')).pipe(z.string().regex(/^[\p{L}\p{N}._-]{1,100}$/u, 'invalid handle'));
const Url = z.string().trim().max(500).regex(/^https?:\/\/\S+$/i, 'http(s) URL').nullable().optional().or(z.literal(''));
const Tags = z.array(z.string().trim().min(1).max(32)).max(20);

const Editable = {
  handle: Handle,
  displayName: opt(100),
  profileUrl: Url,
  externalId: opt(100),
  groupId: z.string().uuid().nullable().optional(),
  tags: Tags.optional(),
  instanceId: z.string().uuid().nullable().optional(),
  loginStatus: z.enum(LOGIN).optional(),
  accountStatus: z.enum(ACCOUNT).optional(),
  notes: opt(2000),
  lastError: opt(500),
};
const CreateBody = z.object({ platform: z.enum(PLATFORM_IDS), ownerId: z.string().uuid().optional(), ...Editable });
const UpdateBody = z.object({ ...Editable, handle: Handle.optional() });

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  platform: z.enum(PLATFORM_IDS).optional(),
  /** uuid, or 'none' = ungrouped */
  groupId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  /** uuid, or 'none' = not linked to a device */
  instanceId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  loginStatus: z.enum(LOGIN).optional(),
  accountStatus: z.enum(ACCOUNT).optional(),
  exception: z.enum(['true', 'false']).optional(),
  /** Comma-separated tag names; an account must carry all of them (case-insensitive). */
  tags: z.string().trim().max(400).optional(),
  ownerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const blank = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim());
const handleTaken = (platform: string, handle: string) =>
  conflict(`${platformById(platform)?.name ?? platform} 账号 @${handle} 已存在`, 'social.account_exists', { platform: platformById(platform)?.name ?? platform, handle });

/** Account owner for a create: self, or (admin) any existing user. */
async function resolveOwner(user: AuthUser, ownerId?: string): Promise<string> {
  if (!ownerId || ownerId === user.id) return user.id;
  if (!isAdmin(user)) throw forbidden('仅管理员可以为其他用户创建账号', 'social.admin_only');
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerId));
  if (!u) throw badRequest('用户不存在', 'users.not_found');
  return u.id;
}

/** Group names for the given ids in one query; the returned lookup maps null/unknown ids to null. */
async function groupNames(tx: Tx, ids: (string | null)[]): Promise<(id: string | null) => string | null> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = want.length ? await tx.select({ id: sg.id, name: sg.name }).from(sg).where(inArray(sg.id, want)) : [];
  const byId = new Map(rows.map((g) => [g.id, g.name]));
  return (id) => (id && byId.get(id)) || null;
}

const FIELDS = ['handle', 'displayName', 'profileUrl', 'externalId', 'notes'] as const;
const STATUS_FIELDS = ['loginStatus', 'accountStatus', 'lastError'] as const;

/**
 * Social accounts (社交账号): own platform accounts, groups, tags, status, logs and device links.
 * Per-device platform limits: GET/PUT /api/social/settings (admin).
 */
export const socialRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // ------------------------------------------------------------ platforms + limits
  app.get('/api/social/platforms', async () => ({ platforms: platformsWithLimits(await getLimits()) }));

  app.get('/api/social/settings', { preHandler: app.requireAdmin }, async () => ({ limits: await getLimits(), platforms: platformsWithLimits(await getLimits()) }));

  app.put('/api/social/settings', {
    preHandler: app.requireAdmin,
    schema: { body: z.object({ limits: z.partialRecord(z.enum(PLATFORM_IDS), z.number().int().min(1).max(MAX_LIMIT)) }) },
  }, async (req) => {
    Object.keys(req.body.limits).forEach(assertPlatformEnabled);
    const limits = await saveLimits(req.body.limits as Record<string, number>);
    return { limits, platforms: platformsWithLimits(limits) };
  });

  // ------------------------------------------------------------ accounts
  app.get('/api/social/accounts', { schema: { querystring: ListQuery } }, async (req) => {
    const qy = req.query;
    const where: SQL[] = [];
    if (!isAdmin(req.user)) where.push(eq(sa.userId, req.user.id));
    else if (qy.ownerId) where.push(eq(sa.userId, qy.ownerId));
    if (qy.platform) where.push(eq(sa.platform, qy.platform));
    if (qy.groupId === 'none') where.push(isNull(sa.groupId));
    else if (qy.groupId) where.push(eq(sa.groupId, qy.groupId));
    if (qy.instanceId === 'none') where.push(isNull(sa.instanceId));
    else if (qy.instanceId) where.push(eq(sa.instanceId, qy.instanceId));
    if (qy.loginStatus) where.push(eq(sa.loginStatus, qy.loginStatus));
    if (qy.accountStatus) where.push(eq(sa.accountStatus, qy.accountStatus));
    if (qy.exception === 'true') where.push(EXCEPTION_SQL);
    if (qy.exception === 'false') where.push(sql`not ${EXCEPTION_SQL}`);
    if (qy.q) {
      const l = like(qy.q);
      where.push(or(ilike(sa.handle, l), ilike(sa.displayName, l), ilike(sa.externalId, l), ilike(sa.notes, l),
        sql`exists (select 1 from social_account_tags at join social_tags t on t.id = at.tag_id where at.account_id = ${sa.id} and t.name ilike ${l})`)!);
    }
    const tags = [...new Set((qy.tags ? qy.tags.split(',') : []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
    for (const t of tags) {
      where.push(sql`exists (select 1 from social_account_tags at join social_tags t on t.id = at.tag_id where at.account_id = ${sa.id} and lower(t.name) = ${t})`);
    }
    const cond = where.length ? and(...where) : undefined;
    const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(sa).where(cond);
    const rows = await db.select().from(sa).where(cond).orderBy(desc(sa.createdAt), desc(sa.id))
      .limit(qy.pageSize).offset((qy.page - 1) * qy.pageSize);
    return { items: await toItems(req.user, rows), total, page: qy.page, pageSize: qy.pageSize };
  });

  /** Tags used by the accounts the caller can see (filter suggestions). */
  app.get('/api/social/tags', { schema: { querystring: z.object({ ownerId: z.string().uuid().optional() }) } }, async (req) => {
    const owner = !isAdmin(req.user) ? req.user.id : req.query.ownerId;
    const rows = await db.selectDistinct({ name: schema.socialTags.name }).from(schema.socialTags)
      .innerJoin(schema.socialAccountTags, eq(schema.socialAccountTags.tagId, schema.socialTags.id))
      .innerJoin(sa, eq(sa.id, schema.socialAccountTags.accountId))
      .where(owner ? eq(sa.userId, owner) : undefined).orderBy(asc(schema.socialTags.name)).limit(500);
    return { tags: rows.map((r) => r.name) };
  });

  app.get('/api/social/accounts/:id', { schema: { params: Id } }, async (req) => {
    const [item] = await toItems(req.user, [await visibleAccount(req.user, req.params.id)]);
    return { account: item };
  });

  app.post('/api/social/accounts', { schema: { body: CreateBody } }, async (req, reply) => {
    const b = req.body;
    assertPlatformEnabled(b.platform);
    const ownerId = await resolveOwner(req.user, b.ownerId);
    const platform = platformById(b.platform)!;
    const id = await db.transaction(async (tx) => {
      if (b.groupId) await groupForOwner(tx, req.user, b.groupId, ownerId);
      if (b.instanceId) await assertLinkable(tx, req.user, b.instanceId, b.platform);
      const [row] = await tx.insert(sa).values({
        userId: ownerId, platform: b.platform, handle: b.handle,
        displayName: blank(b.displayName) ?? null, profileUrl: blank(b.profileUrl) ?? platform.profileUrl(b.handle),
        externalId: blank(b.externalId) ?? null, groupId: b.groupId ?? null, instanceId: b.instanceId ?? null,
        loginStatus: b.loginStatus ?? 'unknown', accountStatus: b.accountStatus ?? 'active',
        notes: blank(b.notes) ?? null, lastError: blank(b.lastError) ?? null, createdBy: req.user.id,
      }).returning().catch((err) => { throw isUniqueViolation(err, 'social_accounts_platform_handle') ? handleTaken(b.platform, b.handle) : err; });
      if (b.tags?.length) await setAccountTags(tx, row!.id, b.tags);
      await writeLogs(tx, req.user, [
        { accountId: row!.id, action: 'create', field: null, fromValue: null, toValue: `${platform.name} @${row!.handle}` },
        ...(await linkLogs(tx, row!.id, null, row!.instanceId)),
      ]);
      return row!.id;
    });
    reply.code(201);
    const [item] = await toItems(req.user, [await visibleAccount(req.user, id)]);
    return { account: item };
  });

  app.put('/api/social/accounts/:id', { schema: { params: Id, body: UpdateBody } }, async (req) => {
    const b = req.body;
    await db.transaction(async (tx) => {
      const cur = await visibleAccount(req.user, req.params.id, tx, true);
      const set: Partial<typeof sa.$inferInsert> = {};
      const logs: LogEntry[] = [];
      const accountId = cur.id;
      for (const k of FIELDS) {
        const v = k === 'handle' ? b.handle : blank(b[k]);
        if (v === undefined || v === cur[k]) continue;
        (set as Record<string, unknown>)[k] = v;
        logs.push({ accountId, action: 'update', field: k, fromValue: cur[k], toValue: v });
      }
      for (const k of STATUS_FIELDS) {
        const v = k === 'lastError' ? blank(b.lastError) : b[k];
        if (v === undefined || v === cur[k]) continue;
        (set as Record<string, unknown>)[k] = v;
        logs.push({ accountId, action: 'status', field: k, fromValue: cur[k], toValue: v });
      }
      if (b.groupId !== undefined && b.groupId !== cur.groupId) {
        if (b.groupId) await groupForOwner(tx, req.user, b.groupId, cur.userId);
        set.groupId = b.groupId;
        const names = await groupNames(tx, [cur.groupId, b.groupId ?? null]);
        logs.push({ accountId, action: 'update', field: 'group', fromValue: names(cur.groupId), toValue: names(b.groupId) });
      }
      if (b.instanceId !== undefined && b.instanceId !== cur.instanceId) {
        if (b.instanceId) await assertLinkable(tx, req.user, b.instanceId, cur.platform, cur.id);
        set.instanceId = b.instanceId;
        logs.push(...await linkLogs(tx, accountId, cur.instanceId, b.instanceId));
      }
      if (b.tags !== undefined) {
        const before = (await tagsOf(tx, [cur.id])).get(cur.id) ?? [];
        if (!sameTags(before, b.tags)) {
          const after = await setAccountTags(tx, cur.id, b.tags);
          logs.push({ accountId, action: 'update', field: 'tags', fromValue: before.join(', ') || null, toValue: after.join(', ') || null });
        }
      }
      if (Object.keys(set).length) {
        await tx.update(sa).set(set).where(eq(sa.id, cur.id))
          .catch((err) => { throw isUniqueViolation(err, 'social_accounts_platform_handle') ? handleTaken(cur.platform, set.handle ?? cur.handle) : err; });
      } else if (logs.length) {
        await tx.update(sa).set({ updatedAt: new Date() }).where(eq(sa.id, cur.id));
      }
      await writeLogs(tx, req.user, logs);
    });
    const [item] = await toItems(req.user, [await visibleAccount(req.user, req.params.id)]);
    return { account: item };
  });

  /** Manual check (标记已检查): sets last_checked_at, optionally the observed statuses and error. */
  app.post('/api/social/accounts/:id/checked', {
    schema: {
      params: Id,
      body: z.object({ loginStatus: z.enum(LOGIN).optional(), accountStatus: z.enum(ACCOUNT).optional(), lastError: opt(500), message: opt(300) }).default({}),
    },
  }, async (req) => {
    const b = req.body;
    await db.transaction(async (tx) => {
      const cur = await visibleAccount(req.user, req.params.id, tx, true);
      const set: Partial<typeof sa.$inferInsert> = { lastCheckedAt: new Date() };
      const logs: LogEntry[] = [{ accountId: cur.id, action: 'checked', field: null, fromValue: null, toValue: null, message: blank(b.message) ?? null }];
      for (const k of STATUS_FIELDS) {
        const v = k === 'lastError' ? blank(b.lastError) : b[k];
        if (v === undefined || v === cur[k]) continue;
        (set as Record<string, unknown>)[k] = v;
        logs.push({ accountId: cur.id, action: 'status', field: k, fromValue: cur[k], toValue: v });
      }
      await tx.update(sa).set(set).where(eq(sa.id, cur.id));
      await writeLogs(tx, req.user, logs);
    });
    const acc = await visibleAccount(req.user, req.params.id);
    await accountChecked(acc); // alerts: a problem result notifies, a clean one recovers
    const [item] = await toItems(req.user, [acc]);
    return { account: item };
  });

  app.delete('/api/social/accounts/:id', { schema: { params: Id } }, async (req, reply) => {
    const cur = await visibleAccount(req.user, req.params.id);
    await db.delete(sa).where(eq(sa.id, cur.id));
    reply.code(204);
  });

  app.get('/api/social/accounts/:id/logs', {
    schema: { params: Id, querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) },
  }, async (req) => {
    const cur = await visibleAccount(req.user, req.params.id);
    const logs = await db.select().from(schema.socialAccountLogs).where(eq(schema.socialAccountLogs.accountId, cur.id))
      .orderBy(desc(schema.socialAccountLogs.at), desc(schema.socialAccountLogs.id)).limit(req.query.limit);
    return { logs };
  });

  /** Batch actions over visible accounts. Any id the caller cannot see fails the whole batch with 404. */
  app.post('/api/social/accounts/batch', {
    schema: {
      body: z.object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        action: z.enum(['move-group', 'add-tags', 'remove-tags', 'unlink', 'delete']),
        groupId: z.string().uuid().nullable().optional(),
        tags: Tags.optional(),
      }),
    },
  }, async (req) => {
    const { action } = req.body;
    const ids = [...new Set(req.body.ids)];
    if (action === 'move-group' && req.body.groupId === undefined) throw badRequest('groupId is required', 'social.batch_group_required');
    if ((action === 'add-tags' || action === 'remove-tags') && !req.body.tags?.length) throw badRequest('tags are required', 'social.batch_tags_required');
    const changed = await db.transaction(async (tx) => {
      const rows = await tx.select().from(sa).where(inArray(sa.id, ids)).orderBy(asc(sa.id)).for('update');
      const visible = rows.filter((r) => isAdmin(req.user) || r.userId === req.user.id);
      if (visible.length !== ids.length) throw notFound('账号不存在', 'social.not_found');
      const logs: LogEntry[] = [];
      let n = 0;
      if (action === 'delete') {
        await tx.delete(sa).where(inArray(sa.id, ids));
        return ids.length;
      }
      if (action === 'unlink') {
        const linked = visible.filter((r) => r.instanceId);
        const names = await instanceNames(tx, linked.map((r) => r.instanceId));
        for (const r of linked) logs.push({ accountId: r.id, action: 'unlink', field: 'device', fromValue: names.get(r.instanceId!)!, toValue: null });
        if (linked.length) await tx.update(sa).set({ instanceId: null }).where(inArray(sa.id, linked.map((r) => r.id)));
        n = linked.length;
      }
      if (action === 'move-group') {
        const gid = req.body.groupId ?? null;
        // one group lookup; every account must belong to the group's owner
        if (gid) await groupForOwner(tx, req.user, gid, visible[0]!.userId);
        if (gid && visible.some((r) => r.userId !== visible[0]!.userId)) throw conflict('分组属于其他用户', 'social.group_owner_mismatch');
        const moving = visible.filter((r) => r.groupId !== gid);
        const names = await groupNames(tx, [gid, ...moving.map((r) => r.groupId)]);
        for (const r of moving) logs.push({ accountId: r.id, action: 'update', field: 'group', fromValue: names(r.groupId), toValue: names(gid) });
        if (moving.length) await tx.update(sa).set({ groupId: gid }).where(inArray(sa.id, moving.map((r) => r.id)));
        n = moving.length;
      }
      if (action === 'add-tags' || action === 'remove-tags') {
        const cur = await tagsOf(tx, ids);
        const drop = new Set(req.body.tags!.map((t) => t.toLowerCase()));
        for (const r of visible) {
          const before = cur.get(r.id) ?? [];
          const next = action === 'add-tags' ? [...before, ...req.body.tags!] : before.filter((t) => !drop.has(t.toLowerCase()));
          if (sameTags(before, next)) continue;
          const after = await setAccountTags(tx, r.id, next);
          logs.push({ accountId: r.id, action: 'update', field: 'tags', fromValue: before.join(', ') || null, toValue: after.join(', ') || null });
          n++;
        }
      }
      await writeLogs(tx, req.user, logs);
      return n;
    });
    return { action, count: ids.length, changed };
  });

  // ------------------------------------------------------------ groups (per user; admins see all)
  app.get('/api/social/groups', { schema: { querystring: z.object({ ownerId: z.string().uuid().optional() }) } }, async (req) => {
    const owner = !isAdmin(req.user) ? req.user.id : req.query.ownerId;
    const rows = await db.select({
      id: sg.id, userId: sg.userId, name: sg.name, createdAt: sg.createdAt, updatedAt: sg.updatedAt,
      ownerName: schema.users.username,
      count: sql<number>`(select count(*)::int from social_accounts a where a.group_id = ${sg.id})`,
    }).from(sg).innerJoin(schema.users, eq(schema.users.id, sg.userId))
      .where(owner ? eq(sg.userId, owner) : undefined).orderBy(asc(schema.users.username), asc(sg.name));
    return { groups: rows };
  });

  const groupExists = (name: string) => conflict('分组名称已存在', 'social.group_exists', { name });

  app.post('/api/social/groups', {
    schema: { body: z.object({ name: z.string().trim().min(1).max(50), ownerId: z.string().uuid().optional() }) },
  }, async (req, reply) => {
    const userId = await resolveOwner(req.user, req.body.ownerId);
    const [row] = await db.insert(sg).values({ userId, name: req.body.name }).returning()
      .catch((err) => { throw isUniqueViolation(err, 'social_account_groups_user_name') ? groupExists(req.body.name) : err; });
    reply.code(201);
    return { group: row };
  });

  async function visibleGroup(user: AuthUser, id: string, tx: Tx) {
    const [g] = await tx.select().from(sg).where(eq(sg.id, id)).for('update');
    if (!g || (!isAdmin(user) && g.userId !== user.id)) throw notFound('分组不存在', 'social.group_not_found');
    return g;
  }

  /** Rename. Accounts in the group get an update log (the group name they show changes). */
  app.put('/api/social/groups/:id', { schema: { params: Id, body: z.object({ name: z.string().trim().min(1).max(50) }) } }, async (req) => {
    return db.transaction(async (tx) => {
      const g = await visibleGroup(req.user, req.params.id, tx);
      if (g.name === req.body.name) return { group: g };
      const [row] = await tx.update(sg).set({ name: req.body.name }).where(eq(sg.id, g.id)).returning()
        .catch((err) => { throw isUniqueViolation(err, 'social_account_groups_user_name') ? groupExists(req.body.name) : err; });
      const members = await tx.select({ id: sa.id }).from(sa).where(eq(sa.groupId, g.id));
      await writeLogs(tx, req.user, members.map((m) => ({ accountId: m.id, action: 'update' as const, field: 'group', fromValue: g.name, toValue: req.body.name })));
      return { group: row };
    });
  });

  /** Delete a group; its accounts become ungrouped (logged per account). */
  app.delete('/api/social/groups/:id', { schema: { params: Id } }, async (req, reply) => {
    await db.transaction(async (tx) => {
      const g = await visibleGroup(req.user, req.params.id, tx);
      const members = await tx.select({ id: sa.id }).from(sa).where(eq(sa.groupId, g.id)).for('update');
      await writeLogs(tx, req.user, members.map((m) => ({ accountId: m.id, action: 'update' as const, field: 'group', fromValue: g.name, toValue: null, message: 'group deleted' })));
      await tx.delete(sg).where(eq(sg.id, g.id));
    });
    reply.code(204);
  });
};
