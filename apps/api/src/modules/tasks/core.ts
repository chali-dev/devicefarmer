import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { TASK_FINAL, type Task, type TaskLog, type TaskStatus } from '../../db/schema.js';
import { conflict } from '../../lib/errors.js';
import { events } from '../../lib/events.js';
import type { AuthUser } from '../auth/rbac.js';
import { publicTask, updateTask } from '../instances/repo.js';

/**
 * Task centre core (任务中心): one scheduling system for every background job.
 *
 * - A module registers a handler per task type (`registerTaskHandler`) and creates tasks with
 *   `createTask`. The `tasks` row is the source of truth; the BullMQ job (id = task id, data
 *   `{ taskId }`) only triggers execution, so the worker always reloads the row.
 * - Statuses: pending | scheduled (BullMQ delayed job until run_at) → running → success | failed | cancelled.
 *   Every transition is guarded by the current status (no lost updates between a cancel and a worker)
 *   and writes a task_logs line.
 * - Retries: up to max_attempts with exponential backoff (BullMQ); between attempts the task is
 *   pending again and its last error is kept. Manual retry (`retryTask`) creates a new task with
 *   retry_of = the original, so the history of the original stays as it was.
 * - Timeouts fail the attempt (code task.timeout) and abort ctx.signal; the attempt counts.
 * - Cancel: pending/scheduled → cancelled and the job is removed; running → cancel_requested + ctx.signal
 *   aborted (through the event bus, so it reaches the worker in any process). Handlers that can't be
 *   interrupted (device ops) just finish; the outcome is then recorded as it happened.
 * - Crash safety: an attempt never runs twice by accident. A job redelivered after a stall (worker
 *   died mid-run) finds its task still `running` and fails it as task.interrupted instead of running
 *   non-idempotent work (e.g. a publish) again; `reconcileTasks()` at startup does the same for
 *   running tasks whose job is gone and re-enqueues pending/scheduled tasks whose job is missing.
 */

export type TaskLogLevel = TaskLog['level'];

export interface TaskContext<P = Record<string, unknown>> {
  /** The row as claimed for this attempt (status running, attempts incremented). */
  task: Task;
  payload: P;
  /** 1-based attempt number. */
  attempt: number;
  /** Aborted on cancel request (reason: TaskError task.cancelled) or timeout (task.timeout). */
  signal: AbortSignal;
  log(level: TaskLogLevel, message: string, data?: Record<string, unknown>): Promise<void>;
}

export interface TaskHandler<P = Record<string, unknown>> {
  /** Returned value (JSON) is stored as the task result. Throw to fail the attempt. */
  run(ctx: TaskContext<P>): Promise<unknown>;
  /** BullMQ queue (one worker per queue). Default 'task-ops'. Device ops use 'instance-ops'. */
  queue?: string;
  /** Worker concurrency of the queue (the highest value registered for a queue wins). Default 2. */
  concurrency?: number;
  /** Defaults for createTask. */
  timeoutMs?: number;
  maxAttempts?: number;
  /** Base delay of the exponential retry backoff (attempt n waits base·2^(n-1)). Default 5 s. */
  backoffMs?: number;
  /** pending/scheduled tasks may be cancelled (default true). Running tasks only get the signal. */
  cancellable?: boolean;
  /** Manual retry allowed (default true). */
  retryable?: boolean;
  /** Extra checks / preparation before a manual retry (throw an HttpError to refuse). */
  beforeRetry?(task: Task, user: AuthUser): Promise<void>;
  /** Called once when a task ends failed or cancelled (also after interruption/timeouts). Errors are logged only. */
  onFailure?(task: Task): Promise<void>;
}

/** Errors with a stable code (stored in tasks.error_code, translated by the UI as errors.<code>). */
export class TaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const DEFAULT_QUEUE = 'task-ops';
const NON_FINAL: TaskStatus[] = ['pending', 'scheduled', 'running'];
const connection = { url: config.REDIS_URL };
const handlers = new Map<string, TaskHandler<any>>();
const queues = new Map<string, Queue<{ taskId: string }>>();
const concurrency = new Map<string, number>();
/** AbortControllers of the attempts running in this process. */
const running = new Map<string, AbortController>();

export const isFinal = (s: TaskStatus) => TASK_FINAL.includes(s);
export const taskHandler = (type: string) => handlers.get(type);
export const registeredTaskTypes = () => [...handlers.keys()];

function queue(name: string): Queue<{ taskId: string }> {
  let q = queues.get(name);
  if (!q) { q = new Queue(name, { connection }); queues.set(name, q); }
  return q;
}

export function registerTaskHandler<P = Record<string, unknown>>(type: string, h: TaskHandler<P>): void {
  if (handlers.has(type)) throw new Error(`task handler already registered: ${type}`);
  handlers.set(type, h);
  const name = h.queue ?? DEFAULT_QUEUE;
  queue(name);
  concurrency.set(name, Math.max(concurrency.get(name) ?? 1, h.concurrency ?? 2));
}

