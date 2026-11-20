/**
 * 安全检查: regression checks for the security findings of 2026-11-19, against the real API, DB and Redis (no mocks).
 * - 角色菜单权限 bypass: a percent-encoded path (/api/%61nalytics/…) reached a switched-off menu's endpoints (the
 *   onRequest hook matched the raw URL); now refused like the plain path, and allowed again once the menu is on.
 * - login timing: an unknown username answered at once (the dummy bcrypt hash was malformed, so no work was done),
 *   a known one after a real bcrypt compare → usernames could be enumerated; now both take a real compare.
 * - /api/events WebSocket: a user disabled after connecting kept receiving events; now the socket is closed (4001)
 *   within the re-check interval (15 s). The remote-control session got the same re-check (user, grant, menu): not
 *   exercised here (it needs a running device in STF).
 * Creates two users (deleted afterwards) and restores the role-menu setting.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:<port> npx tsx --env-file=../../.env scripts/security-check.ts
 */
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { zipSync } from 'fflate';
import WebSocket from 'ws';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';
import { placeholders } from './lib/placeholder.js';

const ph = placeholders('secfake');

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
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
async function loginRaw(username: string, password: string) {
  const body = JSON.stringify(await withCaptcha(API, { username, password }));
  const t = performance.now();
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const ms = performance.now() - t;
  return { status: r.status, body: await r.json() as any, ms };
}
const login = async (u: string, p: string) => (await loginRaw(u, p)).body.token as string;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const A = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const PW = `Sc-${randomBytes(6).toString('hex')}`;
const userIds: string[] = [];
const devIds: string[] = [];
const [prevMenus] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus'));
const ALL_MENUS = ['instances', 'personas', 'social', 'analytics', 'media', 'trending', 'content', 'publish', 'tasks'];

async function createUser(name: string) {
  const r = await http('POST', '/api/users', A, { username: name, password: PW, role: 'user' });
  if (r.status !== 201) throw new Error(`create user: ${r.status} ${r.text}`);
  userIds.push(r.body.user.id);
  return r.body.user.id as string;
}

