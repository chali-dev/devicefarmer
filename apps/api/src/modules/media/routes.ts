import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { MediaAsset, MediaProcessOptions } from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { assertInstancesAccess, isAdmin, type AuthUser } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { maxBytes, mediaLimits } from './formats.js';
import { getMediaLimitSettings } from './limits.js';
import {
  assertCanManage, assertMetaFor, canManage, createMedia, deleteMedia, getVisibleMedia, MediaMetaSchema, openMedia, ownerForScope, setTags,
  type MediaMeta, type Owner,
} from './media.js';
import { normalizeOptions, ProcessOptionsSchema } from './transform.js';

/** Owner of an upload into another user's personal media (multipart field ownerId). */
async function uploadOwnerFor(user: AuthUser, scope: string, ownerId: string): Promise<Owner> {
  if (!isAdmin(user)) throw forbidden('仅管理员可以上传到其他用户的个人素材', 'media.owner_admin_only');
  if (scope !== 'mine') throw badRequest('ownerId only works with scope mine', 'media.bad_scope');
  if (!z.string().uuid().safeParse(ownerId).success) throw notFound('用户不存在', 'users.not_found');
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerId));
  if (!u) throw notFound('用户不存在', 'users.not_found');
  return { ownerType: 'user', ownerId: u.id };
}

const Id = z.object({ id: z.string().uuid() });
const ma = schema.mediaAssets;
const mc = schema.mediaCategories;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const ListQuery = z.object({
  scope: z.enum(['public', 'mine', 'favorites', 'all-users']).default('public'),
  q: z.string().trim().max(100).optional(),
  type: z.enum(['image', 'video']).optional(),
  /** uuid, or 'none' for uncategorized */
  categoryId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  /** Comma-separated tag names; an asset must carry all of them (case-insensitive). */
  tags: z.string().trim().max(400).optional(),
  tag: z.string().trim().max(32).optional(),
  status: z.enum(['processing', 'ready', 'failed']).optional(),
  /** all-users scope (admin): one user's private media */
  ownerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

/** Visibility of a list scope for this user. */
function scopeWhere(user: AuthUser, scope: z.infer<typeof ListQuery>['scope'], ownerId?: string): SQL[] {
  const admin = isAdmin(user);
  switch (scope) {
    case 'public':
      return admin ? [eq(ma.ownerType, 'public')] : [eq(ma.ownerType, 'public'), eq(ma.status, 'ready')];
    case 'mine':
      return [eq(ma.ownerType, 'user'), eq(ma.ownerId, user.id)];
    case 'favorites':
      return [
        eq(ma.ownerType, 'public'), ...(admin ? [] : [eq(ma.status, 'ready')]),
        sql`exists (select 1 from media_favorites f where f.asset_id = ${ma.id} and f.user_id = ${user.id})`,
      ];
    case 'all-users':
      if (!admin) throw forbidden('仅管理员可以查看其他用户的素材', 'media.admin_only');
      return [eq(ma.ownerType, 'user'), ...(ownerId ? [eq(ma.ownerId, ownerId)] : [])];
  }
}

export interface MediaItem extends Omit<MediaAsset, 'fileKey' | 'thumbnailKey' | 'deletedAt'> {
  ownerName: string | null; categoryName: string | null; tags: string[]; isFavorite: boolean; canManage: boolean;
  contentUrl: string; thumbnailUrl: string | null;
}

/** Shapes rows for clients: storage keys stay server-side. */
async function toItems(user: AuthUser, rows: MediaAsset[]): Promise<MediaItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [tagRows, favRows, owners, cats] = await Promise.all([
    db.select({ assetId: schema.mediaAssetTags.assetId, name: schema.mediaTags.name }).from(schema.mediaAssetTags)
      .innerJoin(schema.mediaTags, eq(schema.mediaTags.id, schema.mediaAssetTags.tagId))
      .where(inArray(schema.mediaAssetTags.assetId, ids)).orderBy(asc(schema.mediaTags.name)),
    db.select({ assetId: schema.mediaFavorites.assetId }).from(schema.mediaFavorites)
      .where(and(eq(schema.mediaFavorites.userId, user.id), inArray(schema.mediaFavorites.assetId, ids))),
    db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users)
      .where(inArray(schema.users.id, [...new Set(rows.flatMap((r) => (r.ownerId ? [r.ownerId] : [])))].concat('00000000-0000-0000-0000-000000000000'))),
    db.select({ id: mc.id, name: mc.name }).from(mc)
      .where(inArray(mc.id, [...new Set(rows.flatMap((r) => (r.categoryId ? [r.categoryId] : [])))].concat('00000000-0000-0000-0000-000000000000'))),
  ]);
  const favs = new Set(favRows.map((f) => f.assetId));
  return rows.map(({ fileKey: _f, thumbnailKey, deletedAt: _d, ...r }) => ({
    ...r,
    ownerName: owners.find((o) => o.id === r.ownerId)?.username ?? null,
    categoryName: cats.find((c) => c.id === r.categoryId)?.name ?? null,
    tags: tagRows.filter((t) => t.assetId === r.id).map((t) => t.name),
    isFavorite: favs.has(r.id),
    canManage: canManage(user, { ...r, fileKey: '', thumbnailKey, deletedAt: null }),
    contentUrl: `/api/media/${r.id}/content`,
    thumbnailUrl: thumbnailKey ? `/api/media/${r.id}/thumbnail` : null,
  }));
}