// ---------------------------------------------------------------- logs

export async function taskLog(task: Pick<Task, 'id' | 'instanceId' | 'createdBy'>, level: TaskLogLevel, message: string, data?: Record<string, unknown>): Promise<void> {
  const [log] = await db.insert(schema.taskLogs).values({ taskId: task.id, level, message: message.slice(0, 2000), data: data ?? null }).returning();
  if (log) events.publish({ type: 'task.log', taskId: task.id, instanceId: task.instanceId, createdBy: task.createdBy, log });
}

// ---------------------------------------------------------------- create

export interface CreateTaskInput {
  type: string;
  /** Owner (tasks.created_by); null = system. */
  userId?: string | null;
  /** Device the task acts on (tasks.instance_id; users with a grant on it see the task). */
  instance?: { id: string; name: string } | null;
  /** Display label; defaults to the device name. */
  label?: string | null;
  refType?: string | null;
  refId?: string | null;
  /** Handler input, shown in the task centre: never secrets. */
  payload?: Record<string, unknown>;
  /** Run later (status scheduled until then). */
  runAt?: Date | null;
  /** Unique per type: a second create with the same key returns the existing task (created: false). */
  idempotencyKey?: string | null;
  maxAttempts?: number;
  timeoutMs?: number | null;
  /** BullMQ priority (1 = highest; 0 = none). */
  priority?: number;
  retryOf?: string | null;
}

