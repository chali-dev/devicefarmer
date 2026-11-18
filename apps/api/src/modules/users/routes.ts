import bcrypt from 'bcryptjs';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { User } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { purgeOwnerMedia } from '../media/media.js';
import { moveDeviceAccounts, type AccountMove } from '../social/assign.js';

const Role = z.enum(['admin', 'user']);
const Id = z.object({ id: z.string().uuid() });
const publicUser = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  email: schema.users.email,
  role: schema.users.role,
  disabled: schema.users.disabled,
  builtin: schema.users.builtin,
  createdAt: schema.users.createdAt,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks the target row; 404 when missing. */
async function lockUser(tx: Tx, id: string): Promise<User> {
  const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, id)).for('update');
  if (!u) throw notFound('用户不存在', 'users.not_found');
  return u;
}

/** Refuses a change that would leave no enabled admin (other admins are locked to avoid races). */
async function assertOtherEnabledAdmin(tx: Tx, exceptId: string, msg: string) {
  const others = await tx.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.role, 'admin'), eq(schema.users.disabled, false), ne(schema.users.id, exceptId))).for('update');
  if (others.length === 0) throw badRequest(msg, 'users.last_admin');
}

/** User management + device grants. Admin only. */
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
    if (!u) throw conflict('用户名已存在', 'users.username_taken');
    reply.code(201);
    return { user: u };
  });

  app.patch('/api/users/:id', {
    schema: {
      params: Id,
      body: z.object({ role: Role.optional(), password: z.string().min(8).optional(), disabled: z.boolean().optional() }),
    },
  }, async (req) => {
    const { role, password, disabled } = req.body;
    if (role === undefined && password === undefined && disabled === undefined) throw badRequest('nothing to update', 'common.nothing_to_update');
    const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;
    return db.transaction(async (tx) => {
      const target = await lockUser(tx, req.params.id);
      const demote = role !== undefined && role !== target.role && target.role === 'admin';
      const disable = disabled === true && !target.disabled;
      if (target.builtin) {
        if (role !== undefined && role !== target.role) throw badRequest('内置管理员的角色不可修改', 'users.builtin_role');
        if (disable) throw badRequest('内置管理员不可禁用', 'users.builtin_disable');
        if (password) throw badRequest('内置管理员的密码只能由其本人在个人设置中修改', 'users.builtin_password');
      }
      if (target.id === req.user.id && (demote || disable)) throw badRequest('不能降级或禁用自己', 'users.self_demote');
      if (target.role === 'admin' && !target.disabled && (demote || disable)) {
        await assertOtherEnabledAdmin(tx, target.id, '至少需要保留一个启用的管理员');
      }
      const set: Partial<typeof schema.users.$inferInsert> = {};
      if (role !== undefined) set.role = role;
      if (disabled !== undefined) set.disabled = disabled;
      if (passwordHash) set.passwordHash = passwordHash;
      const [u] = await tx.update(schema.users).set(set).where(eq(schema.users.id, target.id)).returning(publicUser);
      return { user: u! };
    });
  });

  app.delete('/api/users/:id', { schema: { params: Id } }, async (req, reply) => {
    const checkDeletable = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      const target = await lockUser(tx, req.params.id);
      if (target.builtin) throw badRequest('内置管理员不可删除', 'users.builtin_delete');
      if (target.id === req.user.id) throw badRequest('不能删除自己', 'users.self_delete');
      if (target.role === 'admin' && !target.disabled) await assertOtherEnabledAdmin(tx, target.id, '至少需要保留一个启用的管理员');
      return target;
    };
    // Validate first, then purge the user's private media files (rows would only cascade, leaving
    // files behind), then delete the user (checks repeated under the lock).
    await db.transaction(checkDeletable);
    await purgeOwnerMedia(req.params.id);
    await db.transaction(async (tx) => {
      const target = await checkDeletable(tx);
      await tx.delete(schema.users).where(eq(schema.users.id, target.id));
    });
    reply.code(204);
  });

  /**
   * Replace the set of devices a user (role `user`) may access. Admins see every device. A cloud phone belongs to one
   * user (owner decision 2026-11-18): a device newly added here that another user holds → 409 grants.device_assigned
   * (unassign it first; devices the user already had stay, also on legacy multi-user rows), and its linked social
   * accounts move to the user (social/assign.ts). Removing a device moves nothing. No page uses this endpoint any more
   * (我的云机 uses the per-device one below); the scripts set up their placeholder users with it.
   */
  app.put('/api/users/:id/grants', {
    schema: { params: Id, body: z.object({ instanceIds: z.array(z.string().uuid()).max(500) }) },
  }, async (req) => {
    const ids = [...new Set(req.body.instanceIds)].sort();
    const moved = await db.transaction(async (tx) => {
      const u = await lockUser(tx, req.params.id);
      if (u.role !== 'user') throw badRequest('管理员可访问全部设备，无需授权', 'grants.admin_not_needed');
      const found = ids.length
        ? await tx.select({ id: schema.instances.id, name: schema.instances.name }).from(schema.instances).where(inArray(schema.instances.id, ids)).orderBy(schema.instances.id).for('update')
        : [];
      if (found.length !== ids.length) throw badRequest('设备不存在', 'instances.not_found');
      const had = new Set((await tx.select({ id: schema.instanceGrants.instanceId }).from(schema.instanceGrants).where(eq(schema.instanceGrants.userId, u.id))).map((g) => g.id));
      const added = found.filter((i) => !had.has(i.id));
      if (added.length && u.disabled) throw badRequest('用户已禁用，不能分配云手机', 'grants.user_disabled');
      if (added.length) {
        const [other] = await tx.select({ instanceId: schema.instanceGrants.instanceId, username: schema.users.username }).from(schema.instanceGrants)
          .innerJoin(schema.users, eq(schema.users.id, schema.instanceGrants.userId))
          .where(and(inArray(schema.instanceGrants.instanceId, added.map((i) => i.id)), ne(schema.instanceGrants.userId, u.id))).limit(1);
        if (other) {
          const device = added.find((i) => i.id === other.instanceId)!.name;
          throw conflict(`设备 ${device} 已分配给用户 ${other.username}，一台云手机只能分配给一个用户`, 'grants.device_assigned', { device, user: other.username });
        }
      }
      await tx.delete(schema.instanceGrants).where(eq(schema.instanceGrants.userId, u.id));
      if (ids.length) await tx.insert(schema.instanceGrants).values(ids.map((instanceId) => ({ userId: u.id, instanceId })));
      const out: AccountMove[] = [];
      for (const i of added) out.push(...await moveDeviceAccounts(tx, req.user, i.id, u.id));
      return out;
    });
    if (req.audit && moved.length) req.audit.extra = { movedAccounts: moved.length, accountIds: moved.map((m) => m.id) };
    return { instanceIds: ids, movedAccounts: moved.map(({ id, handle }) => ({ id, handle })) };
  });

  /**
   * Assign one device: `userIds` = [] (unassigned, admins only) or exactly one user (role `user`, enabled); more →
   * 400 grants.single_user (owner decision 2026-11-18: a cloud phone belongs to one user). Assigning a (new) user
   * moves the device's linked social accounts to them (social/assign.ts, 409 instances.assign_account_busy while one
   * has unfinished publish tasks / replies, nothing changed); unassigning moves nothing; the same user again = no-op.
   */
  app.put('/api/instances/:id/grants', {
    schema: { params: Id, body: z.object({ userIds: z.array(z.string().uuid()).max(500) }) },
  }, async (req) => {
    const ids = [...new Set(req.body.userIds)];
    if (ids.length > 1) throw badRequest('一台云手机只能分配给一个用户', 'grants.single_user');
    const moved = await db.transaction(async (tx) => {
      const [inst] = await tx.select({ id: schema.instances.id }).from(schema.instances).where(eq(schema.instances.id, req.params.id)).for('update');
      if (!inst) throw notFound('设备不存在', 'instances.not_found');
      const cur = (await tx.select({ id: schema.instanceGrants.userId }).from(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, inst.id))).map((g) => g.id);
      const to = ids[0];
      if (!to) {
        if (cur.length) await tx.delete(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, inst.id));
        return [];
      }
      const [u] = await tx.select({ id: schema.users.id, role: schema.users.role, disabled: schema.users.disabled }).from(schema.users).where(eq(schema.users.id, to)).for('update');
      if (!u) throw badRequest('用户不存在', 'users.not_found');
      if (u.role !== 'user') throw badRequest('管理员可访问全部设备，无需授权', 'grants.admin_not_needed');
      // same user: grants unchanged; still moves linked accounts that don't follow yet (data from before this rule)
      if (cur.length === 1 && cur[0] === to) return moveDeviceAccounts(tx, req.user, inst.id, to);
      if (u.disabled && !cur.includes(to)) throw badRequest('用户已禁用，不能分配云手机', 'grants.user_disabled');
      await tx.delete(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, inst.id));
      await tx.insert(schema.instanceGrants).values({ userId: to, instanceId: inst.id });
      return moveDeviceAccounts(tx, req.user, inst.id, to);
    });
    if (req.audit && moved.length) req.audit.extra = { movedAccounts: moved.length, accountIds: moved.map((m) => m.id) };
    return { userIds: ids, movedAccounts: moved.map(({ id, handle }) => ({ id, handle })) };
  });
};
