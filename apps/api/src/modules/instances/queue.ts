import type { Task } from '../../db/schema.js';
import { conflict, forbidden } from '../../lib/errors.js';
import { isAdmin } from '../auth/rbac.js';
import { createTask, registerTaskHandler } from '../tasks/core.js';
import { getInstance, updateInstance } from './repo.js';
import { opApplySettings, opCreate, opDelete, opImportApp, opInstallApk, opPushAsset, opRestart, opSetProxy, opStart, opStop, opUninstallApp } from './ops.js';

export type DeviceOpName = 'create' | 'start' | 'stop' | 'restart' | 'delete' | 'install-apk' | 'uninstall-app' | 'apply-settings' | 'set-proxy' | 'import-app' | 'push-asset';
/** Ops that need no device (instanceId absent): background jobs of other modules (each registers its handler). */
export type TaskOpName = 'media-process' | 'tracked-refresh';
export type OpName = DeviceOpName | TaskOpName;
/** Task payload of the device ops (stored in tasks.payload; ids and paths only, no secrets). */
export interface OpJob {
  /** create: app library ids to install afterwards (omitted = the preinstall-flagged apps) */
  appIds?: string[];
  /** install-apk: one app = base + splits */
  apkPaths?: string[]; sizes?: number[];
  /** uninstall-app, import-app */
  package?: string;
  /** push-asset, media-process: media_assets.id */
  assetId?: string;
  /** tracked-refresh: tracked_accounts.id */
  trackedAccountId?: string;
}
/** Optional task metadata: what the task works on (e.g. refType 'media' + asset id). */
export interface TaskRef { refType?: string; refId?: string }
/** Ops that act on the device only; their failure must not mark the instance as broken. */
const DEVICE_OPS: DeviceOpName[] = ['install-apk', 'uninstall-app', 'apply-settings', 'import-app', 'push-asset'];
/** Queued lifecycle ops whose route already changed state: cancelling them would leave it inconsistent. */
const NOT_CANCELLABLE: DeviceOpName[] = ['create', 'delete', 'set-proxy'];
const BUSY = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];

/** Records a device-op task and enqueues it (thin wrapper over the task centre). Returns the task id. */
export async function enqueue(op: DeviceOpName, instance: { id: string; name: string }, userId: string | null, extra: OpJob = {}, detail?: string, ref: TaskRef = {}): Promise<string> {
  const { task } = await createTask({
    type: op, userId, instance, label: detail ? `${instance.name} · ${detail}` : instance.name,
    payload: extra as Record<string, unknown>, refType: ref.refType, refId: ref.refId,
  });
  return task.id;
}

/** Records a task for a job that needs no device (instance_id NULL; `label` is shown as its name). */
export async function enqueueTask(op: TaskOpName, extra: OpJob & Record<string, unknown>, userId: string | null, opts: TaskRef & { label: string }): Promise<string> {
  const { task } = await createTask({ type: op, userId, label: opts.label, refType: opts.refType, refId: opts.refId, payload: extra });
  return task.id;
}

const RUN: Record<DeviceOpName, (id: string, p: OpJob) => Promise<void>> = {
  create: (id, p) => opCreate(id, p.appIds),
  start: (id) => opStart(id),
  stop: (id) => opStop(id),
  restart: (id) => opRestart(id),
  delete: (id) => opDelete(id),
  'install-apk': (id, p) => opInstallApk(id, p.apkPaths!, p.sizes!),
  'uninstall-app': (id, p) => opUninstallApp(id, p.package!),
  'apply-settings': (id) => opApplySettings(id),
  'set-proxy': (id) => opSetProxy(id),
  'import-app': (id, p) => opImportApp(id, p.package!),
  'push-asset': (id, p) => opPushAsset(id, p.assetId!),
};

/**
 * Device ops share the 'instance-ops' queue. Concurrency is bounded because booting Android is
 * CPU/memory heavy on the host; raise it per host capacity when scaling out. They are not
 * interruptible: a cancel while running is recorded, the op finishes.
 */
for (const op of Object.keys(RUN) as DeviceOpName[]) {
  registerTaskHandler<OpJob>(op, {
    queue: 'instance-ops',
    concurrency: 2,
    cancellable: !NOT_CANCELLABLE.includes(op),
    // Retrying a failed create would rebuild containers over a half-created device: delete and create again instead.
    retryable: op !== 'create',
    async run(ctx) {
      if (!ctx.task.instanceId) throw new Error(`${op}: missing instanceId`);
      await RUN[op](ctx.task.instanceId, ctx.payload);
    },
    async beforeRetry(task: Task, user) {
      if (op === 'delete' && !isAdmin(user)) throw forbidden('仅管理员可以删除设备', 'instances.delete_admin_only');
      const inst = task.instanceId ? await getInstance(task.instanceId) : undefined;
      if (!inst) throw conflict('任务的目标已不存在', 'tasks.target_gone');
      if (BUSY.includes(inst.status)) throw conflict(`instance is busy (${inst.status})`, 'instances.busy', { status: inst.status });
    },
    async onFailure(task) {
      if (task.status !== 'failed' || !task.instanceId || DEVICE_OPS.includes(op)) return;
      await updateInstance(task.instanceId, { status: 'error', lastError: `${op}: ${task.error ?? ''}` });
    },
  });
}
