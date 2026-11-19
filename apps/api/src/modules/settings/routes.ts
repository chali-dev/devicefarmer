import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { checkHealth, hostCapacity, systemInfo } from '../../health.js';
import { HttpError } from '../../lib/errors.js';
import { assertPlatformEnabled } from '../../lib/platforms-enabled.js';
import { CLEANUP_TYPE, DEFAULT_RETENTION_DAYS, getRetention, MAX_RETENTION_DAYS, saveRetention, scheduleTaskCleanup } from '../tasks/retention.js';
import { getYoutubeSettings, saveYoutubeApiKey } from '../tracked/youtube.js';
import { FIXED_MENUS, GRANTABLE_MENUS, DEFAULT_USER_MENUS, getUserMenus, saveUserMenus } from '../auth/role-menus.js';
import { handlerTimeoutMs } from '../tasks/core.js';
import { isTimeoutType, saveTaskTimeout, storedTimeouts, TIMEOUT_TYPES } from '../tasks/timeouts.js';
import { getMediaLimitSettings, MAX_IMAGE_MB, MAX_VIDEO_MB, mediaLimitDefaults, MEDIA_TYPE_IDS, MediaLimitsInput, saveMediaLimitSettings } from '../media/limits.js';
import { FORMATS } from '../media/formats.js';
import { getStorageSettings, saveStorageSettings, StorageInput, testStorage } from './storage.js';

