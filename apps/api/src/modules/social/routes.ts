import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, forbidden, notFound, isUniqueViolation } from '../../lib/errors.js';
import { assertPlatformEnabled } from '../../lib/platforms-enabled.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { requestAccountCheck } from './check.js';
import { discoverDeviceAccounts, requestAccountSync } from './sync.js';
import { assertAccountDevice } from './assign.js';
import { assertPersonaFor } from '../comments/personas.js';
import { Lang } from '../content/languages.js';
import { PLATFORM_IDS, platformById } from './platforms.js';
import {
  EXCEPTION_SQL, getLimits, instanceNames, MAX_LIMIT, platformsWithLimits, sameTags, saveLimits,
  setAccountTags, tagsOf, toItems, visibleAccount, writeLogs, type LogEntry, type Tx,
} from './social.js';

const sa = schema.socialAccounts;

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
  tags: Tags.optional(),
  // instanceId: the device link is read only since 2026-11-18 (owner decision): it is set by 从云手机同步 (sync.ts)
  // and removed by the batch 解除设备关联. An old client sending it is ignored (zod strips unknown keys).
  /** 账号人设: public persona or one of the account owner's; null clears. */
  personaId: z.string().uuid().nullable().optional(),
  /** 账号语言 (BCP-47, canonicalised); null clears. Publishing uses the content's translation in it. */
  lang: Lang.nullable().optional(),
  // loginStatus / accountStatus / lastError are written by the system (automatic check, check.ts) since
  // 2026-11-18; an old client sending them is ignored (zod strips unknown keys).
  notes: opt(2000),
};
const CreateBody = z.object({ platform: z.enum(PLATFORM_IDS), ownerId: z.string().uuid().optional(), ...Editable });
const UpdateBody = z.object({ ...Editable, handle: Handle.optional() });

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  platform: z.enum(PLATFORM_IDS).optional(),
  /** uuid, or 'none' = not linked to a device */
  instanceId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  /** uuid, or 'none' = no persona */
  personaId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  /** 账号语言, or 'none' = not set */
  lang: z.union([z.literal('none'), Lang]).optional(),
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

/** Persona names for the given ids in one query. */
async function personaNames(tx: Tx, ids: (string | null)[]): Promise<(id: string | null) => string | null> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = want.length ? await tx.select({ id: schema.personas.id, name: schema.personas.name }).from(schema.personas).where(inArray(schema.personas.id, want)) : [];
  const byId = new Map(rows.map((p) => [p.id, p.name]));
  return (id) => (id && byId.get(id)) || null;
}

const FIELDS = ['handle', 'displayName', 'profileUrl', 'externalId', 'notes'] as const;

