import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { CONTENT_STATUSES, POST_TYPES } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { distribute } from '../publish/publish.js';
import { toPublishItems } from '../publish/routes.js';
import {
  assertNoUnfinishedPublish, assertTargetAccounts, assertUsableMedia, ownerOf, refreshContentStatus, setContentMedia, setContentTags, setContentTargets,
  toContentItems, visibleContent,
} from './content.js';
import { getLanguageSettings, Lang, publicTranslation, translationsOf } from './languages.js';

const c = schema.contents;
const Id = z.object({ id: z.string().uuid() });
const Tags = z.array(z.string().trim().min(1).max(32)).max(20);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const like = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const blank = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim());

const Privacy = z.enum(['public', 'unlisted', 'private']);
const Hints = z.object({
  youtube: z.object({ title: z.string().trim().max(100).optional(), description: z.string().max(5000).optional(), privacy: Privacy.optional() }).strict().optional(),
  instagram: z.object({ caption: z.string().max(2200).optional() }).strict().optional(),
  tiktok: z.object({ caption: z.string().max(2200).optional() }).strict().optional(),
  facebook: z.object({ caption: z.string().max(5000).optional() }).strict().optional(),
}).strict();

/** Text-only hints for a translation (options such as YouTube privacy stay on the content). */
const TextHints = z.object({
  youtube: z.object({ title: z.string().trim().max(100).optional(), description: z.string().max(5000).optional() }).strict().optional(),
  instagram: Hints.shape.instagram, tiktok: Hints.shape.tiktok, facebook: Hints.shape.facebook,
}).strict();
const TranslationBody = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(5000).optional(), platformHints: TextHints.optional() });
const LangParams = z.object({ id: z.string().uuid(), lang: Lang });
const ct = schema.contentTranslations;

const Editable = {
  title: z.string().trim().min(1).max(200),
  /** Source language (BCP-47); create defaults to the configured default source language. */
  lang: Lang.nullable().optional(),
  body: z.string().max(5000).optional(),
  category: optText(50),
  tags: Tags.optional(),
  mediaIds: z.array(z.string().uuid()).max(20).optional(),
  /** 发布目标: the owner's accounts, in order (concrete ids; group/persona picks are expanded by the client). */
  targetIds: z.array(z.string().uuid()).max(50).optional(),
  platformHints: Hints.optional(),
  stage: z.enum(['draft', 'ready', 'archived']).optional(),
};
const CreateBody = z.object({ ...Editable, ownerId: z.string().uuid().optional() });
const UpdateBody = z.object({ ...Editable, title: Editable.title.optional() });