/** Platform settings (设置). Admin only. */
export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/api/settings/storage', async () => ({ storage: await getStorageSettings() }));

  app.put('/api/settings/storage', { schema: { body: StorageInput } }, async (req) => {
    const r = await saveStorageSettings(req.body);
    if (!r.saved) throw new HttpError(400, `存储连接测试失败，未保存：${r.test.error}`, 'settings.storage_test_failed', { error: r.test.error ?? '' });
    return { storage: r.settings };
  });

  /** Tests the submitted config, or the stored active one when the body is omitted. */
  app.post('/api/settings/storage/test', { schema: { body: StorageInput.nullish() } }, async (req) => testStorage(req.body ?? undefined));

  /** YouTube Data API key for tracked accounts. Write-only: GET only says whether it is set. */
  app.get('/api/settings/youtube', async () => ({ youtube: await getYoutubeSettings() }));

  /** `apiKey: null` clears it. The key is not tested here (that would spend quota); a refresh reports a bad key. */
  app.put('/api/settings/youtube', {
    schema: { body: z.object({ apiKey: z.string().trim().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/, 'invalid API key format').nullable() }) },
  }, async (req) => {
    assertPlatformEnabled('youtube');
    return { youtube: await saveYoutubeApiKey(req.body.apiKey) };
  });

  // 追踪账号采集设备 (/api/settings/tracked-collectors, key tracked.collectors) was removed on 2026-11-19: every tracked
  // account is read on its own 采集手机 (tracked_accounts.instance_id, tracked/phone.ts).

  /** Task centre retention + the last cleanup run. */
  const lastCleanup = async () => {
    const [t] = await db.select({ id: schema.tasks.id, status: schema.tasks.status, result: schema.tasks.result, finishedAt: schema.tasks.finishedAt, createdAt: schema.tasks.createdAt })
      .from(schema.tasks).where(eq(schema.tasks.type, CLEANUP_TYPE)).orderBy(desc(schema.tasks.createdAt)).limit(1);
    return t ?? null;
  };
  app.get('/api/settings/tasks', async () => ({
    retention: await getRetention(), defaultDays: DEFAULT_RETENTION_DAYS, maxDays: MAX_RETENTION_DAYS, lastCleanup: await lastCleanup(),
  }));

  /** `retentionDays: null` keeps finished tasks forever. */
  app.put('/api/settings/tasks', {
    schema: { body: z.object({ retentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable() }) },
  }, async (req) => ({ retention: await saveRetention(req.body.retentionDays) }));

  /** Runs the cleanup now (as a task of the task centre). */
  app.post('/api/settings/tasks/cleanup', async (req, reply) => {
    const { task } = await scheduleTaskCleanup(req.user.id, true);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  /**
   * 权限管理 (角色菜单权限): which business menus the `user` role sees (auth/role-menus.ts). Admins always see all;
   * `fixed` lists the keys that cannot be granted (always on / admin only).
   */
  const roleMenus = async () => {
    const m = await getUserMenus(true);
    return { menus: m.menus, updatedAt: m.updatedAt, grantable: GRANTABLE_MENUS, defaults: DEFAULT_USER_MENUS, fixed: FIXED_MENUS };
  };
  app.get('/api/settings/role-menus', async () => roleMenus());
  app.put('/api/settings/role-menus', {
    schema: { body: z.object({ menus: z.array(z.string().min(1).max(40)).max(50) }).strict() },
  }, async (req) => {
    await saveUserMenus(req.body.menus);
    return roleMenus();
  });

  /**
   * 任务超时 (tasks/timeouts.ts): one row per user-facing task type, minutes; `timeoutMin` null = none (no timeout) when
   * the type has no default. PUT one type at a time; `null` goes back to the default.
   */
  const timeoutsView = async () => {
    const { value, updatedAt } = await storedTimeouts(true);
    const min = (ms: number | null) => (ms === null ? null : Math.max(1, Math.round(ms / 60_000)));
    return {
      updatedAt,
      items: Object.entries(TIMEOUT_TYPES).map(([type, b]) => {
        const def = handlerTimeoutMs(type);
        return { type, timeoutMin: min(value[type] ?? def), defaultMin: min(def), custom: value[type] !== undefined, min: b.min, max: b.max };
      }),
    };
  };
  app.get('/api/settings/task-timeouts', async () => timeoutsView());
  app.put('/api/settings/task-timeouts/:type', {
    schema: { params: z.object({ type: z.string() }), body: z.object({ timeoutMin: z.number().int().nullable() }).strict() },
  }, async (req) => {
    const { type } = req.params;
    if (!isTimeoutType(type)) throw new HttpError(404, `unknown task type ${type}`, 'settings.task_timeout_unknown', { type });
    const b = TIMEOUT_TYPES[type]!;
    const v = req.body.timeoutMin;
    if (v !== null && (v < b.min || v > b.max)) throw new HttpError(400, `timeout must be ${b.min}–${b.max} min`, 'settings.task_timeout_range', { min: b.min, max: b.max });
    await saveTaskTimeout(type, v);
    return timeoutsView();
  });

  /**
   * 素材上传限制 (media/limits.ts; env values = defaults): size per kind + allowed formats (a subset of `types`, the
   * formats the upload validator knows). GET /api/media/limits (every user) serves the effective values to the upload UI.
   */
  const mediaLimitsView = async () => {
    const { updatedAt, ...limits } = await getMediaLimitSettings(true);
    return {
      limits, updatedAt, defaults: mediaLimitDefaults(),
      max: { imageMaxMb: MAX_IMAGE_MB, videoMaxMb: MAX_VIDEO_MB },
      types: MEDIA_TYPE_IDS.map((id) => { const f = FORMATS.find((x) => x.id === id)!; return { id, kind: f.kind, exts: f.exts }; }),
    };
  };
  app.get('/api/settings/media-limits', async () => mediaLimitsView());
  app.put('/api/settings/media-limits', { schema: { body: MediaLimitsInput } }, async (req) => {
    await saveMediaLimitSettings(req.body);
    return mediaLimitsView();
  });

  /** Env-configured defaults (media limits, adb ports); the audit retention is a setting (系统配置 → 日志). Cheap. */
  app.get('/api/settings/config', async () => ({
    media: { imageMaxMb: config.MEDIA_IMAGE_MAX_MB, videoMaxMb: config.MEDIA_VIDEO_MAX_MB, allowedTypes: config.MEDIA_ALLOWED_TYPES.split(',').map((s) => s.trim()).filter(Boolean) },
    adbPorts: { min: config.ADB_PORT_MIN, max: config.ADB_PORT_MAX },
  }));

  /** Read-only system information: dependency health (real calls), versions, Android host capacity, STF devices. */
  app.get('/api/settings/system', async () => {
    const [health, capacity, info] = await Promise.all([checkHealth(), hostCapacity(), systemInfo()]);
    return { health, capacity, ...info };
  });
};
