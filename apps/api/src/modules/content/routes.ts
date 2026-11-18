import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { CONTENT_STATUSES, POST_TYPES } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { distribute } from '../publish/publish.js';
import { csv, toPublishItems } from '../publish/routes.js';
import { BATCH_ACTIONS, BATCH_MAX, batchContents } from './batch.js';
import {
  assertNoUnfinishedPublish, assertTargetAccounts, assertUsableMedia, ownerOf, refreshContentStatus, setContentMedia, setContentTags, setContentTargets,
  toContentItems, visibleContent,
} from './content.js';
import { assertCategoryFor } from './categories.js';
import { getLanguageSettings, Lang, publicTranslation, translationsOf } from './languages.js';

const c = schema.contents;
const Id = z.object({ id: z.string().uuid() });
const Tags = z.array(z.string().trim().min(1).max(32)).max(20);
const like = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

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
  /** 内容分类: a public category or one of the owner's (null clears). */
  categoryId: z.string().uuid().nullable().optional(),
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
  /** One status or a csv (list tabs: draft | ready,scheduled | published,partially_published | failed | archived). */
  status: csv(z.enum(CONTENT_STATUSES)).optional(),
  /** category id, or 'none' (未分类) */
  categoryId: z.union([z.literal('none'), z.string().uuid()]).optional(),
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
    if (q.categoryId === 'none') where.push(isNull(c.categoryId));
    else if (q.categoryId) where.push(eq(c.categoryId, q.categoryId));
    if (q.tag) {
      where.push(sql`exists (select 1 from content_tag_links l join content_tags t on t.id = l.tag_id where l.content_id = ${c.id} and lower(t.name) = ${q.tag.toLowerCase().replace(/^#+/, '')})`);
    }
    if (q.lang) where.push(or(eq(c.lang, q.lang), sql`exists (select 1 from content_translations x where x.content_id = ${c.id} and x.lang = ${q.lang})`)!);
    if (q.q) where.push(or(ilike(c.title, like(q.q)), ilike(c.body, like(q.q)))!);
    const cond = and(...where, q.status?.length ? inArray(c.status, q.status) : undefined);
    // byStatus: counts per status under every filter except the status one (the list tabs).
    const [[{ total } = { total: 0 }], rows, counts] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(c).where(cond),
      db.select().from(c).where(cond).orderBy(desc(c.updatedAt), desc(c.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
      db.select({ s: c.status, n: sql<number>`count(*)::int` }).from(c).where(and(...where)).groupBy(c.status),
    ]);
    const byStatus = Object.fromEntries(CONTENT_STATUSES.map((s) => [s, counts.find((x) => x.s === s)?.n ?? 0]));
    return { items: await toContentItems(rows, req.user), total, page: q.page, pageSize: q.pageSize, byStatus };
  });

  /** Tags in use (filter suggestions); categories come from /api/content-categories. */
  app.get('/api/contents/facets', { schema: { querystring: z.object({ ownerId: z.string().uuid().optional() }) } }, async (req) => {
    const cond = ownerWhere(req.user, req.query.ownerId);
    const tags = await db.selectDistinct({ v: schema.contentTags.name }).from(schema.contentTagLinks)
      .innerJoin(schema.contentTags, eq(schema.contentTags.id, schema.contentTagLinks.tagId))
      .innerJoin(c, eq(c.id, schema.contentTagLinks.contentId)).where(cond).orderBy(asc(schema.contentTags.name)).limit(500);
    return { tags: tags.map((x) => x.v) };
  });

  app.post('/api/contents', { schema: { body: CreateBody } }, async (req, reply) => {
    const b = req.body;
    const owner = await resolveOwner(req.user, b.ownerId);
    const media = await assertUsableMedia(req.user, owner, b.mediaIds ?? []);
    const targets = await assertTargetAccounts(req.user, owner.id, b.targetIds ?? []);
    const category = b.categoryId ? await assertCategoryFor(owner.id, b.categoryId) : null;
    const stage = b.stage ?? 'draft';
    if (stage === 'archived') throw badRequest('新内容不能直接归档', 'content.bad_stage');
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.insert(c).values({
        userId: owner.id, title: b.title, body: b.body ?? '', categoryId: category?.id ?? null, stage, status: stage,
        lang: b.lang !== undefined ? b.lang : (await getLanguageSettings()).defaultSource,
        platformHints: b.platformHints ?? {}, createdBy: req.user.id,
      }).returning();
      await setContentMedia(tx, r!.id, media.map((m) => m.id));
      await setContentTags(tx, r!.id, b.tags ?? []);
      await setContentTargets(tx, r!.id, targets);
      return r!;
    });
    if (req.audit) req.audit.extra = { id: row.id, media: media.length, ...(category ? { category: category.name } : {}) };
    reply.code(201);
    return { content: (await toContentItems([row], req.user))[0] };
  });

  /**
   * Batch actions (批量操作) on visible contents: an invisible id fails the whole batch with 404; refused rows are
   * returned in `skipped` with their code while the others go through (see batch.ts).
   */
  app.post('/api/contents/batch', {
    schema: {
      body: z.object({
        ids: z.array(z.string().uuid()).min(1).max(BATCH_MAX),
        action: z.enum(BATCH_ACTIONS),
        /** set-category: null clears */
        categoryId: z.string().uuid().nullable().optional(),
        tags: Tags.optional(),
      }),
    },
  }, async (req) => {
    const res = await batchContents(req.user, req.body);
    if (req.audit) req.audit.extra = { ok: res.ok.length, skipped: res.skipped.length, changed: res.changed, ...(res.cancelledTasks !== undefined ? { cancelledTasks: res.cancelledTasks } : {}) };
    return res;
  });

  app.get('/api/contents/:id', { schema: { params: Id } }, async (req) => {
    const row = await visibleContent(req.user, req.params.id);
    // Users see only publish tasks of their own accounts: an admin may have distributed this content to
    // another user's account, whose handle must not reach the content owner (运营只能看到自己的媒体号).
    const tasks = await db.select().from(schema.publishTasks)
      .where(and(eq(schema.publishTasks.contentId, row.id), isAdmin(req.user) ? undefined : eq(schema.publishTasks.userId, req.user.id)))
      .orderBy(desc(schema.publishTasks.scheduledAt));
    return { content: (await toContentItems([row], req.user))[0], translations: await translationsOf(row.id), publishTasks: await toPublishItems(tasks, req.user) };
  });

  app.put('/api/contents/:id', { schema: { params: Id, body: UpdateBody } }, async (req) => {
    const cur = await visibleContent(req.user, req.params.id);
    const b = req.body;
    const media = b.mediaIds ? await assertUsableMedia(req.user, await ownerOf(cur.userId), b.mediaIds) : null;
    const targets = b.targetIds ? await assertTargetAccounts(req.user, cur.userId, b.targetIds) : null;
    const category = b.categoryId ? await assertCategoryFor(cur.userId, b.categoryId) : null;
    if (req.audit && b.categoryId !== undefined) req.audit.extra = { category: category?.name ?? null };
    await db.transaction(async (tx) => {
      const locked = await visibleContent(req.user, cur.id, tx, true);
      const set: Partial<typeof c.$inferInsert> = {};
      if (b.title !== undefined) set.title = b.title;
      if (b.body !== undefined) set.body = b.body;
      // The legacy text is cleared whenever the category changes (see content-category-data-migration.ts).
      if (b.categoryId !== undefined) Object.assign(set, { categoryId: b.categoryId, category: null });
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
    return { content: (await toContentItems([row!], req.user))[0] };
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
