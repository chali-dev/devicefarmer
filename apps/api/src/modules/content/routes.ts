import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { CONTENT_STATUSES, POST_TYPES, type Content, type ContentPlatformHints } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { accountPersonaIds, assertNoBannedWords } from '../comments/persona-style.js';
import { distribute } from '../publish/publish.js';
import { csv, toPublishItems } from '../publish/routes.js';
import { BATCH_ACTIONS, BATCH_MAX, batchContents } from './batch.js';
import {
  assertNoUnfinishedPublish, assertNotPublished, assertTargetAccounts, assertUsableMedia, ownerOf, type Tx, refreshContentStatus, setContentMedia, setContentTags, setContentTargets,
  toContentItems, visibleContent,
} from './content.js';
import { assertCategoryFor } from './categories.js';
import { configuredLanguages, Lang, publicTranslation, SOURCE_LANG, translationsOf } from './languages.js';

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
/**
 * A translation: its text (body / platform texts). The title is optional (owner 2026-11-20: Instagram publishes no title;
 * empty = the content's 内部名称), but a translation must carry some text.
 */
const TranslationBody = z.object({ title: z.string().trim().max(200).default(''), body: z.string().max(5000).optional(), platformHints: TextHints.optional() })
  .refine((b) => Boolean(b.title || b.body?.trim() || hintTexts(b.platformHints).some((x) => x.trim())), { message: 'translation is empty' });
const LangParams = z.object({ id: z.string().uuid(), lang: Lang });
const ct = schema.contentTranslations;

