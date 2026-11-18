import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { ALERT_CHANNEL_MIN_SEVERITIES } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { isUniqueViolation } from '../proxies/pool.js';
import { scheduleAccountChecks } from '../platforms/check.js';
import { deleteAllRead, deleteOwn, markAllRead, markRead, scheduleNotifyCleanup, unreadCount } from './notify.js';
import { CHANNEL_TYPES, getChannel, publicChannel, testChannel, validChannelConfig } from './channels.js';
import { ALERT_KIND_IDS, ALERT_KINDS, CHANNEL_KIND_IDS, getRules, LIMITS, saveRules } from './rules.js';
import './triggers.js'; // registers the generic task-failure alert

const N = schema.notifications;
const Id = z.object({ id: z.string().uuid() });
const KindRule = z.object({ inApp: z.boolean().optional() }).strict();
const C = schema.alertChannels;
const ChannelName = z.string().trim().min(1).max(60);
const ChannelKinds = z.array(z.enum(CHANNEL_KIND_IDS as [string, ...string[]])).max(CHANNEL_KIND_IDS.length).transform((k) => [...new Set(k)]);
const MinSeverity = z.enum(ALERT_CHANNEL_MIN_SEVERITIES).nullable();
const ChannelConfig = z.record(z.string(), z.unknown());
const nameTaken = (name: string) => (err: unknown): never => {
  if (isUniqueViolation(err, 'alert_channels_name_unique')) throw conflict('通道名称已存在', 'alerts.channel_name_taken', { name });
  throw err;
};
async function channelOr404(id: string) {
  const ch = await getChannel(id);
  if (!ch) throw notFound('告警通道不存在', 'alerts.channel_not_found');
  return ch;
}

