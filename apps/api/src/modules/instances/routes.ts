import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { Instance } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { accessibleInstanceIds, assertInstanceAccess, isAdmin } from '../auth/rbac.js';
import { enqueue, type OpName } from './queue.js';
import { getInstance, publicInstance, updateInstance } from './repo.js';
import { proxyKey } from '../network/singbox.js';
import type { ProxyConfig } from '../../db/schema.js';
import { getProfile, PROFILES } from '../../profiles.js';
import { adb, dockerHost, network } from '../../services.js';
import { checkGoogleHealth } from '../google/health.js';
import { DeviceSettings, readDeviceSettings } from './device-settings.js';
import { prepareUpload } from '../apps/package.js';

const BUSY: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const MAX_BATCH = 20;

const Proxy = z.object({
  type: z.enum(['socks5', 'http']),
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, 'hostname or IPv4'),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
});

/** Prevents accidentally giving two instances the same proxy endpoint+user. */
async function assertProxyNotShared(proxy: ProxyConfig, exceptId?: string) {
  const rows = await db.select({ id: schema.instances.id, name: schema.instances.name, proxy: schema.instances.proxy }).from(schema.instances);
  const other = rows.find((r) => r.id !== exceptId && r.proxy && proxyKey(r.proxy) === proxyKey(proxy));
  if (other) throw conflict(`该代理已被设备 ${other.name} 使用（如确需共享请勾选 allowShared）`);
}

const CreateBody = z.object({
  /** One proxy per instance: when creating several, pass `proxies` (one per instance) instead. */
  proxy: Proxy.optional(),
  proxies: z.array(Proxy).max(20).optional(),
  allowShared: z.boolean().optional(),
  profile: z.string().default('redroid-12'),
  count: z.number().int().min(1).max(MAX_BATCH).default(1),
  namePrefix: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, 'lowercase letters, digits and dashes').default('phone'),
  width: z.number().int().min(320).max(2160).default(720),
  height: z.number().int().min(480).max(3840).default(1280),
  dpi: z.number().int().min(120).max(640).default(320),
  memoryMb: z.number().int().min(1024).max(16384).optional(),
  /** Skip the host memory check */
  force: z.boolean().optional(),
}).extend(DeviceSettings.shape);

/** Profiles with availability on the current Android host (image configured, KVM if required). */
async function profileAvailability() {
  const kvm = await dockerHost.hasKvm().catch(() => false);
  return PROFILES.map((p) => {
    const reasons = [p.blockedReason, !p.image && '未配置镜像', p.requiresKvm && !kvm && '宿主机没有 /dev/kvm（需要 x86_64 Linux + KVM）'].filter(Boolean);
    const reason = reasons.length ? reasons.join('；') : null;
    return { id: p.id, label: p.label, engine: p.engine, gapps: p.gapps, available: !reason, reason };
  });
}

/** Picks free names `<prefix>-<n>` and free host adb ports. */
async function allocate(prefix: string, count: number) {
  const existing = await db.select({ name: schema.instances.name, port: schema.instances.adbPort }).from(schema.instances);
  const usedPorts = new Set(existing.map((e) => e.port));
  const usedNames = new Set(existing.map((e) => e.name));
  const out: { name: string; adbPort: number }[] = [];
  let n = 1;
  let port = config.ADB_PORT_MIN;
  while (out.length < count) {
    while (usedNames.has(`${prefix}-${n}`)) n++;
    while (usedPorts.has(port)) port++;
    if (port > config.ADB_PORT_MAX) throw conflict('no free adb ports left on the Android host');
    out.push({ name: `${prefix}-${n}`, adbPort: port });
    usedNames.add(`${prefix}-${n}`);
    usedPorts.add(port);
  }
  return out;
}

