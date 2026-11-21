import type { Task } from '../../db/schema.js';
import { conflict, forbidden } from '../../lib/errors.js';
import { isAdmin } from '../auth/rbac.js';
import { createTask, registerTaskHandler } from '../tasks/core.js';
import { deviceStatusChanged } from '../notify/triggers.js';
import { getInstance, updateInstance } from './repo.js';
import { opCreate, opDelete, opImportApp, opInstallApk, opPushAsset, opRestart, opStart, opStop } from './ops.js';

export type DeviceOpName = 'create' | 'start' | 'stop' | 'restart' | 'delete' | 'install-apk' | 'import-app' | 'push-asset';
/** Ops that need no device (instanceId absent): background jobs of other modules (each registers its handler). */
export type TaskOpName = 'media-process' | 'tracked-refresh';
/** Task payload of the device ops (stored in tasks.payload; ids and paths only, no secrets). */
export interface OpJob {
  /** install-apk: one app = base + splits */
  apkPaths?: string[]; sizes?: number[];
  /** install-apk from the app library: which app version, for the library's install log */
  library?: { package: string; versionCode: string; versionName: string | null };
  /** import-app */
  package?: string;
  /** push-asset, media-process: media_assets.id */
  assetId?: string;
  /** tracked-refresh: tracked_accounts.id */
  trackedAccountId?: string;
}
/** Optional task metadata: what the task works on (e.g. refType 'media' + asset id). */
export interface TaskRef { refType?: string; refId?: string }
/** Ops that act on the device only; their failure must not mark the instance as broken. */
const DEVICE_OPS: DeviceOpName[] = ['install-apk', 'import-app', 'push-asset'];
/** Queued lifecycle ops whose route already changed state: cancelling them would leave it inconsistent. */
const NOT_CANCELLABLE: DeviceOpName[] = ['create', 'delete'];
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
  create: (id) => opCreate(id),
  start: (id) => opStart(id),
  stop: (id) => opStop(id),
  restart: (id) => opRestart(id),
  delete: (id) => opDelete(id),
  'install-apk': (id, p) => opInstallApk(id, p.apkPaths!, p.sizes!),
  'import-app': (id, p) => opImportApp(id, p.package!),
  'push-asset': (id, p) => opPushAsset(id, p.assetId!),
};

/**
 * Device ops share the 'instance-ops' queue (bounded concurrency: a source's API is rate limited, e.g. BitBrowser's
 * client allows 1 request per second). They are not interruptible: a cancel while running is recorded, the op finishes.
 */
for (const op of Object.keys(RUN) as DeviceOpName[]) {
  registerTaskHandler<OpJob>(op, {
    queue: 'instance-ops',
    concurrency: 2,
    cancellable: !NOT_CANCELLABLE.includes(op),
    // A failed add: delete the device and add it again instead.
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
      const row = await updateInstance(task.instanceId, { status: 'error', lastError: `${op}: ${task.error ?? ''}` });
      if (row) await deviceStatusChanged(row, 'error', 'op_failed', op);
    },
  });
}
