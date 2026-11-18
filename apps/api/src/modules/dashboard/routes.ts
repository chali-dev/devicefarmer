import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { collectDashboard } from './registry.js';
import './widgets.js'; // registers the core widgets

const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

/** Dashboard (仪表板): one RBAC-scoped aggregate of every module's widget (see registry.ts). */
export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/dashboard', {
    schema: {
      querystring: z.object({
        /** Admin only: the numbers exactly as this user sees them. */
        userId: z.string().uuid().optional(),
        /** IANA time zone for the per-day trend (default UTC). */
        tz: z.string().max(64).refine(validTz, 'unknown time zone').default('UTC'),
      }),
    },
  }, async (req) => {
    let scope: AuthUser = req.user;
    if (req.query.userId && req.query.userId !== req.user.id) {
      if (!isAdmin(req.user)) throw forbidden('仅管理员可以查看其他用户的仪表板', 'dashboard.admin_only');
      const [u] = await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(eq(schema.users.id, req.query.userId));
      if (!u) throw notFound('用户不存在', 'users.not_found');
      scope = { id: u.id, username: u.username, role: 'user' };
    }
    const now = new Date();
    const r = await collectDashboard({ viewer: req.user, scope, admin: isAdmin(scope), now, tz: req.query.tz });
    return { generatedAt: now.toISOString(), scope: { userId: scope.id, username: scope.username, admin: isAdmin(scope) }, ...r };
  });
};
