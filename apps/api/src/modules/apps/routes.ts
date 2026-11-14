import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isProtectedPackage, mediaTarget } from '../../adapters/adb.js';
import { adb } from '../../services.js';
import { assertInstanceAccess } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { getInstance } from '../instances/repo.js';
import { prepareUpload } from './package.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../../config.js';

const Ids = z.array(z.string().uuid()).min(1).max(100);

/** App management: list, batch install/update (APK or split bundle), batch uninstall. */
export const appRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/instances/:id/apps', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    return { apps: await adb.listApps(inst.adbPort) };
  });

  /**
   * Batch install/update. multipart: field `instanceIds` (JSON array) BEFORE the file part.
   * The upload is stored once and installed on every target as its own task (installs with -r = update).
   */
  app.post('/api/apps/install', async (req, reply) => {
    const file = await req.file();
    if (!file) throw badRequest('missing file');
    const rawIds = (file.fields.instanceIds as { value?: string } | undefined)?.value;
    let ids: string[];
    try { ids = Ids.parse(JSON.parse(rawIds ?? '[]')); } catch { file.file.resume(); throw badRequest('instanceIds must be a JSON array of ids, sent before the file'); }
    for (const id of ids) await assertInstanceAccess(req.user, id, 'operate');
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, ids));
    const prepared = await prepareUpload(file.file, file.filename);
    const accepted: { instanceId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string }[] = [];
    for (const r of rows) {
      if (r.status !== 'running') { skipped.push({ instanceId: r.id, reason: `not running (${r.status})` }); continue; }
      accepted.push({ instanceId: r.id, taskId: await enqueue('install-apk', r, req.user.id, { apkPaths: prepared.apkPaths, sizes: prepared.sizes }, prepared.name) });
    }
    reply.code(202);
    return { filename: prepared.name, apks: prepared.apkPaths.length, accepted, skipped };
  });

  /**
   * Upload a file to the phone's shared storage (images -> Pictures, videos -> Movies,
   * others -> Download) and index it so it shows up in Gallery / app pickers.
   */
  app.post('/api/instances/:id/files', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'control');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    const file = await req.file();
    if (!file) throw badRequest('missing file');
    const { safe, folder, remote } = mediaTarget(file.filename, file.mimetype);
    const tmpDir = path.resolve(config.UPLOAD_DIR, randomUUID());
    await fs.promises.mkdir(tmpDir, { recursive: true });
    try {
      const local = path.join(tmpDir, safe);
      await pipeline(file.file, fs.createWriteStream(local));
      if (file.file.truncated) throw badRequest('file too large');
      await adb.pushMedia(inst.adbPort, local, remote);
      reply.code(201);
      return { path: remote, folder, size: (await fs.promises.stat(local)).size };
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  app.post('/api/apps/uninstall', {
    schema: { body: z.object({ instanceIds: Ids, package: z.string().regex(/^[a-zA-Z0-9_.]{3,150}$/) }) },
  }, async (req, reply) => {
    if (isProtectedPackage(req.body.package)) throw badRequest(`${req.body.package} 是平台组件（远程控制依赖），不能卸载`, 'apps.protected_package', { package: req.body.package });
    for (const id of req.body.instanceIds) await assertInstanceAccess(req.user, id, 'operate');
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, req.body.instanceIds));
    const accepted: { instanceId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string }[] = [];
    for (const r of rows) {
      if (r.status !== 'running') { skipped.push({ instanceId: r.id, reason: `not running (${r.status})` }); continue; }
      accepted.push({ instanceId: r.id, taskId: await enqueue('uninstall-app', r, req.user.id, { package: req.body.package }, req.body.package) });
    }
    reply.code(202);
    return { accepted, skipped };
  });
};