/** Notifications of the signed-in user (own rows only) + admin alert settings (rules) and alert channels. */
export const notifyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * Own notifications, newest first. Filters: `read` all|unread|read (legacy `unread=1` = unread), `kind` (csv of
   * alert kinds), `from` (inclusive) / `to` (exclusive) on created_at; paging by `offset` + `limit` (or the
   * older keyset `before`). `total` counts the filtered rows, `unread` all of the user's unread ones.
   */
  app.get('/api/notifications', {
    schema: {
      querystring: z.object({
        unread: z.enum(['0', '1']).optional(),
        read: z.enum(['all', 'unread', 'read']).optional(),
        kind: z.string().max(400).optional().transform((v) => (v ? [...new Set(v.split(',').map((k) => k.trim()).filter(Boolean))] : []))
          .pipe(z.array(z.enum(ALERT_KIND_IDS as [string, ...string[]])).max(ALERT_KIND_IDS.length)),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
        before: z.coerce.date().optional(),
      }),
    },
  }, async (req) => {
    const q = req.query;
    const read = q.read ?? (q.unread === '1' ? 'unread' : 'all');
    const where = and(
      eq(N.userId, req.user.id),
      read === 'unread' ? isNull(N.readAt) : read === 'read' ? isNotNull(N.readAt) : undefined,
      q.kind.length ? inArray(N.kind, q.kind) : undefined,
      q.from ? gte(N.createdAt, q.from) : undefined,
      q.to ? lt(N.createdAt, q.to) : undefined,
      q.before ? lt(N.createdAt, q.before) : undefined,
    );
    const [rows, [count]] = await Promise.all([
      db.select().from(N).where(where).orderBy(desc(N.createdAt), desc(N.id)).limit(q.limit).offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(N).where(where),
    ]);
    return { notifications: rows, total: count?.n ?? 0, unread: await unreadCount(req.user.id) };
  });

  app.post('/api/notifications/:id/read', { schema: { params: Id } }, async (req) => {
    const row = await markRead(req.user.id, req.params.id);
    if (!row) throw notFound('notification not found', 'alerts.not_found');
    return { notification: row, unread: await unreadCount(req.user.id) };
  });

  app.post('/api/notifications/read-all', async (req) => ({ updated: await markAllRead(req.user.id), unread: 0 }));

  /**
   * Deletes own notifications (inbox clean-up). All or nothing: any id that is not one of the caller's
   * notifications (someone else's, or already gone) makes the whole batch a 404 and nothing is deleted.
   * Alert de-duplication lives in `alert_states`, so deleting a notification never re-triggers or silences an alert.
   */
  app.post('/api/notifications/delete', {
    schema: { body: z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).strict() },
  }, async (req) => {
    const deleted = await deleteOwn(req.user.id, req.body.ids);
    if (deleted === null) throw notFound('notification not found', 'alerts.not_found');
    return { deleted, unread: await unreadCount(req.user.id) };
  });

  /** Deletes all of the caller's read notifications. */
  app.post('/api/notifications/delete-read', async (req) => ({ deleted: await deleteAllRead(req.user.id), unread: await unreadCount(req.user.id) }));

  // ---------------------------------------------------------------- admin settings

  app.get('/api/settings/alerts', { preHandler: app.requireAdmin }, async () => ({
    rules: await getRules(), limits: LIMITS,
    kinds: ALERT_KIND_IDS.map((k) => ({ kind: k, severity: ALERT_KINDS[k].severity, refType: ALERT_KINDS[k].refType, recoverable: ALERT_KINDS[k].recoverable })),
  }));

  app.put('/api/settings/alerts', {
    preHandler: app.requireAdmin,
    schema: {
      body: z.object({
        kinds: z.partialRecord(z.enum(ALERT_KIND_IDS as [string, ...string[]]), KindRule).optional(),
        cooldownMinutes: z.number().int().min(0).max(LIMITS.cooldownMax).optional(),
        notifyAdmins: z.boolean().optional(),
        recovered: z.boolean().optional(),
        retentionDays: z.number().int().min(1).max(LIMITS.retentionMax).optional(),
        accountCheckHours: z.number().int().min(1).max(LIMITS.accountCheckMax).nullable().optional(),
      }).strict(),
    },
  }, async (req) => ({ rules: await saveRules(req.body as Parameters<typeof saveRules>[0]) }));

  // ---------------------------------------------------------------- alert channels (告警通道, admin)

  app.get('/api/alert-channels', { preHandler: app.requireAdmin }, async () => ({
    channels: (await db.select().from(C).orderBy(C.name)).map(publicChannel),
    types: CHANNEL_TYPES,
    kinds: CHANNEL_KIND_IDS.map((k) => ({ kind: k, severity: ALERT_KINDS[k].severity })),
  }));

  /** Secrets in `config` (Telegram: botToken) are sealed and never returned (`<field>Set`). */
  app.post('/api/alert-channels', {
    preHandler: app.requireAdmin,
    schema: { body: z.object({ name: ChannelName, type: z.enum(CHANNEL_TYPES), enabled: z.boolean().default(true), kinds: ChannelKinds.default([]), minSeverity: MinSeverity.default(null), config: ChannelConfig }).strict() },
  }, async (req, reply) => {
    const b = req.body;
    const config = validChannelConfig(b.type, b.config);
    const [row] = await db.insert(C).values({ name: b.name, type: b.type, enabled: b.enabled, kinds: b.kinds, minSeverity: b.minSeverity, config, createdBy: req.user.id })
      .returning().catch(nameTaken(b.name));
    reply.code(201);
    return { channel: publicChannel(row!) };
  });

  /** Partial update; `config` is merged over the stored one (an omitted / empty secret keeps the stored value). */
  app.patch('/api/alert-channels/:id', {
    preHandler: app.requireAdmin,
    schema: { params: Id, body: z.object({ name: ChannelName.optional(), enabled: z.boolean().optional(), kinds: ChannelKinds.optional(), minSeverity: MinSeverity.optional(), config: ChannelConfig.optional() }).strict() },
  }, async (req) => {
    const ch = await channelOr404(req.params.id);
    const b = req.body;
    const set = {
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      ...(b.kinds !== undefined ? { kinds: b.kinds } : {}), ...(b.minSeverity !== undefined ? { minSeverity: b.minSeverity } : {}),
      ...(b.config !== undefined ? { config: validChannelConfig(ch.type, b.config, ch.config) } : {}),
    };
    if (!Object.keys(set).length) return { channel: publicChannel(ch) };
    const [row] = await db.update(C).set(set).where(eq(C.id, ch.id)).returning().catch(nameTaken(b.name ?? ''));
    return { channel: publicChannel(row!) };
  });

  /** Tasks already queued for it end as "not sent". */
  app.delete('/api/alert-channels/:id', { preHandler: app.requireAdmin, schema: { params: Id } }, async (req, reply) => {
    const ch = await channelOr404(req.params.id);
    await db.delete(C).where(eq(C.id, ch.id));
    reply.code(204);
  });

  /** Sends a test message now (also while disabled). The channel's refusal is a coded 400. */
  app.post('/api/alert-channels/:id/test', { preHandler: app.requireAdmin, schema: { params: Id } }, async (req) => testChannel(await channelOr404(req.params.id)));
};

/** Hourly jobs of this module (called from main's hourly timer and once shortly after startup). */
export function alertsHourly(log: FastifyBaseLogger): void {
  void scheduleNotifyCleanup().catch((err) => log.warn({ err }, 'notification cleanup scheduling failed'));
  void scheduleAccountChecks().then((r) => { if (r.created) log.info(r, 'account checks scheduled'); })
    .catch((err) => log.warn({ err }, 'account check scheduling failed'));
}
