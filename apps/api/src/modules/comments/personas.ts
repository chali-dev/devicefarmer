import { and, asc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Persona } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { writeLogs } from '../social/social.js';

/**
 * 人设 (personas) of the script library, scoped like media categories: public personas are managed by admins and usable
 * by everyone; personal ones belong to one user (others get 404; admins see and manage all). Templates reference one
 * via `comment_templates.persona_id`: a shared template only a public persona, a private one a public persona or one of
 * its owner's (`assertPersonaFor`). Deleting or merging a persona moves/clears the reference, never the templates.
 */
const P = schema.personas;
const TPL = schema.commentTemplates;
const SA = schema.socialAccounts;
const Id = z.object({ id: z.string().uuid() });
const Name = z.string().trim().min(1).max(50);
const Description = z.string().trim().max(200).nullable().optional().transform((v) => (v === '' ? null : v));
const Sort = z.number().int().min(-100000).max(100000);

/** Template visibility for the per-persona counts (same rule as the template list). */
const visibleTemplates = (user: AuthUser): SQL | undefined => (isAdmin(user) ? undefined : or(isNull(TPL.userId), eq(TPL.userId, user.id)));

type Exec = Pick<typeof db, 'select'>;

/** A public persona fits everything; a personal one only things owned by its owner (`ownerUserId`, null = shared). */
export const personaFits = (p: Persona, ownerUserId: string | null) => p.ownerType === 'public' || (ownerUserId !== null && p.ownerId === ownerUserId);

/**
 * Throws 400 unless the persona exists and fits something owned by `ownerUserId` (null = shared): a template
 * (`persona.not_allowed`) or a social account (账号人设, `persona.account_not_allowed`).
 */
export async function assertPersonaFor(ownerUserId: string | null, personaId: string, target: 'template' | 'account' = 'template', exec: Exec = db): Promise<Persona> {
  const [p] = await exec.select().from(P).where(eq(P.id, personaId));
  if (!p || !personaFits(p, ownerUserId)) {
    throw target === 'account'
      ? badRequest('人设不存在或不能用于这个账号', 'persona.account_not_allowed')
      : badRequest('人设不存在或不能用于这条话术', 'persona.not_allowed');
  }
  return p;
}

/** Account log rows for a persona change on the given accounts (names, from → to). */
async function logAccountPersona(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], user: AuthUser, accountIds: string[], from: string, to: string | null, message: string) {
  await writeLogs(tx, user, accountIds.map((accountId) => ({ accountId, action: 'update' as const, field: 'persona', fromValue: from, toValue: to, message })));
}

/** Persona the user may see (public: everyone; personal: owner or admin). 404 otherwise. */
async function visiblePersona(user: AuthUser, id: string): Promise<Persona> {
  const [p] = await db.select().from(P).where(eq(P.id, id));
  if (!p || (p.ownerType === 'user' && p.ownerId !== user.id && !isAdmin(user))) throw notFound('人设不存在', 'persona.not_found');
  return p;
}
/** Persona the user may manage (public: admin; personal: owner or admin). */
async function manageablePersona(user: AuthUser, id: string): Promise<Persona> {
  const p = await visiblePersona(user, id);
  if (p.ownerType === 'public' && !isAdmin(user)) throw forbidden('仅管理员可以管理公共人设', 'persona.admin_only');
  return p;
}

function uniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}
async function nameTaken<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err) {
    if (uniqueViolation(err)) throw conflict('人设名称已存在', 'persona.exists', { name });
    throw err;
  }
}

