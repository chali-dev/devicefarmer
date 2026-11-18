import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { visibleAccount } from './social.js';
import { listFollowing, requestFollowingSync } from './following.js';

/**
 * 我的媒体号 → row expansion (owner 2026-11-18): 粉丝 (followers count and its changes, from the automatic account
 * check / sync readings in social_account_stats; no follower list is read) and 追踪中 (the account's real following
 * list, read from its cloud phone). RBAC = social accounts: owner + admins, others 404. Both live under
 * /api/social/accounts/:id/…, the 媒体管理 (social) menu's rule in role-menus.ts.
 */
const Id = z.object({ id: z.string().uuid() });
const DAY = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Followers: latest reading, gains vs. the last reading at or before N days ago (else the first reading inside the window), daily series. */
export function followerSummary(readings: { day: string; followers: number; approx: boolean; at: Date }[], days: number, now = new Date()) {
  const latest = readings[readings.length - 1] ?? null;
  const today = utcDay(now);
  const gain = (n: number): number | null => {
    if (!latest) return null;
    const cut = utcDay(new Date(now.getTime() - n * DAY));
    const inside = readings.filter((r) => r.day > cut);
    if (!inside.length) return null;
    const base = [...readings].reverse().find((r) => r.day <= cut) ?? (inside.length > 1 ? inside[0]! : null);
    return base ? latest.followers - base.followers : null;
  };
  const byDay = new Map(readings.map((r) => [r.day, r]));
  const series = Array.from({ length: days }, (_, i) => utcDay(new Date(now.getTime() - (days - 1 - i) * DAY)))
    .map((day) => ({ day, followers: byDay.get(day)?.followers ?? null }));
  return {
    current: latest ? { followers: latest.followers, approx: latest.approx, day: latest.day, at: latest.at } : null,
    change: { today: gain(1), d7: gain(7), d30: gain(30) },
    today,
    series,
  };
}

export const followingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/social/accounts/:id/followers', { schema: { params: Id, querystring: z.object({ days: z.coerce.number().int().min(7).max(90).default(30) }) } }, async (req) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const S = schema.socialAccountStats;
    const rows = await db.select({ day: S.day, followers: S.followers, approx: S.approx, capturedAt: S.capturedAt }).from(S)
      .where(and(eq(S.socialAccountId, acc.id), isNotNull(S.followers))).orderBy(asc(S.day));
    const readings = rows.map((r) => ({ day: String(r.day), followers: Number(r.followers), approx: (r.approx ?? []).includes('followers'), at: r.capturedAt }));
    return {
      account: { id: acc.id, platform: acc.platform, handle: acc.handle },
      lastCheckedAt: acc.lastCheckedAt, lastCheckCode: acc.lastCheckCode,
      ...followerSummary(readings, req.query.days),
    };
  });

  app.get('/api/social/accounts/:id/following', {
    schema: {
      params: Id,
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        q: z.string().max(100).optional(),
        /** include accounts no longer followed (取消追踪 history) */
        gone: z.enum(['true', 'false']).optional(),
      }),
    },
  }, async (req) => {
    const acc = await visibleAccount(req.user, req.params.id);
    return listFollowing(acc, { limit: req.query.limit, offset: req.query.offset, q: req.query.q, gone: req.query.gone === 'true' });
  });

  app.post('/api/social/accounts/:id/following/sync', { schema: { params: Id } }, async (req, reply) => {
    const acc = await visibleAccount(req.user, req.params.id);
    const task = await requestFollowingSync(req.user, acc);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });
};
