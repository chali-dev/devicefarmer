import { desc, eq, getTableColumns, inArray } from 'drizzle-orm';
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
import { enqueue, type DeviceOpName } from './queue.js';
import { getInstance, publicInstance, publicInstances, publishInstance, updateInstance } from './repo.js';
import { assignFreeProxies, countFreeUsable, isUniqueViolation, lockFreeProxies } from '../proxies/pool.js';
import { getProfile, PROFILES } from '../../profiles.js';
import { adb, dockerHost, network } from '../../services.js';
import { checkGoogleHealth } from '../google/health.js';
import { DeviceSettings, readDeviceSettings } from './device-settings.js';
import { prepareUpload } from '../apps/package.js';

const BUSY: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const MAX_BATCH = 20;

const CreateBody = z.object({
  /**
   * Pool proxy per device (exclusive): `auto` assigns distinct free usable proxies (ok, then unchecked),
   * `pick` binds `proxyIds` (one per device, in order), `none` = direct.
   */
  proxyMode: z.enum(['auto', 'none', 'pick']).default('none'),
  proxyIds: z.array(z.string().uuid()).max(MAX_BATCH).optional(),
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
    if (port > config.ADB_PORT_MAX) throw conflict('no free adb ports left on the Android host', 'instances.no_free_ports');
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
    const visible = await publicInstances(allowed === 'all' ? rows : rows.filter((r) => allowed.has(r.id)));
    if (!isAdmin(req.user)) return { instances: visible };
    // Admin only: users granted each device (never exposed to non-admins).
    const grants = await db.select({
      instanceId: schema.instanceGrants.instanceId, id: schema.users.id,
      username: schema.users.username, displayName: schema.users.displayName,
    }).from(schema.instanceGrants)
      .innerJoin(schema.users, eq(schema.users.id, schema.instanceGrants.userId))
      .orderBy(schema.users.username);
    const owners = new Map<string, { id: string; username: string; displayName: string | null }[]>();
    for (const { instanceId, ...u } of grants) {
      const list = owners.get(instanceId) ?? [];
      list.push(u);
      owners.set(instanceId, list);
    }
    return { instances: visible.map((i) => ({ ...i, owners: owners.get(i.id) ?? [] })) };
  });

  app.get('/api/instances/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    return { instance: await publicInstance(inst) };
  });

  /** Batch create (admin only). Instances are created by the queue. */
  app.post('/api/instances', { schema: { body: CreateBody } }, async (req, reply) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以创建设备', 'instances.create_admin_only');
    const b = req.body;
    const profile = getProfile(b.profile);
    const avail = (await profileAvailability()).find((p) => p.id === b.profile);
    if (!profile || !avail) throw badRequest(`unknown profile "${b.profile}"`, 'instances.unknown_profile', { profile: b.profile });
    if (!avail.available) throw conflict(`profile unavailable: ${avail.reason}`, 'instances.profile_unavailable', { reason: avail.reason ?? '' });
    // Proxies first (cheap, no side effects); the binding itself is decided under row locks below.
    if (b.proxyMode === 'pick') {
      const ids = b.proxyIds ?? [];
      if (ids.length !== b.count) throw badRequest(`proxyIds 数量（${ids.length}）必须等于创建数量（${b.count}）`, 'proxy.count_mismatch', { proxies: ids.length, count: b.count });
      if (new Set(ids).size !== ids.length) throw conflict('同一批次中存在重复代理', 'proxy.duplicate_in_batch');
      await db.transaction((tx) => lockFreeProxies(tx, ids));
    } else if (b.proxyMode === 'auto') {
      const free = await countFreeUsable();
      if (free < b.count) throw conflict(`空闲可用代理不足：需要 ${b.count} 个，当前 ${free} 个`, 'proxy.not_enough_free', { need: b.count, free });
    }
    // Capacity check: refuse to overcommit the Android host's memory (OOM kills every instance).
    if (!b.force) {
      const freeMb = await dockerHost.memAvailableMb();
      const needMb = profile.memEstimateMb * b.count + 512; // keep headroom for the host
      if (needMb > freeMb) {
        throw conflict(`宿主机可用内存不足：需要约 ${needMb} MiB（${b.count} × ${profile.memEstimateMb} + 512 余量），当前可用 ${freeMb} MiB`,
          'instances.insufficient_memory', { needMb, count: b.count, perMb: profile.memEstimateMb, freeMb });
      }
    }
    const slots = await allocate(b.namePrefix, b.count);
    const rows = await db.transaction(async (tx) => {
      // Locked until commit: concurrent creations (SKIP LOCKED) and binds (FOR UPDATE) can't take the same proxy.
      const proxyIds: (string | null)[] = b.proxyMode === 'auto' ? await assignFreeProxies(tx, b.count)
        : b.proxyMode === 'pick' ? (await lockFreeProxies(tx, b.proxyIds!), b.proxyIds!)
          : slots.map(() => null);
      const inserted = await tx.insert(schema.instances).values(slots.map((s, i) => ({
        proxyId: proxyIds[i],
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
    }).catch((err) => {
      if (isUniqueViolation(err, 'instances_proxy_id_unique')) throw conflict('代理已被其他设备占用，请重试', 'proxy.bind_conflict');
      throw err;
    });
    if (b.proxyMode !== 'none' && req.audit) req.audit.extra = { proxyIds: rows.map((r) => r.proxyId) };
    const taskIds = [];
    for (const r of rows) taskIds.push(await enqueue('create', r, req.user.id));
    reply.code(202);
    return { instances: await publicInstances(rows), taskIds };
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
    if (req.body.action === 'delete' && !isAdmin(req.user)) throw forbidden('仅管理员可以删除设备', 'instances.delete_admin_only');
    const ids = [...new Set(req.body.ids)];
    for (const id of ids) await assertInstanceAccess(req.user, id, 'operate');
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, ids));
    const accepted: { instanceId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string }[] = [];
    for (const r of rows) {
      if (BUSY.includes(r.status)) { skipped.push({ instanceId: r.id, reason: `busy (${r.status})` }); continue; }
      if (req.body.action === 'start' && r.status === 'running') { skipped.push({ instanceId: r.id, reason: 'already running' }); continue; }
      if (req.body.action === 'stop' && r.status === 'stopped') { skipped.push({ instanceId: r.id, reason: 'already stopped' }); continue; }
      accepted.push({ instanceId: r.id, taskId: await enqueue(req.body.action as DeviceOpName, r, req.user.id) });
    }
    for (const id of ids) if (!rows.some((r) => r.id === id)) skipped.push({ instanceId: id, reason: 'not found' });
    reply.code(202);
    return { accepted, skipped };
  });

  /** Single-instance APK/bundle upload (same path as batch install). */
  app.post('/api/instances/:id/apk', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'operate');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
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
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    const actual = inst.status === 'running' ? await readDeviceSettings(inst.adbPort).catch(() => null) : null;
    return { configured: { locale: inst.spec.locale, timezone: inst.spec.timezone, deviceName: inst.spec.deviceName }, actual };
  });

  app.patch('/api/instances/:id/settings', {
    schema: { params: z.object({ id: z.string().uuid() }), body: DeviceSettings },
  }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'operate');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (BUSY.includes(inst.status)) throw conflict(`instance is busy (${inst.status})`, 'instances.busy', { status: inst.status });
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
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    const png = await adb.screenshot(inst.adbPort);
    reply.header('content-type', 'image/png')
      .header('content-disposition', `attachment; filename="${inst.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png"`);
    return reply.send(png);
  });

  /**
   * Android logcat on demand (read-only `logcat -d`). Needs `control` like remote control, since logs
   * can contain app data. The keyword is filtered here in JS and never reaches the shell.
   */
  app.get('/api/instances/:id/logcat', {
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({
        lines: z.coerce.number().int().default(500).transform((n) => Math.min(2000, Math.max(50, n))),
        level: z.enum(['E', 'W', 'I', 'D']).default('W'),
        q: z.string().max(200).optional(),
      }),
    },
  }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'control');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    const { lines, level, q } = req.query;
    const out = await adb.shell(inst.adbPort, `logcat -d -v time -t ${lines} '*:${level}'`, 20_000);
    // `-t` counts per buffer (main/system/crash), so cap the merged output to the newest `lines` here.
    let rows = out.split('\n').map((l) => l.replace(/\r/g, '')).filter((l) => l.length > 0).slice(-lines);
    const kw = q?.trim().toLowerCase();
    if (kw) rows = rows.filter((l) => l.toLowerCase().includes(kw));
    return { lines: rows };
  });

  /** Run the Google services health check now (otherwise every 60 s by the monitor). */
  app.post('/api/instances/:id/google/check', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    const google = await checkGoogleHealth(inst.adbPort);
    await updateInstance(inst.id, { google });
    return { google };
  });

  /**
   * Bind a pool proxy to the device, or unbind (null). Admin only: the pool is admin-managed and a proxy
   * is an exclusive, paid resource; users see their devices' proxy (without credentials) but can't change it.
   * Applied by a task (hot reload; legacy devices get a sidecar).
   */
  app.put('/api/instances/:id/proxy', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ proxyId: z.string().uuid().nullable() }) },
  }, async (req, reply) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以为设备绑定代理', 'proxy.bind_admin_only');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (BUSY.includes(inst.status)) throw conflict(`instance is busy (${inst.status})`, 'instances.busy', { status: inst.status });
    const { proxyId } = req.body;
    if (req.audit) req.audit.extra = { fromProxyId: inst.proxyId };
    const updated = await db.transaction(async (tx) => {
      const [p] = proxyId ? await lockFreeProxies(tx, [proxyId], inst.id) : [];
      const [row] = await tx.update(schema.instances).set({ proxyId, proxyStatus: null }).where(eq(schema.instances.id, inst.id)).returning();
      return { row: row!, label: p ? `${p.type}://${p.host}:${p.port}` : '直连' };
    }).catch((err) => {
      if (isUniqueViolation(err, 'instances_proxy_id_unique')) throw conflict('代理已被其他设备占用', 'proxy.bind_conflict');
      throw err;
    });
    await publishInstance(updated.row);
    const taskId = await enqueue('set-proxy', inst, req.user.id, {}, updated.label);
    reply.code(202);
    return { instance: await publicInstance(updated.row), taskId };
  });

  /** Egress check from inside the instance's network namespace (same path as Android traffic). */
  app.post('/api/instances/:id/proxy/check', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (!inst.netContainerId) throw conflict('该设备没有网络组件（旧设备），设置代理后自动创建', 'proxy.no_net_container');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    const proxyStatus = await network.check(inst.netContainerId);
    await updateInstance(inst.id, { proxyStatus });
    return { proxyStatus };
  });

  app.get('/api/tasks', {
    schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), instanceId: z.string().uuid().optional() }) },
  }, async (req) => {
    const allowed = await accessibleInstanceIds(req.user);
    const where = req.query.instanceId ? eq(schema.tasks.instanceId, req.query.instanceId) : undefined;
    const rows = await db.select({ ...getTableColumns(schema.tasks), createdByName: schema.users.username })
      .from(schema.tasks).leftJoin(schema.users, eq(schema.users.id, schema.tasks.createdBy))
      .where(where).orderBy(desc(schema.tasks.createdAt)).limit(req.query.limit);
    return { tasks: allowed === 'all' ? rows : rows.filter((t) => t.instanceId && allowed.has(t.instanceId)) };
  });
};
