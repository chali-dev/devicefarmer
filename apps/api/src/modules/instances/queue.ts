import { Queue, Worker, type Job } from 'bullmq';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { updateInstance, updateTask } from './repo.js';
import { processMedia } from '../media/media.js';
import { refreshTrackedAccount } from '../tracked/tracked.js';
import { opApplySettings, opCreate, opDelete, opImportApp, opInstallApk, opPushAsset, opRestart, opSetProxy, opStart, opStop, opUninstallApp } from './ops.js';

export type DeviceOpName = 'create' | 'start' | 'stop' | 'restart' | 'delete' | 'install-apk' | 'uninstall-app' | 'apply-settings' | 'set-proxy' | 'import-app' | 'push-asset';
/** Ops that need no device (instanceId absent): background jobs of other modules. */
export type TaskOpName = 'media-process' | 'tracked-refresh';
export type OpName = DeviceOpName | TaskOpName;
export interface OpJob {
  taskId: string; op: OpName;
  /** Set for device ops; absent for TaskOpName jobs. */
  instanceId?: string;
  /** install-apk: one app = base + splits */
  apkPaths?: string[]; sizes?: number[];
  /** uninstall-app */
  package?: string;
  /** push-asset, media-process: media_assets.id */
  assetId?: string;
  /** tracked-refresh: tracked_accounts.id */
  trackedAccountId?: string;
}
/** Optional task metadata: what the task works on (e.g. refType 'media' + asset id). */
export interface TaskRef { refType?: string; refId?: string }
/** Ops that act on the device only; their failure must not mark the instance as broken. */
const DEVICE_OPS: OpName[] = ['install-apk', 'uninstall-app', 'apply-settings', 'import-app', 'push-asset'];

const QUEUE = 'instance-ops';
/** Device-less jobs (media processing) get their own queue + worker so they never wait behind device boots. */
const TASK_QUEUE = 'task-ops';
const connection = { url: config.REDIS_URL };

export const opsQueue = new Queue<OpJob>(QUEUE, { connection });
export const tasksQueue = new Queue<OpJob>(TASK_QUEUE, { connection });

/** Records a task row for a device op and enqueues it. Returns the task id. */
export async function enqueue(op: DeviceOpName, instance: { id: string; name: string }, userId: string | null, extra: Partial<OpJob> = {}, detail?: string, ref: TaskRef = {}): Promise<string> {
  const [task] = await db.insert(schema.tasks)
    .values({ type: op, instanceId: instance.id, instanceName: detail ? `${instance.name} · ${detail}` : instance.name, createdBy: userId, ...ref })
    .returning();
  await opsQueue.add(op, { taskId: task!.id, op, ...extra, instanceId: instance.id }, {
    removeOnComplete: 1000, removeOnFail: 1000, attempts: 1,
  });
  return task!.id;
}

/** Records a task row for a job that needs no device (instance_id NULL; `label` is shown as its name). */
export async function enqueueTask(op: TaskOpName, extra: Partial<OpJob>, userId: string | null, opts: TaskRef & { label: string }): Promise<string> {
  const [task] = await db.insert(schema.tasks)
    .values({ type: op, instanceId: null, instanceName: opts.label, createdBy: userId, refType: opts.refType, refId: opts.refId })
    .returning();
  await tasksQueue.add(op, { taskId: task!.id, op, ...extra, instanceId: undefined }, {
    removeOnComplete: 1000, removeOnFail: 1000, attempts: 1,
  });
  return task!.id;
}

async function run(job: Job<OpJob>): Promise<void> {
  const { op } = job.data;
  if (op === 'media-process') return processMedia(job.data.assetId!);
  if (op === 'tracked-refresh') { await refreshTrackedAccount(job.data.trackedAccountId!); return; }
  const instanceId = job.data.instanceId;
  if (!instanceId) throw new Error(`${op}: missing instanceId`);
  switch (op) {
    case 'create': return opCreate(instanceId);
    case 'start': return opStart(instanceId);
    case 'stop': return opStop(instanceId);
    case 'restart': return opRestart(instanceId);
    case 'delete': return opDelete(instanceId);
    case 'install-apk': return opInstallApk(instanceId, job.data.apkPaths!, job.data.sizes!);
    case 'uninstall-app': return opUninstallApp(instanceId, job.data.package!);
    case 'apply-settings': return opApplySettings(instanceId);
    case 'set-proxy': return opSetProxy(instanceId);
    case 'import-app': return opImportApp(instanceId, job.data.package!);
    case 'push-asset': return opPushAsset(instanceId, job.data.assetId!);
  }
}

/**
 * Lifecycle worker. Concurrency is bounded because booting Android is
 * CPU/memory heavy on the host; raise it per host capacity when scaling out.
 */
function makeWorker(queue: string, concurrency: number): Worker<OpJob> {
  const worker = new Worker<OpJob>(queue, async (job) => {
    await updateTask(job.data.taskId, { status: 'running' });
    await run(job);
  }, { connection, concurrency });

  worker.on('completed', (job) => {
    void updateTask(job.data.taskId, { status: 'succeeded', finishedAt: new Date() });
  });
  worker.on('failed', (job, err) => {
    if (!job) return;
    void updateTask(job.data.taskId, { status: 'failed', error: err.message, finishedAt: new Date() });
    if (job.data.instanceId && !DEVICE_OPS.includes(job.data.op)) {
      void updateInstance(job.data.instanceId, { status: 'error', lastError: `${job.data.op}: ${err.message}` });
    }
  });
  return worker;
}

/** Starts the device-op worker and the device-less task worker; close() stops both and their queues. */
export function startWorkers(deviceConcurrency = 2, taskConcurrency = 2): { close(): Promise<void> } {
  const workers = [makeWorker(QUEUE, deviceConcurrency), makeWorker(TASK_QUEUE, taskConcurrency)];
  return {
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([opsQueue.close(), tasksQueue.close()]);
    },
  };
}
