import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { assertInstanceAccess } from '../auth/rbac.js';
import { deleteBackup, listBackups, openBackup, startBackup } from './backup.js';
import { startRestore } from './restore.js';
import { connectionPanel, deviceHistory, deviceLogs } from './connections.js';
import { LEVELS, listLogFiles, readLogs, type LevelName } from './logs.js';
import { getRules, LIMITS as ALERT_LIMITS, saveRules } from '../notify/rules.js';
import { DEFAULT_RETENTION_DAYS, getRetention, MAX_RETENTION_DAYS, saveRetention } from '../tasks/retention.js';
import { PURGE_KINDS, purgeOne, runAllPurges } from './maintenance.js';
import { getSystemSettings, saveSystemSettings, SYSTEM_DEFAULTS, SystemSettings } from './settings.js';

/**
 * System management (系统管理): backups, system logs, settings and the connection monitoring panel (连线监控,
 * admin only since 2026-11-18, including a device's connection history) are admin only.
 */
export const systemRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = { preHandler: app.requireAdmin };
  const IdParam = z.object({ id: z.string().uuid() });

  /**
   * 系统配置 → 日志 shows every retention in one form. Two of them keep their own single stored value elsewhere:
   * 任务日志 = `tasks.retention` (null = keep forever), 通知 = `alerts.rules.retentionDays`.
   */
  const settingsView = async () => {
    const [s, tasks, rules] = await Promise.all([getSystemSettings(), getRetention(), getRules()]);
    return {
      settings: { ...s, taskRetentionDays: tasks.days, notificationRetentionDays: rules.retentionDays },
      defaults: { ...SYSTEM_DEFAULTS, taskRetentionDays: DEFAULT_RETENTION_DAYS, notificationRetentionDays: 30 },
      max: {
        logRetentionDays: 365, historyRetentionDays: 90, auditRetentionDays: 3650, riskEventsRetentionDays: 3650,
        taskRetentionDays: MAX_RETENTION_DAYS, notificationRetentionDays: ALERT_LIMITS.retentionMax,
      },
    };
  };
  const SettingsBody = SystemSettings.partial().extend({
    taskRetentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable().optional(),
    notificationRetentionDays: z.number().int().min(1).max(ALERT_LIMITS.retentionMax).optional(),
  }).strict();
  app.get('/api/system/settings', admin, async () => settingsView());
  app.put('/api/system/settings', { ...admin, schema: { body: SettingsBody } }, async (req) => {
    const { taskRetentionDays, notificationRetentionDays, ...system } = req.body;
    if (Object.keys(system).length) await saveSystemSettings(system);
    if (taskRetentionDays !== undefined) await saveRetention(taskRetentionDays);
    if (notificationRetentionDays !== undefined) await saveRules({ retentionDays: notificationRetentionDays });
    return settingsView();
  });

  /** 立即清理: every retention purge now + the hourly maintenance (crashed backups, daily backup schedule). */
  app.post('/api/system/maintenance', admin, async () => ({ result: await runAllPurges() }));
  /** One row's 立即清理 (系统配置 → 日志): that kind only, with its stored retention. */
  app.post('/api/system/purge/:kind', { ...admin, schema: { params: z.object({ kind: z.enum(PURGE_KINDS) }) } }, async (req) => ({ result: await purgeOne(req.params.kind) }));

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

  /** 导入: replaces the whole database with this backup (task db-restore, safety backup first; restore.ts). */
  app.post('/api/system/backups/:id/restore', { ...admin, schema: { params: IdParam } }, async (req, reply) => {
    const { task, backup } = await startRestore(req.user.id, req.params.id);
    if (req.audit) { req.audit.target = path.basename(backup.key); req.audit.extra = { taskId: task.id, backupId: backup.id }; }
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
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

  // ------------------------------------------------------------ device logs (系统日志 → 设备日志, admin only)
  app.get('/api/system/device-logs', {
    ...admin,
    schema: {
      querystring: z.object({
        instanceId: z.string().uuid().optional(),
        type: z.enum(['status', 'adb', 'offline']).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      }),
    },
  }, async (req) => deviceLogs(req.query));

  // ------------------------------------------------------------ connection monitoring (admin only)
  app.get('/api/system/connections', admin, async (req) => ({ devices: await connectionPanel(req.user) }));

  app.get('/api/system/connections/:id/history', {
    ...admin,
    schema: { params: IdParam, querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }) },
  }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    return { events: await deviceHistory(req.params.id, req.query.hours) };
  });
};
