import { and, asc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Persona } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ScopedCreateBody, ScopedListQuery, ScopedPatchBody, scopedList } from '../../lib/scoped-list.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { writeLogs } from '../social/social.js';
import { bannedHits, exampleWhere, flatStyle, MAX_EXAMPLES, normaliseStyle, PERSONA_LENGTHS, PersonaStyleInput, styleOf } from './persona-style.js';

/**
 * 人设 (personas) of the script library, scoped like media categories: public personas are managed by admins and usable
 * by everyone; personal ones belong to one user (others get 404; admins see and manage all). Templates reference one
 * via `comment_templates.persona_id` (required since 2026-11-18): a shared template only a public persona, a private one a
 * public persona or one of its owner's (`assertPersonaFor`). Deleting a persona deletes its templates. Personas cannot be
 * merged (owner decision 2026-11-18; 内容分类/素材分类 keep their merge).
 *
 * One form (人设页 `/personas`, owner decision 2026-11-18) holds everything: name, 一句话定位 (`description`), 风格 (`style`:
 * one style for posts and comments, see persona-style.ts), 范例 (one list of ≤ 20 for posts and comments = templates of
 * the persona in its own scope, edited through the template API; POST may create the first ones in the same transaction).
 * POST/PATCH take all of it. The persona form only has AI测试 (modules/ai, preview); drafts are made on the social accounts.
 */
