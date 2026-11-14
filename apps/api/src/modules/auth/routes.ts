import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { unauthorized } from '../../lib/errors.js';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/auth/login', {
    schema: { body: z.object({ username: z.string().min(1), password: z.string().min(1) }) },
  }, async (req) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.username, req.body.username));
    // Compare even when the user is missing to keep timing similar.
    const ok = await bcrypt.compare(req.body.password, u?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!u || !ok || u.disabled) throw unauthorized('invalid username or password');
    const token = app.jwt.sign({ sub: u.id });
    return { token, user: { id: u.id, username: u.username, role: u.role } };
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => ({ user: req.user }));
};
