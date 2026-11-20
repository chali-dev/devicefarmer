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
 * Since 2026-11-18 (owner): one user per phone (PUT /api/instances/:id/grants single user, per-user grants refuse a
 * phone held by someone else, legacy two-user rows written in the DB), the sync owner follows the phone (assigned
 * user, else the admin; another ownerId → account_sync.owner_mismatch, legacy phone → owner_required), 自动发现 on an
 * unassigned phone → the builtin admin, the sync writes the check result (recordSyncCheck), and assigning a phone
 * moves its linked accounts to the user (logs, personal persona cleared, old owner's content targets removed,
 * comments follow, 409 instances.assign_account_busy with an unfinished reply, RBAC).
 * Since 2026-11-19 (owner 「不能，转移给新用户，未分配给 ADMIN」): unassigning (per device, per user) moves the accounts to
 * the builtin admin (logs, audit, 409 while busy); disabling a user moves them (a busy phone is kept and reported),
 * deleting one moves them before the cascade; an owner without the phone's grant gets 403 social.device_not_granted on
 * 立即检测 / 追踪中 同步 / 立即采集 / 同步 / 排程 a reply, an admin's check skips at run time, an admin-scheduled reply
 * goes to an operator (comment.device_not_granted) and the hourly schedulers give the account no slot.
 * Placeholder devices on ports 5583–5584, 5586–5587, 5590–5591.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { applySync, discoverOnDevice, discoveryAction, recordSyncCheck } from '../src/modules/social/sync.js';
import { withCaptcha } from './lib/login.js';
import { placeholders } from './lib/placeholder.js';

const ph = placeholders('syfake');

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
const personaIds: string[] = [];
const contentIds: string[] = [];

