import { Queue, Worker, type Job } from 'bullmq';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { updateInstance, updateTask } from './repo.js';
import { opApplySettings, opCreate, opDelete, opImportApp, opInstallApk, opRestart, opSetProxy, opStart, opStop, opUninstallApp } from './ops.js';

export type OpName = 'create' | 'start' | 'stop' | 'restart' | 'delete' | 'install-apk' | 'uninstall-app' | 'apply-settings' | 'set-proxy' | 'import-app';
export interface OpJob {
  taskId: string; op: OpName; instanceId: string;
  /** install-apk: one app = base + splits */
  apkPaths?: string[]; sizes?: number[];
  /** uninstall-app */
  package?: string;
}
/** Ops that act on the device only; their failure must not mark the instance as broken. */
const DEVICE_OPS: OpName[] = ['install-apk', 'uninstall-app', 'apply-settings', 'import-app'];

const QUEUE = 'instance-ops';
const connection = { url: config.REDIS_URL };

export const opsQueue = new Queue<OpJob>(QUEUE, { connection });

/** Records a task row and enqueues it. Returns the task id. */
export async function enqueue(op: OpName, instance: { id: string; name: string }, userId: string | null, extra: Partial<OpJob> = {}, detail?: string): Promise<string> {
  const [task] = await db.insert(schema.tasks)
    .values({ type: op, instanceId: instance.id, instanceName: detail ? `${instance.name} · ${detail}` : instance.name, createdBy: userId })
    .returning();
  await opsQueue.add(op, { taskId: task!.id, op, instanceId: instance.id, ...extra }, {
    removeOnComplete: 1000, removeOnFail: 1000, attempts: 1,
  });
  return task!.id;
}

async function run(job: Job<OpJob>): Promise<void> {
  const { op, instanceId } = job.data;
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
  }
}

/**
 * Lifecycle worker. Concurrency is bounded because booting Android is
 * CPU/memory heavy on the host; raise it per host capacity when scaling out.
 */
export function startWorker(concurrency = 2): Worker<OpJob> {
  const worker = new Worker<OpJob>(QUEUE, async (job) => {
    await updateTask(job.data.taskId, { status: 'running' });
    await run(job);
  }, { connection, concurrency });

  worker.on('completed', (job) => {
    void updateTask(job.data.taskId, { status: 'succeeded', finishedAt: new Date() });
  });
  worker.on('failed', (job, err) => {
    if (!job) return;
    void updateTask(job.data.taskId, { status: 'failed', error: err.message, finishedAt: new Date() });
    if (!DEVICE_OPS.includes(job.data.op)) {
      void updateInstance(job.data.instanceId, { status: 'error', lastError: `${job.data.op}: ${err.message}` });
    }
  });
  return worker;
}
