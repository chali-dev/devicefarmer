import fjwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import type { AuthUser } from './rbac.js';

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

  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    await app.authenticate(req);
    if (req.user.role !== 'admin') throw forbidden('admin only', 'auth.admin_only');
  });
});
