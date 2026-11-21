import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Instance, RequiredApp } from '../../db/schema.js';
import { conflict, isUniqueViolation, notFound } from '../../lib/errors.js';
import { withMutex } from '../../lib/locks.js';
import { adb } from '../../services.js';
import { getInstance } from '../instances/repo.js';
import { appStoreTypes, driverFor, sourceOf } from '../sources/index.js';
import type { SourceType } from '../sources/types.js';
import { createTask, registerTaskHandler, TaskError } from '../tasks/core.js';
import { mapLimit } from './install.js';

/**
 * 必装应用 (owner 2026-11-20, 「开机时侦测缺的就装」): apps every phone must have (e.g. Instagram, YouTube), one list
 * per device source type (「保持可扩性」: only BitBrowser today; another vendor = a driver with an `appStore` and its
 * own rows). Each time a phone is attached (added while on, powered on, restarted, or found running by the monitor)
 * a `required-apps` task checks its source type's packages with adb `pm path` and asks the source to install a
 * missing one from its own app store by `store_app_id` (BitBrowser `/phone/installApp`). BitBrowser
 * installs asynchronously, so the task then polls adb until the apps show up (≤ INSTALL_WAIT_MS); one still
 * missing fails the task with `library.required_not_installed` (the next attach checks again).
 */
export const REQUIRED_TYPE = 'required-apps';
const POLL_MS = 10_000;
const INSTALL_WAIT_MS = 6 * 60_000;
const TASK_TIMEOUT_MS = 10 * 60_000;

const Pkg = z.string().trim().regex(/^[a-zA-Z0-9_.]{3,150}$/, 'invalid package name');
const Body = z.object({
  /** Device source type whose phones need the app (a type with an app store). */
  sourceType: z.string(),
  package: Pkg,
  name: z.string().trim().min(1).max(80),
  /** The app's id in that source's app store (format per driver: `appStore.idPattern`). */
  storeAppId: z.string().trim().min(1).max(100),
}).strict().superRefine((b, ctx) => {
  if (!appStoreTypes().includes(b.sourceType as SourceType)) ctx.addIssue({ code: 'custom', path: ['sourceType'], message: 'source type without an app store' });
  else if (!driverFor(b.sourceType as SourceType).appStore!.idPattern.test(b.storeAppId)) ctx.addIssue({ code: 'custom', path: ['storeAppId'], message: 'invalid app id' });
});
const RA = schema.requiredApps;

/** Required apps of one source type (or all), by name. */
export const listRequiredApps = (sourceType?: SourceType) =>
  db.select().from(RA).where(sourceType ? eq(RA.sourceType, sourceType) : undefined).orderBy(asc(RA.sourceType), asc(RA.name));

export const REQUIRED_APP_REF = 'required_app';
const OPEN = ['pending', 'scheduled', 'running'] as const;
/** An unfinished task of the phone that covers `appId`: a full check (no ref) or that app's install. */
const unfinished = async (instanceId: string, appId?: string) => {
  const T = schema.tasks;
  const [t] = await db.select({ id: T.id }).from(T).where(and(
    eq(T.type, REQUIRED_TYPE), eq(T.instanceId, instanceId), inArray(T.status, [...OPEN]),
    appId ? or(isNull(T.refId), eq(T.refId, appId)) : isNull(T.refId),
  )).limit(1);
  return t ?? null;
};

/**
 * Queues the check for one phone (every required app of its source type, or only `app`: 应用市场 → 安装); no-op
 * without required apps, and returns an unfinished task that already covers it instead of a second one. Never throws
 * (it runs after a phone was attached, which must not fail because of it).
 */
