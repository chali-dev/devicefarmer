/**
 * 必装应用 (library/required.ts, owner 2026-11-20) against the real API, DB, Redis and task centre (no mocks, no phone).
 * - CRUD: GET / POST / PUT / DELETE /api/library/required (admin only; a user → 403 auth.admin_only), strict body
 *   validation (bad package, non-digit BitBrowser app id, missing name, extra field → 400), duplicate package →
 *   409 library.required_taken (also on PUT), unknown id → 404 library.required_not_found; audit rows
 *   library.required_create / _update / _delete / _check with the package as target.
 * - 立即检查 POST /api/library/required/check {instanceIds?} → 202 {taskIds, skipped}: a stopped phone is skipped
 *   (no task); with an empty list nothing is queued even for a running phone; an inert placeholder phone
 *   (scripts/lib/placeholder.ts: running + adb device in the DB, nothing on its adb port) gets ONE `required-apps`
 *   task that fails on adb (code asserted below); an unfinished check of that phone (DB fixture) is returned instead
 *   of a second task.
 * The required_apps table is restored to exactly its previous rows afterwards (seeded Instagram / YouTube included).
 * Usage (from apps/api, test API running): E2E_API=http://127.0.0.1:<port> npx tsx --env-file=../../.env scripts/required-apps-check.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';
import { placeholders } from './lib/placeholder.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
const login = async (username: string, password: string) =>
  (await http('POST', '/api/auth/login', null, await withCaptcha(API, { username, password }))).body?.token as string;
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(400); }
}

const R = schema.requiredApps;
const tag = randomBytes(3).toString('hex');
const t0 = new Date(Date.now() - 1000);
const ph = placeholders('reqchk');
const saved = await db.select().from(R);
const userIds: string[] = [];
const taskIds: string[] = [];
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
if (!T) throw new Error('admin login failed');

try {
  // ---------------------------------------------------------------- RBAC
  const pw = randomBytes(12).toString('base64url');
  const cu = await http('POST', '/api/users', T, { username: `req${tag}`, password: pw, role: 'user' });
  if (cu.status !== 201) throw new Error(`create user: ${cu.status} ${cu.text}`);
  userIds.push(cu.body.user.id);
  const U = await login(`req${tag}`, pw);
  const someId = saved[0]?.id ?? randomUUID();
  const userRes = await Promise.all(([
    ['GET', '/api/library/required'], ['POST', '/api/library/required', { package: `com.req${tag}.x`, name: 'x', bitbrowserAppId: '1' }],
    ['PUT', `/api/library/required/${someId}`, { package: `com.req${tag}.x`, name: 'x', bitbrowserAppId: '1' }], ['DELETE', `/api/library/required/${someId}`],
    ['POST', '/api/library/required/check', {}],
  ] as [string, string, unknown?][]).map(([m, p, b]) => http(m, p, U, b).then((x) => [`${m} ${p}`, x] as const)));
  const bad = userRes.filter(([, x]) => x.status !== 403 || x.body?.code !== 'auth.admin_only');
  check('user: 403 auth.admin_only on every 必装应用 route', !bad.length, bad.map(([k, x]) => `${k}=${x.status} ${x.body?.code}`).join(', '));
  check('…and nothing changed', (await db.select().from(R)).length === saved.length);

  // ---------------------------------------------------------------- list + create
  let r = await http('GET', '/api/library/required', T);
  check('admin GET lists the current rows (sorted by name)', r.status === 200 && r.body.apps.length === saved.length
    && r.body.apps.map((a: any) => a.name).join() === [...saved].map((a) => a.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(), r.text.slice(0, 300));
  const pkgA = `com.reqchk${tag}.alpha`; const pkgB = `com.reqchk${tag}.beta`;
  r = await http('POST', '/api/library/required', T, { package: ` ${pkgA} `, name: ' Alpha ', bitbrowserAppId: '123' });
  const A = r.body?.app;
  check('POST → 201, trimmed fields', r.status === 201 && A?.package === pkgA && A.name === 'Alpha' && A.bitbrowserAppId === '123' && !!A.id, r.text);
  r = await http('POST', '/api/library/required', T, { package: pkgB, name: 'Beta', bitbrowserAppId: '456' });
  const B = r.body?.app;
  check('second POST → 201', r.status === 201 && B?.package === pkgB, r.text);

  // ---------------------------------------------------------------- validation
  const invalid = await Promise.all([
    { package: 'no spaces allowed', name: 'x', bitbrowserAppId: '1' },
    { package: 'ab', name: 'x', bitbrowserAppId: '1' },
    { package: 'com.x/evil', name: 'x', bitbrowserAppId: '1' },
    { package: `com.reqchk${tag}.c`, name: 'x', bitbrowserAppId: '12a' },
    { package: `com.reqchk${tag}.c`, name: 'x', bitbrowserAppId: '' },
    { package: `com.reqchk${tag}.c`, name: '', bitbrowserAppId: '1' },
    { package: `com.reqchk${tag}.c`, bitbrowserAppId: '1' },
    { package: `com.reqchk${tag}.c`, name: 'x', bitbrowserAppId: '1', extra: true },
  ].map((b) => http('POST', '/api/library/required', T, b)));
  check('bad package / non-digit or empty app id / empty or missing name / extra field → 400', invalid.every((x) => x.status === 400), invalid.map((x) => x.status).join(','));
  r = await http('POST', '/api/library/required', T, { package: pkgA, name: 'Dup', bitbrowserAppId: '9' });
  check('duplicate package → 409 library.required_taken', r.status === 409 && r.body?.code === 'library.required_taken', r.text);
  check('refused writes left only the two new rows', (await db.select().from(R)).length === saved.length + 2);

  // ---------------------------------------------------------------- update / delete
  r = await http('PUT', `/api/library/required/${B.id}`, T, { package: pkgB, name: 'Beta 2', bitbrowserAppId: '789' });
  check('PUT → 200 with the new values', r.status === 200 && r.body.app.name === 'Beta 2' && r.body.app.bitbrowserAppId === '789', r.text);
  r = await http('PUT', `/api/library/required/${B.id}`, T, { package: pkgA, name: 'Beta', bitbrowserAppId: '789' });
  check('PUT onto another row\'s package → 409 library.required_taken', r.status === 409 && r.body?.code === 'library.required_taken', r.text);
  r = await http('PUT', `/api/library/required/${randomUUID()}`, T, { package: `com.reqchk${tag}.z`, name: 'Z', bitbrowserAppId: '1' });
  check('PUT unknown id → 404 library.required_not_found', r.status === 404 && r.body?.code === 'library.required_not_found', r.text);
  r = await http('PUT', `/api/library/required/${B.id}`, T, { package: pkgB, name: 'Beta', bitbrowserAppId: 'x1' });
  check('PUT with a non-digit app id → 400', r.status === 400);
  r = await http('DELETE', `/api/library/required/${randomUUID()}`, T);
  check('DELETE unknown id → 404 library.required_not_found', r.status === 404 && r.body?.code === 'library.required_not_found', r.text);
  r = await http('DELETE', `/api/library/required/${B.id}`, T);
  check('DELETE → 204, row gone', r.status === 204 && !(await db.select().from(R).where(eq(R.id, B.id))).length);

  // ---------------------------------------------------------------- 立即检查
  const [on, off] = await ph.insert([
    { name: `reqchk-${tag}-on`, adbPort: 5603, status: 'running', adbState: 'device', bootCompleted: true },
    { name: `reqchk-${tag}-off`, adbPort: 5604, status: 'stopped' },
  ]);
  r = await http('POST', '/api/library/required/check', T, { instanceIds: [off!.id] });
  check('check of a stopped phone → 202, no task, skipped 1', r.status === 202 && r.body.taskIds.length === 0 && r.body.skipped === 1, r.text);
  r = await http('POST', '/api/library/required/check', T, { instanceIds: ['not-a-uuid'] });
  const r2 = await http('POST', '/api/library/required/check', T, { instanceIds: [] });
  const r3 = await http('POST', '/api/library/required/check', T, { all: true });
  check('check body validation (non-uuid, empty list, extra field → 400)', r.status === 400 && r2.status === 400 && r3.status === 400, `${r.status} ${r2.status} ${r3.status}`);

  // an empty list of required apps queues nothing, even for a running phone
  await db.delete(R);
  r = await http('POST', '/api/library/required/check', T, { instanceIds: [on!.id, off!.id] });
  const none = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'required-apps'), eq(schema.tasks.instanceId, on!.id)));
  check('no required apps: running phone → 202 with taskIds [] (nothing to check), stopped one skipped', r.status === 202 && r.body.taskIds.length === 0 && r.body.skipped === 1 && none.length === 0, r.text);
  // the list back + the test row (restored exactly at the end anyway)
  if (saved.length) await db.insert(R).values(saved);
  const [A2] = await db.insert(R).values({ package: pkgA, name: 'Alpha', bitbrowserAppId: '123' }).onConflictDoNothing().returning();
  void A2;

  // an unfinished check of the phone (DB fixture) is returned instead of a second task
  const [fx] = await db.insert(schema.tasks).values({ type: 'required-apps', status: 'scheduled', payload: {}, instanceId: on!.id, instanceName: `${on!.name} · 必装应用`, runAt: new Date(Date.now() + 3600_000) }).returning();
  taskIds.push(fx!.id);
  r = await http('POST', '/api/library/required/check', T, { instanceIds: [on!.id] });
  check('unfinished check of the phone → the same task id, no second task', r.status === 202 && r.body.taskIds.length === 1 && r.body.taskIds[0] === fx!.id
    && (await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'required-apps'), eq(schema.tasks.instanceId, on!.id)))).length === 1, r.text);
  await db.delete(schema.tasks).where(eq(schema.tasks.id, fx!.id));

  // a real run: one task, then it fails on adb (nothing listens on the placeholder's port)
  r = await http('POST', '/api/library/required/check', T, { instanceIds: [on!.id, off!.id] });
  const tid = r.body?.taskIds?.[0] as string | undefined;
  if (tid) taskIds.push(tid);
  check('running phone with required apps → 202, one required-apps task, stopped one skipped', r.status === 202 && r.body.taskIds.length === 1 && r.body.skipped === 1, r.text);
  const task = await waitFor('required-apps task finished', async () => {
    const t = (await http('GET', `/api/tasks/${tid}`, T)).body?.task;
    return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
  }, 90_000);
  console.log(`  task ended: ${task.status} code=${task.errorCode} error=${String(task.error).slice(0, 160)}`);
  check('the task is a required-apps task of the phone, created by the admin', task.type === 'required-apps' && task.instanceId === on!.id && !!task.createdBy);
  // adb has no such device: a plain adb error, stored with the task centre's generic code task.failed
  check('unreachable phone: the check fails with task.failed (adb: device not found), 1 attempt',
    task.status === 'failed' && task.errorCode === 'task.failed' && task.attempts === 1 && /not found/.test(task.error ?? ''), `${task.status} ${task.errorCode} ${task.error}`);
  const [devAfter] = await db.select().from(schema.instances).where(eq(schema.instances.id, on!.id));
  check('a failed check does not change the phone (still running)', devAfter?.status === 'running', devAfter?.status);
  const logs = (await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, tid!))).map((l) => l.message);
  check('task log: no "install requested" line', !logs.some((m) => m.startsWith('install requested')), logs.join(' | '));
  r = await http('GET', `/api/tasks/${tid}`, U);
  check("user can't see the admin's check task of a phone not granted to them (404)", r.status === 404, String(r.status));

  // ---------------------------------------------------------------- audit
  await sleep(600);
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), like(schema.auditLogs.action, 'library.required%')));
  const ok = (action: string, target?: string) => audit.some((a) => a.action === action && a.ok && (target === undefined || a.target === target));
  check('audit: create (target package, detail package + appId)', ok('library.required_create', pkgA)
    && audit.some((a) => a.action === 'library.required_create' && a.ok && (a.detail as any)?.appId === '123'), JSON.stringify(audit.filter((a) => a.action === 'library.required_create').map((a) => [a.target, a.detail])));
  check('audit: update + delete with the package as target', ok('library.required_update', pkgB) && ok('library.required_delete', pkgB));
  check('audit: check recorded', ok('library.required_check'));
  check('audit: refused user attempts recorded (403)', audit.some((a) => a.action === 'library.required_create' && a.status === 403));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  if (taskIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));
  await ph.cleanup().catch((e) => console.log(`cleanup placeholders: ${e}`));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  // required_apps back to exactly the rows from before (ids, values and times)
  await db.transaction(async (tx) => {
    await tx.delete(R);
    if (saved.length) await tx.insert(R).values(saved);
  });
  const after = await db.select().from(R);
  const key = (rows: typeof saved) => JSON.stringify(rows.map((x) => [x.id, x.package, x.name, x.bitbrowserAppId]).sort());
  check('cleanup: required_apps restored to its previous rows', key(after) === key(saved), `${key(after)} vs ${key(saved)}`);
  await sqlClient.end();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
