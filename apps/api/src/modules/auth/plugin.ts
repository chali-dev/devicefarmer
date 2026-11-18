import fjwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import type { AuthUser } from './rbac.js';
import { assertMenuAllowed, menuRuleFor } from './role-menus.js';

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string }; user: AuthUser }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
    requireAdmin: (req: FastifyRequest) => Promise<void>;
    /** Verifies a raw token (used by WebSocket first-message auth). */
    userFromToken: (token: string) => Promise<AuthUser>;
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(fjwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: '12h' },
  });

  // Always re-load the user so role changes / disabling take effect immediately.
  async function loadUser(sub: string): Promise<AuthUser> {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, sub));
    if (!u || u.disabled) throw unauthorized('account disabled or removed', 'auth.account_disabled');
    return { id: u.id, username: u.username, role: u.role };
  }

  app.decorate('userFromToken', async (token: string) => {
    let payload: { sub: string };
    try { payload = app.jwt.verify<{ sub: string }>(token); } catch { throw unauthorized('invalid token'); }
    return loadUser(payload.sub);
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    let payload: { sub: string };
    try { payload = await req.jwtVerify<{ sub: string }>(); } catch { throw unauthorized(); }
    req.user = await loadUser(payload.sub);
  });

  // 角色菜单权限 (role-menus.ts): a menu switched off for users closes its own endpoints. onRequest, i.e. before body
  // validation, so a refused request is a 403 whatever it carries; only for paths of a MENU_API rule. Without a valid
  // token nothing happens here (the route's own authenticate answers 401).
  app.addHook('onRequest', async (req) => {
    const rule = menuRuleFor(req.method, req.url);
    if (!rule) return;
    let payload: { sub: string };
    try { payload = await req.jwtVerify<{ sub: string }>(); } catch { return; }
    const [u] = await db.select({ id: schema.users.id, username: schema.users.username, role: schema.users.role, disabled: schema.users.disabled })
      .from(schema.users).where(eq(schema.users.id, payload.sub));
    if (!u || u.disabled) return;
    await assertMenuAllowed({ id: u.id, username: u.username, role: u.role }, rule);
  });

  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    await app.authenticate(req);
    if (req.user.role !== 'admin') throw forbidden('admin only', 'auth.admin_only');
  });
});