function sendObject(reply: FastifyReply, stream: NodeJS.ReadableStream, type: string, size: number | null, filename: string, download: boolean) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  reply
    .header('content-type', type)
    .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .header('cache-control', 'private, max-age=3600')
    // User-uploaded content: never let it run as a page on the API origin.
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "sandbox; default-src 'none'");
  if (size !== null) reply.header('content-length', String(size));
  return reply.send(stream);
}

/**
 * Media library (素材库): public (admin-managed) and private (per-user) images/videos,
 * categories, tags, favorites, push to devices. See media.ts for the rules.
 */
export const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/media/limits', async () => mediaLimits(await getMediaLimitSettings()));

  app.get('/api/media', { schema: { querystring: ListQuery } }, async (req) => {
    const qy = req.query;
    const where: SQL[] = [isNull(ma.deletedAt), ...scopeWhere(req.user, qy.scope, qy.ownerId)];
    if (qy.q) {
      const l = like(qy.q);
      where.push(or(ilike(ma.name, l), ilike(ma.fileName, l),
        sql`exists (select 1 from media_asset_tags at join media_tags t on t.id = at.tag_id where at.asset_id = ${ma.id} and t.name ilike ${l})`)!);
    }
    if (qy.type) where.push(eq(ma.fileType, qy.type));
    if (qy.categoryId === 'none') where.push(isNull(ma.categoryId));
    else if (qy.categoryId) where.push(eq(ma.categoryId, qy.categoryId));
    if (qy.status) where.push(eq(ma.status, qy.status));
    const tags = [...new Set([...(qy.tags ? qy.tags.split(',') : []), ...(qy.tag ? [qy.tag] : [])].map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
    for (const t of tags) {
      where.push(sql`exists (select 1 from media_asset_tags at join media_tags t on t.id = at.tag_id where at.asset_id = ${ma.id} and lower(t.name) = ${t})`);
    }
    const cond = and(...where);
    const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(ma).where(cond);
    const rows = await db.select().from(ma).where(cond).orderBy(desc(ma.createdAt), desc(ma.id))
      .limit(qy.pageSize).offset((qy.page - 1) * qy.pageSize);
    return { items: await toItems(req.user, rows), total, page: qy.page, pageSize: qy.pageSize };
  });

  /** Tags used by assets visible in a scope (filter suggestions). */
  app.get('/api/media/tags', {
    schema: { querystring: z.object({ scope: ListQuery.shape.scope, ownerId: z.string().uuid().optional() }) },
  }, async (req) => {
    const where = and(isNull(ma.deletedAt), ...scopeWhere(req.user, req.query.scope, req.query.ownerId));
    const rows = await db.selectDistinct({ name: schema.mediaTags.name }).from(schema.mediaTags)
      .innerJoin(schema.mediaAssetTags, eq(schema.mediaAssetTags.tagId, schema.mediaTags.id))
      .innerJoin(ma, eq(ma.id, schema.mediaAssetTags.assetId))
      .where(where).orderBy(asc(schema.mediaTags.name)).limit(500);
    return { tags: rows.map((r) => r.name) };
  });

  // categories: categories.ts

  // ------------------------------------------------------------ upload
  /**
   * multipart, one file per request. Text fields BEFORE the file: scope=public|mine (public: admin),
   * optional ownerId (admin only, with scope mine: the asset goes into that user's personal media,
   * e.g. an upload in the editor of another user's content; user → 403 media.owner_admin_only,
   * unknown user → 404 users.not_found, with scope public → 400 media.bad_scope),
   * optional process (JSON, ProcessOptionsSchema: crop/compress in the job), and the same metadata as
   * PUT /api/media/:id (MediaMetaSchema + assertMetaFor): name (default: file name without extension),
   * categoryId, tags (JSON array of strings). All checks run before the file is stored, so a refused upload leaves no row.
   * Returns 201 with status 'processing'; a media-process task does the rest.
   */
  app.post('/api/media/upload', async (req, reply) => {
    // The multipart cap follows 系统配置 → 素材上传 (media.limits); createMedia checks the per-kind limit.
    const lim = await getMediaLimitSettings();
    const file = await req.file({ limits: { fileSize: Math.max(maxBytes(lim, 'image'), maxBytes(lim, 'video')), files: 1, fields: 10 } });
    if (!file) throw badRequest('missing file', 'media.missing_file');
    const field = (name: string) => {
      const f = file.fields[name] as { value?: unknown } | undefined;
      return typeof f?.value === 'string' ? f.value.trim() : undefined;
    };
    const scope = field('scope') ?? 'mine';
    if (scope !== 'public' && scope !== 'mine') { file.file.resume(); throw badRequest('scope must be public or mine', 'media.bad_scope'); }
    let owner: Owner;
    try {
      owner = ownerForScope(req.user, scope);
      const ownerId = field('ownerId');
      if (ownerId) owner = await uploadOwnerFor(req.user, scope, ownerId);
    } catch (e) { file.file.resume(); throw e; }
    const categoryId = field('categoryId') || null;
    if (categoryId && !z.string().uuid().safeParse(categoryId).success) { file.file.resume(); throw badRequest('invalid categoryId', 'media.category_mismatch'); }
    const tagsRaw = field('tags');
    let tags: unknown;
    if (tagsRaw) { try { tags = JSON.parse(tagsRaw); } catch { tags = tagsRaw; } }
    const metaParsed = MediaMetaSchema.safeParse({ name: field('name') || undefined, categoryId, tags });
    if (!metaParsed.success) {
      file.file.resume();
      const detail = metaParsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
      throw badRequest(`invalid fields: ${detail}`, 'media.bad_fields', { detail });
    }
    const meta: MediaMeta = metaParsed.data;
    const processRaw = field('process');
    let processOpts: MediaProcessOptions | null = null;
    if (processRaw) {
      let parsed: unknown;
      try { parsed = JSON.parse(processRaw); } catch { parsed = undefined; }
      const r = ProcessOptionsSchema.safeParse(parsed);
      if (!r.success) {
        file.file.resume();
        throw badRequest(`invalid process options: ${r.error?.issues.map((i) => `${i.path.join('.') || 'process'} ${i.message}`).join('; ') ?? 'not JSON'}`, 'media.bad_process_options');
      }
      processOpts = normalizeOptions(r.data);
    }
    const asset = await createMedia({ stream: file.file, filename: file.filename || '', mimetype: file.mimetype || '', owner, meta, userId: req.user.id, process: processOpts });
    reply.code(201);
    return { item: (await toItems(req.user, [asset]))[0] };
  });

  // ------------------------------------------------------------ single asset
  app.get('/api/media/:id', { schema: { params: Id } }, async (req) => {
    const a = await getVisibleMedia(req.user, req.params.id);
    return { item: (await toItems(req.user, [a]))[0] };
  });

  app.get('/api/media/:id/content', {
    schema: { params: Id, querystring: z.object({ download: z.enum(['0', '1']).optional() }) },
  }, async (req, reply) => {
    const a = await getVisibleMedia(req.user, req.params.id);
    const ext = a.fileKey.split('.').pop()!;
    return sendObject(reply, await openMedia(a, 'file'), a.mimeType, a.fileSize, `${a.name}.${ext}`, req.query.download === '1');
  });

  app.get('/api/media/:id/thumbnail', { schema: { params: Id } }, async (req, reply) => {
    const a = await getVisibleMedia(req.user, req.params.id);
    if (!a.thumbnailKey) throw notFound('thumbnail not available', 'media.no_thumbnail');
    return sendObject(reply, await openMedia(a, 'thumbnail'), 'image/jpeg', null, `${a.name}-thumb.jpg`, false);
  });

  app.put('/api/media/:id', {
    schema: {
      params: Id,
      body: MediaMetaSchema,
    },
  }, async (req) => {
    const a = await getVisibleMedia(req.user, req.params.id);
    assertCanManage(req.user, a);
    const b = req.body;
    const set: Partial<MediaAsset> = {};
    await assertMetaFor({ ownerType: a.ownerType, ownerId: a.ownerId }, { categoryId: b.categoryId });
    if (b.name !== undefined) set.name = b.name;
    if (b.categoryId !== undefined) set.categoryId = b.categoryId;
    if (!Object.keys(set).length && b.tags === undefined) throw badRequest('nothing to update', 'common.nothing_to_update');
    if (Object.keys(set).length) {
      const done = await db.update(ma).set(set).where(and(eq(ma.id, a.id), isNull(ma.deletedAt))).returning({ id: ma.id });
      if (!done.length) throw notFound('media not found', 'media.not_found');
    }
    if (b.tags !== undefined) await setTags(a.id, b.tags);
    return { item: (await toItems(req.user, [await getVisibleMedia(req.user, a.id)]))[0] };
  });

  /**
   * Contents that reference each asset (shown before deleting: deleting drops the asset from them).
   * Only assets the caller may delete are counted (admins: all; users: their own private media).
   */
  app.get('/api/media/usage', {
    schema: { querystring: z.object({ ids: z.string().transform((s) => [...new Set(s.split(',').filter(Boolean))]).pipe(z.array(z.string().uuid()).min(1).max(100)) }) },
  }, async (req) => {
    const ma = schema.mediaAssets, cm = schema.contentMedia;
    const rows = await db.select({ id: cm.assetId, contents: sql<number>`count(*)::int` }).from(cm)
      .innerJoin(ma, eq(ma.id, cm.assetId))
      .where(and(inArray(cm.assetId, req.query.ids), isAdmin(req.user) ? undefined : and(eq(ma.ownerType, 'user'), eq(ma.ownerId, req.user.id))))
      .groupBy(cm.assetId);
    return { usage: Object.fromEntries(rows.map((r) => [r.id, r.contents])) as Record<string, number> };
  });

  app.delete('/api/media/:id', { schema: { params: Id } }, async (req, reply) => {
    const a = await getVisibleMedia(req.user, req.params.id);
    await deleteMedia(req.user, a);
    reply.code(204);
  });

  /** Deletes what the user may delete; every id gets its own result. */
  app.post('/api/media/batch-delete', {
    schema: { body: z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }) },
  }, async (req) => {
    const results: { id: string; ok: boolean; status: number; code?: string; error?: string }[] = [];
    for (const id of [...new Set(req.body.ids)]) {
      try {
        const a = await getVisibleMedia(req.user, id);
        await deleteMedia(req.user, a);
        results.push({ id, ok: true, status: 204 });
      } catch (err) {
        const e = err instanceof HttpError ? err : new HttpError(500, (err as Error).message);
        results.push({ id, ok: false, status: e.statusCode, code: e.code, error: e.message });
      }
    }
    return { results, deleted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });

  // ------------------------------------------------------------ favorites (public only)
  app.post('/api/media/:id/favorite', { schema: { params: Id } }, async (req) => {
    const a = await getVisibleMedia(req.user, req.params.id);
    if (a.ownerType !== 'public') throw badRequest('只能收藏公共素材', 'media.favorite_public_only');
    await db.insert(schema.mediaFavorites).values({ userId: req.user.id, assetId: a.id }).onConflictDoNothing();
    return { favorite: true };
  });

  app.delete('/api/media/:id/favorite', { schema: { params: Id } }, async (req) => {
    await db.delete(schema.mediaFavorites).where(and(eq(schema.mediaFavorites.userId, req.user.id), eq(schema.mediaFavorites.assetId, req.params.id)));
    return { favorite: false };
  });

  // ------------------------------------------------------------ push to devices
  /**
   * One push-asset task per device × asset. Needs `operate` on every device and visibility of
   * every asset; the asset must be processed. Files go API → adb (not through the device proxy).
   */
  app.post('/api/media/push', {
    schema: { body: z.object({ assetIds: z.array(z.string().uuid()).min(1).max(20), instanceIds: z.array(z.string().uuid()).min(1).max(100) }) },
  }, async (req, reply) => {
    const assetIds = [...new Set(req.body.assetIds)];
    const instanceIds = [...new Set(req.body.instanceIds)];
    await assertInstancesAccess(req.user, instanceIds, 'operate');
    const assets: MediaAsset[] = [];
    for (const id of assetIds) {
      const a = await getVisibleMedia(req.user, id);
      if (a.status !== 'ready') throw conflict(`素材「${a.name}」尚未处理完成（${a.status}）`, 'media.not_ready', { status: a.status, name: a.name });
      assets.push(a);
    }
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, instanceIds));
    const accepted: { instanceId: string; assetId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string }[] = [];
    for (const id of instanceIds) if (!rows.some((r) => r.id === id)) skipped.push({ instanceId: id, reason: 'not found' });
    for (const r of rows) {
      if (r.status !== 'running') { skipped.push({ instanceId: r.id, reason: `not running (${r.status})` }); continue; }
      for (const a of assets) {
        accepted.push({ instanceId: r.id, assetId: a.id, taskId: await enqueue('push-asset', r, req.user.id, { assetId: a.id }, `推送素材 ${a.name}`, { refType: 'media', refId: a.id }) });
      }
    }
    reply.code(202);
    return { accepted, skipped };
  });
};