const ListQuery = z.object({
  status: z.enum(CONTENT_STATUSES).optional(),
  /** exact category, or 'none' */
  category: z.string().trim().max(50).optional(),
  tag: z.string().trim().max(32).optional(),
  /** Available in this language: source language or an existing translation. */
  lang: Lang.optional(),
  q: z.string().trim().max(100).optional(),
  ownerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const Target = z.object({
  accountId: z.string().uuid(),
  title: z.string().trim().max(100).nullable().optional(),
  caption: z.string().max(5000).nullable().optional(),
  hashtags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  options: z.object({ privacy: z.string().max(20).optional() }).strict().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  postType: z.enum(POST_TYPES).optional(),
});
const DistributeBody = z.object({
  targets: z.array(Target).min(1).max(50),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  republish: z.boolean().optional(),
});

function ownerWhere(user: AuthUser, ownerId?: string): SQL | undefined {
  if (isAdmin(user)) return ownerId ? eq(c.userId, ownerId) : undefined;
  if (ownerId && ownerId !== user.id) throw forbidden('仅管理员可以查看其他用户的内容', 'content.admin_only');
  return eq(c.userId, user.id);
}

async function resolveOwner(user: AuthUser, ownerId?: string): Promise<AuthUser> {
  if (!ownerId || ownerId === user.id) return user;
  if (!isAdmin(user)) throw forbidden('仅管理员可以为其他用户创建内容', 'content.admin_only');
  return ownerOf(ownerId);
}

/**
 * Content management (内容管理): contents with ordered media references, categories, tags,
 * platform hints and the distribution to social accounts (creates publish tasks).
 */
export const contentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/contents', { schema: { querystring: ListQuery } }, async (req) => {
    const q = req.query;
    const where: (SQL | undefined)[] = [ownerWhere(req.user, q.ownerId)];
    if (q.status) where.push(eq(c.status, q.status));
    if (q.category === 'none') where.push(sql`${c.category} is null`);
    else if (q.category) where.push(eq(c.category, q.category));
    if (q.tag) {
      where.push(sql`exists (select 1 from content_tag_links l join content_tags t on t.id = l.tag_id where l.content_id = ${c.id} and lower(t.name) = ${q.tag.toLowerCase().replace(/^#+/, '')})`);
    }
    if (q.lang) where.push(or(eq(c.lang, q.lang), sql`exists (select 1 from content_translations x where x.content_id = ${c.id} and x.lang = ${q.lang})`)!);
    if (q.q) where.push(or(ilike(c.title, like(q.q)), ilike(c.body, like(q.q)))!);
    const cond = and(...where);
    const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(c).where(cond);
    const rows = await db.select().from(c).where(cond).orderBy(desc(c.updatedAt), desc(c.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: await toContentItems(rows), total, page: q.page, pageSize: q.pageSize };
  });

  /** Categories and tags in use (filter suggestions). */
  app.get('/api/contents/facets', { schema: { querystring: z.object({ ownerId: z.string().uuid().optional() }) } }, async (req) => {
    const cond = ownerWhere(req.user, req.query.ownerId);
    const [cats, tags] = await Promise.all([
      db.selectDistinct({ v: c.category }).from(c).where(and(cond, sql`${c.category} is not null`)).orderBy(asc(c.category)).limit(500),
      db.selectDistinct({ v: schema.contentTags.name }).from(schema.contentTagLinks)
        .innerJoin(schema.contentTags, eq(schema.contentTags.id, schema.contentTagLinks.tagId))
        .innerJoin(c, eq(c.id, schema.contentTagLinks.contentId)).where(cond).orderBy(asc(schema.contentTags.name)).limit(500),
    ]);
    return { categories: cats.map((x) => x.v!), tags: tags.map((x) => x.v) };
  });

  app.post('/api/contents', { schema: { body: CreateBody } }, async (req, reply) => {
    const b = req.body;
    const owner = await resolveOwner(req.user, b.ownerId);
    const media = await assertUsableMedia(req.user, owner, b.mediaIds ?? []);
    const targets = await assertTargetAccounts(req.user, owner.id, b.targetIds ?? []);
    const stage = b.stage ?? 'draft';
    if (stage === 'archived') throw badRequest('新内容不能直接归档', 'content.bad_stage');
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.insert(c).values({
        userId: owner.id, title: b.title, body: b.body ?? '', category: blank(b.category) ?? null, stage, status: stage,
        lang: b.lang !== undefined ? b.lang : (await getLanguageSettings()).defaultSource,
        platformHints: b.platformHints ?? {}, createdBy: req.user.id,
      }).returning();
      await setContentMedia(tx, r!.id, media.map((m) => m.id));
      await setContentTags(tx, r!.id, b.tags ?? []);
      await setContentTargets(tx, r!.id, targets);
      return r!;
    });
    if (req.audit) req.audit.extra = { id: row.id, media: media.length };
    reply.code(201);
    return { content: (await toContentItems([row]))[0] };
  });

  app.get('/api/contents/:id', { schema: { params: Id } }, async (req) => {
    const row = await visibleContent(req.user, req.params.id);
    const tasks = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, row.id)).orderBy(desc(schema.publishTasks.scheduledAt));
    return { content: (await toContentItems([row]))[0], translations: await translationsOf(row.id), publishTasks: await toPublishItems(tasks, req.user) };
  });

  app.put('/api/contents/:id', { schema: { params: Id, body: UpdateBody } }, async (req) => {
    const cur = await visibleContent(req.user, req.params.id);
    const b = req.body;
    const media = b.mediaIds ? await assertUsableMedia(req.user, await ownerOf(cur.userId), b.mediaIds) : null;
    const targets = b.targetIds ? await assertTargetAccounts(req.user, cur.userId, b.targetIds) : null;
    await db.transaction(async (tx) => {
      const locked = await visibleContent(req.user, cur.id, tx, true);
      const set: Partial<typeof c.$inferInsert> = {};
      if (b.title !== undefined) set.title = b.title;
      if (b.body !== undefined) set.body = b.body;
      const cat = blank(b.category);
      if (cat !== undefined) set.category = cat;
      if (b.platformHints !== undefined) set.platformHints = b.platformHints;
      if (b.lang !== undefined && b.lang !== locked.lang) {
        if (b.lang) {
          const [dup] = await tx.select({ id: ct.id }).from(ct).where(and(eq(ct.contentId, cur.id), eq(ct.lang, b.lang)));
          if (dup) throw conflict('该语言已有译文，不能作为原文语言', 'content.lang_has_translation', { lang: b.lang });
        }
        set.lang = b.lang;
      }
      if (b.stage !== undefined && b.stage !== locked.stage) {
        if (b.stage === 'archived') await assertNoUnfinishedPublish(tx, cur.id, 'archive');
        set.stage = b.stage;
      }
      set.updatedAt = new Date();
      await tx.update(c).set(set).where(eq(c.id, cur.id));
      if (media) await setContentMedia(tx, cur.id, media.map((m) => m.id));
      if (b.tags) await setContentTags(tx, cur.id, b.tags);
      if (targets) await setContentTargets(tx, cur.id, targets);
      await refreshContentStatus(cur.id, tx);
    });
    const [row] = await db.select().from(c).where(eq(c.id, cur.id));
    return { content: (await toContentItems([row!]))[0] };
  });

  /** Refused while publish tasks are unfinished; finished publish history goes with the content. */
  app.delete('/api/contents/:id', { schema: { params: Id } }, async (req, reply) => {
    await db.transaction(async (tx) => {
      const cur = await visibleContent(req.user, req.params.id, tx, true);
      await assertNoUnfinishedPublish(tx, cur.id, 'delete');
      await tx.delete(c).where(eq(c.id, cur.id));
    });
    reply.code(204);
  });

  // ---------------------------------------------------------------- translations (多语言内容, written by people)

  /** Language list for the editor + default source language (any signed-in user; admins edit it in settings). */
  app.get('/api/contents/languages', async () => {
    const { languages, defaultSource } = await getLanguageSettings();
    return { languages, defaultSource };
  });

  app.get('/api/contents/:id/translations', { schema: { params: Id } }, async (req) => {
    const row = await visibleContent(req.user, req.params.id);
    return { translations: await translationsOf(row.id) };
  });

  /** Creates or replaces the content's version in `lang` (not the source language). */
  app.put('/api/contents/:id/translations/:lang', { schema: { params: LangParams, body: TranslationBody } }, async (req, reply) => {
    const { lang } = req.params;
    const b = req.body;
    const row = await db.transaction(async (tx) => {
      const cur = await visibleContent(req.user, req.params.id, tx, true);
      if (cur.lang === lang) throw badRequest('译文语言不能与原文语言相同', 'content.translation_same_lang', { lang });
      const values = { title: b.title, body: b.body ?? '', platformHints: b.platformHints ?? {} };
      const [existing] = await tx.select({ id: ct.id }).from(ct).where(and(eq(ct.contentId, cur.id), eq(ct.lang, lang)));
      const [r] = existing
        ? await tx.update(ct).set({ ...values, updatedAt: new Date() }).where(eq(ct.id, existing.id)).returning()
        : await tx.insert(ct).values({ contentId: cur.id, lang, ...values }).returning();
      await tx.update(c).set({ updatedAt: new Date() }).where(eq(c.id, cur.id));
      if (!existing) reply.code(201);
      return r!;
    });
    if (req.audit) req.audit.extra = { lang };
    return { translation: publicTranslation(row) };
  });

  app.delete('/api/contents/:id/translations/:lang', { schema: { params: LangParams } }, async (req, reply) => {
    const cur = await visibleContent(req.user, req.params.id);
    const gone = await db.delete(ct).where(and(eq(ct.contentId, cur.id), eq(ct.lang, req.params.lang))).returning({ id: ct.id });
    if (!gone.length) throw notFound('译文不存在', 'content.translation_not_found', { lang: req.params.lang });
    await db.update(c).set({ updatedAt: new Date() }).where(eq(c.id, cur.id));
    reply.code(204);
  });

  /** One publish task per target account (scheduled now or at scheduledAt). */
  app.post('/api/contents/:id/distribute', { schema: { params: Id, body: DistributeBody } }, async (req, reply) => {
    const content = await visibleContent(req.user, req.params.id);
    const b = req.body;
    const res = await distribute(req.user, content, b.targets.map((t) => ({ ...t, scheduledAt: t.scheduledAt ? new Date(t.scheduledAt) : null })), {
      maxAttempts: b.maxAttempts, republish: b.republish,
    });
    if (req.audit) req.audit.extra = { created: res.created.map((p) => p.id), existing: res.existing.map((p) => p.id) };
    reply.code(res.created.length ? 201 : 200);
    return { created: await toPublishItems(res.created, req.user), existing: await toPublishItems(res.existing, req.user) };
  });
};