async function addJob(task: Task): Promise<void> {
  const h = handlers.get(task.type);
  if (!h) throw new TaskError('task.unknown_type', `no handler for task type ${task.type}`);
  const delay = task.runAt ? Math.max(0, task.runAt.getTime() - Date.now()) : 0;
  await queue(h.queue ?? DEFAULT_QUEUE).add(task.type, { taskId: task.id }, {
    jobId: task.id,
    delay,
    priority: task.priority || undefined,
    attempts: Math.max(1, task.maxAttempts - task.attempts),
    backoff: { type: 'exponential', delay: h.backoffMs ?? 5000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export async function createTask(input: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
  const h = handlers.get(input.type);
  if (!h) throw new Error(`no task handler registered for type "${input.type}"`);
  const runAt = input.runAt && input.runAt.getTime() > Date.now() ? input.runAt : null;
  const [inserted] = await db.insert(schema.tasks).values({
    type: input.type,
    instanceId: input.instance?.id ?? null,
    instanceName: input.label ?? input.instance?.name ?? null,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    status: runAt ? 'scheduled' : 'pending',
    payload: input.payload ?? {},
    maxAttempts: Math.max(1, input.maxAttempts ?? h.maxAttempts ?? 1),
    timeoutMs: input.timeoutMs === undefined ? h.timeoutMs ?? null : input.timeoutMs,
    priority: input.priority ?? 0,
    idempotencyKey: input.idempotencyKey ?? null,
    retryOf: input.retryOf ?? null,
    runAt,
    createdBy: input.userId ?? null,
  }).onConflictDoNothing().returning();
  if (!inserted) {
    const [existing] = await db.select().from(schema.tasks)
      .where(and(eq(schema.tasks.type, input.type), eq(schema.tasks.idempotencyKey, input.idempotencyKey ?? '')));
    if (!existing) throw new Error('task insert conflicted but no existing task was found');
    return { task: existing, created: false };
  }
  await taskLog(inserted, 'info', runAt ? 'scheduled' : 'created', {
    ...(runAt ? { runAt: runAt.toISOString() } : {}), maxAttempts: inserted.maxAttempts,
    ...(inserted.timeoutMs ? { timeoutMs: inserted.timeoutMs } : {}), ...(inserted.retryOf ? { retryOf: inserted.retryOf } : {}),
  });
  events.publish({ type: 'task.updated', task: publicTask(inserted) });
  try {
    await addJob(inserted);
  } catch (err) {
    await failTask(inserted, 'task.enqueue_failed', `enqueue failed: ${(err as Error).message}`);
    throw err;
  }
  return { task: inserted, created: true };
}

// ---------------------------------------------------------------- transitions

/** Ends a non-final task as failed (no-op if it already ended) and runs the handler's onFailure. */
export async function failTask(task: Task, code: string, message: string, from: TaskStatus[] = NON_FINAL): Promise<Task | undefined> {
  const row = await updateTask(task.id, { status: 'failed', error: message.slice(0, 2000), errorCode: code, finishedAt: new Date() },
    inArray(schema.tasks.status, from));
  if (!row) return undefined;
  await taskLog(row, 'error', `failed: ${message}`, { code, attempts: row.attempts });
  await notifyFailure(row);
  return row;
}

async function notifyFailure(row: Task): Promise<void> {
  try { await handlers.get(row.type)?.onFailure?.(row); } catch (err) {
    await taskLog(row, 'warn', `failure hook error: ${(err as Error).message}`).catch(() => undefined);
  }
}

/**
 * Cancels a task: pending/scheduled → cancelled (job removed); running → cancel_requested and the
 * attempt's signal is aborted. Returns the updated row.
 */
export async function cancelTask(task: Task, by: string | null): Promise<Task> {
  const h = handlers.get(task.type);
  if (isFinal(task.status)) throw conflict('任务已结束，无法取消', 'tasks.already_finished', { status: task.status });
  if (h && h.cancellable === false) throw conflict('该类型的任务不能取消', 'tasks.not_cancellable', { type: task.type });
  const cancelled = await updateTask(task.id, { status: 'cancelled', cancelRequested: true, errorCode: 'task.cancelled', finishedAt: new Date() },
    inArray(schema.tasks.status, ['pending', 'scheduled']));
  if (cancelled) {
    await taskLog(cancelled, 'warn', 'cancelled before it started', { by });
    const job = h ? await queue(h.queue ?? DEFAULT_QUEUE).getJob(task.id) : undefined;
    await job?.remove().catch(() => undefined); // an active job is stopped by the claim guard instead
    await notifyFailure(cancelled);
    return cancelled;
  }
  const req = await updateTask(task.id, { cancelRequested: true }, eq(schema.tasks.status, 'running'));
  if (req) {
    await taskLog(req, 'warn', 'cancel requested while running', { by });
    events.publish({ type: 'task.cancel', taskId: task.id });
    return req;
  }
  // Changed state in between: report the current state.
  const [cur] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  if (!cur || isFinal(cur.status)) throw conflict('任务已结束，无法取消', 'tasks.already_finished', { status: cur?.status ?? 'unknown' });
  return cur;
}

/** Manual retry of a failed/cancelled task: a new task with the same input (retry_of = original). */
export async function retryTask(task: Task, user: AuthUser): Promise<Task> {
  const h = handlers.get(task.type);
  if (task.status !== 'failed' && task.status !== 'cancelled') throw conflict('只能重试失败或已取消的任务', 'tasks.not_retryable_status', { status: task.status });
  if (!h || h.retryable === false) throw conflict('该类型的任务不能重试', 'tasks.not_retryable', { type: task.type });
  await h.beforeRetry?.(task, user);
  const { task: created } = await createTask({
    type: task.type, userId: user.id,
    instance: task.instanceId ? { id: task.instanceId, name: task.instanceName ?? '' } : null,
    label: task.instanceName, refType: task.refType, refId: task.refId,
    payload: task.payload ?? {}, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs, priority: task.priority, retryOf: task.id,
  });
  await taskLog(task, 'info', 'retried as a new task', { newTaskId: created.id, by: user.username });
  return created;
}

// ---------------------------------------------------------------- worker

function errorCode(err: unknown): string | null {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' ? c : null;
}

/** Old-format jobs (before the task centre) carried the op input in the job data. */
function legacyPayload(data: Record<string, unknown>): Record<string, unknown> {
  const { taskId: _t, op: _o, instanceId: _i, ...rest } = data;
  return rest;
}

async function processJob(job: Job<{ taskId: string }>): Promise<void> {
  const taskId = job.data.taskId;
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  if (!row) return; // deleted
  if (row.status === 'running') {
    // Redelivered after a stall: the previous attempt was cut off (process died). Never run it twice.
    await failTask(row, 'task.interrupted', 'the worker running this task stopped (process restart or crash)', ['running']);
    throw new UnrecoverableError('interrupted');
  }
  const h = handlers.get(row.type);
  if (!h) {
    await failTask(row, 'task.unknown_type', `no handler for task type ${row.type}`);
    throw new UnrecoverableError('unknown type');
  }
  const claimed = await updateTask(taskId, { status: 'running', attempts: sql`${schema.tasks.attempts} + 1`, startedAt: new Date() },
    and(inArray(schema.tasks.status, ['pending', 'scheduled']), eq(schema.tasks.cancelRequested, false)));
  if (!claimed) return; // cancelled (or finished) meanwhile
  const attempt = claimed.attempts;
  await taskLog(claimed, 'info', `attempt ${attempt}/${claimed.maxAttempts} started`);

  const ac = new AbortController();
  running.set(taskId, ac);
  let timer: NodeJS.Timeout | undefined;
  const timeout = claimed.timeoutMs
    ? new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new TaskError('task.timeout', `timed out after ${claimed.timeoutMs} ms`);
        ac.abort(e);
        reject(e);
      }, claimed.timeoutMs!);
    })
    : null;
  const ctx: TaskContext = {
    task: claimed, attempt, signal: ac.signal,
    payload: (claimed.payload ?? legacyPayload(job.data as Record<string, unknown>)) as Record<string, unknown>,
    log: (level, message, data) => taskLog(claimed, level, message, data),
  };
  try {
    const p = h.run(ctx);
    p.catch(() => undefined); // after a timeout the handler may still settle; its outcome is ignored
    const result = await (timeout ? Promise.race([p, timeout]) : p);
    const done = await updateTask(taskId, { status: 'success', result: result === undefined ? null : result, error: null, errorCode: null, finishedAt: new Date() },
      eq(schema.tasks.status, 'running'));
    if (done) await taskLog(done, 'info', done.cancelRequested ? 'succeeded (cancel was requested, but the task completed)' : 'succeeded');
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    const [cur] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (!cur || cur.status !== 'running') throw new UnrecoverableError(message);
    if (cur.cancelRequested) {
      const row2 = await updateTask(taskId, { status: 'cancelled', error: message.slice(0, 2000), errorCode: 'task.cancelled', finishedAt: new Date() },
        eq(schema.tasks.status, 'running'));
      if (row2) { await taskLog(row2, 'warn', 'cancelled while running', { error: message }); await notifyFailure(row2); }
      throw new UnrecoverableError(message);
    }
    const code = errorCode(err) ?? 'task.failed';
    if (attempt >= cur.maxAttempts || err instanceof UnrecoverableError) {
      await failTask(cur, code, message, ['running']);
      throw new UnrecoverableError(message);
    }
    const retryIn = (h.backoffMs ?? 5000) * 2 ** job.attemptsMade;
    const back = await updateTask(taskId, { status: 'pending', error: message.slice(0, 2000), errorCode: code }, eq(schema.tasks.status, 'running'));
    if (back) await taskLog(back, 'warn', `attempt ${attempt}/${cur.maxAttempts} failed, retrying`, { error: message, code, retryInMs: retryIn });
    throw err; // BullMQ schedules the next attempt
  } finally {
    clearTimeout(timer);
    running.delete(taskId);
  }
}

