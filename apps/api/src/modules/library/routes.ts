import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { assertInstanceAccess, roleAllows } from '../auth/rbac.js';
import { enqueue } from '../instances/queue.js';
import { getInstance } from '../instances/repo.js';
import { libraryApks, removeLibraryApp } from './library.js';

const Pkg = z.string().regex(/^[a-zA-Z0-9_.]{3,150}$/);

/** App library: import from a device, install to instances, preinstall on new instances. */
export const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/library', async () => ({
    apps: await db.select().from(schema.libraryApps).orderBy(schema.libraryApps.package, desc(schema.libraryApps.createdAt)),
  }));

  app.post('/api/library/import', { schema: { body: z.object({ instanceId: z.string().uuid(), package: Pkg }) } }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.body.instanceId, 'operate');
    const inst = await getInstance(req.body.instanceId);
    if (!inst) throw notFound('instance not found');
    if (inst.status !== 'running') throw conflict('instance is not running');
    const taskId = await enqueue('import-app', inst, req.user.id, { package: req.body.package }, `导入应用库 ${req.body.package}`);
    reply.code(202);
    return { taskId };
  });

  app.patch('/api/library/:id', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ preinstall: z.boolean() }) },
  }, async (req) => {
    if (!roleAllows(req.user.role, 'operate')) throw forbidden('your role cannot change the library');
    const [row] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, req.params.id));
    if (!row) throw notFound('library app not found');
    // Only one version of a package is preinstalled.
    if (req.body.preinstall) await db.update(schema.libraryApps).set({ preinstall: false }).where(eq(schema.libraryApps.package, row.package));
    const [updated] = await db.update(schema.libraryApps).set({ preinstall: req.body.preinstall }).where(eq(schema.libraryApps.id, row.id)).returning();
    return { app: updated };
  });

  app.post('/api/library/:id/install', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ instanceIds: z.array(z.string().uuid()).min(1).max(100) }) },
  }, async (req, reply) => {
    if (!roleAllows(req.user.role, 'operate')) throw forbidden('your role cannot install apps');
    const [lib] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, req.params.id));
    if (!lib) throw notFound('library app not found');
    for (const id of req.body.instanceIds) await assertInstanceAccess(req.user, id, 'operate');
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
    if (req.user.role !== 'admin') throw forbidden('admin only');
    const [row] = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, req.params.id));
    if (!row) throw notFound('library app not found');
    await removeLibraryApp(row);
    reply.code(204);
  });
};