/**
 * Social accounts (社交账号): own platform accounts, personas, tags, status, logs and device links.
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
    if (qy.instanceId === 'none') where.push(isNull(sa.instanceId));
    else if (qy.instanceId) where.push(eq(sa.instanceId, qy.instanceId));
    if (qy.personaId === 'none') where.push(isNull(sa.personaId));
    else if (qy.personaId) where.push(eq(sa.personaId, qy.personaId));
    if (qy.lang === 'none') where.push(isNull(sa.lang));
    else if (qy.lang) where.push(eq(sa.lang, qy.lang));
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
    // 我的媒体号 platform tabs (owner 2026-11-21 「分IG/YOUTUBE 2个页签」): counts under every filter except platform.
    const byPlatformRows = await db.select({ platform: sa.platform, n: sql<number>`count(*)::int` }).from(sa)
      .where(where.length ? and(...where) : undefined).groupBy(sa.platform);
    const byPlatform = Object.fromEntries(byPlatformRows.map((r) => [r.platform, r.n]));
    if (qy.platform) where.push(eq(sa.platform, qy.platform));
    const cond = where.length ? and(...where) : undefined;
    const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(sa).where(cond);
    const rows = await db.select().from(sa).where(cond).orderBy(desc(sa.createdAt), desc(sa.id))
      .limit(qy.pageSize).offset((qy.page - 1) * qy.pageSize);
    return { items: await toItems(req.user, rows), total, byPlatform, page: qy.page, pageSize: qy.pageSize };
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
      if (b.personaId) await assertPersonaFor(ownerId, b.personaId, 'account', tx);
      const [row] = await tx.insert(sa).values({
        userId: ownerId, platform: b.platform, handle: b.handle,
        displayName: blank(b.displayName) ?? null, profileUrl: blank(b.profileUrl) ?? platform.profileUrl(b.handle),
        externalId: blank(b.externalId) ?? null, personaId: b.personaId ?? null, lang: b.lang ?? null,
        notes: blank(b.notes) ?? null, createdBy: req.user.id,
      }).returning().catch((err) => { throw isUniqueViolation(err, 'social_accounts_platform_handle') ? handleTaken(b.platform, b.handle) : err; });
      if (b.tags?.length) await setAccountTags(tx, row!.id, b.tags);
      await writeLogs(tx, req.user, [
        { accountId: row!.id, action: 'create', field: null, fromValue: null, toValue: `${platform.name} @${row!.handle}` },
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
      if (b.personaId !== undefined && b.personaId !== cur.personaId) {
        if (b.personaId) await assertPersonaFor(cur.userId, b.personaId, 'account', tx);
        set.personaId = b.personaId;
        const names = await personaNames(tx, [cur.personaId, b.personaId ?? null]);
        logs.push({ accountId, action: 'update', field: 'persona', fromValue: names(cur.personaId), toValue: names(b.personaId) });
      }
      if (b.lang !== undefined && b.lang !== cur.lang) {
        set.lang = b.lang;
        logs.push({ accountId, action: 'update', field: 'lang', fromValue: cur.lang, toValue: b.lang });
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

  /**
   * 立即检测: queues the automatic check on the account's cloud phone (check.ts; the manual "mark checked"
   * was removed on 2026-11-18). Owner (or admin); refused with a code when it can't run.
   */
  app.post('/api/social/accounts/:id/check', { schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const task = await requestAccountCheck(req.user, acc);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  /**
   * 从云手机同步 (sync.ts): reads the Instagram account logged in on a phone the caller may operate and creates /
   * updates the social account. Owner = the caller; admins may pick any user. 202 + task (result via the task).
   */
  app.post('/api/social/sync-from-device', {
    schema: { body: z.object({ instanceId: z.string().uuid(), ownerId: z.string().uuid().optional() }) },
  }, async (req, reply) => {
    const task = await requestAccountSync(req.user, req.body.instanceId, req.body.ownerId);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  /**
   * 同步 of one account (the single button of 我的媒体号, owner 2026-11-18): step 1 = 从云手机同步 on its linked phone
   * (same task, RBAC and codes as above), step 2 = its feed collection, queued by step 1 once it succeeded.
   */
  app.post('/api/social/accounts/:id/sync', { schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    if (acc.platform !== 'instagram') throw badRequest('该平台不支持从云手机同步', 'account_sync.unsupported_platform', { platform: acc.platform });
    if (!acc.instanceId) throw badRequest('账号未绑定云手机，不能同步', 'account_sync.no_device');
    await assertAccountDevice(req.user, acc);
    const task = await requestAccountSync(req.user, acc.instanceId, undefined, { feed: true });
    if (req.audit) req.audit.extra = { taskId: task.id, instanceId: acc.instanceId };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  /** 自动发现 now (admin): the hourly `dumpsys account` round over every eligible phone. */
  app.post('/api/social/discover', { preHandler: app.requireAdmin }, async () => ({ discovery: await discoverDeviceAccounts() }));

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
        action: z.enum(['set-persona', 'set-lang', 'add-tags', 'remove-tags', 'unlink', 'delete']),
        /** set-persona: null clears */
        personaId: z.string().uuid().nullable().optional(),
        /** set-lang: null clears */
        lang: Lang.nullable().optional(),
        tags: Tags.optional(),
      }),
    },
  }, async (req) => {
    const { action } = req.body;
    const ids = [...new Set(req.body.ids)];
    if (action === 'set-persona' && req.body.personaId === undefined) throw badRequest('personaId is required', 'social.batch_persona_required');
    if (action === 'set-lang' && req.body.lang === undefined) throw badRequest('lang is required', 'social.batch_lang_required');
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
      if (action === 'set-persona') {
        const pid = req.body.personaId ?? null;
        // one lookup; a personal persona must belong to every selected account's owner
        if (pid) {
          const p = await assertPersonaFor(visible[0]!.userId, pid, 'account', tx);
          if (p.ownerType === 'user' && visible.some((r) => r.userId !== p.ownerId)) throw badRequest('人设不存在或不能用于这个账号', 'persona.account_not_allowed');
        }
        const moving = visible.filter((r) => r.personaId !== pid);
        const names = await personaNames(tx, [pid, ...moving.map((r) => r.personaId)]);
        for (const r of moving) logs.push({ accountId: r.id, action: 'update', field: 'persona', fromValue: names(r.personaId), toValue: names(pid) });
        if (moving.length) await tx.update(sa).set({ personaId: pid }).where(inArray(sa.id, moving.map((r) => r.id)));
        n = moving.length;
      }
      if (action === 'set-lang') {
        const lang = req.body.lang ?? null;
        const moving = visible.filter((r) => r.lang !== lang);
        for (const r of moving) logs.push({ accountId: r.id, action: 'update', field: 'lang', fromValue: r.lang, toValue: lang });
        if (moving.length) await tx.update(sa).set({ lang }).where(inArray(sa.id, moving.map((r) => r.id)));
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
};
