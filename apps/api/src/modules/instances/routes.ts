import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { Instance } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { accessibleInstanceIds, assertInstanceAccess, assertInstancesAccess, isAdmin, type AuthUser } from '../auth/rbac.js';
import { checkEgress } from './egress.js';
import { enqueue, type DeviceOpName } from './queue.js';
import { getInstance, publicInstance, publicInstances, publishInstance, updateInstance } from './repo.js';
import { adb } from '../../services.js';
import { prepareUpload } from '../apps/package.js';
import { PLATFORM_IDS } from '../social/platforms.js';
import { scrcpyActive } from '../control/scrcpy-hub.js';
import { deviceBusy, deviceHalts } from '../tracked/collector.js';

const BUSY: Instance['status'][] = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];

/**
 * Grid thumbnails: one screencap per device per TTL, shared by every viewer (and by concurrent requests).
 * `screencap` is a full-resolution PNG (~1.1 MB on a 1080x2374 phone), which over an external phone's
 * tunnel takes 15-30 s and starves its remote-control stream; so thumbnails get a long TTL, and no
 * phone is screencapped while scrcpy streams it (the last thumbnail is served instead).
 */
const THUMB_TTL_MS = 60_000;
const THUMB_WIDTH = 270;
const thumbs = new Map<string, { at: number; jpeg: Promise<Buffer> }>();
function thumbnail(inst: Instance): Promise<Buffer> | null {
  const { id: instanceId, adbPort } = inst;
  const hit = thumbs.get(instanceId);
  const ttl = THUMB_TTL_MS;
  if (hit && (Date.now() - hit.at < ttl || scrcpyActive(adbPort))) return hit.jpeg;
  if (scrcpyActive(adbPort)) return null;
  const jpeg = adb.screenshot(adbPort).then((png) => sharp(png).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer());
  thumbs.set(instanceId, { at: Date.now(), jpeg });
  jpeg.catch(() => { if (thumbs.get(instanceId)?.jpeg === jpeg) thumbs.delete(instanceId); });
  return jpeg;
}
export const instanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

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

  /**
   * Automation state of the visible devices for the 云机管理 cards (owner decision 2026-11-18, moved from the 风控
   * page): `halted` (风控暂停: code, time, source, platform) and `busy` (an automatic operation holds the device lock:
   * collect / check / feed / reply / publish, since). Only devices with one of them are listed. One settings read +
   * one Redis MGET (read only), polled by the page.
   */
  app.get('/api/instances/automation', async (req) => {
    const allowed = await accessibleInstanceIds(req.user);
    const ids = allowed === 'all' ? (await db.select({ id: schema.instances.id }).from(schema.instances)).map((r) => r.id) : [...allowed];
    const [halts, busy] = await Promise.all([deviceHalts(), deviceBusy(ids).catch(() => new Map())]);
    const devices: Record<string, { halted: { at: string; code: string; source: string; platform: string } | null; busy: { what: string; since: string | null } | null }> = {};
    for (const id of ids) {
      const h = halts[id];
      const b = busy.get(id);
      if (h || b) devices[id] = { halted: h ? { at: h.at, code: h.code, source: h.source, platform: h.platform } : null, busy: b ?? null };
    }
    return { devices };
  });

  app.get('/api/instances/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    return { instance: await publicInstance(inst) };
  });

  /**
   * Power of the phones (BitBrowser etc.; power-on is billed) is admin only (owner decision 2026-11-18): start / stop /
   * restart (= off + on) by a user → 403 for a single device, skipped with the code in a batch.
   */
  const POWER_ACTIONS = new Set(['start', 'stop', 'restart']);
  const externalPowerRefused = (user: AuthUser, action: string) => !isAdmin(user) && POWER_ACTIONS.has(action);

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
    await assertInstancesAccess(req.user, ids, 'operate');
    const rows = await db.select().from(schema.instances).where(inArray(schema.instances.id, ids));
    if (rows.length === 1 && externalPowerRefused(req.user, req.body.action)) {
      throw forbidden('比特云手机的开机 / 关机只有管理员可以操作', 'instances.external_power_admin_only');
    }
    const accepted: { instanceId: string; taskId: string }[] = [];
    const skipped: { instanceId: string; reason: string; code?: string }[] = [];
    for (const r of rows) {
      if (externalPowerRefused(req.user, req.body.action)) { skipped.push({ instanceId: r.id, reason: 'external power is admin only', code: 'instances.external_power_admin_only' }); continue; }
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

  /**
   * Full-resolution PNG screenshot, or with `?thumb=1` a small JPEG for the device grid. Thumbnails are
   * shared for THUMB_TTL_MS and concurrent requests share one screencap, so many viewers cost one adb call.
   */
  app.get('/api/instances/:id/screenshot', {
    schema: { params: z.object({ id: z.string().uuid() }), querystring: z.object({ thumb: z.coerce.number().int().min(0).max(1).default(0) }) },
  }, async (req, reply) => {
    await assertInstanceAccess(req.user, req.params.id, 'control');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    if (req.query.thumb) {
      const pending = thumbnail(inst);
      if (!pending) return reply.code(204).send();
      const jpeg = await pending;
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, no-store').send(jpeg);
    }
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

  /**
   * Social platforms allowed on the device (admin only). `null` = all platforms. Turning a platform off
   * keeps accounts already linked; new links are refused and their publish runs fail (platform_disabled).
   */
  app.put('/api/instances/:id/platforms', {
    schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ platforms: z.array(z.enum(PLATFORM_IDS)).max(PLATFORM_IDS.length).nullable() }) },
  }, async (req) => {
    if (!isAdmin(req.user)) throw forbidden('仅管理员可以设置设备允许的平台', 'instances.platforms_admin_only');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    const { platforms } = req.body;
    if (req.audit) req.audit.extra = { from: inst.allowedPlatforms };
    const allowedPlatforms = platforms === null ? null : PLATFORM_IDS.filter((p) => platforms.includes(p));
    const row = await updateInstance(inst.id, { allowedPlatforms });
    return { instance: await publicInstance(row!) };
  });

  /** Egress check on the phone itself over adb (see egress.ts). */
  app.post('/api/instances/:id/proxy/check', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await assertInstanceAccess(req.user, req.params.id, 'view');
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('instance not found', 'instances.not_found');
    if (inst.status !== 'running') throw conflict('instance is not running', 'instances.not_running');
    return { proxyStatus: await checkEgress(inst) };
  });
};
