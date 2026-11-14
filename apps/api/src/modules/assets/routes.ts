import { and, desc, eq, ilike, inArray, not, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { assertInstanceAccess, isAdmin } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { createAsset, getAsset, openAsset, removeAsset } from './assets.js';

const Id = z.object({ id: z.string().uuid() });
const Tag = z.string().trim().min(1).max(32);

/** Asset library (素材库): upload once, push to many devices' shared storage. */
export const assetRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/assets', {
    schema: { querystring: z.object({ q: z.string().trim().max(100).optional(), type: z.enum(['image', 'video', 'other']).optional() }) },
  }, async (req) => {
    const { q, type } = req.query;
    const where: SQL[] = [];
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(or(ilike(schema.assets.name, like), sql`exists (select 1 from unnest(${schema.assets.tags}) t where t ilike ${like})`)!);
    }
    if (type === 'image') where.push(ilike(schema.assets.mime, 'image/%'));
    else if (type === 'video') where.push(ilike(schema.assets.mime, 'video/%'));
    else if (type === 'other') where.push(not(or(ilike(schema.assets.mime, 'image/%'), ilike(schema.assets.mime, 'video/%'))!));
    const assets = await db.select().from(schema.assets).where(where.length ? and(...where) : undefined).orderBy(desc(schema.assets.createdAt)).limit(1000);
    return { assets };
  });

  /** multipart, one file per request; stored on the active backend. */
  app.post('/api/assets', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: config.ASSET_MAX_MB * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('missing file');
    const asset = await createAsset(file.file, file.filename || 'upload', file.mimetype || 'application/octet-stream', req.user.id);
    reply.code(201);
    return { asset };
  });

  app.get('/api/assets/:id/content', {
    schema: { params: Id, querystring: z.object({ download: z.enum(['0', '1']).optional() }) },
  }, async (req, reply) => {
    const asset = await getAsset(req.params.id);
    if (!asset) throw notFound('asset not found');
    const stream = await openAsset(asset);
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    const ascii = asset.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    reply
      .header('content-type', asset.mime)
      .header('content-length', String(asset.size))
      .header('content-disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(asset.name)}`)
      .header('cache-control', 'private, max-age=3600')
      // User-uploaded content: never let it run as a page on the API origin.
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'");
    return reply.send(stream);
  });

  app.patch('/api/assets/:id', {
    schema: { params: Id, body: z.object({ name: z.string().trim().min(1).max(200).optional(), tags: z.array(Tag).max(20).optional() }) },
  }, async (req) => {
    const asset = await getAsset(req.params.id);
    if (!asset) throw notFound('asset not found');
    const set: { name?: string; tags?: string[] } = {};
    if (req.body.name !== undefined) set.name = req.body.name;
    if (req.body.tags !== undefined) set.tags = [...new Set(req.body.tags)];
    if (!Object.keys(set).length) return { asset };
    const [row] = await db.update(schema.assets).set(set).where(eq(schema.assets.id, asset.id)).returning();
    return { asset: row };
  });

  app.delete('/api/assets/:id', { schema: { params: Id } }, async (req, reply) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以删除素材');
    const asset = await getAsset(req.params.id);
    if (!asset) throw notFound('asset not found');
    await removeAsset(asset);
    reply.code(204);
  });

  /** One queue task per device × asset (op push-asset). */
  app.post('/api/assets/push', {
    schema: { body: z.object({ assetIds: z.array(z.string().uuid()).min(1).max(20), instanceIds: z.array(z.string().uuid()).min(1).max(100) }) },
  }, async (req, reply) => {
    const assetIds = [...new Set(req.body.assetIds)];
    const instanceIds = [...new Set(req.body.instanceIds)];
    for (const id of instanceIds) await assertInstanceAccess(req.user, id, 'operate');
    const assets = await db.select().from(schema.assets).where(inArray(schema.assets.id, assetIds));
    if (assets.length !== assetIds.length) throw notFound('asset not found');
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, instanceIds));
    const accepted: { instanceId: string; assetId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string }[] = [];
    for (const id of instanceIds) if (!rows.some((r) => r.id === id)) skipped.push({ instanceId: id, reason: 'not found' });
    for (const r of rows) {
      if (r.status !== 'running') { skipped.push({ instanceId: r.id, reason: `not running (${r.status})` }); continue; }
      for (const a of assets) {
        accepted.push({ instanceId: r.id, assetId: a.id, taskId: await enqueue('push-asset', r, req.user.id, { assetId: a.id }, `推送素材 ${a.name}`) });
      }
    }
    reply.code(202);
    return { accepted, skipped };
  });
};
