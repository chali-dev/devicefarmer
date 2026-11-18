import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { db, schema } from '../../db/index.js';
import { recordAudit } from './audit.js';

/**
 * Centralized audit recording (操作日志).
 *
 * Every mutating request (POST/PUT/PATCH/DELETE) under /api/ is recorded in `onResponse`,
 * after the reply is sent, with a fire-and-forget write. Request bodies are never stored:
 * each action has an allowlisted summary (`detail`) and the result is redacted again
 * (see `redact`). Uploads record only filename and size.
 */

/**
 * Not recorded by the hook (method + route pattern):
 * - POST /api/auth/login: recorded explicitly by the login route (auth.login / auth.login_failed, incl. captcha refusals).
 * - POST /api/auth/captcha/verify: the login page's puzzle check on release (unauthenticated, changes nothing).
 * - read-like POSTs that only query/probe and change nothing the user configured:
 *   proxy egress checks (device and pool, and the unsaved-config test), Google health check, storage connection test,
 *   tracked-account URL parsing (preview).
 * Also skipped: non-mutating methods (GET/HEAD/OPTIONS), WebSocket upgrades, requests outside
 * /api/ and requests that matched no route (404 without a route pattern).
 */
export const AUDIT_EXCLUDED = new Set([
  'POST /api/auth/login',
  'POST /api/auth/captcha/verify',
  'POST /api/instances/:id/proxy/check',
  'POST /api/proxies/:id/check',
  'POST /api/proxies/check',
  'POST /api/proxies/test',
  'POST /api/instances/:id/google/check',
  'POST /api/settings/storage/test',
  'POST /api/tracked-accounts/parse',
  // Marking one's own notifications read or deleting them is per-user inbox state, not a configuration change
  // (only the caller's own rows; alert de-duplication in alert_states is untouched).
  'POST /api/notifications/:id/read',
  'POST /api/notifications/read-all',
  'POST /api/notifications/delete',
  'POST /api/notifications/delete-read',
]);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Upload { filename: string; size: number; instanceIds?: string[]; scope?: string }
interface AuditCtx {
  target?: string | null;
  /** Server-side facts merged into `detail` by the route itself (e.g. auto-assigned proxy ids). Never secrets. */
  extra?: Record<string, unknown>;
  upload?: { filename: string; mimetype: string; stream: { bytesRead?: number }; fields: Record<string, unknown> }; error?: string }

declare module 'fastify' {
  interface FastifyRequest { audit: AuditCtx | null }
}

