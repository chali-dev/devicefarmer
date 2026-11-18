/**
 * Alerts (告警通知) against the real API, DB, Redis and task centre (no mocks).
 * - device.down: placeholder `instances` rows (no Android container, adb ports 5591–5592) set to `running`;
 *   the API's real monitor finds no container and marks them `error`. The device "recovered" path of the
 *   monitor needs a real booted device, so recovery semantics are exercised by calling the real recover()
 *   from this script (the same function the monitor calls).
 * - account.problem: the manual "mark checked" route (problem + recovered). The scheduled official-API account
 *   check (号状态监控) and the connection.expired kind were removed on 2026-11-18 (see platforms-check.ts).
 * - publish.failed: a real distribution to a suspended (facebook, text-only) account fails in preflight.
 * - recipients/RBAC/isolation, cooldown, mark read, WebSocket delivery, rules RBAC/validation, audit, retention.
 * External alert channels (Telegram, fan-out, delivery failures) are covered by scripts/alert-channels-check.ts.
 * Creates two temporary users and removes everything afterwards (settings restored).
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/alerts-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, like, or } from 'drizzle-orm';
import WebSocket from 'ws';
import { db, schema, sqlClient } from '../src/db/index.js';
import { events } from '../src/lib/events.js';
import { NOTIFY_CLEANUP_TASK, recover } from '../src/modules/notify/notify.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(400); }
}
function socket(token: string): Promise<{ ws: WebSocket; got: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/events`);
    const got: any[] = [];
    ws.on('message', (m) => { const ev = JSON.parse(m.toString()); if (ev.type === 'ready') resolve({ ws, got }); else got.push(ev); });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('error', reject);
  });
}

const N = schema.notifications;
const notes = (userId: string, refId: string, kind?: string) => db.select().from(N)
  .where(and(eq(N.userId, userId), eq(N.refId, refId), kind ? eq(N.kind, kind) : undefined)).orderBy(N.createdAt);
const finished = (id: string) => waitFor(`task ${id}`, async () => {
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
}, 90_000);

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!));
const uT = admin!.id;
const tag = randomBytes(3).toString('hex');
const h = (s: string) => `al_${tag}_${s}`;
const userIds: string[] = [];
const fakeIds: string[] = [];
const refIds: string[] = [];
const saved = Object.fromEntries(await Promise.all(['alerts.rules'].map(async (k) =>
  [k, (await db.select().from(schema.settings).where(eq(schema.settings.key, k)))[0]?.value ?? null] as const)));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const sockets: WebSocket[] = [];
await events.start();

try {
  // ---------------------------------------------------------------- setup
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `al${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`ala${tag}`, pw);
  const B = await login(`alb${tag}`, pw);
  const fakes = await db.insert(schema.instances).values([1, 2].map((n) => ({
    name: `alfake-${tag}-${n}`, image: 'none', adbPort: 5590 + n, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning();
  fakeIds.push(...fakes.map((f) => f.id));
  refIds.push(...fakeIds);
  const [D1, D2] = fakes as [typeof fakes[0], typeof fakes[0]];
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: [D1.id] });
  await http('PUT', `/api/users/${uB}/grants`, T, { instanceIds: [D2.id] });
  const [wsA, wsB, wsT] = await Promise.all([socket(A), socket(B), socket(T)]);
  sockets.push(wsA.ws, wsB.ws, wsT.ws);

  // ---------------------------------------------------------------- settings: RBAC, validation, write-only
  let r = await http('GET', '/api/settings/alerts', A);
  check('user: GET alert rules → 403', r.status === 403);
  r = await http('PUT', '/api/settings/alerts', A, { cooldownMinutes: 1 });
  check('user: PUT alert rules → 403', r.status === 403);
  r = await http('PUT', '/api/settings/alerts', T, { cooldownMinutes: -1 });
  check('admin: negative cooldown → 400', r.status === 400);
  r = await http('PUT', '/api/settings/alerts', T, { kinds: { 'nope.kind': { inApp: true } } });
  check('admin: unknown kind → 400', r.status === 400);
  r = await http('PUT', '/api/settings/alerts', T, { accountCheckHours: 24 });
  check('admin: removed rule accountCheckHours → 400', r.status === 400);
  r = await http('PUT', '/api/settings/alerts', T, { kinds: { 'connection.expired': { inApp: true } } });
  check('admin: removed kind connection.expired → 400', r.status === 400);
  const allOn = { 'device.down': { inApp: true }, 'account.problem': { inApp: true }, 'publish.failed': { inApp: true }, 'task.failed': { inApp: true }, 'collector.blocked': { inApp: true }, 'channel.failed': { inApp: true } };
  r = await http('PUT', '/api/settings/alerts', T, { kinds: allOn, cooldownMinutes: 60, notifyAdmins: true, recovered: true, retentionDays: 30 });
  check('admin: save rules', r.status === 200 && r.body.rules.cooldownMinutes === 60 && r.body.rules.kinds['task.failed'].inApp === true, r.text);
  r = await http('GET', '/api/settings/alerts', T);
  check('admin: GET rules lists 6 kinds with severity/recoverable (no connection.expired, no accountCheckHours)', r.status === 200 && r.body.kinds.length === 6
    && r.body.kinds.some((k: any) => k.kind === 'device.down' && k.recoverable) && !r.body.kinds.some((k: any) => k.kind === 'connection.expired') && !('accountCheckHours' in r.body.rules), r.text.slice(0, 300));

  // ---------------------------------------------------------------- device.down through the real monitor
  await db.update(schema.instances).set({ status: 'running' }).where(eq(schema.instances.id, D1.id));
  const nA = await waitFor('device.down for A', async () => (await notes(uA, D1.id, 'device.down')).at(0), 30_000);
  check('monitor: device without container → error → alert to the granted user', nA.severity === 'error' && nA.params.status === 'error' && nA.params.reason === 'container_missing' && nA.params.name === D1.name && !nA.recovered, JSON.stringify(nA));
  await sleep(500);
  check('admin receives the device alert too', (await notes(uT, D1.id, 'device.down')).length === 1);
  check('user B (no grant on D1) receives nothing', (await notes(uB, D1.id)).length === 0);
  check('WebSocket: A got notification.created for D1', wsA.got.some((e) => e.type === 'notification.created' && e.notification.refId === D1.id && e.notification.userId === uA));
  check('WebSocket: admin got own copy', wsT.got.some((e) => e.type === 'notification.created' && e.notification.refId === D1.id && e.notification.userId === uT));
  check('WebSocket: B got no notification event of D1', !wsB.got.some((e) => e.type === 'notification.created' && e.notification.refId === D1.id));
  // cooldown: the same problem again within the cooldown is not delivered again
  await db.update(schema.instances).set({ status: 'running' }).where(eq(schema.instances.id, D1.id));
  await waitFor('D1 error again', async () => (await db.select().from(schema.instances).where(eq(schema.instances.id, D1.id)))[0]?.status === 'error', 30_000);
  await sleep(1500);
  check('cooldown: second failure within the cooldown → no new alert', (await notes(uA, D1.id, 'device.down')).length === 1);
  // recovery (real recover(); the monitor calls the same on error → running) → recovered notice, then a new failure alerts at once
  const recovered = await recover({ kind: 'device.down', refId: D1.id, params: { name: D1.name, status: 'running' } });
  const nRec = await waitFor('recovered notice', async () => (await notes(uA, D1.id, 'device.down')).find((x) => x.recovered), 10_000);
  check('recover(): "recovered" notice (info) to A', recovered && nRec.severity === 'info');
  check('recover() twice → nothing more (state already cleared)', !(await recover({ kind: 'device.down', refId: D1.id, params: { name: D1.name } })));
  await db.update(schema.instances).set({ status: 'running' }).where(eq(schema.instances.id, D1.id));
  await waitFor('alert after recovery', async () => (await notes(uA, D1.id, 'device.down')).filter((x) => !x.recovered).length === 2, 30_000);
  check('after recovery the next failure alerts immediately (cooldown reset)', true);

  // kind off + notifyAdmins off
  await http('PUT', '/api/settings/alerts', T, { kinds: { 'device.down': { inApp: false } } });
  await db.update(schema.instances).set({ status: 'running' }).where(eq(schema.instances.id, D2.id));
  await waitFor('D2 error', async () => (await db.select().from(schema.instances).where(eq(schema.instances.id, D2.id)))[0]?.status === 'error', 30_000);
  await sleep(1500);
  check('kind switched off → no alert', (await notes(uB, D2.id)).length === 0 && (await notes(uT, D2.id)).length === 0);
  await http('PUT', '/api/settings/alerts', T, { kinds: { 'device.down': { inApp: true } }, notifyAdmins: false });
  await db.update(schema.instances).set({ status: 'running' }).where(eq(schema.instances.id, D2.id));
  await waitFor('B alert', async () => (await notes(uB, D2.id, 'device.down')).length === 1, 30_000);
  await sleep(500);
  check('notifyAdmins off → only the granted user (B), not the admin', (await notes(uT, D2.id)).length === 0);
  await http('PUT', '/api/settings/alerts', T, { notifyAdmins: true });

  // ---------------------------------------------------------------- account.problem via the manual check
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: h('ig') });
  const ig: string = r.body.account.id; refIds.push(ig);
  r = await http('POST', `/api/social/accounts/${ig}/checked`, A, { loginStatus: 'logged_out' });
  check('manual check result logged_out → 200', r.status === 200, r.text);
  const nIg = (await notes(uA, ig, 'account.problem'))[0];
  check('account.problem to the owner (reason logged_out, platform/handle params)', !!nIg && nIg.params.reason === 'logged_out' && nIg.params.handle === h('ig') && nIg.refType === 'social_account', JSON.stringify(nIg));
  check('account.problem to admin, not to B', (await notes(uT, ig)).length === 1 && (await notes(uB, ig)).length === 0);
  r = await http('POST', `/api/social/accounts/${ig}/checked`, A, { loginStatus: 'logged_in' });
  const igRec = (await notes(uA, ig, 'account.problem')).find((x) => x.recovered);
  check('manual check logged_in → recovered notice', r.status === 200 && !!igRec);
  r = await http('POST', `/api/social/accounts/${ig}/checked`, A, { accountStatus: 'suspended' });
  check('manual check: account suspended → account.problem (reason suspended)', (await notes(uA, ig, 'account.problem')).some((x) => !x.recovered && x.params.reason === 'suspended'));

  // ---------------------------------------------------------------- publish.failed via a real publish run
  r = await http('POST', '/api/social/accounts', A, { platform: 'facebook', handle: h('fb') });
  const fb: string = r.body.account.id; refIds.push(fb);
  await http('PUT', `/api/social/accounts/${fb}`, A, { accountStatus: 'suspended' });
  r = await http('POST', '/api/contents', A, { title: `al-${tag}`, body: 'alert test' });
  const contentId: string = r.body.content?.id;
  r = await http('POST', `/api/contents/${contentId}/distribute`, A, { targets: [{ accountId: fb }] });
  check('distribute to a suspended account (created)', (r.status === 200 || r.status === 201) && r.body.created?.length === 1, r.text.slice(0, 300));
  const ptId: string = r.body.created?.[0]?.id; refIds.push(ptId);
  const nPub = await waitFor('publish.failed', async () => (await notes(uA, ptId, 'publish.failed'))[0], 60_000);
  check('publish.failed alert to the owner (code publish.account_inactive, title)', nPub.params.code === 'publish.account_inactive' && nPub.params.title === `al-${tag}` && nPub.refType === 'publish', JSON.stringify(nPub));
  await sleep(500);
  check('publish.failed to admin once; B nothing', (await notes(uT, ptId)).length === 1 && (await notes(uB, ptId)).length === 0);

  // ---------------------------------------------------------------- reading: list, isolation, mark read
  r = await http('GET', '/api/notifications', A);
  const mine = r.body.notifications as any[];
  check('A lists only own notifications', r.status === 200 && mine.length > 0 && mine.every((x) => x.userId === uA) && r.body.unread === mine.filter((x) => !x.readAt).length, r.text.slice(0, 200));
  r = await http('GET', '/api/notifications', B);
  check('B lists only own (D2 device alert)', r.status === 200 && r.body.notifications.every((x: any) => x.userId === uB) && r.body.notifications.some((x: any) => x.refId === D2.id));
  const first = mine[0];
  r = await http('POST', `/api/notifications/${first.id}/read`, B);
  check('B cannot mark A\'s notification → 404', r.status === 404 && r.body.code === 'alerts.not_found');
  const unreadBefore = (await http('GET', '/api/notifications', A)).body.unread as number;
  r = await http('POST', `/api/notifications/${first.id}/read`, A);
  check('A marks one read → unread −1', r.status === 200 && !!r.body.notification.readAt && r.body.unread === unreadBefore - 1, r.text);
  r = await http('POST', '/api/notifications/read-all', A);
  check('read-all → unread 0', r.status === 200 && r.body.unread === 0 && (await http('GET', '/api/notifications?unread=1', A)).body.notifications.length === 0);

  // ---------------------------------------------------------------- audit
  await sleep(800);
  const audits = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), or(like(schema.auditLogs.action, 'settings.%'), like(schema.auditLogs.path, '/api/notifications%'))));
  const acts = new Set(audits.map((a) => a.action));
  check('audit: settings.alerts recorded', acts.has('settings.alerts'), [...acts].join(','));
  check('audit: marking notifications read is not recorded', !audits.some((a) => a.path.startsWith('/api/notifications')));

  // ---------------------------------------------------------------- retention (real cleanup task)
  const old = await db.insert(N).values([
    { userId: uA, kind: 'device.down', severity: 'error', params: {}, refType: 'instance', refId: D1.id, readAt: new Date(), createdAt: new Date(Date.now() - 40 * 86400_000) },
    { userId: uA, kind: 'device.down', severity: 'error', params: {}, refType: 'instance', refId: D1.id, createdAt: new Date(Date.now() - 40 * 86400_000) },
    { userId: uA, kind: 'device.down', severity: 'error', params: {}, refType: 'instance', refId: D1.id, createdAt: new Date(Date.now() - 100 * 86400_000) },
    { userId: uA, kind: 'device.down', severity: 'error', params: {}, refType: 'instance', refId: D1.id, readAt: new Date(), createdAt: new Date(Date.now() - 2 * 86400_000) },
  ]).returning();
  const { task: cl } = await createTask({ type: NOTIFY_CLEANUP_TASK, payload: {} });
  const clDone = await finished(cl.id);
  const left = await db.select({ id: N.id }).from(N).where(inArray(N.id, old.map((o) => o.id)));
  const leftIds = new Set(left.map((x) => x.id));
  check('cleanup task: read > 30 d deleted, unread 40 d kept, unread > 90 d deleted, recent read kept',
    clDone.status === 'success' && !leftIds.has(old[0]!.id) && leftIds.has(old[1]!.id) && !leftIds.has(old[2]!.id) && leftIds.has(old[3]!.id), JSON.stringify(clDone.result));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  for (const ws of sockets) ws.close();
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  await db.delete(schema.socialAccounts).where(like(schema.socialAccounts.handle, `al_${tag}_%`));
  if (refIds.length) {
    await db.delete(N).where(inArray(N.refId, refIds.filter(Boolean)));
    await db.delete(schema.alertStates).where(inArray(schema.alertStates.key, refIds.filter(Boolean)));
  }
  await db.delete(N).where(and(eq(N.userId, uT), gte(N.createdAt, t0), eq(N.kind, 'task.failed')));
  for (const [k, v] of Object.entries(saved)) {
    if (v === null) await db.delete(schema.settings).where(eq(schema.settings.key, k));
    else await db.insert(schema.settings).values({ key: k, value: v }).onConflictDoUpdate({ target: schema.settings.key, set: { value: v } });
  }
  const leftUsers = userIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const leftNotes = userIds.length ? await db.select().from(N).where(inArray(N.userId, userIds)) : [];
  check('cleanup: test users (and their notifications), devices, accounts removed; settings restored', leftUsers.length === 0 && leftNotes.length === 0);
  await events.close();
  await closeTaskQueues();
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
