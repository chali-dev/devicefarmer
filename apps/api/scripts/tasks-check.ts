/**
 * Task centre (任务中心) test against the real API, Postgres, Redis/BullMQ workers. No mocks.
 * - The API must run with TASKS_TEST_HANDLERS=1 (registers the test-only `test.echo` type, see
 *   src/modules/tasks/test-handlers.ts). This script registers the same type in its own process
 *   only to create tasks (createTask writes the row and adds the BullMQ job; the API's worker runs it).
 * - Needs no Android device: device-op checks use placeholder `instances` rows (stopped, no containers),
 *   and only ops that fail before touching Docker (uninstall-app needs a running device).
 * - Part 2 (`--restart`) kills the API listening on API_PORT (kill -9) and starts it again
 *   (node --import tsx, TASKS_TEST_HANDLERS=1, log: $TASKS_API_LOG or ./var/tasks-check-api.log) to
 *   check startup reconciliation and stall handling. The restarted API keeps running afterwards.
 * Usage (from apps/api): TASKS_TEST_HANDLERS=1 npx tsx --env-file=../../.env scripts/tasks-check.ts [--restart]
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, like } from 'drizzle-orm';
import WebSocket from 'ws';
import { db, schema, sqlClient } from '../src/db/index.js';
import { events } from '../src/lib/events.js';
import '../src/modules/instances/queue.js';
import { closeTaskQueues, createTask, type CreateTaskInput } from '../src/modules/tasks/core.js';
import '../src/modules/tasks/test-handlers.js';
import type { TestPayload } from '../src/modules/tasks/test-handlers.js';
import { withCaptcha } from './lib/login.js';

const PORT = Number(process.env.API_PORT ?? 3000);
const API = `http://127.0.0.1:${PORT}`;
const RESTART = process.argv.includes('--restart');
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tag = randomBytes(3).toString('hex');

async function http<T = any>(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 30_000, every = 250): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(every); }
}
const row = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;
const logs = async (id: string) => db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, id)).orderBy(schema.taskLogs.ts);
const waitStatus = (id: string, statuses: string[], ms = 30_000) => waitFor(`task ${id} → ${statuses}`, async () => { const r = await row(id); return statuses.includes(r.status) ? r : null; }, ms);

const taskIds: string[] = [];
const echo = async (payload: TestPayload, opts: Partial<CreateTaskInput> = {}) => {
  const r = await createTask({ type: 'test.echo', label: `tasks-check-${tag}`, payload: payload as Record<string, unknown>, ...opts });
  taskIds.push(r.task.id);
  return r.task;
};

const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const users: { id: string; token: string; name: string }[] = [];
const fakeInstances: string[] = [];
const fakeMedia: string[] = [];
let ws: WebSocket | null = null;

try {
  // ---------------------------------------------------------------- setup: two users, one placeholder device granted to B
  for (const n of ['a', 'b']) {
    const name = `tc-${tag}-${n}`; const pass = randomBytes(12).toString('hex');
    const u = await http('POST', '/api/users', admin, { username: name, password: pass, role: 'user' });
    users.push({ id: u.body.user.id, token: await login(name, pass), name });
  }
  const [A, B] = users as [typeof users[0], typeof users[0]];
  const [dev] = await db.insert(schema.instances).values({
    name: `tcfake-${tag}`, image: 'none', adbPort: 41000 + Math.floor(Math.random() * 9000), status: 'stopped', spec: { width: 720, height: 1280, dpi: 320 },
  }).returning();
  fakeInstances.push(dev!.id);
  await http('PUT', `/api/users/${B.id}/grants`, admin, { instanceIds: [dev!.id] });

  // B listens on /api/events (RBAC filter).
  const seen: any[] = [];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events`);
  await new Promise<void>((resolve, reject) => {
    ws!.on('open', () => ws!.send(JSON.stringify({ type: 'auth', token: B.token })));
    ws!.on('message', (m) => { const ev = JSON.parse(m.toString()); if (ev.type === 'ready') resolve(); else seen.push(ev); });
    ws!.on('error', reject);
  });

  // ---------------------------------------------------------------- success
  const ok = await echo({ result: { hello: 'world' } }, { userId: A.id });
  check('new task starts pending (or already running)', ['pending', 'running', 'success'].includes(ok.status) && ok.attempts === 0, ok.status);
  const okDone = await waitStatus(ok.id, ['success', 'failed']);
  const okLogs = await logs(ok.id);
  check('success: result stored, 1 attempt, timestamps set', okDone.status === 'success' && (okDone.result as any)?.hello === 'world' && okDone.attempts === 1 && !!okDone.startedAt && !!okDone.finishedAt);
  check('success: logs created → attempt started → handler log → succeeded',
    ['created', 'attempt 1/1 started', 'test handler running', 'succeeded'].every((m) => okLogs.some((l) => l.message === m)), okLogs.map((l) => l.message).join(' | '));

  // ---------------------------------------------------------------- failure + retry with backoff
  const flaky = await echo({ failTimes: 2 }, { maxAttempts: 3, userId: A.id });
  const flakyDone = await waitStatus(flaky.id, ['success', 'failed']);
  const flakyLogs = await logs(flaky.id);
  const starts = flakyLogs.filter((l) => /^attempt \d\/3 started$/.test(l.message)).map((l) => l.ts.getTime());
  const retried = flakyLogs.filter((l) => /failed, retrying/.test(l.message));
  check('retry: succeeds on attempt 3 of 3', flakyDone.status === 'success' && flakyDone.attempts === 3, `${flakyDone.status} attempts=${flakyDone.attempts}`);
  check('retry: each failed attempt logged with error + backoff', retried.length === 2 && retried.every((l) => (l.data as any)?.code === 'test.failure'));
  check('retry: exponential backoff between attempts (≥1 s, then ≥2 s)', starts.length === 3 && starts[1]! - starts[0]! >= 900 && starts[2]! - starts[1]! >= 1900,
    starts.slice(1).map((t, i) => `${t - starts[i]!}ms`).join(', '));

  const bad = await echo({ failTimes: 9, failCode: 'test.boom' }, { maxAttempts: 2, userId: A.id });
  const badDone = await waitStatus(bad.id, ['success', 'failed']);
  check('final failure after max_attempts keeps code + message', badDone.status === 'failed' && badDone.attempts === 2 && badDone.errorCode === 'test.boom' && /planned failure 2/.test(badDone.error ?? ''), `${badDone.errorCode} ${badDone.error}`);

  // ---------------------------------------------------------------- timeout
  const slow = await echo({ sleepMs: 8000 }, { timeoutMs: 1000, userId: A.id });
  const slowDone = await waitStatus(slow.id, ['success', 'failed']);
  const slowMs = slowDone.finishedAt!.getTime() - slowDone.startedAt!.getTime();
  check('timeout fails the attempt with task.timeout', slowDone.status === 'failed' && slowDone.errorCode === 'task.timeout' && slowMs < 3000, `${slowDone.errorCode} after ${slowMs}ms`);

  // ---------------------------------------------------------------- scheduled
  const runAt = new Date(Date.now() + 4000);
  const sched = await echo({}, { runAt, userId: A.id });
  check('runAt in the future → scheduled', sched.status === 'scheduled' && sched.runAt?.getTime() === runAt.getTime());
  await sleep(1500);
  check('scheduled task has not started early', (await row(sched.id)).status === 'scheduled');
  const schedDone = await waitStatus(sched.id, ['success', 'failed'], 15_000);
  const lateBy = schedDone.startedAt!.getTime() - runAt.getTime();
  check('scheduled task runs on time', schedDone.status === 'success' && lateBy >= -50 && lateBy < 3000, `started ${lateBy}ms after run_at`);

  // ---------------------------------------------------------------- cancel
  const far = await echo({}, { runAt: new Date(Date.now() + 3600_000), userId: A.id });
  let r = await http('POST', `/api/tasks/${far.id}/cancel`, A.token);
  const { Queue } = await import('bullmq');
  const tq = new Queue('task-ops', { connection: { url: process.env.REDIS_URL! } });
  check('cancel scheduled → cancelled, BullMQ job removed', r.status === 200 && r.body.task.status === 'cancelled' && !(await tq.getJob(far.id)), r.text.slice(0, 120));

  // Occupy both task-ops slots, then a third task stays pending.
  const blockers = [await echo({ sleepMs: 4000 }), await echo({ sleepMs: 4000 })];
  await Promise.all(blockers.map((b) => waitStatus(b.id, ['running'])));
  const queued = await echo({ result: 'should-not-run' }, { userId: A.id });
  await sleep(300);
  const qBefore = await row(queued.id);
  r = await http('POST', `/api/tasks/${queued.id}/cancel`, A.token);
  await Promise.all(blockers.map((b) => waitStatus(b.id, ['success'])));
  await sleep(1000);
  const qAfter = await row(queued.id);
  check('cancel pending → cancelled and never runs', qBefore.status === 'pending' && r.status === 200 && qAfter.status === 'cancelled' && qAfter.attempts === 0, `${qBefore.status} → ${qAfter.status} attempts=${qAfter.attempts}`);

  const long = await echo({ sleepMs: 60_000 }, { userId: A.id });
  await waitStatus(long.id, ['running']);
  r = await http('POST', `/api/tasks/${long.id}/cancel`, A.token);
  const longDone = await waitStatus(long.id, ['cancelled', 'success', 'failed'], 10_000);
  check('cancel running → signal aborts the handler → cancelled', r.status === 200 && r.body.task.cancelRequested === true && longDone.status === 'cancelled' && longDone.errorCode === 'task.cancelled', longDone.status);

  const stubborn = await echo({ sleepMs: 2500, ignoreSignal: true }, { userId: A.id });
  await waitStatus(stubborn.id, ['running']);
  await http('POST', `/api/tasks/${stubborn.id}/cancel`, A.token);
  const stubDone = await waitStatus(stubborn.id, ['cancelled', 'success', 'failed']);
  check('handler that ignores the signal finishes; outcome recorded as success + cancel_requested',
    stubDone.status === 'success' && stubDone.cancelRequested && (await logs(stubborn.id)).some((l) => /cancel was requested/.test(l.message)));
  r = await http('POST', `/api/tasks/${ok.id}/cancel`, A.token);
  check('cancel a finished task → 409 tasks.already_finished', r.status === 409 && r.body.code === 'tasks.already_finished');
  const [nc] = await db.insert(schema.tasks).values({ type: 'create', status: 'scheduled', payload: {}, instanceId: dev!.id, instanceName: `tcfake-${tag}`, runAt: new Date(Date.now() + 3600_000) }).returning();
  r = await http('POST', `/api/tasks/${nc!.id}/cancel`, admin);
  await db.delete(schema.tasks).where(eq(schema.tasks.id, nc!.id));
  check('device create task is not cancellable → 409 tasks.not_cancellable', r.status === 409 && r.body.code === 'tasks.not_cancellable');

  // ---------------------------------------------------------------- idempotency
  const key = `tc-${tag}-idem`;
  const par = await Promise.all(Array.from({ length: 10 }, () => createTask({ type: 'test.echo', label: `tasks-check-${tag}`, payload: {}, idempotencyKey: key, userId: A.id })));
  const ids = new Set(par.map((p) => p.task.id));
  taskIds.push(...ids);
  const rowsWithKey = await db.select().from(schema.tasks).where(eq(schema.tasks.idempotencyKey, key));
  check('10 parallel creates with one idempotency key → one task', ids.size === 1 && par.filter((p) => p.created).length === 1 && rowsWithKey.length === 1);
  await waitStatus([...ids][0]!, ['success']);
  const again = await createTask({ type: 'test.echo', payload: {}, idempotencyKey: key });
  check('same key after completion returns the existing task', !again.created && again.task.id === [...ids][0] && again.task.status === 'success');

  // ---------------------------------------------------------------- manual retry
  r = await http('POST', `/api/tasks/${bad.id}/retry`, A.token);
  const retryTask = r.body?.task;
  if (retryTask) taskIds.push(retryTask.id);
  check('manual retry of a failed task → 202 new task (retry_of, same payload)', r.status === 202 && retryTask.id !== bad.id && retryTask.retryOf === bad.id && retryTask.createdBy === A.id);
  const origAfter = await row(bad.id);
  check('original keeps its history (still failed, retry logged)', origAfter.status === 'failed' && (await logs(bad.id)).some((l) => l.message === 'retried as a new task'));
  r = await http('POST', `/api/tasks/${long.id}/retry`, A.token);
  if (r.body?.task) taskIds.push(r.body.task.id);
  check('cancelled task can be retried too', r.status === 202);
  r = await http('POST', `/api/tasks/${ok.id}/retry`, A.token);
  check('retry of a successful task → 409 tasks.not_retryable_status', r.status === 409 && r.body.code === 'tasks.not_retryable_status');

  // ---------------------------------------------------------------- device op on the new core (no Docker touched)
  const devTask = (await createTask({ type: 'uninstall-app', instance: dev!, label: `tcfake-${tag} · com.example.none`, payload: { package: 'com.example.none' }, userId: null })).task;
  taskIds.push(devTask.id);
  const devDone = await waitStatus(devTask.id, ['success', 'failed']);
  const [devAfter] = await db.select().from(schema.instances).where(eq(schema.instances.id, dev!.id));
  check('device-only op failure does not mark the device error', devDone.status === 'failed' && /not running/.test(devDone.error ?? '') && devAfter!.status === 'stopped', `${devDone.error} / ${devAfter!.status}`);

  // ---------------------------------------------------------------- REST: list, filters, detail, stats, RBAC
  let l = await http('GET', `/api/tasks?type=test.echo&q=tasks-check-${tag}&limit=200`, admin);
  check('admin list filtered by type + search', l.status === 200 && l.body.total >= 12 && l.body.tasks.every((t: any) => t.type === 'test.echo' && !('payload' in t)), `total=${l.body.total}`);
  l = await http('GET', `/api/tasks?status=failed,cancelled&q=tasks-check-${tag}`, admin);
  check('status filter (comma list)', l.body.tasks.length > 0 && l.body.tasks.every((t: any) => ['failed', 'cancelled'].includes(t.status)));
  l = await http('GET', `/api/tasks?q=tasks-check-${tag}&limit=2&offset=2`, admin);
  check('pagination: limit/offset with total', l.body.tasks.length === 2 && l.body.total >= 12);
  l = await http('GET', `/api/tasks?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, admin);
  check('date range filter', l.status === 200 && l.body.total === 0);
  l = await http('GET', `/api/tasks?status=bogus`, admin);
  check('invalid status filter → 400', l.status === 400);

  const la = await http('GET', `/api/tasks?q=tasks-check-${tag}&limit=200`, A.token);
  const lb = await http('GET', `/api/tasks?limit=200`, B.token);
  check('user A sees only own tasks', la.body.tasks.length > 0 && la.body.tasks.every((t: any) => t.createdBy === A.id));
  check('user B (no own tasks) sees only tasks on the granted device', lb.body.tasks.length >= 1 && lb.body.tasks.every((t: any) => t.instanceId === dev!.id) && lb.body.tasks.some((t: any) => t.id === devTask.id));
  check('user B cannot open/cancel/retry A\'s task → 404',
    (await http('GET', `/api/tasks/${ok.id}`, B.token)).status === 404 && (await http('POST', `/api/tasks/${bad.id}/retry`, B.token)).status === 404 && (await http('POST', `/api/tasks/${sched.id}/cancel`, B.token)).status === 404);
  const userFilter = await http('GET', `/api/tasks?userId=${A.id}&limit=200`, admin);
  check('admin owner filter', userFilter.body.tasks.length > 0 && userFilter.body.tasks.every((t: any) => t.createdBy === A.id));
  const d = await http('GET', `/api/tasks/${flaky.id}`, A.token);
  check('detail: payload, result, logs, actions, owner name', d.status === 200 && d.body.task.payload.failTimes === 2 && d.body.task.result.attempt === 3 && d.body.logs.length >= 8 && d.body.task.canRetry === false && d.body.task.createdByName === A.name);
  const st = await http('GET', `/api/tasks/stats?q=tasks-check-${tag}`, A.token);
  check('stats: counts by status/type for the visible set', st.status === 200 && st.body.byStatus.success >= 4 && st.body.byStatus.failed >= 2 && st.body.byType['test.echo'] >= 10 && st.body.types.includes('media-process'));
  const stB = await http('GET', `/api/tasks/stats?q=tasks-check-${tag}`, B.token);
  check('stats for B exclude A\'s tasks', Object.values(stB.body.byStatus as Record<string, number>).reduce((a, b) => a + b, 0) === 0);

  // ---------------------------------------------------------------- events RBAC
  await sleep(500);
  check('events: B receives task updates of the granted device', seen.some((e) => e.type === 'task.updated' && e.task.id === devTask.id));
  check('events: B never receives A\'s tasks, nor payload/result, nor internal cancel events',
    !seen.some((e) => (e.task && e.task.createdBy === A.id) || (e.type === 'task.log' && e.createdBy === A.id) || e.type === 'task.cancel' || (e.task && 'payload' in e.task)));

  // ---------------------------------------------------------------- audit
  await sleep(500);
  const audits = await db.select().from(schema.auditLogs).where(and(inArray(schema.auditLogs.action, ['task.cancel', 'task.retry']), inArray(schema.auditLogs.targetId, [far.id, queued.id, long.id, bad.id])));
  check('audit: cancel + retry recorded with target', audits.some((a) => a.action === 'task.cancel' && a.targetId === far.id && a.username === A.name && a.target?.includes('tasks-check'))
    && audits.some((a) => a.action === 'task.retry' && a.targetId === bad.id && (a.detail as any)?.newTaskId === retryTask?.id), `${audits.length} entries`);
  await tq.close();

  // ---------------------------------------------------------------- startup reconciliation (kill -9 + restart)
  if (RESTART) {
    const sleeper = await echo({ sleepMs: 300_000 }, { userId: A.id });
    await waitStatus(sleeper.id, ['running']);
    const orphanRunning = (await db.insert(schema.tasks).values({ type: 'test.echo', status: 'running', attempts: 1, payload: {}, instanceName: `tasks-check-${tag}`, createdBy: A.id, startedAt: new Date() }).returning())[0]!;
    const orphanPending = (await db.insert(schema.tasks).values({ type: 'test.echo', status: 'pending', payload: { result: 'requeued' }, instanceName: `tasks-check-${tag}`, createdBy: A.id }).returning())[0]!;
    const devRunning = (await db.insert(schema.tasks).values({ type: 'stop', status: 'running', attempts: 1, payload: {}, instanceId: dev!.id, instanceName: `tcfake-${tag}`, startedAt: new Date() }).returning())[0]!;
    const [asset] = await db.insert(schema.mediaAssets).values({
      ownerType: 'public', name: `tc-${tag}`, fileName: `tc-${tag}.jpg`, storage: 'local', fileKey: `public/images/tc-${tag}-missing.jpg`,
      fileType: 'image', mimeType: 'image/jpeg', fileSize: 1, checksum: 'x', status: 'processing',
    }).returning();
    fakeMedia.push(asset!.id);
    const mediaRunning = (await db.insert(schema.tasks).values({ type: 'media-process', status: 'running', attempts: 1, payload: { assetId: asset!.id }, refType: 'media', refId: asset!.id, instanceName: `tasks-check-${tag}`, startedAt: new Date() }).returning())[0]!;
    taskIds.push(orphanRunning.id, orphanPending.id, devRunning.id, mediaRunning.id);

    const pid = execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN']).toString().trim().split('\n')[0]!;
    process.kill(Number(pid), 'SIGKILL');
    console.log(`  killed API pid ${pid}; restarting`);
    await sleep(1000);
    const logFile = process.env.TASKS_API_LOG ?? path.resolve('var/tasks-check-api.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, ['--env-file=../../.env', '--import', 'tsx', 'src/main.ts'], {
      cwd: path.resolve('.'), detached: true, stdio: ['ignore', out, out], env: { ...process.env, TASKS_TEST_HANDLERS: '1' },
    });
    child.unref();
    console.log(`  new API pid ${child.pid} (log ${logFile})`);
    await waitFor('API up', async () => (await fetch(`${API}/api/health`)).status < 500, 60_000, 500);

    const or = await waitStatus(orphanRunning.id, ['failed', 'success'], 10_000);
    check('restart: orphaned running task (job gone) → failed task.interrupted', or.status === 'failed' && or.errorCode === 'task.interrupted');
    const op = await waitStatus(orphanPending.id, ['failed', 'success'], 15_000);
    check('restart: pending task without job is enqueued again and runs', op.status === 'success' && op.result === 'requeued' && (await logs(op.id)).some((x) => /enqueued again/.test(x.message)));
    const mr = await waitStatus(mediaRunning.id, ['failed'], 10_000);
    const [assetAfter] = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, asset!.id));
    check('restart: interrupted media-process → task failed and asset failed (not processing forever)', mr.errorCode === 'task.interrupted' && assetAfter!.status === 'failed', assetAfter!.status);
    const dr = await waitStatus(devRunning.id, ['failed'], 10_000);
    const [devErr] = await db.select().from(schema.instances).where(eq(schema.instances.id, dev!.id));
    check('restart: interrupted lifecycle op marks the device error (as before)', dr.errorCode === 'task.interrupted' && devErr!.status === 'error', devErr!.status);
    const t0 = Date.now();
    const sl = await waitStatus(sleeper.id, ['failed', 'success'], 120_000);
    check('restart: task running in the killed process (stalled job) → failed task.interrupted, not rerun', sl.status === 'failed' && sl.errorCode === 'task.interrupted' && sl.attempts === 1, `after ${Math.round((Date.now() - t0) / 1000)} s`);
  } else {
    console.log('  (startup reconciliation not run: pass --restart)');
  }
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  ws?.close();
  if (taskIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));
  await db.delete(schema.tasks).where(like(schema.tasks.instanceName, `%tasks-check-${tag}%`));
  for (const id of fakeMedia) await db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, id));
  for (const id of fakeInstances) {
    await db.delete(schema.tasks).where(eq(schema.tasks.instanceId, id));
    await db.delete(schema.instances).where(eq(schema.instances.id, id));
  }
  for (const u of users) await http('DELETE', `/api/users/${u.id}`, admin);
  await closeTaskQueues();
  await events.close();
  await sqlClient.end();
  const passed = results.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