export const instanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/profiles', async () => ({ profiles: await profileAvailability() }));

  app.get('/api/instances', async (req) => {
    const allowed = await accessibleInstanceIds(req.user);
    const rows = await db.select().from(schema.instances).orderBy(schema.instances.name);
    return { instances: (allowed === 'all' ? rows : rows.filter((r) => allowed.has(r.id))).map(publicInstance) };
  });

  app.get('/api/instances/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    return { instance: publicInstance(inst) };
  });

  /** Batch create (admin only). Instances are created by the queue. */
  app.post('/api/instances', { schema: { body: CreateBody } }, async (req, reply) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以创建设备');
    const b = req.body;
    const profile = getProfile(b.profile);
    const avail = (await profileAvailability()).find((p) => p.id === b.profile);
    if (!profile || !avail) throw badRequest(`unknown profile "${b.profile}"`);
    if (!avail.available) throw conflict(`profile unavailable: ${avail.reason}`);
    if (b.proxy && b.count > 1) throw badRequest('多台设备请使用 proxies（每台一个代理），避免共享同一代理');
    if (b.proxies && b.proxies.length !== b.count) throw badRequest(`proxies 数量（${b.proxies.length}）必须等于创建数量（${b.count}）`);
    const proxies: (ProxyConfig | null)[] = Array.from({ length: b.count }, (_, i) => b.proxies?.[i] ?? b.proxy ?? null);
    if (!b.allowShared) {
      const keys = proxies.filter((p): p is ProxyConfig => !!p).map(proxyKey);
      if (new Set(keys).size !== keys.length) throw conflict('同一批次中存在重复代理');
      for (const p of proxies) if (p) await assertProxyNotShared(p);
    }
    // Capacity check: refuse to overcommit the Android host's memory (OOM kills every instance).
    if (!b.force) {
      const freeMb = await dockerHost.memAvailableMb();
      const needMb = profile.memEstimateMb * b.count + 512; // keep headroom for the host
      if (needMb > freeMb) {
        throw conflict(`宿主机可用内存不足：需要约 ${needMb} MiB（${b.count} × ${profile.memEstimateMb} + 512 余量），当前可用 ${freeMb} MiB`);
      }
    }
    const slots = await allocate(b.namePrefix, b.count);
    const rows = await db.transaction(async (tx) => {
      const inserted = await tx.insert(schema.instances).values(slots.map((s, i) => ({
        proxy: proxies[i],
        name: s.name, adbPort: s.adbPort, image: profile.image!, engine: profile.engine, profile: profile.id,
        status: 'creating' as const, createdBy: req.user.id,
        spec: {
          width: b.width, height: b.height, dpi: b.dpi,
          ...(b.memoryMb ? { memoryMb: b.memoryMb } : {}),
          ...(b.locale ? { locale: b.locale } : {}),
          ...(b.timezone ? { timezone: b.timezone } : {}),
          ...(b.deviceName ? { deviceName: b.deviceName } : {}),
        },
      }))).returning();
      return inserted;
    });
    const taskIds = [];
    for (const r of rows) taskIds.push(await enqueue('create', r, req.user.id));
    reply.code(202);
    return { instances: rows.map(publicInstance), taskIds };
  });

  /** Batch lifecycle actions. Each instance becomes one task; busy instances are skipped. */
  app.post('/api/instances/actions', {
    schema: {
      body: z.object({
        action: z.enum(['start', 'stop', 'restart', 'delete']),
        ids: z.array(z.string().uuid()).min(1).max(100),
      }),
    },
  }, async (req, reply) => {
    if (req.body.action === 'delete' && !isAdmin(req.user)) throw forbidden('仅管理员可以删除设备');
    const ids = [...new Set(req.body.ids)];
    for (const id of ids) await assertInstanceAccess(req.user, id, 'operate');
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, ids));
    const accepted: { instanceId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string }[] = [];
    for (const r of rows) {
      if (BUSY.includes(r.status)) { skipped.push({ instanceId: r.id, reason: `busy (${r.status})` }); continue; }
      if (req.body.action === 'start' && r.status === 'running') { skipped.push({ instanceId: r.id, reason: 'already running' }); continue; }
      if (req.body.action === 'stop' && r.status === 'stopped') { skipped.push({ instanceId: r.id, reason: 'already stopped' }); continue; }
      accepted.push({ instanceId: r.id, taskId: await enqueue(req.body.action as OpName, r, req.user.id) });
    }
    for (const id of ids) if (!rows.some((r) => r.id === id)) skipped.push({ instanceId: id, reason: 'not found' });
    reply.code(202);
    return { accepted, skipped };
  });

  /** Single-instance APK/bundle upload (same path as batch install). */
  app.post('/api/instances/:id/apk', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'operate');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    if (inst.status !== 'running') throw conflict('instance is not running');
    const file = await req.file();
    if (!file) throw badRequest('missing file');
    const prepared = await prepareUpload(file.file, file.filename);
    const taskId = await enqueue('install-apk', inst, req.user.id, { apkPaths: prepared.apkPaths, sizes: prepared.sizes }, prepared.name);
    reply.code(202);
    return { taskId, filename: file.filename, apks: prepared.apkPaths.length };
  });

  /** Device settings that Android exposes (locale, timezone, device name). Applied by a task. */
  app.get('/api/instances/:id/settings', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    const actual = inst.status === 'running' ? await readDeviceSettings(inst.adbPort).catch(() => null) : null;
    return { configured: { locale: inst.spec.locale, timezone: inst.spec.timezone, deviceName: inst.spec.deviceName }, actual };
  });

  app.patch('/api/instances/:id/settings', {
    schema: { params: z.object({ id: z.string().uuid() }), body: DeviceSettings },
  }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'operate');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    if (BUSY.includes(inst.status)) throw conflict(`instance is busy (${inst.status})`);
    const spec = { ...inst.spec, ...Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)) };
    await updateInstance(inst.id, { spec });
    // Running: apply now. Stopped: applied automatically on next start.
    const taskId = inst.status === 'running' ? await enqueue('apply-settings', inst, req.user.id) : null;
    reply.code(202);
    return { spec, taskId };
  });

  /** Full-resolution PNG screenshot. */
  app.get('/api/instances/:id/screenshot', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'control');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    if (inst.status !== 'running') throw conflict('instance is not running');
    const png = await adb.screenshot(inst.adbPort);
    reply.header('content-type', 'image/png')
      .header('content-disposition', `attachment; filename="${inst.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png"`);
    return reply.send(png);
  });

  /** Run the Google services health check now (otherwise every 60 s by the monitor). */
  app.post('/api/instances/:id/google/check', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    if (inst.status !== 'running') throw conflict('instance is not running');
    const google = await checkGoogleHealth(inst.adbPort);
    await updateInstance(inst.id, { google });
    return { google };
  });

  /** Set or clear (null) the instance's proxy. Applied by a task (hot reload; legacy instances get a sidecar). */
  app.put('/api/instances/:id/proxy', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ proxy: Proxy.nullable(), allowShared: z.boolean().optional() }) },
  }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'operate');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    if (BUSY.includes(inst.status)) throw conflict(`instance is busy (${inst.status})`);
    let proxy: ProxyConfig | null = req.body.proxy;
    // Keep the stored password when the client re-submits the form without it (passwords are write-only).
    if (proxy && proxy.password === undefined && inst.proxy?.password && proxyKey(inst.proxy) === proxyKey(proxy)) {
      proxy = { ...proxy, password: inst.proxy.password };
    }
    if (proxy && !req.body.allowShared) await assertProxyNotShared(proxy, inst.id);
    const updated = await updateInstance(inst.id, { proxy, proxyStatus: null });
    const taskId = await enqueue('set-proxy', inst, req.user.id, {}, proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : '直连');
    reply.code(202);
    return { instance: publicInstance(updated!), taskId };
  });

  /** Egress check from inside the instance's network namespace (same path as Android traffic). */
  app.post('/api/instances/:id/proxy/check', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found');
    if (!inst.netContainerId) throw conflict('该设备没有网络组件（旧设备），设置代理后自动创建');
    if (inst.status !== 'running') throw conflict('instance is not running');
    const proxyStatus = await network.check(inst.netContainerId);
    await updateInstance(inst.id, { proxyStatus });
    return { proxyStatus };
  });

  app.get('/api/tasks', {
    schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), instanceId: z.string().uuid().optional() }) },
  }, async (req) => {
    const allowed = await accessibleInstanceIds(req.user);
    const where = req.query.instanceId ? eq(schema.tasks.instanceId, req.query.instanceId) : undefined;
    const rows = await db.select().from(schema.tasks).where(where).orderBy(desc(schema.tasks.createdAt)).limit(req.query.limit);
    return { tasks: allowed === 'all' ? rows : rows.filter((t) => t.instanceId && allowed.has(t.instanceId)) };
  });
};
