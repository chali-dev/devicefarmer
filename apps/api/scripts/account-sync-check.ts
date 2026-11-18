/**
 * 从云手机同步 + 自动发现, without a phone (real API, DB, BullMQ, task centre; no mocks):
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/account-sync-check.ts
 *
 * Placeholder device rows (adb ports 5583–5584 and 5590–5591, status stopped, no containers) carry the grants. What
 * runs for real: the API routes (RBAC, codes, 202 + task, audit), the task `account-device-sync` end to end up to the
 * device (a stopped placeholder → result `offline`; the 自动发现 switch off → skipped), task visibility (device-less:
 * creator + admins only), and the DB part `applySync` / `discoverOnDevice` imported from src (same DB as the API),
 * driven with placeholder Instagram ids and handles: created / updated (display name, externalId, link, rename) /
 * taken (no owner leaked) / limit_reached / platform_disabled / several ids on one phone; 自动发现's rule (exactly one
 * assigned user → sync task for that user, idempotent per day; several / none → account.discovered notice to admins
 * + the phone's users, once a day; recorded ids → nothing). NOT covered here: reading `dumpsys account` and the own
 * profile on a phone (scripts/account-sync-device-check.ts on bit-ins-02).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { applySync, discoverOnDevice, discoveryAction } from '../src/modules/social/sync.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
if (/:3000\b/.test(API)) throw new Error('refusing to run against the main API (port 3000): set E2E_API and API_PORT to the test API');
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = schema.tasks;
const SA = schema.socialAccounts;
/** Follows a task (and its pace deferrals) to its final row. */
async function waitTask(id: string, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const [row] = await db.select().from(T).where(eq(T.id, id));
    if (row && ['success', 'failed', 'cancelled'].includes(row.status)) {
      const next = (row.result as any)?.outcome === 'deferred' ? (row.result as any).taskId : null;
      if (!next) return row;
      id = next;
    }
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for task ${id}`);
    await sleep(500);
  }
}

const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const [adminRow] = await db.select().from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!));
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const userIds: string[] = [];
const devIds: string[] = [];
const taskIds = new Set<string>();
const settingKeys = ['risk.device', 'social.limits', 'risk.halts'];
const saved = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const fakeId = () => `9${randomBytes(5).readUIntBE(0, 5)}`;

try {
  // ---------------------------------------------------------------- setup
  for (const n of ['a', 'b', 'c']) {
    const r = await http('POST', '/api/users', admin, { username: `sy${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB, uC] = userIds as [string, string, string];
  const A = await login(`sya${tag}`, pw);
  const B = await login(`syb${tag}`, pw);
  const devs = await db.insert(schema.instances).values([5583, 5584, 5590, 5591].map((port, n) => ({
    name: `syfake-${tag}-${n + 1}`, image: 'none', adbPort: port, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 },
    allowedPlatforms: n === 3 ? ['tiktok'] : null,
  }))).returning();
  devIds.push(...devs.map((d) => d.id));
  const [D1, D2, D3, D4] = devs as [typeof devs[0], typeof devs[0], typeof devs[0], typeof devs[0]];
  // D1: A only; D2: A + B; D3: nobody; D4: A, Instagram not allowed
  await http('PUT', `/api/users/${uA}/grants`, admin, { instanceIds: [D1.id, D2.id, D4.id] });
  await http('PUT', `/api/users/${uB}/grants`, admin, { instanceIds: [D2.id] });
  await http('PUT', '/api/social/settings', admin, { limits: { instagram: 1 } });

  // ---------------------------------------------------------------- API: RBAC + codes before queueing
  const sync = (tok: string, body: Record<string, unknown>) => http('POST', '/api/social/sync-from-device', tok, body);
  let r = await sync(B, { instanceId: D1.id });
  check('not assigned → 403 auth.no_instance_access', r.status === 403 && r.body.code === 'auth.no_instance_access', r.text);
  r = await sync(A, { instanceId: D3.id });
  check('not assigned (nobody) → 403', r.status === 403, r.text);
  r = await sync(A, { instanceId: '00000000-0000-4000-8000-000000000001' });
  check('unknown device → 404 instances.not_found', r.status === 404 && r.body.code === 'instances.not_found', r.text);
  r = await sync(A, { instanceId: D1.id, ownerId: uB });
  check('user picks another owner → 403 social.admin_only', r.status === 403 && r.body.code === 'social.admin_only', r.text);
  r = await sync(A, { instanceId: D1.id, ownerId: uA });
  const ownTask = r.body?.task?.id;
  check('user, owner = self explicitly → 202', r.status === 202 && !!ownTask, r.text);
  r = await sync(admin, { instanceId: D1.id, ownerId: '00000000-0000-4000-8000-000000000002' });
  check('admin, unknown owner → 400 users.not_found', r.status === 400 && r.body.code === 'users.not_found', r.text);
  r = await sync(A, { instanceId: D4.id });
  check('Instagram not allowed on the device → 409 social.platform_disabled', r.status === 409 && r.body.code === 'social.platform_disabled', r.text);
  r = await http('POST', '/api/social/sync-from-device', null, { instanceId: D1.id });
  check('unauthenticated → 401', r.status === 401, r.text);

  // the task: device-less, the creator sees it, a co-assigned user does not; stopped device → offline
  if (ownTask) { taskIds.add(ownTask); await waitTask(ownTask); }
  r = await sync(A, { instanceId: D2.id });
  const d2Task = r.body?.task?.id as string;
  taskIds.add(d2Task);
  const fin = await waitTask(d2Task);
  check('task account-device-sync on its own queue, no instance (creator + admins only)', fin.type === 'account-device-sync' && fin.instanceId === null && fin.refType === 'instance' && fin.refId === D2.id && fin.createdBy === uA);
  check('stopped device → success, result offline', fin.status === 'success' && (fin.result as any)?.outcome === 'synced' && (fin.result as any)?.result === 'offline', JSON.stringify(fin.result));
  check('creator reads the task + result', (await http('GET', `/api/tasks/${d2Task}`, A)).body?.task?.result?.result === 'offline');
  check('co-assigned user B → 404 on the task', (await http('GET', `/api/tasks/${d2Task}`, B)).status === 404);
  check('admin reads the task', (await http('GET', `/api/tasks/${d2Task}`, admin)).status === 200);
  const logs = await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, d2Task));
  check('task log has the result line', logs.some((l) => l.message === 'account sync result: offline'));

  r = await sync(admin, { instanceId: D3.id, ownerId: uC });
  taskIds.add(r.body?.task?.id);
  check('admin, any device + chosen owner → 202', r.status === 202, r.text);
  const admTask = await waitTask(r.body.task.id);
  check('admin task carries the chosen owner', (admTask.payload as any).ownerId === uC && (admTask.result as any)?.result === 'offline');

  // in progress / halted
  const [held] = await db.insert(T).values({ type: 'account-device-sync', refType: 'instance', refId: D1.id, status: 'scheduled', runAt: new Date(Date.now() + 3600_000), payload: {}, createdBy: uA }).returning();
  taskIds.add(held!.id);
  r = await sync(A, { instanceId: D1.id });
  check('a queued sync on the device → 409 account_sync.in_progress', r.status === 409 && r.body.code === 'account_sync.in_progress', r.text);
  await db.delete(T).where(eq(T.id, held!.id));
  await db.insert(schema.settings).values({ key: 'risk.halts', value: { [D1.id]: { at: new Date().toISOString(), code: 'x', source: 'account_check', platform: 'instagram' } } })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: { [D1.id]: { at: new Date().toISOString(), code: 'x', source: 'account_check', platform: 'instagram' } } } });
  r = await sync(A, { instanceId: D1.id });
  check('halted device → 409 account_sync.device_halted', r.status === 409 && r.body.code === 'account_sync.device_halted', r.text);
  await db.delete(schema.settings).where(eq(schema.settings.key, 'risk.halts'));

  // audit
  await sleep(500);
  const aud = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'social.sync_from_device'), sql`${schema.auditLogs.at} > now() - interval '10 minutes'`));
  check('audit social.sync_from_device (ok + refused, instanceId/ownerId only)', aud.some((a) => a.ok && (a.detail as any)?.instanceId === D2.id) && aud.some((a) => !a.ok && a.status === 403)
    && aud.some((a) => (a.detail as any)?.ownerId === uC), `${aud.length} rows`);

  // ---------------------------------------------------------------- applySync (DB part, placeholder ids/handles)
  const userA = { id: uA, username: `sya${tag}`, role: 'user' as const };
  const h = `syncchk_${tag}`;
  const id1 = fakeId();
  const counts = { followers: 12_000, following: 6, posts: 0, approx: ['followers'] };
  let o = await applySync({ inst: D1, ownerId: uA, actor: userA, handle: h, displayName: 'Sync One', deviceIds: [id1], counts });
  const [acc] = await db.select().from(SA).where(eq(SA.handle, h));
  check('created: new account (owner, device, externalId, profile URL, logged in)', o.result === 'created' && o.accountId === acc?.id && acc?.userId === uA && acc.instanceId === D1.id
    && acc.externalId === id1 && acc.profileUrl === `https://www.instagram.com/${h}/` && acc.displayName === 'Sync One' && acc.loginStatus === 'logged_in' && acc.createdBy === uA, JSON.stringify(o));
  const st = await db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, acc!.id));
  check('created: today\'s stats row, source device, approx', st.length === 1 && st[0]!.source === 'device' && st[0]!.followers === 12_000 && st[0]!.following === 6 && st[0]!.posts === 0 && st[0]!.approx?.join() === 'followers');
  let alog = await db.select().from(schema.socialAccountLogs).where(eq(schema.socialAccountLogs.accountId, acc!.id));
  check('created: logs create + link, "synced from device", actor', alog.some((l) => l.action === 'create' && l.message === 'synced from device' && l.actorId === uA) && alog.some((l) => l.action === 'link' && l.toValue === D1.name));
  const viaApi = await http('GET', '/api/social/accounts', A);
  check('the user lists the synced account', viaApi.body.items?.some((x: any) => x.id === acc!.id));

  o = await applySync({ inst: D1, ownerId: uA, actor: userA, handle: h.toUpperCase(), displayName: 'Sync Two', deviceIds: [id1], counts: { ...counts, followers: 12_100, approx: [] } });
  const same = await db.select().from(SA).where(sql`lower(${SA.handle}) = ${h}`);
  check('updated: same handle (any case) → no second row, display name updated', o.result === 'updated' && o.accountId === acc!.id && same.length === 1 && same[0]!.displayName === 'Sync Two' && o.changed?.join() === 'displayName', JSON.stringify(o));
  const st2 = await db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, acc!.id));
  check('updated: today\'s stats row replaced', st2.length === 1 && st2[0]!.followers === 12_100 && st2[0]!.approx === null);
  o = await applySync({ inst: D1, ownerId: uA, actor: userA, handle: h, displayName: 'Sync Two', deviceIds: [id1] });
  check('updated without changes: nothing logged', o.result === 'updated' && o.changed?.length === 0);

  o = await applySync({ inst: D2, ownerId: uB, actor: null, handle: h, displayName: 'Other', deviceIds: [id1] });
  const after = await db.select().from(SA).where(eq(SA.id, acc!.id));
  check('taken: handle owned by another user → taken, no owner / id leaked, row unchanged', o.result === 'taken' && Object.keys(o).join() === 'result' && after[0]!.userId === uA && after[0]!.displayName === 'Sync Two');

  o = await applySync({ inst: D1, ownerId: uA, actor: userA, handle: `syncchk2_${tag}`, displayName: null, deviceIds: [fakeId()] });
  check('limit_reached: device already has its 1 Instagram account → nothing created', o.result === 'limit_reached' && (await db.select().from(SA).where(eq(SA.handle, `syncchk2_${tag}`))).length === 0);
  o = await applySync({ inst: D4, ownerId: uA, actor: userA, handle: `syncchk3_${tag}`, displayName: null, deviceIds: [fakeId()] });
  check('platform_disabled: device does not allow Instagram', o.result === 'platform_disabled');

  // rename on Instagram: the phone's only id belongs to an account with another handle
  o = await applySync({ inst: D1, ownerId: uA, actor: userA, handle: `${h}_new`, displayName: 'Sync Two', deviceIds: [id1] });
  const [ren] = await db.select().from(SA).where(eq(SA.id, acc!.id));
  check('rename: same externalId, new handle → updated handle + profile URL (logged)', o.result === 'updated' && ren!.handle === `${h}_new` && ren!.profileUrl === `https://www.instagram.com/${h}_new/` && o.changed?.includes('handle'));

  // an own account recorded by hand without device/externalId gets linked and its id filled
  const manual = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `syncman_${tag}` });
  const id2 = fakeId();
  o = await applySync({ inst: D2, ownerId: uA, actor: userA, handle: `syncman_${tag}`, displayName: 'Manual', deviceIds: [id2] });
  const [man] = await db.select().from(SA).where(eq(SA.id, manual.body.account.id));
  alog = await db.select().from(schema.socialAccountLogs).where(eq(schema.socialAccountLogs.accountId, man!.id));
  check('updated: unlinked own account → linked to the phone, externalId filled, logs', o.result === 'updated' && man!.instanceId === D2.id && man!.externalId === id2
    && ['externalId', 'displayName', 'device'].every((f) => o.changed?.includes(f)) && alog.filter((l) => l.message === 'synced from device').length === 3, JSON.stringify(o));
  o = await applySync({ inst: D1, ownerId: uA, actor: userA, handle: `syncman_${tag}`, displayName: 'Manual', deviceIds: [id2] });
  check('linked to another phone → updated, link kept, linkedElsewhere', o.result === 'updated' && o.linkedElsewhere === true
    && (await db.select().from(SA).where(eq(SA.id, man!.id)))[0]!.instanceId === D2.id);

  // several Instagram accounts on one phone: the only unrecorded id is the profile's
  await http('PUT', '/api/social/settings', admin, { limits: { instagram: 3 } });
  const id3 = fakeId();
  o = await applySync({ inst: D3, ownerId: uC, actor: null, handle: `syncmulti_${tag}`, displayName: null, deviceIds: [id1, id3] });
  const [multi] = await db.select().from(SA).where(eq(SA.handle, `syncmulti_${tag}`));
  check('several ids on the phone: externalId = the only unrecorded one; system actor', o.result === 'created' && multi?.externalId === id3 && multi.createdBy === null);
  const id4 = fakeId(); const id5 = fakeId();
  o = await applySync({ inst: D3, ownerId: uC, actor: null, handle: `syncmulti2_${tag}`, displayName: null, deviceIds: [id4, id5] });
  const [multi2] = await db.select().from(SA).where(eq(SA.handle, `syncmulti2_${tag}`));
  check('two unrecorded ids: externalId left empty (account check fills it later)', o.result === 'created' && multi2?.externalId === null);

  // concurrency: two syncs of one new handle at once → one row
  const hc = `syncrace_${tag}`;
  const both = await Promise.all([1, 2].map(() => applySync({ inst: D3, ownerId: uC, actor: null, handle: hc, displayName: null, deviceIds: [] })));
  check('two concurrent syncs of one handle → one created, one updated', both.map((x) => x.result).sort().join() === 'created,updated' && (await db.select().from(SA).where(eq(SA.handle, hc))).length === 1);

  // ---------------------------------------------------------------- 自动发现
  check('rule: nothing unrecorded → nothing', discoveryAction([], [uA]) === null);
  check('rule: exactly one assigned user → sync for that user', JSON.stringify(discoveryAction(['1'], [uA])) === JSON.stringify({ kind: 'sync', ownerId: uA }));
  check('rule: several users → notice', JSON.stringify(discoveryAction(['1'], [uA, uB])) === JSON.stringify({ kind: 'notify', reason: 'multiple_users' }));
  check('rule: nobody → notice', JSON.stringify(discoveryAction(['1'], [])) === JSON.stringify({ kind: 'notify', reason: 'no_user' }));

  const free = fakeId();
  let d = await discoverOnDevice(D1, [id1, free]);
  check('one assigned user (D1: A): unrecorded id → auto sync task for A', d.action?.kind === 'sync' && (d.action as any).ownerId === uA && d.created === true && d.unknown.join() === free);
  taskIds.add(d.taskId!);
  const autoRow = (await db.select().from(T).where(eq(T.id, d.taskId!)))[0]!;
  check('auto task: system (no creator), payload auto, key per phone + ids + day', autoRow.createdBy === null && (autoRow.payload as any).auto === true && /^discover:[0-9a-f-]+:[0-9a-f]{16}:\d{4}-\d\d-\d\d$/.test(autoRow.idempotencyKey ?? ''));
  const again = await discoverOnDevice(D1, [id1, free]);
  check('same ids again the same day → no second task', again.created === false && again.taskId === d.taskId);
  const autoFin = await waitTask(d.taskId!);
  check('auto task on a stopped phone → offline (nothing opened)', (autoFin.result as any)?.result === 'offline');
  check('user A does not see the system task', (await http('GET', `/api/tasks/${d.taskId}`, A)).status === 404);

  d = await discoverOnDevice(D1, [id1]);
  check('every id recorded → nothing', d.action === null && !d.taskId);

  const n0 = await db.select().from(schema.notifications).where(eq(schema.notifications.kind, 'account.discovered'));
  d = await discoverOnDevice(D2, [fakeId()]);
  const n1 = await db.select().from(schema.notifications).where(and(eq(schema.notifications.kind, 'account.discovered'), eq(schema.notifications.refId, D2.id)));
  check('several assigned users (D2: A + B) → notice, no task', d.action?.kind === 'notify' && d.notified === true && !d.taskId);
  check('notice goes to A, B and the admin (info, params)', [uA, uB, adminRow!.id].every((u) => n1.some((n) => n.userId === u)) && !n1.some((n) => n.userId === uC)
    && n1[0]!.severity === 'info' && (n1[0]!.params as any).reason === 'multiple_users' && (n1[0]!.params as any).count === 1 && (n1[0]!.params as any).name === D2.name);
  check('the notice adds rows (none before for this phone)', n1.length > 0 && !n0.some((n) => n.refId === D2.id));
  const ids2 = [fakeId()];
  await discoverOnDevice(D3, ids2);
  const again2 = await discoverOnDevice(D3, ids2);
  const n3 = await db.select().from(schema.notifications).where(and(eq(schema.notifications.kind, 'account.discovered'), eq(schema.notifications.refId, D3.id)));
  check('nobody assigned (D3) → notice to admins only, once a day for the same ids', n3.length === 1 && n3[0]!.userId === adminRow!.id && (n3[0]!.params as any).reason === 'no_user' && again2.notified === false);
  const bell = await http('GET', '/api/notifications', B);
  check('user B sees the D2 notice in the bell', JSON.stringify(bell.body).includes('account.discovered'));

  // switch (风控 accountDiscovery)
  r = await http('PUT', '/api/risk/settings', admin, { accountDiscovery: 'yes' });
  check('accountDiscovery must be boolean → 400', r.status === 400, r.text);
  r = await http('PUT', '/api/risk/settings', admin, { accountDiscovery: false });
  const rs = await http('GET', '/api/risk/settings', admin);
  check('accountDiscovery off saved (default was on)', r.status === 200 && JSON.stringify(rs.body).includes('"accountDiscovery":false'), rs.text.slice(0, 300));
  r = await http('POST', '/api/social/discover', admin);
  check('立即发现 with the switch off → enabled false, nothing read', r.status === 200 && r.body.discovery?.enabled === false && r.body.discovery.read === 0, r.text);
  d = await discoverOnDevice(D1, [id1, fakeId()]);
  taskIds.add(d.taskId!);
  const offFin = await waitTask(d.taskId!);
  check('an auto task that runs while the switch is off → skipped account_sync.discovery_off', (offFin.result as any)?.outcome === 'skipped' && (offFin.result as any)?.code === 'account_sync.discovery_off');
  await http('PUT', '/api/risk/settings', admin, { accountDiscovery: true });
  r = await http('POST', '/api/social/discover', admin);
  check('立即发现 on: stopped placeholders are not read', r.status === 200 && r.body.discovery?.enabled === true, r.text);
  r = await http('POST', '/api/social/discover', A);
  check('立即发现 as a user → 403', r.status === 403, r.text);
  const audD = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'social.discover'), sql`${schema.auditLogs.at} > now() - interval '10 minutes'`));
  check('audit social.discover', audD.length >= 2);
} catch (err) {
  check('unexpected error', false, String((err as Error).stack ?? err));
} finally {
  const ids = [...taskIds].filter(Boolean);
  const devTasks = devIds.length ? await db.select({ id: T.id }).from(T).where(and(eq(T.type, 'account-device-sync'), inArray(T.refId, devIds))) : [];
  const all = [...new Set([...ids, ...devTasks.map((x) => x.id)])];
  if (all.length) await db.delete(T).where(inArray(T.id, all));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  if (devIds.length) {
    await db.delete(schema.notifications).where(inArray(schema.notifications.refId, devIds));
    await db.delete(schema.alertStates).where(sql`${schema.alertStates.kind} = 'account.discovered' and split_part(${schema.alertStates.key}, ':', 1) in (${sql.join(devIds.map((x) => sql`${x}`), sql`, `)})`);
    await db.delete(schema.riskEvents).where(inArray(schema.riskEvents.instanceId, devIds));
    await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
  }
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (saved.length) await db.insert(schema.settings).values(saved);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
