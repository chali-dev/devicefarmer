import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { DeviceSource } from '../../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../../lib/errors.js';
import { isUniqueViolation } from '../proxies/pool.js';
import { enqueue } from '../instances/queue.js';
import { publicInstances } from '../instances/repo.js';
import { driverFor, getSource, mergeSecrets, openConfig, publicConfig, sealConfig, SOURCE_TYPES } from './index.js';

/**
 * Device sources (设备来源) and adding their phones as devices. Admin only. Secret config fields
 * (BitBrowser: the client's Local API Token) are sealed and write-only (see sources/index.ts).
 */
const Id = z.object({ id: z.string().uuid() });
const Name = z.string().trim().min(1).max(60);
const PhoneId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

async function deviceCounts(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: schema.instances.sourceId, n: count() }).from(schema.instances)
    .where(inArray(schema.instances.sourceId, ids)).groupBy(schema.instances.sourceId);
  return new Map(rows.map((r) => [r.id!, r.n]));
}
function publicSource(s: DeviceSource, devices: number) {
  const driver = driverFor(s.type);
  let health = null;
  try { health = driver.health?.(driver.config.parse(openConfig(driver, s.config))) ?? null; } catch { /* config unreadable: no health */ }
  return { id: s.id, type: s.type, name: s.name, config: publicConfig(driver, s.config), health, devices, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

/**
 * Parses the config for the type (secret fields merged with `stored` on edits) and checks the source
 * answers; 400 with the reason otherwise. Returns the form to store (secrets sealed).
 */
async function validConfig(type: DeviceSource['type'], raw: Record<string, unknown>, stored?: unknown) {
  const driver = driverFor(type);
  const parsed = driver.config.safeParse(mergeSecrets(driver, raw, stored));
  if (!parsed.success) throw badRequest(`配置不正确：${parsed.error.issues[0]?.message ?? ''}`, 'sources.invalid_config', { error: parsed.error.issues[0]?.message ?? '' });
  try {
    await driver.test(parsed.data);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 200);
    throw badRequest(`连接测试失败，未保存：${msg}`, 'sources.test_failed', { error: msg });
  }
  return sealConfig(driver, parsed.data as Record<string, unknown>);
}

/** Free local port for an external phone's adb connection (separate range from local containers). */
async function allocatePort(taken: Set<number>): Promise<number> {
  for (const r of await db.select({ port: schema.instances.adbPort }).from(schema.instances)) taken.add(r.port);
  for (let p = config.EXTERNAL_ADB_PORT_MIN; p <= config.EXTERNAL_ADB_PORT_MAX; p++) if (!taken.has(p)) { taken.add(p); return p; }
  throw conflict('no free local ports left for external phones', 'instances.no_free_ports');
}

/** Device name from the phone's name: `<type prefix>-<slug>`, unique with a numeric suffix. */
function deviceName(prefix: string, phoneName: string, used: Set<string>): string {
  const slug = phoneName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'phone';
  let name = `${prefix}-${slug}`;
  for (let n = 2; used.has(name); n++) name = `${prefix}-${slug}-${n}`;
  used.add(name);
  return name;
}
const NAME_PREFIX: Record<DeviceSource['type'], string> = { bitbrowser: 'bit' };

export const sourceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/api/device-sources', async () => {
    const rows = await db.select().from(schema.deviceSources).orderBy(schema.deviceSources.name);
    const n = await deviceCounts(rows.map((r) => r.id));
    return { sources: rows.map((r) => publicSource(r, n.get(r.id) ?? 0)), types: SOURCE_TYPES };
  });

  /** Saved only when the connection test passes. */
  app.post('/api/device-sources', {
    schema: { body: z.object({ type: z.enum(SOURCE_TYPES), name: Name, config: z.record(z.string(), z.unknown()) }) },
  }, async (req, reply) => {
    const cfg = await validConfig(req.body.type, req.body.config);
    const [row] = await db.insert(schema.deviceSources).values({ type: req.body.type, name: req.body.name, config: cfg, createdBy: req.user.id }).returning()
      .catch((err) => { if (isUniqueViolation(err, 'device_sources_name_unique')) throw conflict('来源名称已存在', 'sources.name_taken', { name: req.body.name }); throw err; });
    reply.code(201);
    return { source: publicSource(row!, 0) };
  });

  /** A new config is tested before it is saved; running devices pick it up on their next connection. */
  app.patch('/api/device-sources/:id', {
    schema: { params: Id, body: z.object({ name: Name.optional(), config: z.record(z.string(), z.unknown()).optional() }) },
  }, async (req) => {
    const src = await getSource(req.params.id);
    if (!src) throw notFound('来源不存在', 'sources.not_found');
    const set: Partial<DeviceSource> = {};
    if (req.body.name !== undefined) set.name = req.body.name;
    if (req.body.config !== undefined) set.config = await validConfig(src.type, req.body.config, src.config);
    if (req.audit) req.audit.extra = { from: { name: src.name, config: publicConfig(driverFor(src.type), src.config) } };
    const [row] = Object.keys(set).length
      ? await db.update(schema.deviceSources).set(set).where(eq(schema.deviceSources.id, src.id)).returning()
        .catch((err) => { if (isUniqueViolation(err, 'device_sources_name_unique')) throw conflict('来源名称已存在', 'sources.name_taken', { name: req.body.name ?? '' }); throw err; })
      : [src];
    return { source: publicSource(row!, (await deviceCounts([src.id])).get(src.id) ?? 0) };
  });

  app.delete('/api/device-sources/:id', { schema: { params: Id } }, async (req, reply) => {
    const src = await getSource(req.params.id);
    if (!src) throw notFound('来源不存在', 'sources.not_found');
    const n = (await deviceCounts([src.id])).get(src.id) ?? 0;
    if (n) throw conflict(`该来源还有 ${n} 台设备，请先删除这些设备`, 'sources.in_use', { count: n });
    await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, src.id));
    reply.code(204);
  });

  /** The source's phones, each with the device it was added as (if any). */
  app.get('/api/device-sources/:id/phones', { schema: { params: Id } }, async (req) => {
    const src = await getSource(req.params.id);
    if (!src) throw notFound('来源不存在', 'sources.not_found');
    const driver = driverFor(src.type);
    const [phones, rows] = await Promise.all([
      driver.listPhones(driver.config.parse(src.config)),
      db.select({ id: schema.instances.id, name: schema.instances.name, externalId: schema.instances.externalId })
        .from(schema.instances).where(eq(schema.instances.sourceId, src.id)),
    ]);
    const byExt = new Map(rows.map((r) => [r.externalId, { id: r.id, name: r.name }]));
    return { phones: phones.map((p) => ({ ...p, instance: byExt.get(p.id) ?? null })) };
  });

  /**
   * Adds phones of a source as devices. Nothing is powered on: phones that are already on are
   * attached, the others stay stopped until someone starts them (power-on may be billed).
   */
  app.post('/api/instances/external', {
    schema: { body: z.object({ sourceId: z.string().uuid(), phoneIds: z.array(PhoneId).min(1).max(20) }) },
  }, async (req, reply) => {
    const src = await getSource(req.body.sourceId);
    if (!src) throw notFound('来源不存在', 'sources.not_found');
    const driver = driverFor(src.type);
    const phones = new Map((await driver.listPhones(driver.config.parse(src.config))).map((p) => [p.id, p]));
    const wanted = [...new Set(req.body.phoneIds)];
    const missing = wanted.filter((id) => !phones.has(id));
    if (missing.length) throw notFound('来源中没有这台手机', 'sources.phone_not_found', { ids: missing.join(', ') });
    const existing = await db.select({ externalId: schema.instances.externalId }).from(schema.instances)
      .where(and(eq(schema.instances.sourceId, src.id), inArray(schema.instances.externalId, wanted)));
    if (existing.length) throw conflict('部分手机已添加为设备', 'sources.already_added', { ids: existing.map((e) => e.externalId).join(', ') });
    const used = new Set((await db.select({ name: schema.instances.name }).from(schema.instances)).map((r) => r.name));
    const ports = new Set<number>();
    const values = [];
    for (const id of wanted) {
      values.push({
        name: deviceName(NAME_PREFIX[src.type], phones.get(id)!.name, used), adbPort: await allocatePort(ports),
        engine: src.type, profile: src.type, image: src.type, sourceId: src.id, externalId: id,
        status: 'creating' as const, createdBy: req.user.id, spec: { width: 1080, height: 1920, dpi: 420 },
      });
    }
    const rows = await db.insert(schema.instances).values(values).returning().catch((err) => {
      if (isUniqueViolation(err, 'instances_source_external_unique')) throw conflict('部分手机已添加为设备', 'sources.already_added', { ids: '' });
      if (isUniqueViolation(err, '')) throw new HttpError(409, '设备名称或端口冲突，请重试', 'instances.add_conflict');
      throw err;
    });
    if (req.audit) req.audit.extra = { source: src.name, phones: wanted.map((id) => phones.get(id)!.name) };
    const taskIds = [];
    for (const r of rows) taskIds.push(await enqueue('create', r, req.user.id, {}, `${src.name} ${phones.get(r.externalId!)!.name}`));
    reply.code(202);
    return { instances: await publicInstances(rows), taskIds };
  });
};