try {
  // ---------------------------------------------------------------- setup
  for (const n of ['a', 'b', 'c']) {
    const r = await http('POST', '/api/users', admin, { username: `sy${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB, uC] = userIds as [string, string, string];
  const A = await login(`sya${tag}`, pw);
  const B = await login(`syb${tag}`, pw);
  const devs = await ph.insert([5583, 5584, 5590, 5591].map((port, n) => ({
    name: `syfake-${tag}-${n + 1}`, adbPort: port, status: 'stopped' as const,
    allowedPlatforms: n === 3 ? ['tiktok'] : null,
  })));
  devIds.push(...devs.map((d) => d.id));
  const [D1, D2, D3, D4] = devs as [typeof devs[0], typeof devs[0], typeof devs[0], typeof devs[0]];
  // D1: A only; D2: A + B (legacy data: the API refuses a second user now, so B's row is written in the DB); D3: nobody;
  // D4: A, Instagram not allowed
  await http('PUT', `/api/users/${uA}/grants`, admin, { instanceIds: [D1.id, D2.id, D4.id] });
  await db.insert(schema.instanceGrants).values({ userId: uB, instanceId: D2.id });
  await http('PUT', '/api/social/settings', admin, { limits: { instagram: 1 } });
  const grantsOf = async (userId: string) => (await db.select().from(schema.instanceGrants).where(eq(schema.instanceGrants.userId, userId))).map((g) => g.instanceId).sort();

  // ---------------------------------------------------------------- one user per phone
  let g = await http('PUT', `/api/instances/${D1.id}/grants`, admin, { userIds: [uA, uB] });
  check('device grants with two users → 400 grants.single_user', g.status === 400 && g.body.code === 'grants.single_user', g.text);
  g = await http('PUT', `/api/users/${uB}/grants`, admin, { instanceIds: [D2.id, D1.id] });
  check('per-user grants adding a phone held by another user → 409 grants.device_assigned, nothing changed', g.status === 409 && g.body.code === 'grants.device_assigned'
    && g.body.params?.user === `sya${tag}` && (await grantsOf(uB)).join() === D2.id, g.text);
  g = await http('PUT', `/api/users/${uB}/grants`, admin, { instanceIds: [D2.id] });
  check('per-user grants keeping a legacy shared phone → 200', g.status === 200 && (await grantsOf(uB)).join() === D2.id, g.text);
  g = await http('PUT', `/api/instances/${D3.id}/grants`, admin, { userIds: [adminRow!.id] });
  check('assigning an admin → 400 grants.admin_not_needed', g.status === 400 && g.body.code === 'grants.admin_not_needed', g.text);
  g = await http('PUT', `/api/instances/${D3.id}/grants`, A, { userIds: [uA] });
  check('assigning as a user → 403', g.status === 403, g.text);

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

  // owner follows the phone: assigned user, else the admin running it
  r = await sync(admin, { instanceId: D3.id, ownerId: uC });
  check('admin, unassigned phone + another owner → 400 account_sync.owner_mismatch', r.status === 400 && r.body.code === 'account_sync.owner_mismatch', r.text);
  r = await sync(admin, { instanceId: D3.id });
  taskIds.add(r.body?.task?.id);
  check('admin, unassigned phone, no owner → 202', r.status === 202, r.text);
  const admTask = await waitTask(r.body.task.id);
  check('unassigned phone: the account owner is the admin', (admTask.payload as any).ownerId === adminRow!.id && (admTask.result as any)?.result === 'offline');
  r = await sync(admin, { instanceId: D1.id, ownerId: uC });
  check('admin, phone assigned to A + owner C → 400 account_sync.owner_mismatch', r.status === 400 && r.body.code === 'account_sync.owner_mismatch', r.text);
  r = await sync(admin, { instanceId: D1.id });
  taskIds.add(r.body?.task?.id);
  const d1Adm = r.status === 202 ? await waitTask(r.body.task.id) : null;
  check('admin, phone assigned to A, no owner → owner A', (d1Adm?.payload as any)?.ownerId === uA, r.text);
  r = await sync(admin, { instanceId: D2.id });
  check('admin, legacy phone with two users, no owner → 400 account_sync.owner_required', r.status === 400 && r.body.code === 'account_sync.owner_required', r.text);
  r = await sync(admin, { instanceId: D2.id, ownerId: uB });
  taskIds.add(r.body?.task?.id);
  const d2Adm = r.status === 202 ? await waitTask(r.body.task.id) : null;
  check('admin, legacy phone, one of its users picked → 202, owner B', (d2Adm?.payload as any)?.ownerId === uB, r.text);

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
    && aud.some((a) => a.ok && (a.detail as any)?.ownerId === uB), `${aud.length} rows`);

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
  const on = (id: string) => ({ id, disabled: false });
  const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  check('rule: nothing unrecorded → nothing', discoveryAction([], [on(uA)], adminRow!.id) === null);
  check('rule: exactly one assigned user → sync for that user', eqJson(discoveryAction(['1'], [on(uA)], adminRow!.id), { kind: 'sync', ownerId: uA, via: 'assigned' }));
  check('rule: several users (legacy) → notice', eqJson(discoveryAction(['1'], [on(uA), on(uB)], adminRow!.id), { kind: 'notify', reason: 'multiple_users' }));
  check('rule: nobody → sync for the builtin admin', eqJson(discoveryAction(['1'], [], adminRow!.id), { kind: 'sync', ownerId: adminRow!.id, via: 'builtin_admin' }));
  check('rule: nobody and no builtin admin → notice no_user', eqJson(discoveryAction(['1'], [], null), { kind: 'notify', reason: 'no_user' }));
  check('rule: the assigned user is disabled → notice user_disabled', eqJson(discoveryAction(['1'], [{ id: uA, disabled: true }], adminRow!.id), { kind: 'notify', reason: 'user_disabled' }));

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
  d = await discoverOnDevice(D3, ids2);
  taskIds.add(d.taskId!);
  const again2 = await discoverOnDevice(D3, ids2);
  const n3 = await db.select().from(schema.notifications).where(and(eq(schema.notifications.kind, 'account.discovered'), eq(schema.notifications.refId, D3.id)));
  check('nobody assigned (D3) → auto sync task for the builtin admin, once a day, no notice', adminRow!.builtin && d.action?.kind === 'sync' && (d.action as any).ownerId === adminRow!.id
    && (d.action as any).via === 'builtin_admin' && d.created === true && again2.taskId === d.taskId && again2.created === false && n3.length === 0, JSON.stringify(d));
  const d3Row = (await db.select().from(T).where(eq(T.id, d.taskId!)))[0]!;
  check('builtin admin task: payload owner = admin, system task', (d3Row.payload as any).ownerId === adminRow!.id && d3Row.createdBy === null);
  // the phone's only user is disabled → notice user_disabled
  await http('PUT', `/api/instances/${D3.id}/grants`, admin, { userIds: [uC] });
  await http('PATCH', `/api/users/${uC}`, admin, { disabled: true });
  d = await discoverOnDevice(D3, [fakeId()]);
  const n3b = await db.select().from(schema.notifications).where(and(eq(schema.notifications.kind, 'account.discovered'), eq(schema.notifications.refId, D3.id)));
  check('assigned user disabled → notice user_disabled, no task', d.action?.kind === 'notify' && (d.action as any).reason === 'user_disabled' && !d.taskId && d.notified === true
    && n3b.some((n) => n.userId === adminRow!.id && (n.params as any).reason === 'user_disabled'));
  g = await http('PUT', `/api/instances/${D1.id}/grants`, admin, { userIds: [uC] });
  check('assigning a phone to a disabled user → 400 grants.user_disabled', g.status === 400 && g.body.code === 'grants.user_disabled', g.text);
  await http('PATCH', `/api/users/${uC}`, admin, { disabled: false });
  await http('PUT', `/api/instances/${D3.id}/grants`, admin, { userIds: [] });
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

  // ---------------------------------------------------------------- the sync writes the check result (同步 replaces 立即检测)
  await db.update(SA).set({ loginStatus: 'logged_out', lastCheckCode: 'logged_out', lastError: 'old error', lastCheckedAt: null }).where(eq(SA.id, acc!.id));
  const logsBefore = (await db.select().from(schema.socialAccountLogs).where(eq(schema.socialAccountLogs.accountId, acc!.id))).length;
  let nAcc = await recordSyncCheck(D1, { result: 'ok', accountId: acc!.id }, uA);
  let [chk] = await db.select().from(SA).where(eq(SA.id, acc!.id));
  let clog = (await db.select().from(schema.socialAccountLogs).where(eq(schema.socialAccountLogs.accountId, acc!.id))).slice(logsBefore);
  check('sync ok → logged_in, last_check_code ok, last_checked_at, last_error cleared', nAcc === 1 && chk!.loginStatus === 'logged_in' && chk!.lastCheckCode === 'ok' && chk!.lastError === null
    && !!chk!.lastCheckedAt && Date.now() - chk!.lastCheckedAt.getTime() < 60_000);
  check('sync ok → logs (checked "sync on <phone>", status "synced from device")', clog.some((l) => l.action === 'checked' && l.message === `sync on ${D1.name}` && l.toValue === 'ok')
    && clog.some((l) => l.field === 'loginStatus' && l.message === 'synced from device' && l.toValue === 'logged_in') && clog.some((l) => l.field === 'lastError' && l.toValue === null), JSON.stringify(clog.map((l) => [l.action, l.field, l.message])));
  nAcc = await recordSyncCheck(D1, { result: 'not_logged_in', detail: 'no Instagram account on the device' }, null);
  [chk] = await db.select().from(SA).where(eq(SA.id, acc!.id));
  const prob = await db.select().from(schema.notifications).where(and(eq(schema.notifications.kind, 'account.problem'), eq(schema.notifications.refId, acc!.id)));
  check('sync not_logged_in → the phone\'s Instagram accounts logged_out (code logged_out)', nAcc === 1 && chk!.loginStatus === 'logged_out' && chk!.lastCheckCode === 'logged_out' && chk!.lastCheckDetail === 'no Instagram account on the device');
  check('sync not_logged_in → account.problem to the owner', prob.some((n) => n.userId === uA));
  await recordSyncCheck(D1, { result: 'ok', accountId: acc!.id }, uA);
  const [st0] = await db.select().from(schema.alertStates).where(and(eq(schema.alertStates.kind, 'account.problem'), eq(schema.alertStates.key, acc!.id)));
  check('sync ok again → account.problem recovered (alert state inactive)', st0?.active === false, JSON.stringify(st0));

  // ---------------------------------------------------------------- accounts follow the phone's assignment
  const mv = await ph.insert([5586, 5587].map((port, n) => ({
    name: `syfake-${tag}-m${n + 1}`, adbPort: port, status: 'stopped' as const,
  })));
  devIds.push(...mv.map((x) => x.id));
  const [D5, D6] = mv as [typeof mv[0], typeof mv[0]];
  const adminActor = { id: adminRow!.id, username: adminRow!.username, role: 'admin' as const };
  const h5a = `syncmv_a_${tag}`; const h5b = `syncmv_b_${tag}`; const h6 = `syncmv_c_${tag}`;
  const oa = await applySync({ inst: D5, ownerId: adminRow!.id, actor: adminActor, handle: h5a, displayName: null, deviceIds: [fakeId(), fakeId()] });
  const ob = await applySync({ inst: D5, ownerId: adminRow!.id, actor: adminActor, handle: h5b, displayName: null, deviceIds: [fakeId(), fakeId()] });
  const oc = await applySync({ inst: D6, ownerId: adminRow!.id, actor: adminActor, handle: h6, displayName: null, deviceIds: [fakeId()] });
  check('setup: three admin-owned accounts on unassigned phones', [oa, ob, oc].every((o) => o.result === 'created'), JSON.stringify([oa, ob, oc]));
  const [pPersonal, pPublic] = await db.insert(schema.personas).values([
    { ownerType: 'user', ownerId: adminRow!.id, name: `sync-personal-${tag}` }, { ownerType: 'public', ownerId: null, name: `sync-public-${tag}` },
  ]).returning();
  personaIds.push(pPersonal!.id, pPublic!.id);
  await db.update(SA).set({ personaId: pPersonal!.id }).where(eq(SA.id, oa.accountId!));
  await db.update(SA).set({ personaId: pPublic!.id }).where(eq(SA.id, ob.accountId!));
  const [cAdmin] = await db.insert(schema.contents).values({ userId: adminRow!.id, title: `sync content ${tag}` }).returning();
  contentIds.push(cAdmin!.id);
  await db.insert(schema.contentTargets).values({ contentId: cAdmin!.id, accountId: oa.accountId!, position: 0 });
  const cm = await http('POST', '/api/comments', admin, { accountId: ob.accountId, text: `hello ${tag}`, authorName: 'Viewer', authorHandle: '@viewer', externalPostId: 'p1' });
  const commentId = cm.body?.comment?.id ?? cm.body?.id;
  const rp = await http('POST', `/api/comments/${commentId}/replies`, admin, { text: `thanks ${tag}` });
  const replyId = rp.body?.reply?.id ?? rp.body?.id;
  check('setup: a manual comment + a reply draft on the second account', cm.status < 300 && rp.status < 300 && !!replyId, `${cm.text} ${rp.text}`);

  g = await http('PUT', `/api/instances/${D5.id}/grants`, A, { userIds: [uA] });
  check('assign as a user → 403', g.status === 403, g.text);
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [uA] });
  const stillAdmin = await db.select().from(SA).where(inArray(SA.id, [oa.accountId!, ob.accountId!]));
  check('unfinished reply (draft) on a linked account → 409 instances.assign_account_busy (handle, counts), nothing changed', g.status === 409 && g.body.code === 'instances.assign_account_busy'
    && g.body.params?.handle === h5b && g.body.params?.replies === 1 && g.body.params?.publish === 0
    && stillAdmin.every((a) => a.userId === adminRow!.id) && (await db.select().from(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, D5.id))).length === 0, g.text);
  await http('DELETE', `/api/comment-replies/${replyId}`, admin);
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [uA] });
  const moved = await db.select().from(SA).where(inArray(SA.id, [oa.accountId!, ob.accountId!]));
  const ma = moved.find((a) => a.id === oa.accountId)!; const mb = moved.find((a) => a.id === ob.accountId)!;
  check('assign → 200, both linked accounts moved to A', g.status === 200 && g.body.movedAccounts?.length === 2 && ma.userId === uA && mb.userId === uA, g.text);
  check('personal persona of the old owner cleared, public persona kept', ma.personaId === null && mb.personaId === pPublic!.id);
  const mlog = await db.select().from(schema.socialAccountLogs).where(inArray(schema.socialAccountLogs.accountId, [ma.id, mb.id]));
  check('logs: owner admin → A ("phone assigned", actor admin), persona cleared on the first', [ma.id, mb.id].every((id) => mlog.some((l) => l.accountId === id && l.field === 'owner'
    && l.fromValue === adminRow!.username && l.toValue === `sya${tag}` && l.message === 'phone assigned' && l.actorId === adminRow!.id))
    && mlog.some((l) => l.accountId === ma.id && l.field === 'persona' && l.fromValue === `sync-personal-${tag}` && l.toValue === null)
    && !mlog.some((l) => l.accountId === mb.id && l.field === 'persona'));
  check('content target on the old owner\'s content removed', (await db.select().from(schema.contentTargets).where(eq(schema.contentTargets.accountId, ma.id))).length === 0);
  check('the account\'s comments follow it', (await db.select().from(schema.comments).where(eq(schema.comments.id, commentId)))[0]?.userId === uA);
  check('user A lists the moved accounts', (await http('GET', '/api/social/accounts', A)).body.items?.filter((x: any) => x.id === ma.id || x.id === mb.id).length === 2);
  await sleep(500);
  const audG = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'grants.update'), sql`${schema.auditLogs.at} > now() - interval '10 minutes'`));
  check('audit grants.update with moved count + ids only', audG.some((a) => a.ok && (a.detail as any)?.movedAccounts === 2 && (a.detail as any)?.accountIds?.length === 2 && !JSON.stringify(a.detail).includes(h5a)));
  const nLogs = mlog.length;
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [uA] });
  check('same user again → no-op (nothing moved, no logs)', g.status === 200 && g.body.movedAccounts?.length === 0
    && (await db.select().from(schema.socialAccountLogs).where(inArray(schema.socialAccountLogs.accountId, [ma.id, mb.id]))).length === nLogs, g.text);
  g = await http('PUT', `/api/users/${uB}/grants`, admin, { instanceIds: [D2.id, D6.id] });
  check('per-user grants adding an unassigned phone → its account moves to B', g.status === 200 && g.body.movedAccounts?.length === 1 && (await db.select().from(SA).where(eq(SA.id, oc.accountId!)))[0]?.userId === uB, g.text);
  const re = await applySync({ inst: D5, ownerId: uA, actor: userA, handle: h5a, displayName: 'Moved', deviceIds: [] });
  check('re-sync by the new owner → updated (not taken)', re.result === 'updated' && re.accountId === ma.id);

  // ---------------------------------------------------------------- account-level device actions need the grant (2026-11-19)
  const owners = async () => (await db.select({ id: SA.id, userId: SA.userId }).from(SA).where(inArray(SA.id, [ma.id, mb.id]))).map((a) => a.userId);
  const grantRows = (instanceId: string) => db.select().from(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, instanceId));
  // A owns ma / mb but no longer holds D5 (written in the DB: the state of legacy data or a disabled owner's kept phone)
  await db.delete(schema.instanceGrants).where(and(eq(schema.instanceGrants.userId, uA), eq(schema.instanceGrants.instanceId, D5.id)));
  const denied: [string, string][] = [
    ['立即检测', `/api/social/accounts/${ma.id}/check`], ['追踪中 同步', `/api/social/accounts/${ma.id}/following/sync`],
    ['立即采集', `/api/social/accounts/${ma.id}/collect`], ['同步', `/api/social/accounts/${ma.id}/sync`],
  ];
  for (const [what, path] of denied) {
    const r = await http('POST', path, A);
    check(`owner without the phone's grant: ${what} → 403 social.device_not_granted`, r.status === 403 && r.body.code === 'social.device_not_granted', r.text);
  }
  check('nothing queued for the account by those refusals', (await db.select().from(T).where(and(eq(T.refId, ma.id), sql`${T.createdAt} > now() - interval '1 minute'`))).length === 0);
  const cmA = await http('POST', '/api/comments', A, { accountId: mb.id, text: `grant ${tag}`, authorName: 'Viewer', authorHandle: '@viewer2', externalPostId: 'p2' });
  const cmAId = cmA.body?.comment?.id ?? cmA.body?.id;
  const drA = await http('POST', `/api/comments/${cmAId}/replies`, A, { text: `draft ${tag}` });
  const drAId = drA.body?.reply?.id ?? drA.body?.id;
  let rq = await http('POST', `/api/comment-replies/${drAId}/submit`, A, { scheduledAt: null });
  check('owner without the grant: a draft is still saved, 排程 → 403 social.device_not_granted (stays a draft)', drA.status < 300 && rq.status === 403 && rq.body.code === 'social.device_not_granted'
    && (await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, drAId)))[0]?.status === 'draft', `${drA.text} ${rq.text}`);
  // admins are unaffected; at run time the owner still has no phone → skipped / handed to an operator
  rq = await http('POST', `/api/social/accounts/${ma.id}/check`, admin);
  taskIds.add(rq.body?.task?.id);
  const chkT = rq.status === 202 ? await waitTask(rq.body.task.id) : null;
  check('admin 立即检测 → 202; the run skips it: social.device_not_granted (owner no longer holds the phone)', rq.status === 202 && chkT?.status === 'success'
    && (chkT.result as any)?.outcome === 'skipped' && (chkT.result as any)?.code === 'social.device_not_granted', `${rq.text} ${JSON.stringify(chkT?.result)}`);
  rq = await http('POST', `/api/comment-replies/${drAId}/submit`, admin, { scheduledAt: null });
  let rep: typeof schema.commentTasks.$inferSelect | undefined;
  for (let i = 0; i < 60; i++) {
    [rep] = await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, drAId));
    if (rep && !['scheduled', 'sending'].includes(rep.status)) break;
    await sleep(500);
  }
  if (rep?.taskId) taskIds.add(rep.taskId);
  const handLog = await db.select().from(schema.commentLogs).where(and(eq(schema.commentLogs.commentTaskId, drAId), eq(schema.commentLogs.action, 'handed_over')));
  check('admin 排程 the draft → at run time handed to an operator: awaiting_operator, reason comment.device_not_granted', rq.status === 200 && rep?.status === 'awaiting_operator'
    && rep?.method === 'manual' && handLog.some((l) => l.code === 'comment.device_not_granted'), `${rep?.status} ${JSON.stringify(handLog)}`);
  await http('POST', `/api/comment-replies/${drAId}/cancel`, admin);
  // hourly schedulers: the account's phone running, owner without the grant → no slot; with the grant back → slots
  const { scheduleAccountDeviceChecks } = await import('../src/modules/social/check.js');
  const { scheduleFollowingSyncs } = await import('../src/modules/social/following.js');
  const { scheduleFeedCollects } = await import('../src/modules/feed/collect.js');
  const { ownerHoldsDevice } = await import('../src/modules/social/assign.js');
  const runSchedulers = async () => {
    await db.update(schema.instances).set({ status: 'running', adbState: 'device' }).where(eq(schema.instances.id, D5.id));
    await scheduleAccountDeviceChecks(new Date(), 25 * 3600_000);
    await scheduleFollowingSyncs(new Date(), 25 * 3600_000);
    await scheduleFeedCollects(new Date(), 25 * 3600_000);
    await db.update(schema.instances).set({ status: 'stopped', adbState: null }).where(eq(schema.instances.id, D5.id));
    const rows = await db.select().from(T).where(and(inArray(T.refId, [ma.id, mb.id]), sql`${T.idempotencyKey} ~ '^(acct-check|following|feed:social):'`));
    for (const x of rows) taskIds.add(x.id);
    if (rows.length) await db.update(T).set({ status: 'cancelled', finishedAt: new Date() }).where(inArray(T.id, rows.map((x) => x.id)));
    return rows;
  };
  const none = await runSchedulers();
  check('schedulers (account check, 追踪中, 帖子采集): owner without the grant → no slot for its accounts', none.length === 0, JSON.stringify(none.map((x) => x.idempotencyKey)));
  await db.insert(schema.instanceGrants).values({ userId: uA, instanceId: D5.id });
  const some = await runSchedulers();
  check('schedulers: grant back → slots for both accounts of all three kinds', ['acct-check', 'following', 'feed:social'].every((k) => [ma.id, mb.id].every((id) => some.some((x) => x.refId === id && x.idempotencyKey!.startsWith(`${k}:`)))),
    JSON.stringify(some.map((x) => x.idempotencyKey)));

  // ---------------------------------------------------------------- unassigning moves the accounts to the builtin admin
  const [builtin] = await db.select().from(schema.users).where(eq(schema.users.builtin, true));
  const cmB = await http('POST', '/api/comments', A, { accountId: ma.id, text: `busy ${tag}`, authorName: 'Viewer', authorHandle: '@viewer3', externalPostId: 'p3' });
  const cmBId = cmB.body?.comment?.id ?? cmB.body?.id;
  const drB = await http('POST', `/api/comments/${cmBId}/replies`, A, { text: `busy draft ${tag}` });
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [] });
  check('unassign with a reply draft on a linked account → 409 instances.assign_account_busy, grant + owners unchanged', g.status === 409 && g.body.code === 'instances.assign_account_busy'
    && (await grantRows(D5.id)).length === 1 && (await owners()).every((u) => u === uA), g.text);
  await http('DELETE', `/api/comment-replies/${drB.body?.reply?.id ?? drB.body?.id}`, A);
  const nLogs2 = (await db.select().from(schema.socialAccountLogs).where(inArray(schema.socialAccountLogs.accountId, [ma.id, mb.id]))).length;
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [] });
  check('unassign → 200, no grant, both accounts moved to the builtin admin', g.status === 200 && g.body.movedAccounts?.length === 2 && (await grantRows(D5.id)).length === 0
    && (await owners()).every((u) => u === builtin!.id), g.text);
  const ulog = await db.select().from(schema.socialAccountLogs).where(and(inArray(schema.socialAccountLogs.accountId, [ma.id, mb.id]), eq(schema.socialAccountLogs.message, 'phone unassigned')));
  check('logs: owner A → builtin admin ("phone unassigned", actor admin)', nLogs2 > 0 && [ma.id, mb.id].every((id) => ulog.some((l) => l.accountId === id && l.field === 'owner'
    && l.fromValue === `sya${tag}` && l.toValue === builtin!.username && l.actorId === adminRow!.id)), JSON.stringify(ulog));
  check('the comments follow to the admin', (await db.select().from(schema.comments).where(inArray(schema.comments.id, [cmAId, cmBId]))).every((c) => c.userId === builtin!.id));
  check('user A no longer lists them; 立即检测 on one → 404', !(await http('GET', '/api/social/accounts', A)).body.items?.some((x: any) => x.id === ma.id || x.id === mb.id)
    && (await http('POST', `/api/social/accounts/${ma.id}/check`, A)).status === 404);
  await sleep(500);
  const audU = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'grants.update'), eq(schema.auditLogs.targetId, D5.id), sql`${schema.auditLogs.at} > now() - interval '1 minute'`));
  check('audit grants.update of the unassign: moved count + ids only', audU.some((a) => a.ok && (a.detail as any)?.movedAccounts === 2 && (a.detail as any)?.accountIds?.length === 2 && !JSON.stringify(a.detail).includes(h5a)), JSON.stringify(audU.map((a) => a.detail)));
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [] });
  check('unassign again → nothing moved (admin-owned accounts stay)', g.status === 200 && g.body.movedAccounts?.length === 0, g.text);
  // per-user grants removing a phone: B's account on D6 → builtin admin
  g = await http('PUT', `/api/users/${uB}/grants`, admin, { instanceIds: [D2.id] });
  const [ocRow] = await db.select().from(SA).where(eq(SA.id, oc.accountId!));
  check('per-user grants removing a phone → its account of that user moves to the builtin admin', g.status === 200 && g.body.movedAccounts?.length === 1 && ocRow?.userId === builtin!.id, g.text);

  // ---------------------------------------------------------------- disabling / deleting a user who holds a phone
  const C = await login(`syc${tag}`, pw);
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [uC] });
  check('setup: D5 assigned to C → both accounts move to C', g.status === 200 && (await owners()).every((u) => u === uC), g.text);
  const cmC = await http('POST', '/api/comments', C, { accountId: ma.id, text: `c ${tag}`, authorName: 'Viewer', authorHandle: '@viewer4', externalPostId: 'p4' });
  const cmCId = cmC.body?.comment?.id ?? cmC.body?.id;
  const drC = await http('POST', `/api/comments/${cmCId}/replies`, C, { text: `c draft ${tag}` });
  const drCId = drC.body?.reply?.id ?? drC.body?.id;
  let pu = await http('PATCH', `/api/users/${uC}`, admin, { disabled: true });
  check('disable C with a reply draft on the phone → 200 (disabled), that phone\'s accounts kept (keptAccounts, code assign_account_busy)', pu.status === 200 && pu.body.user?.disabled === true
    && pu.body.keptAccounts?.length === 1 && pu.body.keptAccounts[0].instanceId === D5.id && pu.body.keptAccounts[0].code === 'instances.assign_account_busy'
    && (await owners()).every((u) => u === uC), pu.text);
  check('a disabled owner holds no phone (account actions / schedulers skip)', !(await ownerHoldsDevice({ userId: uC, instanceId: D5.id })));
  await http('PATCH', `/api/users/${uC}`, admin, { disabled: false });
  await http('DELETE', `/api/comment-replies/${drCId}`, admin);
  pu = await http('PATCH', `/api/users/${uC}`, admin, { disabled: true });
  const dlog = await db.select().from(schema.socialAccountLogs).where(and(inArray(schema.socialAccountLogs.accountId, [ma.id, mb.id]), eq(schema.socialAccountLogs.message, 'owner disabled')));
  check('disable C → accounts moved to the builtin admin ("owner disabled"), grant row kept', pu.status === 200 && pu.body.movedAccounts?.length === 2 && pu.body.keptAccounts?.length === 0
    && (await owners()).every((u) => u === builtin!.id) && dlog.filter((l) => l.field === 'owner').length === 2 && (await grantRows(D5.id)).length === 1, pu.text);
  await sleep(500);
  const audDis = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'user.update'), eq(schema.auditLogs.targetId, uC), sql`${schema.auditLogs.at} > now() - interval '1 minute'`));
  check('audit user.update of the disable: moved count + ids', audDis.some((a) => (a.detail as any)?.movedAccounts === 2), JSON.stringify(audDis.map((a) => a.detail)));
  await http('PATCH', `/api/users/${uC}`, admin, { disabled: false });
  g = await http('PUT', `/api/instances/${D5.id}/grants`, admin, { userIds: [uC] });
  check('re-enabled + assigned the same user again → the accounts move back to C', g.status === 200 && g.body.movedAccounts?.length === 2 && (await owners()).every((u) => u === uC), g.text);
  const drD = await http('POST', `/api/comments/${cmCId}/replies`, C, { text: `c draft 2 ${tag}` });
  const drDId = drD.body?.reply?.id ?? drD.body?.id;
  const del = await http('DELETE', `/api/users/${uC}`, admin);
  const delLog = await db.select().from(schema.socialAccountLogs).where(and(inArray(schema.socialAccountLogs.accountId, [ma.id, mb.id]), eq(schema.socialAccountLogs.message, 'owner deleted')));
  check('delete C (with a reply draft) → 204, both accounts kept and moved to the builtin admin ("owner deleted"), the draft deleted with C', del.status === 204
    && (await owners()).length === 2 && (await owners()).every((u) => u === builtin!.id) && delLog.length === 2
    && !!drDId && (await db.select().from(schema.commentTasks).where(eq(schema.commentTasks.id, drDId))).length === 0, `${drD.text} ${del.text}`);
} catch (err) {
  check('unexpected error', false, String((err as Error).stack ?? err));
} finally {
  const ids = [...taskIds].filter(Boolean);
  const devTasks = devIds.length ? await db.select({ id: T.id }).from(T).where(and(eq(T.type, 'account-device-sync'), inArray(T.refId, devIds))) : [];
  const all = [...new Set([...ids, ...devTasks.map((x) => x.id)])];
  if (all.length) await db.delete(T).where(inArray(T.id, all));
  const left = await db.select({ id: SA.id }).from(SA).where(sql`${SA.handle} like ${`%${tag}%`}`);
  if (left.length) {
    await db.delete(schema.alertStates).where(and(eq(schema.alertStates.kind, 'account.problem'), inArray(schema.alertStates.key, left.map((x) => x.id))));
    await db.delete(schema.notifications).where(inArray(schema.notifications.refId, left.map((x) => x.id)));
    await db.delete(SA).where(inArray(SA.id, left.map((x) => x.id)));
  }
  if (contentIds.length) await db.delete(schema.contents).where(inArray(schema.contents.id, contentIds));
  if (personaIds.length) await db.delete(schema.personas).where(inArray(schema.personas.id, personaIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  if (devIds.length) {
    await db.delete(schema.notifications).where(inArray(schema.notifications.refId, devIds));
    await db.delete(schema.alertStates).where(sql`${schema.alertStates.kind} = 'account.discovered' and split_part(${schema.alertStates.key}, ':', 1) in (${sql.join(devIds.map((x) => sql`${x}`), sql`, `)})`);
    await db.delete(schema.riskEvents).where(inArray(schema.riskEvents.instanceId, devIds));
    await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
  }
  await ph.cleanup();
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (saved.length) await db.insert(schema.settings).values(saved);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
