import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest, conflict } from '../../lib/errors.js';
import { assertPlatformEnabled } from '../../lib/platforms-enabled.js';
import { isAdmin } from '../auth/rbac.js';
import { ACCOUNT_REF_TYPE } from '../platforms/check.js';
import { appOptions } from '../platforms/credentials.js';
import { connectionFor } from '../platforms/connections.js';
import { adapterById } from '../platforms/index.js';
import { platformCapabilities } from '../platforms/service.js';
import { visibleAccount } from '../social/social.js';
import { createTask } from '../tasks/core.js';
import {
  accountLabel, accountPosts, accountRows, accountScope, dailyRows, POST_SORTS, dayRange, MAX_RANGE_DAYS, pendingStats, STATS_TASK, summary, utcDay,
} from './analytics.js';

const Id = z.object({ id: z.string().uuid() });
const Range = z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).default(7);
/**
 * Account analytics (账号分析) of own social accounts. Data comes only from the official APIs (task
 * account-stats); manual entry was removed (owner decision 2026-11-18), old `manual` rows stay readable.
 * Users see their own accounts (others 404),
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

  /** Own posts with per-post likes/comments as the last refresh stored them (capability accountPosts). */
  app.get('/api/analytics/accounts/:id/posts', {
    schema: {
      params: Id,
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
        sort: z.enum(POST_SORTS).default('published'),
      }),
    },
  }, async (req) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const caps = await platformCapabilities(acc.platform);
    return { apiPosts: !!caps?.accountPosts, ...(await accountPosts(acc.id, req.query)) };
  });

  /** "Refresh now" through the official API (task account-stats). */
  app.post('/api/analytics/accounts/:id/refresh', { schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    assertPlatformEnabled(acc.platform);
    const adapter = adapterById(acc.platform);
    if (!adapter || !adapter.capabilities(await appOptions(acc.platform)).accountStats) {
      throw badRequest('该平台没有可用的官方数据接口', 'analytics.unsupported', { platform: acc.platform });
    }
    if (!(await connectionFor(acc.id))) throw conflict('该账号未通过官方接口授权', 'analytics.not_connected');
    if ((await pendingStats([acc.id])).has(acc.id)) throw conflict('该账号的数据正在刷新', 'analytics.refresh_in_progress');
    const { task } = await createTask({
      type: STATS_TASK, userId: req.user.id, label: accountLabel(acc), refType: ACCOUNT_REF_TYPE, refId: acc.id, payload: { socialAccountId: acc.id },
    });
    reply.code(202);
    return { taskId: task.id };
  });
};
