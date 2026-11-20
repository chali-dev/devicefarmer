import { and, asc, eq, inArray } from 'drizzle-orm';
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

const unfinished = async (instanceId: string) => {
  const [t] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
    eq(schema.tasks.type, REQUIRED_TYPE), eq(schema.tasks.instanceId, instanceId), inArray(schema.tasks.status, ['pending', 'scheduled', 'running']),
  )).limit(1);
  return t ?? null;
};

/**
 * Queues the check for one phone; no-op without required apps, and returns the queued / running one instead of a
 * second task. Never throws (it runs after a phone was attached, which must not fail because of it).
 */
export async function queueRequiredAppsCheck(inst: Pick<Instance, 'id' | 'name' | 'engine'>, userId: string | null): Promise<string | null> {
  try {
    if (!(await listRequiredApps(inst.engine)).length) return null;
    return await withMutex(`task:${REQUIRED_TYPE}:${inst.id}`, async () => {
      const open = await unfinished(inst.id);
      if (open) return open.id;
      const { task } = await createTask({ type: REQUIRED_TYPE, userId, instance: inst, label: `${inst.name} · 必装应用` });
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
    const apps = await listRequiredApps(inst.engine);
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

/** Admin routes (registered inside libraryRoutes, so they share its requireAdmin hook). */
export function requiredAppRoutes(r: Parameters<FastifyPluginAsyncZod>[0]) {
  const taken = (err: unknown) => {
    if (isUniqueViolation(err, 'required_apps_source_package_unique')) throw conflict('该包名已在此来源的必装应用中', 'library.required_taken');
    throw err;
  };

  /** `sourceTypes` = the device source types with an app store (one tab each in the UI). */
  r.get('/api/library/required', async () => ({ apps: await listRequiredApps(), sourceTypes: appStoreTypes() }));

  r.post('/api/library/required', { schema: { body: Body } }, async (req, reply) => {
    const [row] = await db.insert(RA).values(req.body as typeof RA.$inferInsert).returning().catch(taken);
    if (req.audit) req.audit.target = row!.package;
    reply.code(201);
    return { app: row };
  });

  r.put('/api/library/required/:id', { schema: { params: z.object({ id: z.string().uuid() }), body: Body } }, async (req) => {
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

  /** 立即检查: queues the check on every running phone (or the given ones). */
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