const Editable = {
  /**
   * 内部名称 (shown as the list title, never published on Instagram). Optional since 2026-11-20 (人工发文 needn't write
   * Chinese): empty → `fallbackName` (first line of the source text, else 未命名内容); the editor derives a better one.
   */
  title: z.string().trim().max(200),
  /**
   * Source language: fixed to Chinese (zh-CN) since 2026-11-18. Accepted only as zh-CN on create, and only unchanged on
   * update (older contents keep their source language, read-only; one without any may be set to zh-CN); anything else
   * → 400 content.source_lang_fixed.
   */
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

/** Text values of platform hints (titles, descriptions, captions; not options such as privacy). */
const hintTexts = (h: ContentPlatformHints | undefined) =>
  Object.values(h ?? {}).flatMap((v) => Object.entries(v ?? {}).flatMap(([k, x]) => (k !== 'privacy' && typeof x === 'string' ? [x] : [])));

/**
 * 人设禁用词 (persona.banned_word): the personas of the content = its target accounts' 账号人设 (+ the persona of an AI
 * draft). Checked whenever texts or targets are saved, and for translations.
 */
async function assertContentWords(contentId: string | null, targetIds: string[] | null, aiPersonaId: string | null | undefined, texts: (string | null | undefined)[]) {
  const ids = targetIds ?? (contentId
    ? (await db.select({ id: schema.contentTargets.accountId }).from(schema.contentTargets).where(eq(schema.contentTargets.contentId, contentId))).map((r) => r.id)
    : []);
  await assertNoBannedWords([...await accountPersonaIds(ids), aiPersonaId], texts);
}
const UpdateBody = z.object({ ...Editable, title: Editable.title.optional() });

/** 内部名称 when none was given: the first non-empty line of the text (≤ 50 chars), else 未命名内容. */
export const fallbackName = (body: string | undefined) => (body ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 50) ?? '未命名内容';

/** Key-order independent JSON (undefined values dropped), to tell a changed value from the stored one. */
const stable = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 已发布的内容不能编辑: on a content with a published task, any CHANGE of title, body, platform texts, media, targets or
 * source language is refused with 409 content.published_locked (values sent unchanged, category, stage and tags pass).
 */
async function assertUnlockedChange(exec: typeof db | Tx, cur: Content, b: z.infer<typeof UpdateBody>) {
  const changes = (b.title !== undefined && b.title !== cur.title) || (b.body !== undefined && b.body !== cur.body)
    || (b.platformHints !== undefined && stable(b.platformHints) !== stable(cur.platformHints ?? {}))
    || (b.lang !== undefined && b.lang !== cur.lang);
  let other = false;
  if (!changes && (b.mediaIds || b.targetIds)) {
    const [media, targets] = await Promise.all([
      b.mediaIds ? exec.select({ id: schema.contentMedia.assetId }).from(schema.contentMedia).where(eq(schema.contentMedia.contentId, cur.id)).orderBy(asc(schema.contentMedia.position)) : [],
      b.targetIds ? exec.select({ id: schema.contentTargets.accountId }).from(schema.contentTargets).where(eq(schema.contentTargets.contentId, cur.id)).orderBy(asc(schema.contentTargets.position)) : [],
    ]);
    other = (!!b.mediaIds && !sameList([...new Set(b.mediaIds)], media.map((r) => r.id))) || (!!b.targetIds && !sameList([...new Set(b.targetIds)], targets.map((r) => r.id)));
  }
  if (changes || other) await assertNotPublished(exec, cur.id);
}

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

/**
 * One target account: when and as what (帖子 / Reels / 限动). No per-account texts or options (owner 2026-11-19
 * 「按账号单独改文案…删干净」): every account gets the content's text in its language and the content's privacy;
 * an older body with title / caption / hashtags / options is a 400 (strict).
 */
const Target = z.object({
  accountId: z.string().uuid(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  postType: z.enum(POST_TYPES).optional(),
}).strict();
const DistributeBody = z.object({
  targets: z.array(Target).min(1).max(50),
  // 1 个内容只发布一次: an older page's `republish` is stripped (ignored); a published pair is always 409.
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
    if (!b.title) b.title = fallbackName(b.body);
    const owner = await resolveOwner(req.user, b.ownerId);
    const media = await assertUsableMedia(req.user, owner, b.mediaIds ?? []);
    const targets = await assertTargetAccounts(req.user, owner.id, b.targetIds ?? []);
    const category = b.categoryId ? await assertCategoryFor(owner.id, b.categoryId) : null;
    const stage = b.stage ?? 'draft';
    if (stage === 'archived') throw badRequest('新内容不能直接归档', 'content.bad_stage');
    if (b.lang && b.lang !== SOURCE_LANG) throw badRequest('原文语言固定为中文', 'content.source_lang_fixed', { lang: b.lang });
    await assertContentWords(null, targets, null, [b.title, b.body, ...hintTexts(b.platformHints)]);
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.insert(c).values({
        userId: owner.id, title: b.title, body: b.body ?? '', categoryId: category?.id ?? null, stage, status: stage,
        lang: SOURCE_LANG,
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
        /** publish (批量发布): one time for all (null/absent = now), post type (default feed), drafts too, preview only */
        scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
        postType: z.enum(POST_TYPES).optional(),
        includeDrafts: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
  }, async (req) => {
    const b = req.body;
    const res = await batchContents(req.user, { ...b, scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null });
    if (req.audit) {
      req.audit.extra = {
        ok: res.ok.length, skipped: res.skipped.length, changed: res.changed,
        ...(res.cancelledTasks !== undefined ? { cancelledTasks: res.cancelledTasks } : {}),
        ...(res.publish ? { tasks: res.publish.tasks, skippedCodes: [...new Set(res.skipped.map((s) => s.code))] } : {}),
      };
    }
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
    if (b.title === '') b.title = fallbackName(b.body ?? cur.body);
    // 已发布的内容不能编辑: checked first (before media / banned-word validation) and again under the row lock.
    await assertUnlockedChange(db, cur, b);
    const media = b.mediaIds ? await assertUsableMedia(req.user, await ownerOf(cur.userId), b.mediaIds) : null;
    const targets = b.targetIds ? await assertTargetAccounts(req.user, cur.userId, b.targetIds) : null;
    const category = b.categoryId ? await assertCategoryFor(cur.userId, b.categoryId) : null;
    if (req.audit && b.categoryId !== undefined) req.audit.extra = { category: category?.name ?? null };
    if (b.title !== undefined || b.body !== undefined || b.platformHints !== undefined || targets) {
      await assertContentWords(cur.id, targets, cur.aiGenerated?.personaId,
        [b.title ?? cur.title, b.body ?? cur.body, ...hintTexts(b.platformHints ?? cur.platformHints)]);
    }
    await db.transaction(async (tx) => {
      const locked = await visibleContent(req.user, cur.id, tx, true);
      await assertUnlockedChange(tx, locked, b);
      const set: Partial<typeof c.$inferInsert> = {};
      if (b.title !== undefined) set.title = b.title;
      if (b.body !== undefined) set.body = b.body;
      if (b.categoryId !== undefined) set.categoryId = b.categoryId;
      if (b.platformHints !== undefined) set.platformHints = b.platformHints;
      // The source language can no longer be changed (older contents keep theirs, read-only). The one exception: a
      // legacy content without a source language may be declared Chinese (unless it has a Chinese translation).
      if (b.lang !== undefined && b.lang !== locked.lang) {
        if (locked.lang !== null || b.lang !== SOURCE_LANG) throw badRequest('原文语言固定为中文，不能修改', 'content.source_lang_fixed', { lang: b.lang ?? '' });
        const [dup] = await tx.select({ id: ct.id }).from(ct).where(and(eq(ct.contentId, cur.id), eq(ct.lang, SOURCE_LANG)));
        if (dup) throw conflict('该语言已有译文，不能作为原文语言', 'content.lang_has_translation', { lang: SOURCE_LANG });
        set.lang = SOURCE_LANG;
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

  /**
   * Languages for the editor: `source` (zh-CN, fixed), `configured` (配置语系 = languages bound to the social accounts
   * the caller sees: own; admins all, or `ownerId`'s) and `languages` = source + configured.
   */
  app.get('/api/contents/languages', { schema: { querystring: z.object({ ownerId: z.string().uuid().optional() }) } }, async (req) => {
    const owner = !isAdmin(req.user) ? req.user.id : req.query.ownerId ?? null;
    const configured = await configuredLanguages(owner);
    return { source: SOURCE_LANG, configured, languages: [SOURCE_LANG, ...configured] };
  });

  app.get('/api/contents/:id/translations', { schema: { params: Id } }, async (req) => {
    const row = await visibleContent(req.user, req.params.id);
    return { translations: await translationsOf(row.id) };
  });

  /** Creates or replaces the content's version in `lang` (not the source language). */
  app.put('/api/contents/:id/translations/:lang', { schema: { params: LangParams, body: TranslationBody } }, async (req, reply) => {
    const { lang } = req.params;
    const b = req.body;
    const pre = await visibleContent(req.user, req.params.id);
    await assertNotPublished(db, pre.id);
    await assertContentWords(pre.id, null, pre.aiGenerated?.personaId, [b.title, b.body, ...hintTexts(b.platformHints)]);
    const row = await db.transaction(async (tx) => {
      const cur = await visibleContent(req.user, req.params.id, tx, true);
      await assertNotPublished(tx, cur.id);
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
    await assertNotPublished(db, cur.id);
    const gone = await db.delete(ct).where(and(eq(ct.contentId, cur.id), eq(ct.lang, req.params.lang))).returning({ id: ct.id });
    if (!gone.length) throw notFound('译文不存在', 'content.translation_not_found', { lang: req.params.lang });
    await db.update(c).set({ updatedAt: new Date() }).where(eq(c.id, cur.id));
    reply.code(204);
  });

  /** One publish task per target account (scheduled now or at scheduledAt). */
  app.post('/api/contents/:id/distribute', { schema: { params: Id, body: DistributeBody } }, async (req, reply) => {
    const content = await visibleContent(req.user, req.params.id);
    const b = req.body;
    const res = await distribute(req.user, content, b.targets.map((t) => ({ ...t, scheduledAt: t.scheduledAt ? new Date(t.scheduledAt) : null })));
    if (req.audit) req.audit.extra = { created: res.created.map((p) => p.id), existing: res.existing.map((p) => p.id) };
    reply.code(res.created.length ? 201 : 200);
    return { created: await toPublishItems(res.created, req.user), existing: await toPublishItems(res.existing, req.user) };
  });
};
