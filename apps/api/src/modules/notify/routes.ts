import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { scheduleAccountChecks } from '../platforms/check.js';
import { markAllRead, markRead, scheduleNotifyCleanup, unreadCount } from './notify.js';
import { ALERT_KIND_IDS, ALERT_KINDS, getRules, LIMITS, saveRules } from './rules.js';
import { getTelegramSettings, saveTelegramSettings, sendTestMessage, TELEGRAM_LANGS } from './telegram.js';
import './triggers.js'; // registers the generic task-failure alert

const N = schema.notifications;
const Id = z.object({ id: z.string().uuid() });
const KindRule = z.object({ inApp: z.boolean().optional(), telegram: z.boolean().optional() }).strict();

/** Notifications of the signed-in user (own rows only) + admin alert settings (rules, Telegram). */
export const notifyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/notifications', {
    schema: { querystring: z.object({ unread: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.date().optional() }) },
  }, async (req) => {
    const q = req.query;
    const rows = await db.select().from(N)
      .where(and(eq(N.userId, req.user.id), q.unread === '1' ? sql`${N.readAt} is null` : undefined, q.before ? lt(N.createdAt, q.before) : undefined))
      .orderBy(desc(N.createdAt)).limit(q.limit);
    return { notifications: rows, unread: await unreadCount(req.user.id) };
  });

  app.post('/api/notifications/:id/read', { schema: { params: Id } }, async (req) => {
    const row = await markRead(req.user.id, req.params.id);
    if (!row) throw notFound('notification not found', 'alerts.not_found');
    return { notification: row, unread: await unreadCount(req.user.id) };
  });

  app.post('/api/notifications/read-all', async (req) => ({ updated: await markAllRead(req.user.id), unread: 0 }));

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

  /** Write-only token: GET only says whether it is set. */
  app.get('/api/settings/telegram', { preHandler: app.requireAdmin }, async () => ({ telegram: await getTelegramSettings() }));

  app.put('/api/settings/telegram', {
    preHandler: app.requireAdmin,
    schema: {
      body: z.object({
        enabled: z.boolean().optional(),
        /** Numeric chat id (groups/channels are negative) or @channelusername. */
        chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, 'invalid chat id').nullable().optional(),
        /** BotFather token `<bot id>:<secret>`; null clears it. */
        token: z.string().trim().regex(/^\d{3,20}:[A-Za-z0-9_-]{30,64}$/, 'invalid bot token').nullable().optional(),
        language: z.enum(TELEGRAM_LANGS).optional(),
      }).strict(),
    },
  }, async (req) => ({ telegram: await saveTelegramSettings(req.body) }));

  /** Sends a test message with the stored settings now (also while disabled). Telegram's refusal is a coded 400. */
  app.post('/api/settings/telegram/test', { preHandler: app.requireAdmin }, async () => sendTestMessage());
};

/** Hourly jobs of this module (called from main's hourly timer and once shortly after startup). */
export function alertsHourly(log: FastifyBaseLogger): void {
  void scheduleNotifyCleanup().catch((err) => log.warn({ err }, 'notification cleanup scheduling failed'));
  void scheduleAccountChecks().then((r) => { if (r.created) log.info(r, 'account checks scheduled'); })
    .catch((err) => log.warn({ err }, 'account check scheduling failed'));
}