const P = schema.personas;
const TPL = schema.commentTemplates;
const SA = schema.socialAccounts;
const Id = z.object({ id: z.string().uuid() });
const scoped = scopedList('persona', '人设', P, P);
/** Suffix of a copy's name: 「原名 (副本)」, then 「原名 (副本 2)」, … (names are at most 50 characters). */
const COPY_SUFFIX = '副本';
const NAME_MAX = 50;
/** Name of a copy for an owner who already has `taken` (lower-case) names. */
export function copyName(source: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const suffix = ` (${COPY_SUFFIX}${i > 1 ? ` ${i}` : ''})`;
    const name = `${[...source].slice(0, NAME_MAX - suffix.length).join('').trimEnd()}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Template visibility for the per-persona counts (same rule as the template list). */
const visibleTemplates = (user: AuthUser): SQL | undefined => (isAdmin(user) ? undefined : or(isNull(TPL.userId), eq(TPL.userId, user.id)));

type Exec = Pick<typeof db, 'select'>;

/** A persona row for lists/responses: style with defaults. */
export const publicPersona = ({ style: _s, ...p }: Persona) => ({
  ...p, style: styleOf({ style: _s }),
});

/** Persona-only fields of the create/patch bodies (style replaces the whole stored style). */
const PersonaFields = { style: PersonaStyleInput.optional() };
/** 范例 created with a new persona (same limits as the form: ≤ MAX_EXAMPLES, ≤ 2200 chars each). */
const NewExamples = z.array(z.string().trim().min(1).max(2200)).max(MAX_EXAMPLES);
const CreateBody = ScopedCreateBody.extend({ ...PersonaFields, examples: NewExamples.optional() });
const PatchBody = ScopedPatchBody.extend(PersonaFields);

function personaSet(b: z.infer<typeof PatchBody>) {
  const set: Partial<typeof P.$inferInsert> = {};
  if (b.style !== undefined) set.style = normaliseStyle(b.style);
  return set;
}

/** Template name of an example: its first 30 characters (as the form does). */
const exampleName = (text: string) => text.replace(/\s+/g, ' ').slice(0, 30);

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
export const manageablePersona = async (user: AuthUser, id: string) => scoped.manageable(user, await findPersona(id));

export const personaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * public = public personas; mine = the caller's; all-users = every user's personal personas (admin, optional ownerId).
   * `count` = templates using the persona that the caller can see, `accounts` = social accounts with it as 账号人设 that the
   * caller can see (admin: all; else own), one grouped query each. No generation runs here (the 人设 page has no AI column
   * since 2026-11-18): the last runs are in GET /api/personas/:id for managers.
   */
  app.get('/api/personas', { schema: { querystring: ScopedListQuery } }, async (req) => {
    const { scope } = req.query;
    const where = scoped.listWhere(req.user, scope, req.query.ownerId);
    const counts = db.select({ personaId: TPL.personaId, n: sql<number>`count(*)::int`.as('n') }).from(TPL)
      .where(and(isNotNull(TPL.personaId), visibleTemplates(req.user))).groupBy(TPL.personaId).as('c');
    const accounts = db.select({ personaId: SA.personaId, na: sql<number>`count(*)::int`.as('na') }).from(SA)
      .where(and(isNotNull(SA.personaId), isAdmin(req.user) ? undefined : eq(SA.userId, req.user.id))).groupBy(SA.personaId).as('a');
    const rows = await db.select({
      p: P, ownerName: schema.users.username, count: sql<number>`coalesce(${counts.n}, 0)`, accounts: sql<number>`coalesce(${accounts.na}, 0)`,
    }).from(P)
      .leftJoin(counts, eq(counts.personaId, P.id)).leftJoin(accounts, eq(accounts.personaId, P.id)).leftJoin(schema.users, eq(schema.users.id, P.ownerId))
      .where(where).orderBy(...(scope === 'all-users' ? [asc(schema.users.username)] : []), asc(P.sort), asc(P.name));
    const writable = (p: Persona) => p.ownerType === 'user' || isAdmin(req.user);
    return {
      personas: rows.map((r) => ({
        ...publicPersona(r.p), ownerName: r.ownerName ?? null, count: r.count, accounts: r.accounts, writable: writable(r.p),
      })),
      lengths: PERSONA_LENGTHS,
    };
  });

  /**
   * One persona (anyone who may see it): style, 范例 (templates in the persona's own scope, oldest first) and the
   * length ranges. Used by the form and by the persona card of the post editor / reply composers.
   */
  app.get('/api/personas/:id', { schema: { params: Id } }, async (req) => {
    const p = await visiblePersona(req.user, req.params.id);
    const manages = p.ownerType === 'user' || isAdmin(req.user);
    const examples = await db.select({ id: TPL.id, name: TPL.name, text: TPL.text }).from(TPL)
      .where(exampleWhere(p)).orderBy(asc(TPL.createdAt), asc(TPL.id));
    return {
      persona: { ...publicPersona(p), writable: manages },
      examples,
      lengths: PERSONA_LENGTHS, maxExamples: MAX_EXAMPLES,
    };
  });

  /**
   * scope public (admin) or mine; admins may create a personal persona for another user with ownerId. Optional
   * `examples` (texts) become its first 范例 in the same transaction (public: shared templates; personal:
   * the owner's); a text with one of the new persona's banned words → 400 persona.banned_word, nothing created.
   */
  app.post('/api/personas', { schema: { body: CreateBody } }, async (req, reply) => {
    const { examples, ...b } = req.body;
    const { ownerId, sort } = await scoped.createTarget(req.user, b);
    const extra = personaSet(b);
    const ex = examples ?? [];
    const hits = bannedHits(extra.style?.bannedWords, ex);
    if (hits.length) throw badRequest(`范例包含禁用词：${hits.join('、')}`, 'persona.banned_word', { persona: b.name, words: hits.join('、') });
    const [row] = await scoped.uniqueName(b.name, () => db.transaction(async (tx) => {
      const rows = await tx.insert(P).values({
        ownerType: ownerId ? 'user' : 'public', ownerId, name: b.name, description: b.description ?? null, sort, createdBy: req.user.id, ...extra,
      }).returning();
      // created_at 1 ms apart so the 范例 keep the form's order (listed and sent to the model oldest first).
      const t0 = Date.now();
      const tpl = ex.map((text, i) => ({ text, name: exampleName(text), personaId: rows[0]!.id, userId: ownerId, createdBy: req.user.id, createdAt: new Date(t0 + i) }));
      if (tpl.length) await tx.insert(TPL).values(tpl);
      return rows;
    }));
    if (req.audit) req.audit.extra = { id: row!.id, examples: ex.length };
    reply.code(201);
    return { persona: publicPersona(row!) };
  });

  app.patch('/api/personas/:id', {
    schema: { params: Id, body: PatchBody },
  }, async (req) => {
    const p = await manageablePersona(req.user, req.params.id);
    const { style: _s, ...scopedBody } = req.body;
    const extra = personaSet(req.body);
    const set = { ...Object.fromEntries(Object.entries(scopedBody).filter(([, v]) => v !== undefined)), ...extra };
    if (!Object.keys(set).length) scoped.patchSet({});
    const [row] = await scoped.uniqueName(req.body.name ?? p.name, () => db.update(P).set(set).where(eq(P.id, p.id)).returning());
    return { persona: publicPersona(row!) };
  });

  /**
   * Its templates (范例) are deleted with it (every template needs a persona since 2026-11-18); accounts using it become
   * 未设人设 (logged).
   */
  app.delete('/api/personas/:id', { schema: { params: Id } }, async (req, reply) => {
    const p = await manageablePersona(req.user, req.params.id);
    await db.transaction(async (tx) => {
      // 防并发: the persona row first (范例 create locks it too, comments/routes.ts assertExampleRoom), so a 范例 written
      // at the same time is either deleted with it or refused, never left behind without its persona (FK set null).
      await tx.select({ id: P.id }).from(P).where(eq(P.id, p.id)).for('update');
      const moved = await tx.delete(TPL).where(eq(TPL.personaId, p.id)).returning({ id: TPL.id });
      const accounts = await tx.update(SA).set({ personaId: null }).where(eq(SA.personaId, p.id)).returning({ id: SA.id });
      await logAccountPersona(tx, req.user, accounts.map((a) => a.id), p.name, null, 'persona deleted');
      await tx.delete(P).where(eq(P.id, p.id));
      if (req.audit) req.audit.extra = { templates: moved.length, accounts: accounts.length };
    });
    reply.code(204);
  });

  /**
   * 复制到我的人设: a new personal persona of the caller (admins: of `ownerId`, any existing user; users: only themselves,
   * another ownerId → 403 `persona.admin_only`) from any persona the caller may see (else 404): name 「原名 (副本)」 (taken
   * names, case-insensitive, get 「(副本 2)」, 「(副本 3)」…), 一句话定位, the style (single shape) and every 范例 copied as private templates of the new owner on the new persona (daily AI drafts are set per social account,
   * nothing to copy). One transaction: the limit of 20 范例 is
   * checked after the copy and a violation (`persona.examples_full`) leaves nothing behind.
   */
  app.post('/api/personas/:id/copy', {
    schema: { params: Id, body: z.object({ ownerId: z.string().uuid().optional() }).strict().nullish() },
  }, async (req, reply) => {
    const src = await visiblePersona(req.user, req.params.id);
    const ownerId = req.body?.ownerId ?? req.user.id;
    if (ownerId !== req.user.id) {
      if (!isAdmin(req.user)) throw scoped.adminOnly();
      const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerId));
      if (!u) throw notFound('用户不存在', 'users.not_found');
    }
    const { row, examples } = await scoped.uniqueName(src.name, () => db.transaction(async (tx) => {
      // Serialises copies for one owner, so two parallel copies pick different numbers.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`persona-copy:${ownerId}`}))`);
      const taken = new Set((await tx.select({ name: P.name }).from(P).where(eq(P.ownerId, ownerId))).map((x) => x.name.toLowerCase()));
      const [last] = await tx.select({ max: sql<number | null>`max(${P.sort})` }).from(P).where(eq(P.ownerId, ownerId));
      const [row] = await tx.insert(P).values({
        ownerType: 'user', ownerId, name: copyName(src.name, taken), description: src.description, sort: (last?.max ?? -1) + 1,
        style: flatStyle(src.style), createdBy: req.user.id,
      }).returning();
      const tpls = await tx.select().from(TPL).where(exampleWhere(src)).orderBy(asc(TPL.createdAt), asc(TPL.id));
      if (tpls.length) {
        // created_at 1 ms apart so the copies keep the source order (范例 are listed oldest first).
        const t0 = Date.now();
        await tx.insert(TPL).values(tpls.map((t, i) => ({
          userId: ownerId, personaId: row!.id, tags: t.tags, name: t.name, text: t.text, createdBy: req.user.id, createdAt: new Date(t0 + i),
        })));
      }
      const examples = tpls.length;
      if (examples > MAX_EXAMPLES) throw badRequest(`每个人设最多 ${MAX_EXAMPLES} 条范例`, 'persona.examples_full', { max: MAX_EXAMPLES });
      return { row: row!, examples };
    }));
    if (req.audit) req.audit.extra = { sourceId: src.id, id: row.id, name: row.name, ownerId, examples };
    reply.code(201);
    return { persona: publicPersona(row), examples };
  });

  // No merge for personas (owner decision 2026-11-18): POST /api/personas/:id/merge does not exist (404).
};