type Body = Record<string, unknown>;
type Ctx = { req: FastifyRequest; body: Body; params: Body; upload?: Upload };
interface ActionSpec {
  action: string | ((c: Ctx) => string);
  /** Human-readable target from the request itself (otherwise resolved from :id). */
  target?: (c: Ctx) => string | null | undefined | Promise<string | null | undefined>;
  targetId?: (c: Ctx) => string | null | undefined;
  /** Allowlisted summary. Never return the body itself. */
  detail?: (c: Ctx) => Record<string, unknown> | undefined;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const self = (c: Ctx) => c.req.user?.username;
const selfId = (c: Ctx) => c.req.user?.id;
const fileDetail = (c: Ctx) => (c.upload ? { filename: c.upload.filename, size: c.upload.size } : undefined);

async function instanceNames(list: string[]): Promise<string | null> {
  const valid = list.filter((id) => UUID.test(id)).slice(0, 100);
  if (!valid.length) return null;
  const rows = await db.select({ name: schema.instances.name }).from(schema.instances).where(inArray(schema.instances.id, valid));
  const names = rows.map((r) => r.name).sort();
  if (!names.length) return null;
  return names.length > 10 ? `${names.slice(0, 10).join(', ')} 等 ${names.length} 台` : names.join(', ');
}

async function mediaNames(list: string[]): Promise<string | null> {
  const valid = list.filter((id) => UUID.test(id)).slice(0, 100);
  if (!valid.length) return null;
  const rows = await db.select({ name: schema.mediaAssets.name }).from(schema.mediaAssets).where(inArray(schema.mediaAssets.id, valid));
  const names = rows.map((r) => r.name);
  if (!names.length) return null;
  return names.length > 5 ? `${names.slice(0, 5).join(', ')} 等 ${names.length} 个` : names.join(', ');
}

async function socialAccountName(id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  const [r] = await db.select({ platform: schema.socialAccounts.platform, handle: schema.socialAccounts.handle }).from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
  return r ? `${r.platform} @${r.handle}` : null;
}

/** Non-secret fields of an alert channel config (Telegram); the bot token only as replaced / unchanged. */
function channelConfigDetail(cfg: unknown): Record<string, unknown> {
  if (!cfg || typeof cfg !== 'object') return {};
  const c = cfg as Body;
  return { chatId: c.chatId, threadId: c.threadId, language: c.language, bot: typeof c.botToken === 'string' && c.botToken ? 'replaced' : 'unchanged' };
}

const proxyText = (b: Body) => (typeof b.host === 'string' ? `${String(b.type)}://${b.host}:${String(b.port)}` : null);

/** `${METHOD} ${routePattern}` → action. Unknown routes fall back to `${method} ${routePattern}`. */
export const ACTIONS: Record<string, ActionSpec> = {
  // auth (self-service)
  'PATCH /api/auth/me': {
    action: 'profile.update', target: self, targetId: selfId,
    detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined) }),
  },
  'POST /api/auth/password': { action: 'auth.password_change', target: self, targetId: selfId },
  // users
  'POST /api/users': {
    action: 'user.create', target: ({ body }) => body.username as string, detail: ({ body }) => ({ role: body.role }),
  },
  'PATCH /api/users/:id': {
    action: 'user.update',
    detail: ({ body }) => ({ role: body.role, disabled: body.disabled, pwReset: body.password !== undefined ? true : undefined }),
  },
  'DELETE /api/users/:id': { action: 'user.delete' },
  'PUT /api/users/:id/grants': {
    action: 'grants.update', detail: ({ body }) => ({ scope: 'user', instanceIds: ids(body.instanceIds), count: ids(body.instanceIds).length }),
  },
  'PUT /api/instances/:id/grants': {
    action: 'grants.update', detail: ({ body }) => ({ scope: 'device', userIds: ids(body.userIds), count: ids(body.userIds).length }),
  },
  // devices (设备)
  'POST /api/instances': {
    action: 'device.create',
    target: ({ body }) => `${body.namePrefix}-* × ${body.count}`,
    detail: ({ body }) => ({
      profile: body.profile, count: body.count, namePrefix: body.namePrefix,
      width: body.width, height: body.height, dpi: body.dpi, memoryMb: body.memoryMb,
      locale: body.locale, timezone: body.timezone, deviceName: body.deviceName,
      proxyMode: body.proxyMode, force: body.force,
    }),
  },
  'POST /api/instances/external': { action: 'device.add_external', detail: ({ body }) => ({ sourceId: body.sourceId, phoneIds: Array.isArray(body.phoneIds) ? body.phoneIds : [] }) },
  'POST /api/device-sources': { action: 'device_source.create', target: ({ body }) => body.name as string, detail: ({ body }) => ({ type: body.type, config: body.config }) },
  'PATCH /api/device-sources/:id': { action: 'device_source.update', detail: ({ body }) => ({ name: body.name, config: body.config }) },
  'DELETE /api/device-sources/:id': { action: 'device_source.delete' },
  'POST /api/instances/actions': {
    action: ({ body }) => `device.action.${typeof body.action === 'string' ? body.action : 'unknown'}`,
    target: ({ body }) => instanceNames(ids(body.ids)),
    detail: ({ body }) => ({ action: body.action, ids: ids(body.ids), count: ids(body.ids).length }),
  },
  'PATCH /api/instances/:id/settings': {
    action: 'device.settings', detail: ({ body }) => ({ locale: body.locale, timezone: body.timezone, deviceName: body.deviceName }),
  },
  'PUT /api/instances/:id/proxy': { action: 'proxy.set', detail: ({ body }) => ({ proxyId: body.proxyId ?? null }) },
  'PUT /api/instances/:id/platforms': { action: 'device.platforms', detail: ({ body }) => ({ platforms: Array.isArray(body.platforms) ? body.platforms : null }) },
  'POST /api/instances/:id/apk': { action: 'app.install', detail: fileDetail },
  'POST /api/instances/:id/files': { action: 'file.upload', detail: fileDetail },
  // apps
  'POST /api/apps/install': {
    action: 'app.install',
    target: ({ upload }) => instanceNames(upload?.instanceIds ?? []),
    detail: ({ upload }) => (upload ? { filename: upload.filename, size: upload.size, instanceIds: upload.instanceIds ?? [], count: upload.instanceIds?.length ?? 0 } : undefined),
  },
  'POST /api/apps/uninstall': {
    action: 'app.uninstall', target: ({ body }) => body.package as string,
    detail: ({ body }) => ({ package: body.package, instanceIds: ids(body.instanceIds), count: ids(body.instanceIds).length }),
  },
  // app library (应用库)
  'POST /api/library/import': {
    action: 'library.import', target: ({ body }) => body.package as string,
    detail: ({ body }) => ({ package: body.package, instanceId: body.instanceId }),
  },
  'POST /api/library/upload': {
    action: 'library.upload',
    detail: ({ upload }) => (upload ? { filename: upload.filename, size: upload.size } : undefined),
  },
  'PATCH /api/library/:id': { action: 'library.update', detail: ({ body }) => ({ preinstall: body.preinstall }) },
  'POST /api/library/:id/install': {
    action: 'library.install', detail: ({ body }) => ({ instanceIds: ids(body.instanceIds), count: ids(body.instanceIds).length }),
  },
  'DELETE /api/library/:id': { action: 'library.delete' },
  // media library (素材库)
  'POST /api/media/upload': {
    action: 'media.upload', target: ({ upload }) => upload?.filename,
    detail: ({ upload }) => (upload ? { filename: upload.filename, size: upload.size, scope: upload.scope } : undefined),
  },
  'PUT /api/media/:id': {
    action: ({ body }) => (body.status === 'disabled' ? 'media.disable' : body.status === 'ready' ? 'media.enable' : 'media.update'),
    detail: ({ body }) => ({ name: body.name, categoryId: body.categoryId, tags: body.tags, status: body.status }),
  },
  'DELETE /api/media/:id': { action: 'media.delete' },
  'POST /api/media/batch-delete': {
    action: 'media.batch_delete',
    target: ({ body }) => mediaNames(ids(body.ids)),
    detail: ({ body }) => ({ ids: ids(body.ids), count: ids(body.ids).length }),
  },
  'POST /api/media/:id/favorite': { action: 'media.favorite' },
  'DELETE /api/media/:id/favorite': { action: 'media.unfavorite' },
  'POST /api/media/categories': {
    action: 'media.category_create', target: ({ body }) => body.name as string, detail: ({ body }) => ({ scope: body.scope, ownerId: body.ownerId, name: body.name, sort: body.sort }),
  },
  'PATCH /api/media/categories/:id': { action: 'media.category_update', detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined), name: body.name, sort: body.sort }) },
  'DELETE /api/media/categories/:id': { action: 'media.category_delete' },
  'POST /api/media/categories/:id/merge': { action: 'media.category_merge' },
  'POST /api/media/push': {
    action: 'media.push',
    target: ({ body }) => mediaNames(ids(body.assetIds)),
    detail: ({ body }) => ({
      assetIds: ids(body.assetIds), instanceIds: ids(body.instanceIds),
      assets: ids(body.assetIds).length, devices: ids(body.instanceIds).length,
    }),
  },
  // proxy pool (代理管理). Usernames/passwords are never stored in the log.
  'POST /api/proxies': {
    action: 'proxy.create', target: ({ body }) => proxyText(body),
    detail: ({ body }) => ({ type: body.type, kind: body.kind, host: body.host, port: body.port, auth: Boolean(body.username), label: body.label, provider: body.provider }),
  },
  'PUT /api/proxies/:id': {
    action: 'proxy.update',
    detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined && k !== 'password' && k !== 'username'), authChanged: body.password !== undefined || body.username !== undefined || undefined }),
  },
  'DELETE /api/proxies/:id': { action: 'proxy.delete' },
  'POST /api/proxies/import': {
    action: 'proxy.import',
    detail: ({ body }) => ({ defaultType: body.defaultType, kind: body.kind, dryRun: body.dryRun, lines: typeof body.text === 'string' ? body.text.split(/\r?\n/).filter((l) => l.trim()).length : 0 }),
  },
  // social accounts (社交账号). Notes and error texts are not copied into the audit log.
  'POST /api/social/accounts': {
    action: 'social.account_create', target: ({ body }) => `${String(body.platform)} @${String(body.handle).replace(/^@+/, '')}`,
    detail: ({ body }) => ({ platform: body.platform, ownerId: body.ownerId, instanceId: body.instanceId, personaId: body.personaId, loginStatus: body.loginStatus, accountStatus: body.accountStatus }),
  },
  'PUT /api/social/accounts/:id': {
    action: 'social.account_update',
    detail: ({ body }) => ({
      fields: Object.keys(body).filter((k) => body[k] !== undefined), instanceId: body.instanceId, personaId: body.personaId,
      loginStatus: body.loginStatus, accountStatus: body.accountStatus,
    }),
  },
  'POST /api/social/accounts/:id/checked': {
    action: 'social.account_checked', detail: ({ body }) => ({ loginStatus: body.loginStatus, accountStatus: body.accountStatus, error: body.lastError ? true : undefined }),
  },
  'DELETE /api/social/accounts/:id': { action: 'social.account_delete' },
  'POST /api/social/accounts/batch': {
    action: ({ body }) => `social.batch.${typeof body.action === 'string' ? body.action : 'unknown'}`,
    detail: ({ body }) => ({ action: body.action, ids: ids(body.ids), count: ids(body.ids).length, personaId: body.personaId, tags: body.tags }),
  },
  'PUT /api/social/settings': { action: 'social.settings_update', detail: ({ body }) => ({ limits: body.limits }) },
  // tracked accounts (追踪账号)
  'POST /api/tracked-accounts': {
    action: 'tracked.create', detail: ({ body }) => ({ platform: body.platform, tags: body.tags, favorite: body.favorite, refreshIntervalHours: body.refreshIntervalHours }),
  },
  'PATCH /api/tracked-accounts/:id': {
    action: 'tracked.update',
    detail: ({ body }) => ({
      fields: Object.keys(body).filter((k) => body[k] !== undefined), favorite: body.favorite, status: body.status, tags: body.tags, refreshIntervalHours: body.refreshIntervalHours,
    }),
  },
  'DELETE /api/tracked-accounts/:id': { action: 'tracked.delete' },
  'DELETE /api/tracked-accounts/:id/snapshots/:snapshotId': { action: 'tracked.snapshot_delete', detail: ({ params }) => ({ snapshotId: params.snapshotId }) },
  'DELETE /api/tracked-accounts/:id/posts/:postId': { action: 'tracked.post_delete', detail: ({ params }) => ({ postId: params.postId }) },
  'POST /api/tracked-accounts/:id/refresh': { action: 'tracked.refresh' },
  'POST /api/tracked-accounts/refresh': { action: 'tracked.refresh_batch', detail: ({ body }) => ({ ids: ids(body.ids), count: ids(body.ids).length }) },
  'POST /api/tracked-accounts/schedule': {
    action: 'tracked.schedule_batch', detail: ({ body }) => ({ count: ids(body.ids).length, refreshIntervalHours: body.refreshIntervalHours }),
  },
  // 趋势热点 / 定时采集
  'PUT /api/trending/settings': {
    action: 'trending.settings_update',
    detail: ({ body }) => ({ regions: body.regions, categoryId: body.categoryId, intervalHours: body.intervalHours, maxResults: body.maxResults, retentionDays: body.retentionDays }),
  },
  'POST /api/trending/refresh': { action: 'trending.refresh' },
  'POST /api/collection/run': { action: 'collection.run' },
  // platform integrations (平台接入). Client secrets and tokens are never logged; the OAuth callback
  // (a GET) is recorded explicitly by its route as platform.connect / platform.connect_failed.
  'PUT /api/settings/platforms/:platform': {
    action: 'platform.credentials_update', target: ({ params }) => String(params.platform),
    detail: ({ body }) => ({
      clientId: typeof body.clientId === 'string' ? body.clientId : body.clientId === null ? null : undefined,
      confidential: typeof body.clientSecret === 'string' ? 'set' : body.clientSecret === null ? 'cleared' : undefined, options: body.options,
    }),
  },
  'POST /api/platforms/:platform/connect': {
    action: 'platform.connect_start', target: ({ body }) => socialAccountName(body.socialAccountId),
    targetId: ({ body }) => (typeof body.socialAccountId === 'string' ? body.socialAccountId : null),
    detail: ({ params }) => ({ platform: params.platform }),
  },
  'DELETE /api/platforms/accounts/:id/connection': { action: 'platform.disconnect' },
  'POST /api/platforms/accounts/:id/check': { action: 'platform.account_check' },
  // content (内容管理) and publish scheduler (定时发布). Captions/bodies are not copied into the audit log.
  'POST /api/contents': {
    action: 'content.create', target: ({ body }) => body.title as string,
    detail: ({ body }) => ({ ownerId: body.ownerId, categoryId: body.categoryId, tags: body.tags, mediaIds: ids(body.mediaIds), targetIds: body.targetIds ? ids(body.targetIds) : undefined, stage: body.stage, lang: body.lang }),
  },
  'PUT /api/contents/:id': {
    action: ({ body }) => (body.stage === 'archived' ? 'content.archive' : 'content.update'),
    detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined), stage: body.stage, categoryId: body.categoryId, tags: body.tags, mediaIds: body.mediaIds ? ids(body.mediaIds) : undefined, targetIds: body.targetIds ? ids(body.targetIds) : undefined, lang: body.lang }),
  },
  'DELETE /api/contents/:id': { action: 'content.delete' },
  // 批量操作: action + ids only (the route adds ok/skipped/changed counts), never texts.
  'POST /api/contents/batch': {
    action: ({ body }) => `content.batch.${typeof body.action === 'string' ? body.action : 'unknown'}`,
    detail: ({ body }) => ({ action: body.action, ids: ids(body.ids), count: ids(body.ids).length, categoryId: body.categoryId, tags: body.tags }),
  },
  // 多语言内容: only the language is recorded, never the translated texts.
  'PUT /api/contents/:id/translations/:lang': { action: 'content.translation_save', detail: ({ params }) => ({ lang: params.lang }) },
  'DELETE /api/contents/:id/translations/:lang': { action: 'content.translation_delete', detail: ({ params }) => ({ lang: params.lang }) },
  'POST /api/contents/:id/distribute': {
    action: 'content.distribute',
    detail: ({ body }) => {
      const targets = Array.isArray(body.targets) ? (body.targets as Body[]) : [];
      return {
        accountIds: targets.map((t) => t.accountId), count: targets.length, republish: body.republish, maxAttempts: body.maxAttempts,
        scheduledAt: targets.map((t) => t.scheduledAt ?? null), postTypes: targets.map((t) => t.postType ?? 'feed'),
      };
    },
  },
  'POST /api/publish/tasks/:id/cancel': { action: 'publish.cancel' },
  'POST /api/publish/tasks/:id/reschedule': { action: 'publish.reschedule', detail: ({ body }) => ({ scheduledAt: body.scheduledAt }) },
  'POST /api/publish/tasks/:id/retry': { action: 'publish.retry', detail: ({ body }) => ({ scheduledAt: body.scheduledAt }) },
  'PATCH /api/publish/tasks/:id': { action: 'publish.update', detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined) }) },
  'POST /api/publish/tasks/:id/outcome': {
    action: ({ body }) => (body.result === 'published' ? 'publish.outcome_published' : 'publish.outcome_failed'),
    detail: ({ body }) => ({ result: body.result, url: body.url, externalId: body.externalId }),
  },
  // comments & engagement (评论互动). Comment and reply texts are not copied into the audit log.
  'PUT /api/comments/settings': {
    action: 'comment.rules_update',
    detail: ({ body }) => ({ requireApproval: body.requireApproval, duplicateMax: body.duplicateMax, duplicateWindowHours: body.duplicateWindowHours, sendsPerHour: body.sendsPerHour }),
  },
  'POST /api/comments/accounts/:id/sync': { action: 'comment.sync' },
  'POST /api/comments': {
    action: 'comment.manual_create', target: ({ body }) => socialAccountName(body.accountId),
    targetId: ({ body }) => (typeof body.accountId === 'string' ? body.accountId : null),
    detail: ({ body }) => ({ externalId: body.externalId, parentId: body.parentId, externalPostId: body.externalPostId }),
  },
  'PATCH /api/comments/:id': { action: 'comment.status', detail: ({ body }) => ({ status: body.status }) },
  'DELETE /api/comments/:id': { action: 'comment.delete' },
  'POST /api/comments/:id/replies': { action: 'comment.reply_create', detail: ({ body }) => ({ templateId: body.templateId, submit: body.submit, scheduledAt: body.scheduledAt }) },
  'PATCH /api/comment-replies/:id': { action: 'comment.reply_update', detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined) }) },
  'POST /api/comment-replies/:id/submit': { action: 'comment.reply_submit' },
  'POST /api/comment-replies/:id/approve': { action: 'comment.reply_approve' },
  'POST /api/comment-replies/approve': { action: 'comment.reply_approve_batch', detail: ({ body }) => ({ ids: ids(body.ids), count: ids(body.ids).length }) },
  'POST /api/comment-replies/:id/reject': { action: 'comment.reply_reject', detail: ({ body }) => ({ reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined }) },
  'POST /api/comment-replies/:id/cancel': { action: 'comment.reply_cancel' },
  'POST /api/comment-replies/:id/outcome': {
    action: ({ body }) => (body.result === 'sent' ? 'comment.reply_outcome_sent' : 'comment.reply_outcome_failed'),
    detail: ({ body }) => ({ result: body.result, externalReplyId: body.externalReplyId }),
  },
  'POST /api/comment-templates': { action: 'comment.template_create', target: ({ body }) => body.name as string, detail: ({ body }) => ({ shared: body.shared, kind: body.kind ?? 'comment' }) },
  'PUT /api/comment-templates/:id': { action: 'comment.template_update', detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined), kind: body.kind }) },
  'DELETE /api/comment-templates/:id': { action: 'comment.template_delete' },
  // 人设: names only (no descriptions); the route adds the persona name of a template and the merge target.
  'POST /api/personas': { action: 'persona.create', target: ({ body }) => body.name as string, detail: ({ body }) => ({ scope: body.scope, name: body.name }) },
  'PATCH /api/personas/:id': { action: 'persona.update', detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined), name: body.name, sort: body.sort }) },
  'DELETE /api/personas/:id': { action: 'persona.delete' },
  'POST /api/personas/:id/merge': { action: 'persona.merge' },
  // 内容分类: names only (no descriptions); the merge route adds the target name.
  'POST /api/content-categories': { action: 'content_category.create', target: ({ body }) => body.name as string, detail: ({ body }) => ({ scope: body.scope, name: body.name }) },
  'PATCH /api/content-categories/:id': { action: 'content_category.update', detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined), name: body.name, sort: body.sort }) },
  'DELETE /api/content-categories/:id': { action: 'content_category.delete' },
  'POST /api/content-categories/:id/merge': { action: 'content_category.merge' },
  // account analytics (账号分析)
  'POST /api/analytics/accounts/:id/refresh': { action: 'analytics.refresh' },
  // task centre (任务中心)
  'POST /api/tasks/:id/cancel': { action: 'task.cancel' },
  'POST /api/tasks/:id/retry': { action: 'task.retry' },
  // settings
  // The key itself is never stored in the log.
  'PUT /api/settings/tasks': { action: 'settings.task_retention', detail: ({ body }) => ({ retentionDays: body.retentionDays }) },
  'POST /api/settings/tasks/cleanup': { action: 'settings.task_cleanup' },
  'PUT /api/settings/languages': { action: 'settings.languages', detail: ({ body }) => ({ languages: body.languages, defaultSource: body.defaultSource }) },
  'PUT /api/settings/tracked-collectors/:platform': {
    action: 'settings.tracked_collector', detail: ({ params, body }) => ({ platform: params.platform, instanceId: body.instanceId, resume: body.resume }),
  },
  'PUT /api/settings/youtube': { action: 'settings.youtube_api_key', detail: ({ body }) => ({ set: typeof body.apiKey === 'string' }) },
  // alerts (告警通知): rules
  'PUT /api/settings/alerts': {
    action: 'settings.alerts',
    detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined), accountCheckHours: body.accountCheckHours, cooldownMinutes: body.cooldownMinutes }),
  },
  // alert channels (告警通道): config is summarised field by field; secrets only as set / replaced / unchanged
  'POST /api/alert-channels': {
    action: 'alert_channel.create', target: ({ body }) => body.name as string,
    detail: ({ body }) => ({ type: body.type, enabled: body.enabled, kinds: body.kinds, minSeverity: body.minSeverity, ...channelConfigDetail(body.config) }),
  },
  'PATCH /api/alert-channels/:id': {
    action: 'alert_channel.update',
    detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined), name: body.name, enabled: body.enabled, kinds: body.kinds, minSeverity: body.minSeverity, ...channelConfigDetail(body.config) }),
  },
  'DELETE /api/alert-channels/:id': { action: 'alert_channel.delete' },
  'POST /api/alert-channels/:id/test': { action: 'alert_channel.test' },
  'PUT /api/settings/storage': {
    action: 'storage.update',
    detail: ({ body }) => {
      const s3 = body.s3 as { endpoint?: string; region?: string; bucket?: string; forcePathStyle?: boolean; prefix?: string } | undefined;
      // Access key id and secret are never stored.
      return { type: body.type, s3: s3 ? { endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, forcePathStyle: s3.forcePathStyle, prefix: s3.prefix } : undefined };
    },
  },
  // system management (系统管理)
  'PUT /api/system/settings': {
    action: 'system.settings',
    detail: ({ body }) => ({ backup: body.backup, logRetentionDays: body.logRetentionDays, historyRetentionDays: body.historyRetentionDays }),
  },
  'POST /api/system/maintenance': { action: 'system.maintenance' },
  'POST /api/system/backups': { action: 'system.backup_create' },
  'DELETE /api/system/backups/:id': { action: 'system.backup_delete' },
};

