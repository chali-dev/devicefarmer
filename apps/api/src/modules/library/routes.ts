import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { assertInstanceAccess, assertInstancesAccess } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { getInstance } from '../instances/repo.js';
import { prepareUpload } from '../apps/package.js';
import { installLog, installTargets } from './install.js';
import { requiredAppRoutes } from './required.js';
import { addUploadToLibrary, LIBRARY_TASK_REF, libraryInstallJob, libraryTaskRef, removeLibraryApp } from './library.js';
import fs from 'node:fs';
import path from 'node:path';

const Pkg = z.string().regex(/^[a-zA-Z0-9_.]{3,150}$/);

/**
 * App library (应用库, admin only since 2026-11-18): import from a device or upload, install to devices; 必装应用
 * (required.ts). Every route requires an admin (403 auth.admin_only otherwise), including the list, targets and logs.
 */
async function libraryApp(id: string) {
  const [lib] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, id));
  if (!lib) throw notFound('library app not found', 'library.not_found');
  return lib;
}

export const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);
  requiredAppRoutes(app);

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
   * Upload. multipart, one file:
   * .apk or a split bundle (.apks/.xapk/.apkm/.zip). Package and version are read from the manifests.
   */
  app.post('/api/library/upload', async (req) => {
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

  /** Devices this entry can be installed on, with the installed version (live read over adb) and a state. */
  app.get('/api/library/:id/targets', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const lib = await libraryApp(req.params.id);
    return installTargets(lib);
  });

  /** Install log of this entry's package (all versions), task-centre visibility. */
  app.get('/api/library/:id/logs', {
    schema: { params: z.object({ id: z.string().uuid() }), querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }) },
  }, async (req) => {
    const lib = await libraryApp(req.params.id);
    return installLog(req.user, lib.package, req.query.limit, req.query.offset);
  });

  /** One request for a batch of devices: one install-apk task per device (refType library_app). */
  app.post('/api/library/:id/install', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ instanceIds: z.array(z.string().uuid()).min(1).max(100) }) },
  }, async (req, reply) => {
    const lib = await libraryApp(req.params.id);
    const ids = [...new Set(req.body.instanceIds)];
    await assertInstancesAccess(req.user, ids, 'operate');
    const T = schema.tasks;
    const [rows, pending] = await Promise.all([
      db.select().from(schema.instances).where(inArray(schema.instances.id, ids)),
      db.select({ instanceId: T.instanceId }).from(T).where(and(eq(T.type, 'install-apk'), eq(T.refType, LIBRARY_TASK_REF), eq(T.refId, lib.id), inArray(T.status, ['pending', 'scheduled', 'running']), inArray(T.instanceId, ids))),
    ]);
    const busy = new Set(pending.map((p) => p.instanceId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const accepted: { instanceId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string; code: string }[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) { skipped.push({ instanceId: id, reason: 'not found', code: 'instances.not_found' }); continue; }
      if (r.status !== 'running') { skipped.push({ instanceId: id, reason: `not running (${r.status})`, code: 'instances.not_running' }); continue; }
      if (busy.has(id)) { skipped.push({ instanceId: id, reason: 'install already queued', code: 'library.install_pending' }); continue; }
      accepted.push({ instanceId: id, taskId: await enqueue('install-apk', r, req.user.id, libraryInstallJob(lib), `${lib.package} ${lib.versionName ?? lib.versionCode}`, libraryTaskRef(lib)) });
    }
    if (req.audit) { req.audit.target = `${lib.package} ${lib.versionName ?? lib.versionCode}`; req.audit.extra = { id: lib.id, accepted: accepted.length, skipped: skipped.length }; }
    reply.code(202);
    return { accepted, skipped };
  });

  app.delete('/api/library/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const [row] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, req.params.id));
    if (!row) throw notFound('library app not found', 'library.not_found');
    await removeLibraryApp(row);
    reply.code(204);
  });
};
