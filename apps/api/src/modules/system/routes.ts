import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { assertInstanceAccess } from '../auth/rbac.js';
import { deleteBackup, listBackups, openBackup, startBackup } from './backup.js';
import { connectionPanel, deviceHistory } from './connections.js';
import { LEVELS, listLogFiles, readLogs, type LevelName } from './logs.js';
import { systemHourly } from './maintenance.js';
import { getSystemSettings, saveSystemSettings, SYSTEM_DEFAULTS, SystemSettings } from './settings.js';

/**
 * System management (系统管理): backups, system logs and settings are admin only; the connection
 * monitoring panel is RBAC-scoped like the device list.
 */
export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = { preHandler: app.requireAdmin };
  const IdParam = z.object({ id: z.string().uuid() });

  app.get('/api/system/settings', admin, async () => ({ settings: await getSystemSettings(), defaults: SYSTEM_DEFAULTS }));
  app.put('/api/system/settings', { ...admin, schema: { body: SystemSettings.partial() } }, async (req) => ({ settings: await saveSystemSettings(req.body) }));

  /** Runs the hourly maintenance now (retention, crashed backups, daily backup schedule). */
  app.post('/api/system/maintenance', admin, async () => ({ result: await systemHourly() }));

  // ------------------------------------------------------------ backups
  app.get('/api/system/backups', admin, async () => ({ backups: await listBackups(), pgDumpCmd: config.PG_DUMP_CMD }));

  app.post('/api/system/backups', admin, async (req, reply) => {
    const { task } = await startBackup(req.user.id);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  app.get('/api/system/backups/:id/download', { ...admin, schema: { params: IdParam } }, async (req, reply) => {
    const { backup, stream } = await openBackup(req.params.id);
    const name = path.basename(backup.key);
    reply.header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store');
    if (backup.size !== null) reply.header('content-length', String(backup.size));
    return reply.send(stream);
  });

  app.delete('/api/system/backups/:id', { ...admin, schema: { params: IdParam } }, async (req, reply) => {
    const b = await deleteBackup(req.params.id);
    if (req.audit) { req.audit.target = path.basename(b.key); req.audit.extra = { storage: b.storage }; }
    reply.code(204);
  });

  // ------------------------------------------------------------ logs
  app.get('/api/system/logs', {
    ...admin,
    schema: {
      querystring: z.object({
        level: z.enum(Object.keys(LEVELS) as [LevelName, ...LevelName[]]).optional(),
        q: z.string().max(200).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(200),
      }),
    },
  }, async (req) => readLogs({ ...req.query, q: req.query.q?.trim() || undefined }));

  app.get('/api/system/logs/files', admin, async () => ({ files: await listLogFiles() }));

  // ------------------------------------------------------------ connection monitoring (RBAC-scoped)
  app.get('/api/system/connections', { preHandler: app.authenticate }, async (req) => ({ devices: await connectionPanel(req.user) }));

  app.get('/api/system/connections/:id/history', {
    preHandler: app.authenticate,
    schema: { params: IdParam, querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }) },
  }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    return { events: await deviceHistory(req.params.id, req.query.hours) };
  });
};
