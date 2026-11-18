/**
 * 通知中心 (own notifications inbox) against the real API, DB and Redis (no mocks).
 * - Volume rows are written straight into `notifications` (fixed kinds / times / read states, so every expected
 *   count is computed from the seeded list); one alert per user goes through the real `notify()` (the function
 *   triggers.ts calls) on a placeholder `instances` row (no container, status stopped, adb port 5589) granted to
 *   that user, so de-duplication in `alert_states` is the real one.
 * - Checks: list filters (read/unread/read, legacy unread=1, kind csv, from inclusive / to exclusive), paging
 *   (offset/limit pages = the full list), total/unread numbers, own rows only; POST /api/notifications/delete
 *   (own ids, duplicates, another user's id or a missing id → whole batch 404 with nothing deleted, empty / > 500 /
 *   non-uuid → 400, admin can't delete a user's rows either), POST /api/notifications/delete-read, unread count
 *   after mark read / delete, WebSocket notification.created, deleting the alert's notification keeps the
 *   cooldown (no second delivery) and recover → notify delivers again, nothing of it in the audit log.
 * Creates two temporary users and removes everything afterwards.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/notifications-check.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import WebSocket from 'ws';
import { db, schema, sqlClient } from '../src/db/index.js';
import { events } from '../src/lib/events.js';
import { notify, recover } from '../src/modules/notify/notify.js';
import { closeTaskQueues } from '../src/modules/tasks/core.js';
import { withCaptcha } from './lib/login.js';

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
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
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
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const userIds: string[] = [];
const fakeIds: string[] = [];
const sockets: WebSocket[] = [];
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
await events.start();

const list = (token: string, q = '') => http<{ notifications: any[]; total: number; unread: number }>('GET', `/api/notifications${q ? `?${q}` : ''}`, token);
const countRows = async (userId: string) => (await db.select({ id: N.id }).from(N).where(eq(N.userId, userId))).length;

try {
  // ---------------------------------------------------------------- setup
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `nc${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`nca${tag}`, pw);
  const B = await login(`ncb${tag}`, pw);
  const [dev] = await db.insert(schema.instances).values({ name: `ncfake-${tag}`, image: 'none', adbPort: 5589, status: 'stopped', spec: { width: 720, height: 1280, dpi: 320 } }).returning();
  fakeIds.push(dev!.id);
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: [dev!.id] });

  // Seed: A gets 30 rows over 7.5 days (kinds cycle, every 4th read), B gets 5 (2 read).
  const KINDS = ['device.down', 'publish.failed', 'task.failed'] as const;
  const now = Date.now();
  const seedA = Array.from({ length: 30 }, (_, i) => ({
    userId: uA, kind: KINDS[i % 3]!, severity: 'error' as const, params: { name: `n${i}` }, refType: 'instance', refId: randomUUID(),
    createdAt: new Date(now - (30 - i) * 6 * 3600_000 - 60_000), readAt: i % 4 === 0 ? new Date() : null,
  }));
  const seedB = Array.from({ length: 5 }, (_, i) => ({
    userId: uB, kind: 'device.down', severity: 'error' as const, params: { name: `b${i}` }, refType: 'instance', refId: randomUUID(),
    createdAt: new Date(now - (i + 1) * 3600_000), readAt: i < 2 ? new Date() : null,
  }));
  const rowsA = await db.insert(N).values(seedA).returning();
  const rowsB = await db.insert(N).values(seedB).returning();
  const idsB = rowsB.map((r) => r.id);

  // One real alert through notify(): A (granted) gets it live.
  const wsA = await socket(A);
  sockets.push(wsA.ws);
  const alert = { kind: 'device.down' as const, refId: dev!.id, params: { name: dev!.name, status: 'error', reason: 'container_missing' } };
  const delivered = await notify(alert);
  await sleep(800);
  const [real] = await db.select().from(N).where(and(eq(N.userId, uA), eq(N.refId, dev!.id)));
  check('real notify(): delivered to the granted user', delivered && !!real, JSON.stringify(real));
  check('WebSocket: A got notification.created of it', wsA.got.some((e) => e.type === 'notification.created' && e.notification.id === real?.id));

  // ---------------------------------------------------------------- list: totals, filters, paging
  const allA = [...rowsA, real!];
  const expUnread = allA.filter((r) => !r.readAt).length; // 30 - 8 + 1 = 23
  let r = await list(A, 'limit=200');
  const byTime = [...allA].sort((x, y) => +y.createdAt - +x.createdAt || (y.id > x.id ? 1 : -1));
  check(`A: total ${allA.length}, unread ${expUnread}`, r.status === 200 && r.body.total === allA.length && r.body.unread === expUnread && r.body.notifications.length === allA.length, `${r.body?.total}/${r.body?.unread}`);
  check('A: newest first', r.body.notifications.map((n: any) => n.id).join() === byTime.map((n) => n.id).join());
  check('A: only own rows (none of B\'s)', r.body.notifications.every((n: any) => n.userId === uA));
  r = await list(A, 'read=unread&limit=200');
  check(`read=unread → ${expUnread}`, r.body.total === expUnread && r.body.notifications.length === expUnread && r.body.notifications.every((n: any) => !n.readAt));
  r = await list(A, 'read=read&limit=200');
  check('read=read → 8', r.body.total === 8 && r.body.notifications.every((n: any) => n.readAt), String(r.body.total));
  r = await list(A, 'unread=1&limit=200');
  check('legacy unread=1 still works', r.body.notifications.length === expUnread);
  r = await list(A, 'kind=publish.failed');
  check('kind=publish.failed → 10', r.body.total === 10 && r.body.notifications.every((n: any) => n.kind === 'publish.failed'), String(r.body.total));
  r = await list(A, 'kind=publish.failed,task.failed&read=unread');
  const expPT = allA.filter((n) => n.kind !== 'device.down' && !n.readAt).length;
  check(`kind csv + unread → ${expPT}`, r.body.total === expPT, String(r.body.total));
  r = await list(A, 'kind=device.down');
  check('kind=device.down → 11 (10 seeded + real)', r.body.total === 11, String(r.body.total));
  const from = seedA[10]!.createdAt;
  const to = seedA[20]!.createdAt;
  r = await list(A, `from=${from.toISOString()}&to=${to.toISOString()}&limit=200`);
  check('from inclusive / to exclusive → 10', r.body.total === 10 && r.body.notifications.some((n: any) => n.id === rowsA[10]!.id) && !r.body.notifications.some((n: any) => n.id === rowsA[20]!.id), String(r.body.total));
  r = await list(A, `from=${from.toISOString()}&read=read`);
  const expFromRead = allA.filter((n) => n.createdAt >= from && n.readAt).length;
  check(`from + read=read → ${expFromRead}`, r.body.total === expFromRead, String(r.body.total));
  const paged: string[] = [];
  let pagesOk = true;
  for (let off = 0; off < allA.length; off += 7) {
    const p = await list(A, `limit=7&offset=${off}`);
    pagesOk &&= p.body.total === allA.length && p.body.notifications.length === Math.min(7, allA.length - off);
    paged.push(...p.body.notifications.map((n: any) => n.id));
  }
  check('paging limit=7: 5 pages, last has 3, together = full list in order', pagesOk && paged.join() === byTime.map((n) => n.id).join());
  r = await list(A, 'offset=100');
  check('offset past the end → empty page, total kept', r.body.notifications.length === 0 && r.body.total === allA.length);
  for (const q of ['kind=nope.kind', 'read=maybe', 'limit=0', 'limit=201', 'offset=-1', 'from=notadate']) {
    r = await list(A, q);
    check(`list ${q} → 400`, r.status === 400, String(r.status));
  }
  r = await list(B, 'limit=200');
  check('B: total 5, unread 3, none of A\'s', r.body.total === 5 && r.body.unread === 3 && r.body.notifications.every((n: any) => n.userId === uB));
  r = await http('GET', '/api/notifications', null);
  check('no token → 401', r.status === 401);

  // ---------------------------------------------------------------- delete
  r = await http('POST', '/api/notifications/delete', null, { ids: [rowsA[1]!.id] });
  check('delete without token → 401', r.status === 401);
  const before = await countRows(uA);
  // rowsA[1..3] are unread (1, 2, 3 % 4 != 0) → unread drops by 3
  r = await http('POST', '/api/notifications/delete', A, { ids: [rowsA[1]!.id, rowsA[2]!.id, rowsA[3]!.id] });
  check('A deletes 3 own unread → deleted 3, unread −3', r.status === 200 && r.body.deleted === 3 && r.body.unread === expUnread - 3, r.text);
  check('DB: A has 3 rows fewer', (await countRows(uA)) === before - 3);
  r = await http('POST', '/api/notifications/delete', A, { ids: [rowsA[4]!.id, rowsA[4]!.id] });
  check('duplicate ids count once → deleted 1 (a read one, unread unchanged)', r.status === 200 && r.body.deleted === 1 && r.body.unread === expUnread - 3, r.text);
  const aCount = await countRows(uA);
  const bCount = await countRows(uB);
  r = await http('POST', '/api/notifications/delete', A, { ids: [rowsA[5]!.id, rowsA[6]!.id, idsB[0]] });
  check('own ids + one of B\'s → 404 alerts.not_found', r.status === 404 && r.body?.code === 'alerts.not_found', r.text);
  check('… and nothing deleted (A and B unchanged)', (await countRows(uA)) === aCount && (await countRows(uB)) === bCount);
  r = await http('POST', '/api/notifications/delete', A, { ids: [rowsA[5]!.id, randomUUID()] });
  check('own id + unknown id → 404, nothing deleted', r.status === 404 && (await countRows(uA)) === aCount);
  r = await http('POST', '/api/notifications/delete', A, { ids: [rowsA[1]!.id] });
  check('already deleted id → 404', r.status === 404);
  r = await http('POST', '/api/notifications/delete', B, { ids: [rowsA[5]!.id] });
  check('B deleting A\'s notification → 404, row kept', r.status === 404 && (await countRows(uA)) === aCount);
  r = await http('POST', '/api/notifications/delete', T, { ids: [rowsA[5]!.id] });
  check('admin deleting A\'s notification → 404 (own inbox only)', r.status === 404 && (await countRows(uA)) === aCount);
  r = await http('POST', '/api/notifications/delete', A, { ids: [] });
  check('empty ids → 400', r.status === 400);
  r = await http('POST', '/api/notifications/delete', A, { ids: Array.from({ length: 501 }, () => randomUUID()) });
  check('501 ids → 400', r.status === 400);
  r = await http('POST', '/api/notifications/delete', A, { ids: ['not-a-uuid'] });
  check('non-uuid id → 400', r.status === 400);
  r = await http('POST', '/api/notifications/delete', A, {});
  check('missing ids → 400', r.status === 400);
  r = await http('POST', '/api/notifications/delete', A, { ids: Array.from({ length: 500 }, (_, i) => (i === 0 ? rowsA[5]!.id : randomUUID())) });
  check('500 ids (max) accepted by validation (404 here: unknown ids), nothing deleted', r.status === 404 && (await countRows(uA)) === aCount);

  // mark read changes the unread count; then delete-read removes exactly the read ones
  r = await http('POST', `/api/notifications/${rowsA[5]!.id}/read`, A);
  const unreadNow = expUnread - 4;
  check(`mark read → unread ${unreadNow}`, r.status === 200 && r.body.unread === unreadNow, r.text);
  const readBefore = (await list(A, 'read=read')).body.total;
  const bReadBefore = (await list(B, 'read=read')).body.total;
  r = await http('POST', '/api/notifications/delete-read', A);
  check(`delete-read → deleted ${readBefore} (8 seeded − 1 deleted + 1 marked), unread unchanged`, r.status === 200 && r.body.deleted === readBefore && readBefore === 8 && r.body.unread === unreadNow, r.text);
  r = await list(A, 'limit=200');
  check(`A afterwards: total ${unreadNow}, all unread`, r.body.total === unreadNow && r.body.unread === unreadNow && r.body.notifications.every((n: any) => !n.readAt));
  check('B\'s read notifications untouched', (await list(B, 'read=read')).body.total === bReadBefore && bReadBefore === 2);
  r = await http('POST', '/api/notifications/delete-read', A);
  check('delete-read again → 0', r.status === 200 && r.body.deleted === 0);

  // ---------------------------------------------------------------- de-duplication is not affected
  const [stateBefore] = await db.select().from(schema.alertStates).where(and(eq(schema.alertStates.kind, 'device.down'), eq(schema.alertStates.key, dev!.id)));
  r = await http('POST', '/api/notifications/delete', A, { ids: [real!.id] });
  check('A deletes the real alert\'s notification', r.status === 200 && r.body.deleted === 1);
  const again = await notify(alert);
  const [stateAfter] = await db.select().from(schema.alertStates).where(and(eq(schema.alertStates.kind, 'device.down'), eq(schema.alertStates.key, dev!.id)));
  const aRealRows = await db.select().from(N).where(and(eq(N.userId, uA), eq(N.refId, dev!.id)));
  check('same alert within the cooldown after deleting → not delivered again (state kept)',
    !again && aRealRows.length === 0 && !!stateAfter?.active && +stateAfter.lastAlertAt! === +stateBefore!.lastAlertAt!);
  const rec = await recover(alert);
  const afterRecover = await notify(alert);
  const aRows2 = await db.select().from(N).where(and(eq(N.userId, uA), eq(N.refId, dev!.id)));
  check('recover → recovered notice; next problem delivered again (normal de-dup)', rec && afterRecover && aRows2.length === 2 && aRows2.some((n) => n.recovered) && aRows2.some((n) => !n.recovered), JSON.stringify(aRows2.map((n) => n.recovered)));

  // ---------------------------------------------------------------- audit
  await sleep(1000);
  const audits = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), like(schema.auditLogs.path, '/api/notifications%')));
  check('audit: no entries for notification list/read/delete/delete-read', audits.length === 0, audits.map((a) => a.path).join(','));
  const userAudit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), eq(schema.auditLogs.action, 'user.create')));
  check('audit: (control) the user creation of this run is recorded', userAudit.length >= 2, String(userAudit.length));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  for (const ws of sockets) ws.close();
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (fakeIds.length) {
    await db.delete(N).where(inArray(N.refId, fakeIds));
    await db.delete(schema.alertStates).where(inArray(schema.alertStates.key, fakeIds));
    await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  }
  const leftUsers = userIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const leftNotes = userIds.length ? await db.select().from(N).where(inArray(N.userId, userIds)) : [];
  check('cleanup: test users, their notifications, the placeholder device and its alert state removed', leftUsers.length === 0 && leftNotes.length === 0);
  await events.close();
  await closeTaskQueues();
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
