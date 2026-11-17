import { and, asc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Persona } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { ScopedCreateBody, ScopedListQuery, ScopedPatchBody, scopedList } from '../../lib/scoped-list.js';
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
const scoped = scopedList('persona', '人设', P, P);

/** Template visibility for the per-persona counts (same rule as the template list). */
const visibleTemplates = (user: AuthUser): SQL | undefined => (isAdmin(user) ? undefined : or(isNull(TPL.userId), eq(TPL.userId, user.id)));

type Exec = Pick<typeof db, 'select'>;

/** A public persona fits everything; a personal one only things owned by its owner (`ownerUserId`, null = shared). */
export const personaFits = (p: Persona, ownerUserId: string | null) => scoped.fits(p, ownerUserId);

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

const findPersona = async (id: string) => (await db.select().from(P).where(eq(P.id, id)))[0];
const visiblePersona = async (user: AuthUser, id: string) => scoped.visible(user, await findPersona(id));
const manageablePersona = async (user: AuthUser, id: string) => scoped.manageable(user, await findPersona(id));

export const personaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * public = public personas; mine = the caller's; all-users = every user's personal personas (admin, optional ownerId).
   * `count` = templates using the persona that the caller can see (one grouped query).
   */
  app.get('/api/personas', { schema: { querystring: ScopedListQuery } }, async (req) => {
    const { scope } = req.query;
    const where = scoped.listWhere(req.user, scope, req.query.ownerId);
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
  app.post('/api/personas', { schema: { body: ScopedCreateBody } }, async (req, reply) => {
    const b = req.body;
    const { ownerId, sort } = await scoped.createTarget(req.user, b);
    const [row] = await scoped.uniqueName(b.name, () => db.insert(P).values({
      ownerType: ownerId ? 'user' : 'public', ownerId, name: b.name, description: b.description ?? null, sort, createdBy: req.user.id,
    }).returning());
    if (req.audit) req.audit.extra = { id: row!.id };
    reply.code(201);
    return { persona: row };
  });

  app.patch('/api/personas/:id', {
    schema: { params: Id, body: ScopedPatchBody },
  }, async (req) => {
    const p = await manageablePersona(req.user, req.params.id);
    const set = scoped.patchSet(req.body);
    const [row] = await scoped.uniqueName(req.body.name ?? p.name, () => db.update(P).set(set).where(eq(P.id, p.id)).returning());
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
    scoped.assertMerge(src, dst);
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
