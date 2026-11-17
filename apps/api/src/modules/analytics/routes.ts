import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { assertPlatformEnabled } from '../../lib/platforms-enabled.js';
import { isAdmin } from '../auth/rbac.js';
import { ACCOUNT_REF_TYPE } from '../platforms/check.js';
import { appOptions } from '../platforms/credentials.js';
import { connectionFor } from '../platforms/connections.js';
import { adapterById } from '../platforms/index.js';
import { visibleAccount } from '../social/social.js';
import { createTask } from '../tasks/core.js';
import {
  accountLabel, accountRows, accountScope, dailyRows, dayRange, MAX_RANGE_DAYS, pendingStats, STATS_TASK, summary, upsertDay, utcDay,
} from './analytics.js';

const Id = z.object({ id: z.string().uuid() });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && utcDay(new Date(`${d}T00:00:00Z`)) === d, 'invalid date');
const Range = z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).default(7);
const Count = z.number().int().min(0).max(1e13).nullable().optional();
const StatsBody = z.object({
  /** UTC day (default today). */
  day: Day.optional(),
  followers: Count, following: Count, posts: Count,
  /** Activity of that day. */
  views: Count, likes: Count, shares: Count, comments: Count,
});

/**
 * Account analytics (账号分析) of own social accounts. Users see their own accounts (others 404),
 * admins all, optionally filtered by owner. Days are UTC.
 */
export const analyticsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/analytics/summary', {
    schema: {
      querystring: z.object({
        days: Range,
        ownerId: z.string().uuid().optional(),
        platform: z.string().max(32).optional(),
      }),
    },
  }, async (req) => summary(accountScope({ admin: isAdmin(req.user), userId: req.user.id, ownerId: req.query.ownerId, platform: req.query.platform }), req.query.days));

  /** One account: per-day rows of the range (empty days included) and the account's state. */
  app.get('/api/analytics/accounts/:id', { schema: { params: Id, querystring: z.object({ days: Range }) } }, async (req) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const to = utcDay(new Date());
    const range = dayRange(to, req.query.days);
    const scope = accountScope({ admin: true, userId: req.user.id, accountId: acc.id });
    const [[account], rows] = await Promise.all([accountRows(scope), dailyRows(scope, range[0]!, to)]);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const adapter = adapterById(acc.platform);
    return {
      account: account!,
      apiStats: !!adapter && adapter.capabilities(await appOptions(acc.platform)).accountStats,
      from: range[0], to,
      days: range.map((day) => {
        const r = byDay.get(day);
        const { id: _id, day: _d, ...v } = r ?? { id: '', day: '' };
        return r ? { day, ...v } : { day, source: null };
      }),
    };
  });

  app.post('/api/analytics/accounts/:id/stats', { schema: { params: Id, body: StatsBody } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const { day: d, ...values } = req.body;
    if (Object.values(values).every((v) => v === undefined || v === null)) throw badRequest('至少填写一项数据', 'analytics.stats_empty');
    const day = d ?? utcDay(new Date());
    if (day > utcDay(new Date())) throw badRequest('日期不能晚于今天', 'analytics.future_day');
    if (req.audit) req.audit.extra = { day };
    const row = await upsertDay(db, acc.id, day, values, 'manual', { createdBy: req.user.id });
    reply.code(201);
    return { stats: row };
  });

  app.delete('/api/analytics/accounts/:id/stats/:day', { schema: { params: z.object({ id: z.string().uuid(), day: Day }) } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const st = schema.socialAccountStats;
    const del = await db.delete(st).where(and(eq(st.socialAccountId, acc.id), eq(st.day, req.params.day))).returning({ id: st.id });
    if (!del.length) throw notFound('该日没有数据', 'analytics.stats_not_found');
    reply.code(204);
  });

  /** "Refresh now" through the official API (task account-stats). */
  app.post('/api/analytics/accounts/:id/refresh', { schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    assertPlatformEnabled(acc.platform);
    const adapter = adapterById(acc.platform);
    if (!adapter || !adapter.capabilities(await appOptions(acc.platform)).accountStats) {
      throw badRequest('该平台没有可用的官方数据接口，请手动录入', 'analytics.unsupported', { platform: acc.platform });
    }
    if (!(await connectionFor(acc.id))) throw conflict('该账号未通过官方接口授权，请手动录入', 'analytics.not_connected');
    if ((await pendingStats([acc.id])).has(acc.id)) throw conflict('该账号的数据正在刷新', 'analytics.refresh_in_progress');
    const { task } = await createTask({
      type: STATS_TASK, userId: req.user.id, label: accountLabel(acc), refType: ACCOUNT_REF_TYPE, refId: acc.id, payload: { socialAccountId: acc.id },
    });
    reply.code(202);
    return { taskId: task.id };
  });
};
