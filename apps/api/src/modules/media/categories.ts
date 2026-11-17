import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { ScopedCreateBody, ScopedListQuery, ScopedPatchBody, scopedList } from '../../lib/scoped-list.js';
import { isAdmin } from '../auth/rbac.js';

/**
 * 素材分类 (media categories), same model as personas / content categories (lib/scoped-list.ts): public categories are
 * managed by admins, personal ones belong to one user (others get 404; admins see and manage all); names are unique per
 * owner case-insensitively. Unlike those lists a category only holds assets of exactly its own owner (public assets in
 * public categories, a user's assets in that user's categories: media.ts `assertCategoryFor`), so a merge stays within
 * one owner (`mergeIntoPublic: false`). Deleting or merging clears/moves the assets' reference, never the assets.
 */
const MC = schema.mediaCategories;
const MA = schema.mediaAssets;
const Id = z.object({ id: z.string().uuid() });
const scoped = scopedList('media_category', '分类', MC, MC, { mergeIntoPublic: false });

const findCategory = async (id: string) => (await db.select().from(MC).where(eq(MC.id, id)))[0];

export const mediaCategoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * public / mine / all-users (admin, optional ownerId); `scope=mine&ownerId=` (admin) still lists that user's categories.
   * `count` = assets in the category the caller can see (not deleted; public assets only when ready for non-admins), one
   * grouped query.
   */
  app.get('/api/media/categories', { schema: { querystring: ScopedListQuery } }, async (req) => {
    const { scope, ownerId } = req.query;
    let where;
    if (scope === 'mine' && ownerId && ownerId !== req.user.id) {
      if (!isAdmin(req.user)) throw scoped.adminOnly();
      where = eq(MC.ownerId, ownerId);
    } else where = scoped.listWhere(req.user, scope, ownerId);
    const counts = db.select({ categoryId: MA.categoryId, n: sql<number>`count(*)::int`.as('n') }).from(MA)
      .where(and(isNotNull(MA.categoryId), isNull(MA.deletedAt), isAdmin(req.user) ? undefined : or(eq(MA.ownerType, 'user'), eq(MA.status, 'ready'))))
      .groupBy(MA.categoryId).as('c');
    const rows = await db.select({ x: MC, ownerName: schema.users.username, count: sql<number>`coalesce(${counts.n}, 0)` }).from(MC)
      .leftJoin(counts, eq(counts.categoryId, MC.id)).leftJoin(schema.users, eq(schema.users.id, MC.ownerId))
      .where(where).orderBy(...(scope === 'all-users' ? [asc(schema.users.username)] : []), asc(MC.sort), asc(MC.name));
    return {
      categories: rows.map((r) => ({ ...r.x, ownerName: r.ownerName ?? null, count: r.count, writable: r.x.ownerType === 'user' || isAdmin(req.user) })),
    };
  });

  /** scope public (admin) or mine; admins may create a personal category for another user with ownerId. */
  app.post('/api/media/categories', { schema: { body: ScopedCreateBody } }, async (req, reply) => {
    const b = req.body;
    const { ownerId, sort } = await scoped.createTarget(req.user, b);
    const [row] = await scoped.uniqueName(b.name, () => db.insert(MC).values({
      ownerType: ownerId ? 'user' : 'public', ownerId, name: b.name, description: b.description ?? null, sort,
    }).returning());
    if (req.audit) req.audit.extra = { id: row!.id };
    reply.code(201);
    return { category: row };
  });

  app.patch('/api/media/categories/:id', { schema: { params: Id, body: ScopedPatchBody } }, async (req) => {
    const cur = scoped.manageable(req.user, await findCategory(req.params.id));
    const set = scoped.patchSet(req.body);
    const [row] = await scoped.uniqueName(req.body.name ?? cur.name, () => db.update(MC).set(set).where(eq(MC.id, cur.id)).returning());
    return { category: row };
  });

  /** Assets in the category become 未分类. */
  app.delete('/api/media/categories/:id', { schema: { params: Id } }, async (req, reply) => {
    const cur = scoped.manageable(req.user, await findCategory(req.params.id));
    await db.transaction(async (tx) => {
      const moved = await tx.update(MA).set({ categoryId: null }).where(eq(MA.categoryId, cur.id)).returning({ id: MA.id });
      await tx.delete(MC).where(eq(MC.id, cur.id));
      if (req.audit) req.audit.extra = { assets: moved.length };
    });
    reply.code(204);
  });

  /** Moves the assets to `into` (same owner only: public → public, personal → the same user's), then deletes the source. */
  app.post('/api/media/categories/:id/merge', { schema: { params: Id, body: z.object({ into: z.string().uuid() }) } }, async (req) => {
    const src = scoped.manageable(req.user, await findCategory(req.params.id));
    const dst = scoped.visible(req.user, await findCategory(req.body.into));
    if (req.audit) req.audit.target = src.name;
    scoped.assertMerge(src, dst);
    const moved = await db.transaction(async (tx) => {
      const rows = await tx.update(MA).set({ categoryId: dst.id }).where(eq(MA.categoryId, src.id)).returning({ id: MA.id });
      await tx.delete(MC).where(eq(MC.id, src.id));
      return rows.length;
    });
    if (req.audit) req.audit.extra = { into: dst.name, assets: moved };
    return { category: dst, moved };
  });
};
