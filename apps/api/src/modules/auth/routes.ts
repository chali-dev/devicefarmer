import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, unauthorized } from '../../lib/errors.js';

/** Public profile of a user (never includes passwordHash). */
const profileColumns = {
  id: schema.users.id,
  username: schema.users.username,
  role: schema.users.role,
  displayName: schema.users.displayName,
  email: schema.users.email,
  builtin: schema.users.builtin,
};

async function loadProfile(id: string) {
  const [u] = await db.select(profileColumns).from(schema.users).where(eq(schema.users.id, id));
  if (!u) throw unauthorized('account disabled or removed');
  return u;
}

// '' (after trimming) clears the field.
const emptyToNull = (v: string) => (v === '' ? null : v);

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/auth/login', {
    schema: { body: z.object({ username: z.string().min(1), password: z.string().min(1) }) },
  }, async (req) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.username, req.body.username));
    // Compare even when the user is missing to keep timing similar.
    const ok = await bcrypt.compare(req.body.password, u?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!u || !ok || u.disabled) throw unauthorized('invalid username or password');
    const token = app.jwt.sign({ sub: u.id });
    return { token, user: { id: u.id, username: u.username, role: u.role, displayName: u.displayName, email: u.email, builtin: u.builtin } };
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => ({ user: await loadProfile(req.user.id) }));

  app.patch('/api/auth/me', {
    preHandler: app.authenticate,
    schema: {
      body: z.object({
        displayName: z.string().trim().max(40).transform(emptyToNull).optional(),
        email: z.union([z.literal(''), z.string().trim().max(254).pipe(z.email())]).transform(emptyToNull).optional(),
      }),
    },
  }, async (req) => {
    const set: { displayName?: string | null; email?: string | null } = {};
    if (req.body.displayName !== undefined) set.displayName = req.body.displayName;
    if (req.body.email !== undefined) set.email = req.body.email;
    if (Object.keys(set).length) await db.update(schema.users).set(set).where(eq(schema.users.id, req.user.id));
    return { user: await loadProfile(req.user.id) };
  });

  app.post('/api/auth/password', {
    preHandler: app.authenticate,
    schema: {
      body: z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(128),
      }),
    },
  }, async (req, reply) => {
    const [u] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, req.user.id));
    if (!u) throw unauthorized('account disabled or removed');
    if (!(await bcrypt.compare(req.body.currentPassword, u.passwordHash))) throw badRequest('当前密码不正确');
    if (req.body.newPassword === req.body.currentPassword) throw badRequest('新密码不能与当前密码相同');
    const passwordHash = await bcrypt.hash(req.body.newPassword, 10);
    await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, req.user.id));
    return reply.code(204).send();
  });
};
