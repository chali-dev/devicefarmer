import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { ContentCategory } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { ScopedCreateBody, ScopedListQuery, ScopedPatchBody, scopedList } from '../../lib/scoped-list.js';
import { isAdmin } from '../auth/rbac.js';

/**
 * 内容分类 (content categories), same model as personas (lib/scoped-list.ts): public categories are managed by admins
 * and usable by everyone; personal ones belong to one user (others get 404; admins see and manage all). A content
 * (`contents.category_id`) may use a public category or one of its owner's (`assertCategoryFor`). Deleting or merging
 * a category clears/moves the contents' reference, never the contents.
 */
const CC = schema.contentCategories;
const C = schema.contents;
const Id = z.object({ id: z.string().uuid() });
const scoped = scopedList('content_category', '分类', CC, CC);

type Exec = Pick<typeof db, 'select'>;
const findCategory = async (id: string, exec: Exec = db) => (await exec.select().from(CC).where(eq(CC.id, id)))[0];

/** Throws 400 `content_category.not_allowed` unless the category exists and fits a content owned by `ownerUserId`. */
export async function assertCategoryFor(ownerUserId: string, categoryId: string, exec: Exec = db): Promise<ContentCategory> {
  const row = await findCategory(categoryId, exec);
  if (!row || !scoped.fits(row, ownerUserId)) throw badRequest('分类不存在或不能用于这条内容', 'content_category.not_allowed');
  return row;
}

/** Shape of `content.category` in responses. */
export const categoryRef = (x: ContentCategory) => ({ id: x.id, name: x.name, ownerType: x.ownerType, ownerId: x.ownerId });

export const contentCategoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /** `count` = contents using the category that the caller can see (admin: all; else own), one grouped query. */
  app.get('/api/content-categories', { schema: { querystring: ScopedListQuery } }, async (req) => {
    const { scope } = req.query;
    const where = scoped.listWhere(req.user, scope, req.query.ownerId);
    const counts = db.select({ categoryId: C.categoryId, n: sql<number>`count(*)::int`.as('n') }).from(C)
      .where(and(isNotNull(C.categoryId), isAdmin(req.user) ? undefined : eq(C.userId, req.user.id))).groupBy(C.categoryId).as('c');
    const rows = await db.select({ x: CC, ownerName: schema.users.username, count: sql<number>`coalesce(${counts.n}, 0)` }).from(CC)
      .leftJoin(counts, eq(counts.categoryId, CC.id)).leftJoin(schema.users, eq(schema.users.id, CC.ownerId))
      .where(where).orderBy(...(scope === 'all-users' ? [asc(schema.users.username)] : []), asc(CC.sort), asc(CC.name));
    return {
      categories: rows.map((r) => ({ ...r.x, ownerName: r.ownerName ?? null, count: r.count, writable: r.x.ownerType === 'user' || isAdmin(req.user) })),
    };
  });

  /** scope public (admin) or mine; admins may create a personal category for another user with ownerId. */
  app.post('/api/content-categories', { schema: { body: ScopedCreateBody } }, async (req, reply) => {
    const b = req.body;
    const { ownerId, sort } = await scoped.createTarget(req.user, b);
    const [row] = await scoped.uniqueName(b.name, () => db.insert(CC).values({
      ownerType: ownerId ? 'user' : 'public', ownerId, name: b.name, description: b.description ?? null, sort, createdBy: req.user.id,
    }).returning());
    if (req.audit) req.audit.extra = { id: row!.id };
    reply.code(201);
    return { category: row };
  });

  app.patch('/api/content-categories/:id', { schema: { params: Id, body: ScopedPatchBody } }, async (req) => {
    const cur = scoped.manageable(req.user, await findCategory(req.params.id));
    const set = scoped.patchSet(req.body);
    const [row] = await scoped.uniqueName(req.body.name ?? cur.name, () => db.update(CC).set(set).where(eq(CC.id, cur.id)).returning());
    return { category: row };
  });

  /** Contents using it become 未分类. */
  app.delete('/api/content-categories/:id', { schema: { params: Id } }, async (req, reply) => {
    const cur = scoped.manageable(req.user, await findCategory(req.params.id));
    await db.transaction(async (tx) => {
      const moved = await tx.update(C).set({ categoryId: null }).where(eq(C.categoryId, cur.id)).returning({ id: C.id });
      await tx.delete(CC).where(eq(CC.id, cur.id));
      if (req.audit) req.audit.extra = { contents: moved.length };
    });
    reply.code(204);
  });

  /** Moves the contents to `into`, then deletes the source (public → public; personal → same owner's or public). */
  app.post('/api/content-categories/:id/merge', { schema: { params: Id, body: z.object({ into: z.string().uuid() }) } }, async (req) => {
    const src = scoped.manageable(req.user, await findCategory(req.params.id));
    const dst = scoped.visible(req.user, await findCategory(req.body.into));
    if (req.audit) req.audit.target = src.name;
    scoped.assertMerge(src, dst);
    const moved = await db.transaction(async (tx) => {
      const rows = await tx.update(C).set({ categoryId: dst.id }).where(eq(C.categoryId, src.id)).returning({ id: C.id });
      await tx.delete(CC).where(eq(CC.id, src.id));
      return rows.length;
    });
    if (req.audit) req.audit.extra = { into: dst.name, contents: moved };
    return { category: dst, moved };
  });
};

/** Categories by id (content responses). */
export async function categoriesByIds(ids: string[]): Promise<Map<string, ContentCategory>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  return new Map((await db.select().from(CC).where(inArray(CC.id, uniq))).map((r) => [r.id, r]));
}