try {
  const u1 = `sec1-${tag}`;
  const u1Id = await createUser(u1);
  const U1 = await login(u1, PW);

  // ------------------------------------------------------------ menu hook vs percent-encoded paths
  let r = await http('PUT', '/api/settings/role-menus', A, { menus: ['instances'] });
  check('menus: only 我的云机 on for users', r.status === 200, r.text);
  const paths: [string, string][] = [
    ['/api/analytics/summary?days=7', '/api/%61nalytics/summary?days=7'],
    ['/api/trending', '/api/%74rending'],
    ['/api/tracked-accounts', '/api/%74racked-accounts'],
    ['/api/social/accounts/00000000-0000-0000-0000-000000000000/feed', '/api/social/accounts/00000000-0000-0000-0000-000000000000/%66eed'],
  ];
  for (const [plain, enc] of paths) {
    const a = await http('GET', plain, U1);
    const b = await http('GET', enc, U1);
    check(`menu off: ${plain} 403 rbac.menu_disabled`, a.status === 403 && a.body?.code === 'rbac.menu_disabled', `${a.status} ${a.text.slice(0, 120)}`);
    check(`menu off: encoded ${enc} 403 too`, b.status === 403 && b.body?.code === 'rbac.menu_disabled', `${b.status} ${b.text.slice(0, 120)}`);
  }
  r = await http('PUT', '/api/settings/role-menus', A, { menus: ALL_MENUS });
  for (const [, enc] of paths.slice(0, 3)) {
    const b = await http('GET', enc, U1);
    check(`menu on: encoded ${enc} answers 200`, b.status === 200, `${b.status} ${b.text.slice(0, 120)}`);
  }
  check('menu on: unknown encoded path still 404', (await http('GET', '/api/%61nalytics/nope', U1)).status === 404);

  // ------------------------------------------------------------ login timing: unknown vs known username
  const unknown: number[] = [];
  const known: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = await loginRaw(`nobody-${tag}-${i}`, 'wrong-password-1');
    const b = await loginRaw(u1, 'wrong-password-1');
    if (a.status === 401) unknown.push(a.ms);
    if (b.status === 401) known.push(b.ms);
  }
  check('login: both failures 401 auth.invalid_credentials', unknown.length === 5 && known.length === 5);
  const mu = median(unknown);
  const mk = median(known);
  console.log(`  login median: unknown user ${mu.toFixed(1)} ms, known user ${mk.toFixed(1)} ms`);
  check('login: an unknown username takes a real bcrypt compare (≥ 60 % of a known one)', mu >= 0.6 * mk, `unknown ${mu.toFixed(1)} ms vs known ${mk.toFixed(1)} ms`);

  // ------------------------------------------------------------ /api/events closes for a disabled user
  const u2 = `sec2-${tag}`;
  const u2Id = await createUser(u2);
  const U2 = await login(u2, PW);
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/events`);
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: U2 })));
    ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'ready') { clearTimeout(timer); resolve(true); } });
    ws.on('error', () => undefined);
  });
  check('events: user socket ready', ready);
  const closed = new Promise<number | 'open'>((resolve) => {
    const timer = setTimeout(() => resolve('open'), 25_000);
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  r = await http('PATCH', `/api/users/${u2Id}`, A, { disabled: true });
  check('events: admin disables the user', r.status === 200, r.text);
  const code = await closed;
  check('events: socket of the disabled user closed 4001 within 25 s', code === 4001, String(code));
  if (code === 'open') ws.terminate();

  // ------------------------------------------------------------ retry replays a device-less automation task's payload
  // Fixture: a placeholder phone (never started) assigned to user 1, an Instagram account of user 1 linked to it, and
  // FAILED tasks user 1 created back then (rows written in the DB, like a task from before the reassignment).
  const u3 = `sec3-${tag}`;
  const u3Id = await createUser(u3);
  const [dev] = await ph.insert({
    name: `secfake-${tag}`, adbPort: 5602, status: 'stopped',
  });
  devIds.push(dev!.id);
  r = await http('PUT', `/api/instances/${dev!.id}/grants`, A, { userIds: [u1Id] });
  check('retry: phone assigned to user 1', r.status === 200, r.text);
  r = await http('POST', '/api/social/accounts', U1, { platform: 'instagram', handle: `sec_${tag}` });
  check('retry: user 1 adds an Instagram account', r.status === 201, r.text);
  const accId = r.body.account.id as string;
  await linkAccount(accId, dev!.id);
  const failedTask = async (type: string, payload: Record<string, unknown>, refType: string, refId: string) => (await db.insert(schema.tasks).values({
    type, status: 'failed', createdBy: u1Id, instanceName: dev!.name, refType, refId, payload, attempts: 1, errorCode: 'test.fixture', error: 'fixture', finishedAt: new Date(),
  }).returning())[0]!.id;
  const syncTask = await failedTask('account-device-sync', { instanceId: dev!.id, ownerId: u1Id }, 'instance', dev!.id);
  const syncTask2 = await failedTask('account-device-sync', { instanceId: dev!.id, ownerId: u1Id }, 'instance', dev!.id);
  const checkTask = await failedTask('account-device-check', { socialAccountId: accId }, 'social_account', accId);
  const followTask = await failedTask('account-following', { socialAccountId: accId }, 'social_account', accId);
  const feedTask = await failedTask('feed-collect', { kind: 'social', accountId: accId }, 'social_account', accId);
  r = await http('POST', `/api/tasks/${syncTask2}/retry`, U1);
  check('retry: while still assigned, user 1 may retry the sync (202)', r.status === 202, r.text);
  if (r.status === 202) await http('POST', `/api/tasks/${r.body.task.id}/cancel`, U1);

  r = await http('PUT', `/api/instances/${dev!.id}/grants`, A, { userIds: [u3Id] });
  check('retry: phone reassigned to user 3 (account moves with it)', r.status === 200, r.text);
  r = await http('POST', `/api/tasks/${syncTask}/retry`, U1);
  check('retry: former user 1 can no longer retry the sync of that phone (403 auth.no_instance_access)', r.status === 403 && r.body?.code === 'auth.no_instance_access', `${r.status} ${r.text.slice(0, 160)}`);
  r = await http('POST', `/api/tasks/${syncTask}/retry`, A);
  check('retry: admin retrying it with the old owner → 400 account_sync.owner_mismatch', r.status === 400 && r.body?.code === 'account_sync.owner_mismatch', `${r.status} ${r.text.slice(0, 160)}`);
  for (const [name, id] of [['account check', checkTask], ['following', followTask], ['feed collection', feedTask]] as const) {
    r = await http('POST', `/api/tasks/${id}/retry`, U1);
    check(`retry: former owner's ${name} task on the moved account → 404 social.not_found`, r.status === 404 && r.body?.code === 'social.not_found', `${r.status} ${r.text.slice(0, 160)}`);
  }
  const queued = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.retryOf, [syncTask, checkTask, followTask, feedTask]));
  check('retry: nothing was queued by the refused retries', queued.length === 0, String(queued.length));

  // ------------------------------------------------------------ split bundle (zip) bomb on POST /api/apps/install
  const U3 = await login(u3, PW);
  const bundle = (declared?: number) => {
    const z = zipSync({ 'base.apk': new Uint8Array(4096) }, { level: 6 });
    if (declared !== undefined) {
      // Patch the declared uncompressed size in the local header (+22) and the central directory entry (+24).
      const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
      for (let i = 0; i + 4 <= z.length; i++) {
        const sig = dv.getUint32(i, true);
        if (sig === 0x04034b50) dv.setUint32(i + 22, declared, true);
        if (sig === 0x02014b50) dv.setUint32(i + 24, declared, true);
      }
    }
    return z;
  };
  const install = async (zip: Uint8Array, name: string) => {
    const fd = new FormData();
    fd.append('instanceIds', JSON.stringify([dev!.id]));
    fd.append('file', new Blob([zip]), name);
    const res = await fetch(`${API}/api/apps/install`, { method: 'POST', headers: { authorization: `Bearer ${U3}` }, body: fd });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  let ir = await install(bundle(), `ok-${tag}.apks`);
  check('apps: a normal split bundle is unpacked (202, 1 apk, stopped phone skipped)', ir.status === 202 && ir.body?.apks === 1 && ir.body?.skipped?.length === 1, JSON.stringify(ir.body));
  ir = await install(bundle(0xF0000000), `bomb-${tag}.apks`);
  check('apps: a bundle declaring ~4 GB unpacked → 400 apps.too_large (nothing inflated)', ir.status === 400 && ir.body?.code === 'apps.too_large', `${ir.status} ${JSON.stringify(ir.body)}`);
  check('apps: API still answers after the bomb', (await http('GET', '/api/ready', null)).status === 200);

  void u1Id;
} finally {
  if (prevMenus) await db.insert(schema.settings).values({ key: prevMenus.key, value: prevMenus.value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: prevMenus.value } });
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus'));
  if (devIds.length) {
    await db.delete(schema.tasks).where(inArray(schema.tasks.instanceId, devIds));
    await db.delete(schema.tasks).where(inArray(schema.tasks.refId, devIds));
    await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
  }
  await ph.cleanup();
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, A);
  await sqlClient.end();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
