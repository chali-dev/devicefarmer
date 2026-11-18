import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isAdmin } from '../auth/rbac.js';
import { visibleAccount } from '../social/social.js';
import { accountPosts, accountRows, accountScope, dailyRows, POST_SORTS, dayRange, MAX_RANGE_DAYS, summary, utcDay } from './analytics.js';

const Id = z.object({ id: z.string().uuid() });
const Range = z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).default(7);
/**
 * Account analytics (账号分析) of own social accounts, read only: there is no data source any more (the
 * official-API task was removed on 2026-11-18, manual entry before); previously collected rows stay
 * readable. Users see their own accounts (others 404), admins all, optionally filtered by owner. Days are UTC.
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
    return {
      account: account!,
      from: range[0], to,
      days: range.map((day) => {
        const r = byDay.get(day);
        const { id: _id, day: _d, ...v } = r ?? { id: '', day: '' };
        return r ? { day, ...v } : { day, source: null };
      }),
    };
  });

  /** Own posts with per-post likes/comments as they were stored earlier. */
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
    return accountPosts(acc.id, req.query);
  });
};
