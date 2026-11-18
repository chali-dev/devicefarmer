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
import { COLLECTOR_PLATFORMS, collectorSettings, saveCollector } from '../tracked/collector.js';
import { FIXED_MENUS, GRANTABLE_MENUS, DEFAULT_USER_MENUS, getUserMenus, saveUserMenus } from '../auth/role-menus.js';
import { getPublishRetry, PublishRetryInput, publicRetry, publishRetryDefaults, savePublishRetry } from '../publish/retry-settings.js';
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

  /**
   * 追踪账号采集设备: per platform (Instagram) the device whose app is read for tracked accounts, its halt state
   * (challenge screen → stopped until resumed) and the pace counters. `instanceId: null` unsets it.
   */
  app.get('/api/settings/tracked-collectors', async () => collectorSettings());
  app.put('/api/settings/tracked-collectors/:platform', {
    schema: {
      params: z.object({ platform: z.enum(COLLECTOR_PLATFORMS) }),
      body: z.object({ instanceId: z.string().uuid().nullable().optional(), resume: z.boolean().optional() })
        .refine((b) => b.instanceId !== undefined || b.resume, 'nothing to update'),
    },
  }, async (req) => {
    assertPlatformEnabled(req.params.platform);
    return saveCollector(req.params.platform, req.body);
  });

  // 多语言内容: the admin language list (/api/settings/languages, key content.languages) was removed on 2026-11-18:
  // the source is fixed to zh-CN and 配置语系 = the languages bound to social accounts (content/languages.ts).

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

  /** 发布任务: attempts + backoff + per-attempt timeout of publish rounds (publish/retry-settings.ts; env values = defaults). */
  const retryView = async () => {
    const d = publishRetryDefaults();
    return { retry: publicRetry(await getPublishRetry()), defaults: publicRetry({ ...d, updatedAt: null }) };
  };
  app.get('/api/settings/publish-retry', async () => retryView());
  app.put('/api/settings/publish-retry', { schema: { body: PublishRetryInput } }, async (req) => {
    await savePublishRetry(req.body);
    return retryView();
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

  /** Env-configured values shown read-only in the UI (publish defaults, audit retention, media limits). Cheap. */
  app.get('/api/settings/config', async () => ({
    publish: { maxAttempts: config.PUBLISH_MAX_ATTEMPTS, timeoutMs: config.PUBLISH_TIMEOUT_MS, retryBackoffMs: config.PUBLISH_RETRY_BACKOFF_MS },
    auditRetentionDays: config.AUDIT_RETENTION_DAYS,
    media: { imageMaxMb: config.MEDIA_IMAGE_MAX_MB, videoMaxMb: config.MEDIA_VIDEO_MAX_MB, allowedTypes: config.MEDIA_ALLOWED_TYPES.split(',').map((s) => s.trim()).filter(Boolean) },
    adbPorts: { min: config.ADB_PORT_MIN, max: config.ADB_PORT_MAX },
  }));

  /** Read-only system information: dependency health (real calls), versions, Android host capacity, STF devices. */
  app.get('/api/settings/system', async () => {
    const [health, capacity, info] = await Promise.all([checkHealth(), hostCapacity(), systemInfo()]);
    return { health, capacity, ...info };
  });
};
