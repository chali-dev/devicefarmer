import bcrypt from 'bcryptjs';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

const Role = z.enum(['admin', 'operator', 'viewer']);
const publicUser = { id: schema.users.id, username: schema.users.username, role: schema.users.role, disabled: schema.users.disabled, createdAt: schema.users.createdAt };

/** User management + instance grants. Admin only. */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/api/users', async () => {
    const users = await db.select(publicUser).from(schema.users).orderBy(schema.users.createdAt);
    const grants = await db.select().from(schema.instanceGrants);
    return {
      users: users.map((u) => ({ ...u, instanceIds: grants.filter((g) => g.userId === u.id).map((g) => g.instanceId) })),
    };
  });

  app.post('/api/users', {
    schema: { body: z.object({ username: z.string().regex(/^[a-zA-Z0-9_.-]{3,32}$/), password: z.string().min(8), role: Role }) },
  }, async (req, reply) => {
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    const [u] = await db.insert(schema.users).values({ username: req.body.username, passwordHash, role: req.body.role })
      .onConflictDoNothing().returning(publicUser);
    if (!u) throw conflict('username already exists');
    reply.code(201);
    return { user: u };
  });

  app.patch('/api/users/:id', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ role: Role.optional(), password: z.string().min(8).optional(), disabled: z.boolean().optional() }),
    },
  }, async (req) => {
    if (req.params.id === req.user.id && (req.body.role && req.body.role !== 'admin' || req.body.disabled)) {
      throw badRequest('you cannot demote or disable yourself');
    }
    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (req.body.role) set.role = req.body.role;
    if (req.body.disabled !== undefined) set.disabled = req.body.disabled;
    if (req.body.password) set.passwordHash = await bcrypt.hash(req.body.password, 10);
    if (Object.keys(set).length === 0) throw badRequest('nothing to update');
    const [u] = await db.update(schema.users).set(set).where(eq(schema.users.id, req.params.id)).returning(publicUser);
    if (!u) throw notFound('user not found');
    return { user: u };
  });

  app.delete('/api/users/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    if (req.params.id === req.user.id) throw badRequest('you cannot delete yourself');
    const r = await db.delete(schema.users).where(eq(schema.users.id, req.params.id)).returning({ id: schema.users.id });
    if (r.length === 0) throw notFound('user not found');
    reply.code(204);
  });

  /** Replace the set of instances a user may access. */
  app.put('/api/users/:id/grants', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ instanceIds: z.array(z.string().uuid()).max(500) }) },
  }, async (req) => {
    const ids = [...new Set(req.body.instanceIds)];
    await db.transaction(async (tx) => {
      const [u] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, req.params.id));
      if (!u) throw notFound('user not found');
      if (ids.length) {
        const found = await tx.select({ id: schema.instances.id }).from(schema.instances).where(inArray(schema.instances.id, ids));
        if (found.length !== ids.length) throw badRequest('unknown instance id');
      }
      await tx.delete(schema.instanceGrants).where(eq(schema.instanceGrants.userId, req.params.id));
      if (ids.length) await tx.insert(schema.instanceGrants).values(ids.map((instanceId) => ({ userId: req.params.id, instanceId })));
    });
    return { instanceIds: ids };
  });
};