/** Cheap `:id` → name lookups, by route prefix. */
async function resolveTarget(pattern: string, id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  if (pattern.startsWith('/api/instances/:id')) {
    const [r] = await db.select({ name: schema.instances.name }).from(schema.instances).where(eq(schema.instances.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/device-sources/:id')) {
    const [r] = await db.select({ name: schema.deviceSources.name }).from(schema.deviceSources).where(eq(schema.deviceSources.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/alert-channels/:id')) {
    const [r] = await db.select({ name: schema.alertChannels.name }).from(schema.alertChannels).where(eq(schema.alertChannels.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/users/:id')) {
    const [r] = await db.select({ name: schema.users.username }).from(schema.users).where(eq(schema.users.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/media/categories/:id')) {
    const [r] = await db.select({ name: schema.mediaCategories.name }).from(schema.mediaCategories).where(eq(schema.mediaCategories.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/media/:id')) {
    const [r] = await db.select({ name: schema.mediaAssets.name }).from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/proxies/:id')) {
    const [r] = await db.select({ label: schema.proxies.label, type: schema.proxies.type, host: schema.proxies.host, port: schema.proxies.port })
      .from(schema.proxies).where(eq(schema.proxies.id, id));
    return r ? (r.label ? `${r.label} (${r.type}://${r.host}:${r.port})` : `${r.type}://${r.host}:${r.port}`) : null;
  }
  if (pattern.startsWith('/api/social/accounts/:id') || pattern.startsWith('/api/platforms/accounts/:id') || pattern.startsWith('/api/analytics/accounts/:id')) {
    const [r] = await db.select({ platform: schema.socialAccounts.platform, handle: schema.socialAccounts.handle }).from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
    return r ? `${r.platform} @${r.handle}` : null;
  }
  if (pattern.startsWith('/api/tracked-accounts/:id')) {
    const [r] = await db.select({ platform: schema.trackedAccounts.platform, handle: schema.trackedAccounts.handle })
      .from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, id));
    return r ? `${r.platform} ${r.handle}` : null;
  }
  if (pattern.startsWith('/api/contents/:id')) {
    const [r] = await db.select({ title: schema.contents.title }).from(schema.contents).where(eq(schema.contents.id, id));
    return r?.title ?? null;
  }
  if (pattern.startsWith('/api/publish/tasks/:id')) {
    const [r] = await db.select({ platform: schema.publishTasks.platform, handle: schema.socialAccounts.handle, title: schema.contents.title })
      .from(schema.publishTasks)
      .leftJoin(schema.socialAccounts, eq(schema.socialAccounts.id, schema.publishTasks.accountId))
      .leftJoin(schema.contents, eq(schema.contents.id, schema.publishTasks.contentId))
      .where(eq(schema.publishTasks.id, id));
    return r ? `${r.platform} @${r.handle ?? '?'} · ${r.title ?? ''}` : null;
  }
  if (pattern.startsWith('/api/comments/accounts/:id')) {
    const [r] = await db.select({ platform: schema.socialAccounts.platform, handle: schema.socialAccounts.handle }).from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
    return r ? `${r.platform} @${r.handle}` : null;
  }
  if (pattern.startsWith('/api/comments/:id')) {
    const [r] = await db.select({ platform: schema.comments.platform, handle: schema.socialAccounts.handle, author: schema.comments.authorName })
      .from(schema.comments).leftJoin(schema.socialAccounts, eq(schema.socialAccounts.id, schema.comments.accountId)).where(eq(schema.comments.id, id));
    return r ? `${r.platform} @${r.handle ?? '?'} · ${r.author ?? '?'}` : null;
  }
  if (pattern.startsWith('/api/comment-replies/:id')) {
    const [r] = await db.select({ platform: schema.commentTasks.platform, handle: schema.socialAccounts.handle, author: schema.comments.authorName })
      .from(schema.commentTasks).leftJoin(schema.socialAccounts, eq(schema.socialAccounts.id, schema.commentTasks.accountId))
      .leftJoin(schema.comments, eq(schema.comments.id, schema.commentTasks.commentId)).where(eq(schema.commentTasks.id, id));
    return r ? `${r.platform} @${r.handle ?? '?'} → ${r.author ?? '?'}` : null;
  }
  if (pattern.startsWith('/api/personas/:id')) {
    const [r] = await db.select({ name: schema.personas.name }).from(schema.personas).where(eq(schema.personas.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/content-categories/:id')) {
    const [r] = await db.select({ name: schema.contentCategories.name }).from(schema.contentCategories).where(eq(schema.contentCategories.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/comment-templates/:id')) {
    const [r] = await db.select({ name: schema.commentTemplates.name }).from(schema.commentTemplates).where(eq(schema.commentTemplates.id, id));
    return r?.name ?? null;
  }
  if (pattern.startsWith('/api/tasks/:id')) {
    const [r] = await db.select({ type: schema.tasks.type, label: schema.tasks.instanceName }).from(schema.tasks).where(eq(schema.tasks.id, id));
    return r ? (r.label ? `${r.type} · ${r.label}` : r.type) : null;
  }
  if (pattern.startsWith('/api/library/:id')) {
    const [r] = await db.select({ pkg: schema.libraryApps.package, v: schema.libraryApps.versionName, c: schema.libraryApps.versionCode })
      .from(schema.libraryApps).where(eq(schema.libraryApps.id, id));
    return r ? `${r.pkg} ${r.v ?? r.c}` : null;
  }
  return null;
}

function audited(req: FastifyRequest): string | null {
  const pattern = req.routeOptions.url;
  if (!pattern || !pattern.startsWith('/api/') || !MUTATING.has(req.method) || req.ws) return null;
  const key = `${req.method} ${pattern}`;
  return AUDIT_EXCLUDED.has(key) ? null : key;
}

function fieldText(raw: unknown): string | undefined {
  const value = (raw as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' ? value.slice(0, 20) : undefined;
}

function parseIds(raw: unknown): string[] | undefined {
  const value = (raw as { value?: unknown } | undefined)?.value;
  if (typeof value !== 'string') return undefined;
  try {
    const arr = JSON.parse(value) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 100) : undefined;
  } catch { return undefined; }
}

async function buildEntry(req: FastifyRequest, key: string, status: number) {
  const pattern = req.routeOptions.url!;
  const ctx = req.audit ?? {};
  const params = (req.params ?? {}) as Body;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Body;
  const upload: Upload | undefined = ctx.upload
    ? { filename: ctx.upload.filename, size: ctx.upload.stream.bytesRead ?? 0, instanceIds: parseIds(ctx.upload.fields.instanceIds), scope: fieldText(ctx.upload.fields.scope) }
    : undefined;
  const c: Ctx = { req, body, params, upload };
  const spec = ACTIONS[key];
  const id = typeof params.id === 'string' ? params.id : null;

  let target: string | null | undefined = ctx.target;
  if (target === undefined && spec?.target) target = await spec.target(c);
  if (target === undefined && id) target = await resolveTarget(pattern, id);

  // Unknown routes: no body summary at all, only the route params.
  const detail: Record<string, unknown> = { ...(spec ? spec.detail?.(c) : { params }), ...ctx.extra };
  if (status >= 400 && ctx.error) detail.error = ctx.error.slice(0, 200);

  return {
    userId: req.user?.id ?? null,
    username: req.user?.username ?? null,
    action: spec ? (typeof spec.action === 'function' ? spec.action(c) : spec.action) : key,
    target: target ?? null,
    targetId: spec?.targetId?.(c) ?? id,
    method: req.method,
    path: pattern,
    status,
    ip: req.ip,
    detail,
  };
}

export const auditPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('audit', null);

  app.addHook('preHandler', async (req) => {
    const key = audited(req);
    if (!key) return;
    req.audit = {};
    // DELETE: resolve the name now, the row is gone by the time the response is sent.
    const id = (req.params as Body | undefined)?.id;
    if (req.method === 'DELETE' && typeof id === 'string') {
      try { req.audit.target = await resolveTarget(req.routeOptions.url!, id); } catch (err) { req.log.warn({ err }, 'audit target lookup failed'); }
    }
    // Multipart: remember filename + the stream (its bytesRead gives the size). Contents are never read here.
    if (req.isMultipart()) {
      const original = req.file.bind(req);
      const ctx = req.audit;
      req.file = (async (...args: Parameters<typeof original>) => {
        const f = await original(...args);
        if (f) ctx.upload = { filename: f.filename, mimetype: f.mimetype, stream: f.file as { bytesRead?: number }, fields: f.fields as Record<string, unknown> };
        return f;
      }) as typeof req.file;
    }
  });

  app.addHook('onError', async (req, _reply, err) => {
    if (req.audit) req.audit.error = err.message;
  });

  app.addHook('onResponse', async (req, reply) => {
    const key = audited(req);
    if (!key) return;
    const status = reply.statusCode;
    // Not awaited: the reply is already sent and audit failures must not surface anywhere.
    void buildEntry(req, key, status)
      .then((e) => recordAudit(req.log, e))
      .catch((err) => req.log.error({ err, key }, 'audit entry failed'));
  });
});
