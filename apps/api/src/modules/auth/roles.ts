import { and, asc, count, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { invalidateMenuCache, normaliseMenus, validateMenus } from './role-menus.js';

/**
 * 自定义角色 (权限管理, owner decision 2026-11-18, admin only): besides the two built-in roles (管理员, 普通用户) an admin
 * adds roles with a name, an optional description and their own set of grantable menus. A custom role is a variant of
 * the `user` role (users.role stays 'user', users.role_id points here): same data scope and RBAC as a normal user, only
 * the menus differ (auth/role-menus.ts). Admin-only menus are never grantable to any role.
 * Codes: role.not_found (404), role.name_taken (409, case-insensitive), role.name_reserved (400), role.in_use (409
 * {count}: users still have the role; deleting never moves them silently), rbac.menu_unknown / rbac.menu_not_grantable.
 */
const RESERVED = ['管理员', '普通用户', '用户', 'admin', 'user', 'administrator', 'normal user'];
const Name = z.string().trim().min(1).max(32);
const Description = z.string().trim().max(200).nullable();
const Menus = z.array(z.string().min(1).max(40)).max(50);
const Id = z.object({ id: z.string().uuid() });

function assertName(name: string) {
  if (RESERVED.includes(name.toLowerCase())) throw badRequest(`角色名「${name}」为内置角色保留`, 'role.name_reserved', { name });
}
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505'
  || (e as { cause?: { code?: string } })?.cause?.code === '23505';
const nameTaken = (name: string) => conflict(`角色名「${name}」已存在`, 'role.name_taken', { name });

/** Users counted as members: role 'user' only (a stale role_id on an admin, e.g. promoted by an older colour, is not). */
export async function listRoles() {
  const [rows, counts] = await Promise.all([
    db.select().from(schema.roles).orderBy(asc(schema.roles.createdAt), asc(schema.roles.name)),
    db.select({ roleId: schema.users.roleId, n: count() }).from(schema.users)
      .where(and(eq(schema.users.role, 'user'), isNotNull(schema.users.roleId))).groupBy(schema.users.roleId),
  ]);
  const byRole = new Map(counts.map((c) => [c.roleId, c.n]));
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, menus: normaliseMenus(r.menus),
    userCount: byRole.get(r.id) ?? 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }));
}

async function roleView(id: string) {
  const r = (await listRoles()).find((x) => x.id === id);
  if (!r) throw notFound('角色不存在', 'role.not_found');
  return r;
}

export const roleRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/api/roles', async () => ({ roles: await listRoles() }));

  app.post('/api/roles', {
    schema: { body: z.object({ name: Name, description: Description.optional(), menus: Menus.default([]) }).strict() },
  }, async (req, reply) => {
    const { name, description, menus } = req.body;
    assertName(name);
    const valid = validateMenus(menus);
    let id: string;
    try {
      const [r] = await db.insert(schema.roles).values({ name, description: description || null, menus: valid }).returning({ id: schema.roles.id });
      id = r!.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken(name);
      throw e;
    }
    invalidateMenuCache();
    reply.code(201);
    return { role: await roleView(id) };
  });

  app.patch('/api/roles/:id', {
    schema: { params: Id, body: z.object({ name: Name.optional(), description: Description.optional(), menus: Menus.optional() }).strict() },
  }, async (req) => {
    const { name, description, menus } = req.body;
    if (name === undefined && description === undefined && menus === undefined) throw badRequest('nothing to update', 'common.nothing_to_update');
    if (name !== undefined) assertName(name);
    const set: Partial<typeof schema.roles.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) set.name = name;
    if (description !== undefined) set.description = description || null;
    if (menus !== undefined) set.menus = validateMenus(menus);
    try {
      const [r] = await db.update(schema.roles).set(set).where(eq(schema.roles.id, req.params.id)).returning({ id: schema.roles.id });
      if (!r) throw notFound('角色不存在', 'role.not_found');
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken(name!);
      throw e;
    }
    invalidateMenuCache();
    return { role: await roleView(req.params.id) };
  });

  app.delete('/api/roles/:id', { schema: { params: Id } }, async (req, reply) => {
    await db.transaction(async (tx) => {
      // FOR UPDATE: an assignment in parallel (FK key-share lock) waits for this and then fails role.not_found.
      const [r] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.id, req.params.id)).for('update');
      if (!r) throw notFound('角色不存在', 'role.not_found');
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(schema.users)
        .where(and(eq(schema.users.roleId, r.id), eq(schema.users.role, 'user')));
      if (n > 0) throw conflict(`还有 ${n} 个用户使用该角色，请先为他们更换角色`, 'role.in_use', { count: n });
      // Stale references of admins (role_id is only meaningful for role 'user') must not block the FK.
      await tx.update(schema.users).set({ roleId: null }).where(eq(schema.users.roleId, r.id));
      await tx.delete(schema.roles).where(eq(schema.roles.id, r.id));
    });
    invalidateMenuCache();
    reply.code(204);
  });
};
