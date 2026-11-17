import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { assertInstanceAccess, assertInstancesAccess, isAdmin } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { getInstance } from '../instances/repo.js';
import { prepareUpload } from '../apps/package.js';
import { addUploadToLibrary, libraryApks, removeLibraryApp } from './library.js';
import fs from 'node:fs';
import path from 'node:path';

const Pkg = z.string().regex(/^[a-zA-Z0-9_.]{3,150}$/);

/** App library: import from a device or upload (admin), install to instances, preinstall on new instances. */
export const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/library', async () => ({
    apps: await db.select().from(schema.libraryApps).orderBy(schema.libraryApps.package, desc(schema.libraryApps.createdAt)),
  }));

  app.post('/api/library/import', { schema: { body: z.object({ instanceId: z.string().uuid(), package: Pkg }) } }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.body.instanceId, 'operate');
    const inst = await getInstance(req.body.instanceId);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    const taskId = await enqueue('import-app', inst, req.user.id, { package: req.body.package }, `导入应用库 ${req.body.package}`);
    reply.code(202);
    return { taskId };
  });

  /**
   * Upload (admin only: library entries can be preinstalled on every new device). multipart, one file:
   * .apk or a split bundle (.apks/.xapk/.apkm/.zip). Package and version are read from the manifests.
   */
  app.post('/api/library/upload', async (req) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以上传到应用库', 'library.upload_admin_only');
    const file = await req.file();
    if (!file) throw badRequest('missing file', 'library.missing_file');
    const prepared = await prepareUpload(file.file, file.filename);
    try {
      const row = await addUploadToLibrary(prepared.apkPaths, req.user.username);
      if (req.audit) { req.audit.target = `${row.package} ${row.versionName ?? row.versionCode}`; req.audit.extra = { id: row.id, versionCode: row.versionCode, apks: row.files.length }; }
      return { app: row };
    } finally {
      await fs.promises.rm(path.dirname(prepared.apkPaths[0]!), { recursive: true, force: true });
    }
  });

  app.patch('/api/library/:id', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ preinstall: z.boolean() }) },
  }, async (req) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以修改应用库预装设置', 'library.preinstall_admin_only');
    const [row] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, req.params.id));
    if (!row) throw notFound('library app not found', 'library.not_found');
    // Only one version of a package is preinstalled.
    if (req.body.preinstall) await db.update(schema.libraryApps).set({ preinstall: false }).where(eq(schema.libraryApps.package, row.package));
    const [updated] = await db.update(schema.libraryApps).set({ preinstall: req.body.preinstall }).where(eq(schema.libraryApps.id, row.id)).returning();
    return { app: updated };
  });

  app.post('/api/library/:id/install', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ instanceIds: z.array(z.string().uuid()).min(1).max(100) }) },
  }, async (req, reply) => {
    const [lib] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, req.params.id));
    if (!lib) throw notFound('library app not found', 'library.not_found');
    await assertInstancesAccess(req.user, req.body.instanceIds, 'operate');
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, req.body.instanceIds));
    const accepted: { instanceId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string }[] = [];
    for (const r of rows) {
      if (r.status !== 'running') { skipped.push({ instanceId: r.id, reason: `not running (${r.status})` }); continue; }
      accepted.push({ instanceId: r.id, taskId: await enqueue('install-apk', r, req.user.id, libraryApks(lib), `${lib.package} ${lib.versionName ?? lib.versionCode}`) });
    }
    reply.code(202);
    return { accepted, skipped };
  });

  app.delete('/api/library/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以从应用库删除', 'library.delete_admin_only');
    const [row] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, req.params.id));
    if (!row) throw notFound('library app not found', 'library.not_found');
    await removeLibraryApp(row);
    reply.code(204);
  });
};