export const personaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * public = public personas; mine = the caller's; all-users = every user's personal personas (admin, optional ownerId).
   * `count` = templates using the persona that the caller can see (one grouped query).
   */
  app.get('/api/personas', {
    schema: { querystring: z.object({ scope: z.enum(['public', 'mine', 'all-users']).default('public'), ownerId: z.string().uuid().optional() }) },
  }, async (req) => {
    const { scope, ownerId } = req.query;
    if (scope === 'all-users' && !isAdmin(req.user)) throw forbidden('仅管理员可以查看其他用户的人设', 'persona.admin_only');
    const where = scope === 'public' ? eq(P.ownerType, 'public')
      : scope === 'mine' ? eq(P.ownerId, req.user.id)
        : ownerId ? eq(P.ownerId, ownerId) : isNotNull(P.ownerId);
    const counts = db.select({ personaId: TPL.personaId, n: sql<number>`count(*)::int`.as('n') }).from(TPL)
      .where(and(isNotNull(TPL.personaId), visibleTemplates(req.user))).groupBy(TPL.personaId).as('c');
    const rows = await db.select({ p: P, ownerName: schema.users.username, count: sql<number>`coalesce(${counts.n}, 0)` }).from(P)
      .leftJoin(counts, eq(counts.personaId, P.id)).leftJoin(schema.users, eq(schema.users.id, P.ownerId))
      .where(where).orderBy(...(scope === 'all-users' ? [asc(schema.users.username)] : []), asc(P.sort), asc(P.name));
    return {
      personas: rows.map((r) => ({
        ...r.p, ownerName: r.ownerName ?? null, count: r.count, writable: r.p.ownerType === 'user' || isAdmin(req.user),
      })),
    };
  });

  /** scope public (admin) or mine; admins may create a personal persona for another user with ownerId. */
  app.post('/api/personas', {
    schema: { body: z.object({ scope: z.enum(['public', 'mine']), ownerId: z.string().uuid().optional(), name: Name, description: Description, sort: Sort.optional() }) },
  }, async (req, reply) => {
    const b = req.body;
    if (b.scope === 'public' && !isAdmin(req.user)) throw forbidden('仅管理员可以管理公共人设', 'persona.admin_only');
    if (b.ownerId && b.ownerId !== req.user.id && !isAdmin(req.user)) throw forbidden('仅管理员可以管理其他用户的人设', 'persona.admin_only');
    const ownerId = b.scope === 'public' ? null : b.ownerId ?? req.user.id;
    if (ownerId && ownerId !== req.user.id) {
      const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerId));
      if (!u) throw notFound('用户不存在', 'users.not_found');
    }
    const owner = ownerId ? eq(P.ownerId, ownerId) : isNull(P.ownerId);
    const sort = b.sort ?? ((await db.select({ max: sql<number | null>`max(${P.sort})` }).from(P).where(owner))[0]?.max ?? -1) + 1;
    const [row] = await nameTaken(b.name, () => db.insert(P).values({
      ownerType: ownerId ? 'user' : 'public', ownerId, name: b.name, description: b.description ?? null, sort, createdBy: req.user.id,
    }).returning());
    if (req.audit) req.audit.extra = { id: row!.id };
    reply.code(201);
    return { persona: row };
  });

  app.patch('/api/personas/:id', {
    schema: { params: Id, body: z.object({ name: Name.optional(), description: Description, sort: Sort.optional() }) },
  }, async (req) => {
    const p = await manageablePersona(req.user, req.params.id);
    const set = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) throw badRequest('nothing to update', 'common.nothing_to_update');
    const [row] = await nameTaken(req.body.name ?? p.name, () => db.update(P).set(set).where(eq(P.id, p.id)).returning());
    return { persona: row };
  });

  /** Templates and accounts using it become 未设人设 (templates' legacy text is cleared too, see persona-data-migration.ts). */
  app.delete('/api/personas/:id', { schema: { params: Id } }, async (req, reply) => {
    const p = await manageablePersona(req.user, req.params.id);
    await db.transaction(async (tx) => {
      const moved = await tx.update(TPL).set({ personaId: null, persona: null }).where(eq(TPL.personaId, p.id)).returning({ id: TPL.id });
      const accounts = await tx.update(SA).set({ personaId: null }).where(eq(SA.personaId, p.id)).returning({ id: SA.id });
      await logAccountPersona(tx, req.user, accounts.map((a) => a.id), p.name, null, 'persona deleted');
      await tx.delete(P).where(eq(P.id, p.id));
      if (req.audit) req.audit.extra = { templates: moved.length, accounts: accounts.length };
    });
    reply.code(204);
  });

  /**
   * Moves the templates and accounts to `into`, then deletes the source. Allowed: public → public (admin), personal → the same
   * owner's personal persona or a public one (every template/account using a personal persona belongs to its owner).
   */
  app.post('/api/personas/:id/merge', { schema: { params: Id, body: z.object({ into: z.string().uuid() }) } }, async (req) => {
    const src = await manageablePersona(req.user, req.params.id);
    const dst = await visiblePersona(req.user, req.body.into);
    if (req.audit) req.audit.target = src.name;
    if (src.id === dst.id) throw badRequest('不能合并到自身', 'persona.merge_same');
    const ok = dst.ownerType === 'public' || (src.ownerType === 'user' && dst.ownerId === src.ownerId);
    if (!ok) throw badRequest('只能合并到同一范围的人设（个人人设可以合并到公共人设）', 'persona.merge_scope');
    const moved = await db.transaction(async (tx) => {
      const rows = await tx.update(TPL).set({ personaId: dst.id, persona: null }).where(eq(TPL.personaId, src.id)).returning({ id: TPL.id });
      const accounts = await tx.update(SA).set({ personaId: dst.id }).where(eq(SA.personaId, src.id)).returning({ id: SA.id });
      await logAccountPersona(tx, req.user, accounts.map((a) => a.id), src.name, dst.name, 'persona merged');
      await tx.delete(P).where(eq(P.id, src.id));
      return { templates: rows.length, accounts: accounts.length };
    });
    if (req.audit) req.audit.extra = { into: dst.name, ...moved };
    return { persona: dst, moved: moved.templates, movedAccounts: moved.accounts };
  });
};