export async function queueRequiredAppsCheck(inst: Pick<Instance, 'id' | 'name' | 'engine'>, userId: string | null, app?: RequiredApp): Promise<string | null> {
  try {
    if (!app && !(await listRequiredApps(inst.engine)).length) return null;
    return await withMutex(`task:${REQUIRED_TYPE}:${inst.id}`, async () => {
      const open = await unfinished(inst.id, app?.id);
      if (open) return open.id;
      const { task } = await createTask({
        type: REQUIRED_TYPE, userId, instance: inst, label: `${inst.name} · ${app ? `安装 ${app.name}` : '必装应用'}`,
        ...(app ? { refType: REQUIRED_APP_REF, refId: app.id, payload: { appIds: [app.id] } } : {}),
      });
      return task.id;
    });
  } catch {
    return null;
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

registerTaskHandler(REQUIRED_TYPE, {
  queue: 'required-apps', concurrency: 2, timeoutMs: TASK_TIMEOUT_MS, maxAttempts: 1,
  async run(ctx) {
    const inst = ctx.task.instanceId ? await getInstance(ctx.task.instanceId) : undefined;
    if (!inst) throw new TaskError('tasks.target_gone', 'device no longer exists');
    if (inst.status !== 'running' || inst.adbState !== 'device') throw new TaskError('instances.not_running', 'device is not running');
    const only = (ctx.payload as { appIds?: string[] } | null)?.appIds;
    const apps = (await listRequiredApps(inst.engine)).filter((a) => !only || only.includes(a.id));
    if (only && !apps.length) throw new TaskError('library.required_not_found', 'required app no longer exists');
    const missing: RequiredApp[] = [];
    for (const a of apps) if (!(await adb.isInstalled(inst.adbPort, a.package))) missing.push(a);
    await ctx.log('info', `required apps: ${apps.length - missing.length}/${apps.length} installed`, { missing: missing.map((a) => a.package) });
    if (!missing.length) return { checked: apps.length, missing: [], requested: [] };

    const { driver, cfg } = await sourceOf(inst);
    if (!driver.appStore) throw new TaskError('library.required_unsupported', `source ${driver.type} has no app store`);
    const requested: string[] = [];
    for (const a of missing) {
      try {
        await driver.appStore.install(cfg, inst.externalId, a.storeAppId);
        requested.push(a.package);
        await ctx.log('info', `install requested: ${a.package}`, { package: a.package, appId: a.storeAppId });
      } catch (err) {
        await ctx.log('warn', `install request failed: ${a.package}`, { package: a.package, error: (err as Error).message.slice(0, 300) });
      }
    }

    // The source installs in the background: wait until adb sees every requested app.
    let pending = missing.filter((a) => requested.includes(a.package));
    const deadline = Date.now() + INSTALL_WAIT_MS;
    while (pending.length && Date.now() < deadline && !ctx.signal.aborted) {
      await sleep(POLL_MS, ctx.signal);
      const still: RequiredApp[] = [];
      for (const a of pending) {
        if (await adb.isInstalled(inst.adbPort, a.package).catch(() => false)) await ctx.log('info', `installed: ${a.package}`, { package: a.package });
        else still.push(a);
      }
      pending = still;
    }
    const notInstalled = missing.filter((a) => !requested.includes(a.package) || pending.includes(a)).map((a) => a.package);
    if (notInstalled.length) {
      throw new TaskError('library.required_not_installed', `not installed: ${notInstalled.join(', ')}`);
    }
    return { checked: apps.length, missing: missing.map((a) => a.package), requested };
  },
});

const BUSY = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CONCURRENCY = 6;
/**
 * missing – running, the app is absent (selectable); installed – present (hidden in the picker); installing – an
 * unfinished task covers it; offline – not running / adb not attached / the read failed; busy – lifecycle op running.
 */
export type RequiredTargetState = 'missing' | 'installed' | 'installing' | 'offline' | 'busy';
export interface RequiredTarget { id: string; name: string; status: string; users: string[]; state: RequiredTargetState; reason?: string }

/** 安装 picker of one app: every phone of its source type, the app read live (`pm path`, read only). */
export async function requiredTargets(app: RequiredApp): Promise<{ devices: RequiredTarget[] }> {
  const I = schema.instances;
  const T = schema.tasks;
  const [rows, grants, pending] = await Promise.all([
    db.select({ id: I.id, name: I.name, status: I.status, adbPort: I.adbPort, adbState: I.adbState }).from(I).where(eq(I.engine, app.sourceType)).orderBy(I.name),
    db.select({ instanceId: schema.instanceGrants.instanceId, name: schema.users.username, nick: schema.users.displayName })
      .from(schema.instanceGrants).innerJoin(schema.users, eq(schema.users.id, schema.instanceGrants.userId)),
    db.select({ instanceId: T.instanceId }).from(T)
      .where(and(eq(T.type, REQUIRED_TYPE), inArray(T.status, [...OPEN]), or(isNull(T.refId), eq(T.refId, app.id)))),
  ]);
  const usersOf = new Map<string, string[]>();
  for (const g of grants) usersOf.set(g.instanceId, [...(usersOf.get(g.instanceId) ?? []), g.nick || g.name]);
  const running = new Set(pending.map((p) => p.instanceId));
  const devices = await mapLimit(rows, PROBE_CONCURRENCY, async (r): Promise<RequiredTarget> => {
    const base = { id: r.id, name: r.name, status: r.status, users: usersOf.get(r.id) ?? [] };
    if (BUSY.includes(r.status)) return { ...base, state: 'busy', reason: r.status };
    if (r.status !== 'running') return { ...base, state: 'offline', reason: r.status };
    if (r.adbState !== 'device') return { ...base, state: 'offline', reason: 'adb' };
    let has: boolean;
    try { has = await adb.isInstalled(r.adbPort, app.package, PROBE_TIMEOUT_MS); }
    catch { return { ...base, state: 'offline', reason: 'probe' }; }
    if (has) return { ...base, state: 'installed' };
    return { ...base, state: running.has(r.id) ? 'installing' : 'missing' };
  });
  return { devices };
}

/** Admin routes (registered inside libraryRoutes, so they share its requireAdmin hook). */
export function requiredAppRoutes(r: Parameters<FastifyPluginAsyncZod>[0]) {
  const taken = (err: unknown) => {
    if (isUniqueViolation(err, 'required_apps_source_package_unique')) throw conflict('该包名已在此来源的必装应用中', 'library.required_taken');
    throw err;
  };

  /** `sourceTypes` = the device source types with an app store (one tab each in the UI). */
  r.get('/api/library/required', async () => ({ apps: await listRequiredApps(), sourceTypes: appStoreTypes() }));

  const appOf = async (id: string) => {
    const [a] = await db.select().from(RA).where(eq(RA.id, id));
    if (!a) throw notFound('required app not found', 'library.required_not_found');
    return a;
  };
  const Id = z.object({ id: z.string().uuid() });

  /**
   * 云机管理 → 安装应用 of one phone: the app store list of its source type, each read live (`pm path`; null = not
   * running / adb not attached / read failed) and whether an unfinished task covers it.
   */
  r.get('/api/library/required/device/:id', { schema: { params: Id } }, async (req) => {
    const inst = await getInstance(req.params.id);
    if (!inst) throw notFound('device not found', 'instances.not_found');
    const T = schema.tasks;
    const [apps, open] = await Promise.all([
      listRequiredApps(inst.engine),
      db.select({ refId: T.refId }).from(T).where(and(eq(T.type, REQUIRED_TYPE), eq(T.instanceId, inst.id), inArray(T.status, [...OPEN]))),
    ]);
    const online = inst.status === 'running' && inst.adbState === 'device';
    const full = open.some((o) => o.refId == null);
    const items = await mapLimit(apps, PROBE_CONCURRENCY, async (a) => ({
      id: a.id,
      installed: online ? await adb.isInstalled(inst.adbPort, a.package, PROBE_TIMEOUT_MS).catch(() => null) : null,
      installing: full || open.some((o) => o.refId === a.id),
    }));
    return { online, apps: items };
  });

  /** 安装 picker of one app. */
  r.get('/api/library/required/:id/targets', { schema: { params: Id } }, async (req) => requiredTargets(await appOf(req.params.id)));

  /** 安装 one app on the picked phones of its source type: one task per phone (an unfinished one covering it is returned). */
  r.post('/api/library/required/:id/install', {
    schema: { params: Id, body: z.object({ instanceIds: z.array(z.string().uuid()).min(1).max(500) }).strict() },
  }, async (req, reply) => {
    const app = await appOf(req.params.id);
    const I = schema.instances;
    const ids = [...new Set(req.body.instanceIds)];
    const rows = await db.select({ id: I.id, name: I.name, status: I.status, engine: I.engine }).from(I).where(inArray(I.id, ids));
    const taskIds: string[] = [];
    const skipped: { id: string; code: string }[] = [];
    for (const id of ids) {
      const inst = rows.find((x) => x.id === id);
      if (!inst) { skipped.push({ id, code: 'instances.not_found' }); continue; }
      if (inst.engine !== app.sourceType) { skipped.push({ id, code: 'library.required_wrong_source' }); continue; }
      if (inst.status !== 'running') { skipped.push({ id, code: 'instances.not_running' }); continue; }
      const t = await queueRequiredAppsCheck(inst, req.user.id, app);
      if (t) taskIds.push(t); else skipped.push({ id, code: 'common.busy' });
    }
    if (req.audit) { req.audit.target = app.package; req.audit.extra = { devices: taskIds.length }; }
    reply.code(202);
    return { taskIds, skipped };
  });

  r.post('/api/library/required', { schema: { body: Body } }, async (req, reply) => {
    const [row] = await db.insert(RA).values(req.body as typeof RA.$inferInsert).returning().catch(taken);
    if (req.audit) req.audit.target = row!.package;
    reply.code(201);
    return { app: row };
  });

  r.put('/api/library/required/:id', { schema: { params: Id, body: Body } }, async (req) => {
    const [row] = await db.update(RA).set(req.body as typeof RA.$inferInsert).where(eq(RA.id, req.params.id)).returning().catch(taken);
    if (!row) throw notFound('required app not found', 'library.required_not_found');
    if (req.audit) req.audit.target = row.package;
    return { app: row };
  });

  r.delete('/api/library/required/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const [row] = await db.delete(RA).where(eq(RA.id, req.params.id)).returning();
    if (!row) throw notFound('required app not found', 'library.required_not_found');
    if (req.audit) req.audit.target = row.package;
    reply.code(204);
  });

  /** Full check (+ install of what is missing) on the given phones (no list = every running phone); API only. */
  r.post('/api/library/required/check', {
    schema: { body: z.object({ instanceIds: z.array(z.string().uuid()).min(1).max(500).optional() }).strict() },
  }, async (req, reply) => {
    const I = schema.instances;
    const rows = await db.select({ id: I.id, name: I.name, status: I.status, engine: I.engine }).from(I)
      .where(req.body.instanceIds ? inArray(I.id, req.body.instanceIds) : eq(I.status, 'running'));
    const running = rows.filter((x) => x.status === 'running');
    const taskIds: string[] = [];
    for (const inst of running) {
      const id = await queueRequiredAppsCheck(inst, req.user.id);
      if (id) taskIds.push(id);
    }
    if (req.audit) req.audit.extra = { devices: running.length };
    reply.code(202);
    return { taskIds, skipped: rows.length - running.length };
  });
}