// Cancel requests reach the worker through the event bus (any API process may receive the request).
events.on('event', (ev) => {
  if (ev.type === 'task.cancel') running.get(ev.taskId)?.abort(new TaskError('task.cancelled', 'cancelled'));
});

/**
 * Startup reconciliation (before the workers start): running tasks whose job is gone fail as
 * task.interrupted (an active job is left to BullMQ's stall check, which redelivers it and
 * processJob fails it); pending/scheduled tasks without a job are enqueued again.
 */
export async function reconcileTasks(log: FastifyBaseLogger): Promise<void> {
  const live = new Map<string, string>();
  for (const q of queues.values()) {
    for (const state of ['active', 'waiting', 'delayed', 'prioritized'] as const) {
      const jobs = await q.getJobs([state], 0, -1);
      for (const j of jobs) if (j?.data?.taskId) live.set(j.data.taskId, state);
    }
  }
  const rows = await db.select().from(schema.tasks).where(inArray(schema.tasks.status, NON_FINAL));
  let failed = 0; let requeued = 0;
  for (const row of rows) {
    if (live.has(row.id)) continue;
    if (row.status === 'running' || row.payload === null) {
      // payload null = a pre-task-centre row whose input only lived in the (lost) job.
      if (await failTask(row, 'task.interrupted', 'the job of this task was lost (process restart or crash)')) failed++;
      continue;
    }
    if (!handlers.has(row.type)) { log.warn({ taskId: row.id, type: row.type }, 'task without handler left as is'); continue; }
    try {
      await addJob(row);
      await taskLog(row, 'warn', 'job was missing; enqueued again at startup');
      requeued++;
    } catch (err) {
      log.error({ err, taskId: row.id }, 'task re-enqueue failed');
    }
  }
  if (failed || requeued) log.info({ failed, requeued }, 'task reconciliation');
}

/** Starts one worker per registered queue. maxStalledCount 0: a stalled job is not silently rerun. */
export function startTaskWorkers(): { close(): Promise<void> } {
  const workers = [...queues.keys()].map((name) => {
    const w = new Worker<{ taskId: string }>(name, processJob, { connection, concurrency: concurrency.get(name) ?? 2, maxStalledCount: 0 });
    // Backup for failures that bypass processJob (e.g. BullMQ's own stall failure): the row must not stay running.
    w.on('failed', (job, err) => {
      if (!job?.data?.taskId) return;
      void (async () => {
        const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, job.data.taskId));
        if (row?.status === 'running' && !running.has(row.id)) {
          await failTask(row, /stalled/.test(err.message) ? 'task.interrupted' : 'task.failed', err.message, ['running']);
        }
      })().catch(() => undefined);
    });
    return w;
  });
  return {
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

/** Closes the queues only (scripts that create tasks without running workers). */
export async function closeTaskQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
}
