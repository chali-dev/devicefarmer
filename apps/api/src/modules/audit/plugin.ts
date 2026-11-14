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
 * - POST /api/auth/login: recorded explicitly by the login route (auth.login / auth.login_failed).
 * - read-like POSTs that only query/probe and change nothing the user configured:
 *   proxy egress checks (device and pool), Google health check, storage connection test.
 * Also skipped: non-mutating methods (GET/HEAD/OPTIONS), WebSocket upgrades, requests outside
 * /api/ and requests that matched no route (404 without a route pattern).
 */
export const AUDIT_EXCLUDED = new Set([
  'POST /api/auth/login',
  'POST /api/instances/:id/proxy/check',
  'POST /api/proxies/:id/check',
  'POST /api/proxies/check',
  'POST /api/instances/:id/google/check',
  'POST /api/settings/storage/test',
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
  'POST /api/instances/actions': {
    action: ({ body }) => `device.action.${typeof body.action === 'string' ? body.action : 'unknown'}`,
    target: ({ body }) => instanceNames(ids(body.ids)),
    detail: ({ body }) => ({ action: body.action, ids: ids(body.ids), count: ids(body.ids).length }),
  },
  'PATCH /api/instances/:id/settings': {
    action: 'device.settings', detail: ({ body }) => ({ locale: body.locale, timezone: body.timezone, deviceName: body.deviceName }),
  },
  'PUT /api/instances/:id/proxy': { action: 'proxy.set', detail: ({ body }) => ({ proxyId: body.proxyId ?? null }) },
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
    action: 'media.category_create', target: ({ body }) => body.name as string, detail: ({ body }) => ({ scope: body.scope, name: body.name, sort: body.sort }),
  },
  'PUT /api/media/categories/:id': { action: 'media.category_update', detail: ({ body }) => ({ name: body.name, sort: body.sort }) },
  'DELETE /api/media/categories/:id': { action: 'media.category_delete' },
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
    detail: ({ body }) => ({ type: body.type, host: body.host, port: body.port, auth: Boolean(body.username), label: body.label, provider: body.provider }),
  },
  'PUT /api/proxies/:id': {
    action: 'proxy.update',
    detail: ({ body }) => ({ fields: Object.keys(body).filter((k) => body[k] !== undefined && k !== 'password' && k !== 'username'), authChanged: body.password !== undefined || body.username !== undefined || undefined }),
  },
  'DELETE /api/proxies/:id': { action: 'proxy.delete' },
  'POST /api/proxies/import': {
    action: 'proxy.import',
    detail: ({ body }) => ({ defaultType: body.defaultType, dryRun: body.dryRun, lines: typeof body.text === 'string' ? body.text.split(/\r?\n/).filter((l) => l.trim()).length : 0 }),
  },
  // settings
  'PUT /api/settings/storage': {
    action: 'storage.update',
    detail: ({ body }) => {
      const s3 = body.s3 as { endpoint?: string; region?: string; bucket?: string; forcePathStyle?: boolean; prefix?: string } | undefined;
      // Access key id and secret are never stored.
      return { type: body.type, s3: s3 ? { endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, forcePathStyle: s3.forcePathStyle, prefix: s3.prefix } : undefined };
    },
  },
};

/** Cheap `:id` → name lookups, by route prefix. */
async function resolveTarget(pattern: string, id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  if (pattern.startsWith('/api/instances/:id')) {
    const [r] = await db.select({ name: schema.instances.name }).from(schema.instances).where(eq(schema.instances.id, id));
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
