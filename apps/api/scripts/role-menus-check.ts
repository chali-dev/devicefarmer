/**
 * 权限管理 (角色菜单权限) + 系统日志 → 设备日志 against the real API and DB (no mocks).
 * - role menus: default = every grantable menu (today's behaviour) for GET /api/settings/role-menus, the login body and
 *   /api/auth/me; admin PUT/GET, validation (unknown key → rbac.menu_unknown, dashboard / admin-only key →
 *   rbac.menu_not_grantable, extra field / non-array → 400, user PUT → 403); with menus switched off: the user's
 *   effective menus, a disabled menu's own endpoints → 403 rbac.menu_disabled (also with an invalid body: checked before
 *   validation), shared endpoints still answer (GET personas / tasks / instances / social accounts, media upload with
 *   内容管理 on), an endpoint shared by two menus (publish runs: 排程发布 + 媒体管理) only refused when both are off,
 *   remote control session closed 4003 while 我的云机 is off, admin unaffected, re-enable → allowed again, audit
 *   `settings.role_menus` with the menu list.
 * - device logs: GET /api/system/device-logs on two placeholder devices (no container; status events written as rows):
 *   exact totals per device / type (status, adb, offline) / time range, paging, names, 400 on a bad type, user 403.
 * Restores the previous role-menu setting and removes its users/devices afterwards.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 API_PORT=3000 npx tsx --env-file=../../.env scripts/role-menus-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray } from 'drizzle-orm';
import WebSocket from 'ws';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

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
async function loginBody(username: string, password: string) {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return r.json() as Promise<{ token: string; menus: string[] }>;
}
/** Opens a remote-control session and returns the close code (or 'open' if it got past auth). */
function sessionClose(token: string, instanceId: string): Promise<number | string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/instances/${instanceId}/session`);
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout'); }, 15_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
    ws.on('error', () => undefined);
  });
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

const ADMIN = await loginBody(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const T = ADMIN.token;
const tag = randomBytes(3).toString('hex');
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const userIds: string[] = [];
const fakeIds: string[] = [];
const [prevRow] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus'));

try {
  // Start from the default (no stored value) so "default = today's behaviour" is checked for real.
  await db.delete(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus'));
  await http('PUT', '/api/settings/role-menus', T, { menus: ['instances', 'personas', 'social', 'analytics', 'media', 'trending', 'content', 'publish', 'tasks'] });
  await db.delete(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus'));

  // ---------------------------------------------------------------- defaults
  let r = await http('GET', '/api/settings/role-menus', T);
  const ALL = ['instances', 'personas', 'social', 'analytics', 'media', 'trending', 'content', 'publish', 'tasks'];
  check('GET role-menus: default = every grantable menu, no updatedAt', r.status === 200 && sameSet(r.body.menus, ALL) && sameSet(r.body.defaults, ALL)
    && sameSet(r.body.grantable, ALL) && r.body.updatedAt === null && r.body.fixed.always.includes('dashboard') && r.body.fixed.adminOnly.includes('connections'), r.text.slice(0, 300));
  check('admin login/me menus: every key incl. admin pages', ADMIN.menus.includes('permissions') && ADMIN.menus.includes('logs') && ADMIN.menus.includes('analytics'));

  const pw = randomBytes(12).toString('base64url');
  r = await http('POST', '/api/users', T, { username: `rm${tag}`, password: pw, role: 'user' });
  userIds.push(r.body.user?.id ?? r.body.id);
  const U = await loginBody(`rm${tag}`, pw);
  const UT = U.token;
  check('user login body: menus = dashboard + every grantable menu (default)', sameSet(U.menus, ['dashboard', ...ALL]), JSON.stringify(U.menus));
  r = await http('GET', '/api/auth/me', UT);
  check('user /api/auth/me: same menus', r.status === 200 && sameSet(r.body.menus, ['dashboard', ...ALL]) && r.body.user.username === `rm${tag}`);
  r = await http('GET', '/api/analytics/summary?days=7', UT);
  check('default: user reads analytics (200)', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);

  // ---------------------------------------------------------------- validation + RBAC of the setting
  const bad = await Promise.all([
    http('PUT', '/api/settings/role-menus', T, { menus: ['nope'] }),
    http('PUT', '/api/settings/role-menus', T, { menus: ['users'] }),
    http('PUT', '/api/settings/role-menus', T, { menus: ['dashboard'] }),
    http('PUT', '/api/settings/role-menus', T, { menus: ['connections'] }),
    http('PUT', '/api/settings/role-menus', T, { menus: ['media'], extra: 1 }),
    http('PUT', '/api/settings/role-menus', T, { menus: 'media' }),
  ]);
  check('PUT unknown key → 400 rbac.menu_unknown', bad[0]!.status === 400 && bad[0]!.body.code === 'rbac.menu_unknown' && bad[0]!.body.params.menu === 'nope');
  check('PUT admin-only / dashboard key → 400 rbac.menu_not_grantable', [bad[1]!, bad[2]!, bad[3]!].every((x) => x.status === 400 && x.body.code === 'rbac.menu_not_grantable'),
    [bad[1]!, bad[2]!, bad[3]!].map((x) => `${x.status} ${x.body?.code}`).join(','));
  check('PUT extra field / not an array → 400', bad[4]!.status === 400 && bad[5]!.status === 400);
  r = await http('GET', '/api/settings/role-menus', T);
  check('refused PUTs changed nothing', r.body.updatedAt === null && sameSet(r.body.menus, ALL));
  check('user GET/PUT role-menus → 403', (await http('GET', '/api/settings/role-menus', UT)).status === 403 && (await http('PUT', '/api/settings/role-menus', UT, { menus: [] })).status === 403);

  // ---------------------------------------------------------------- switch off: analytics, trending, personas, tasks, instances
  const OFF1 = ['social', 'media', 'content', 'publish'];
  r = await http('PUT', '/api/settings/role-menus', T, { menus: [...OFF1, 'publish', 'media'] });
  check('PUT saves (duplicates folded, sidebar order)', r.status === 200 && JSON.stringify(r.body.menus) === JSON.stringify(['social', 'media', 'content', 'publish']) && !!r.body.updatedAt, r.text.slice(0, 200));
  r = await http('GET', '/api/auth/me', UT);
  check('user effective menus follow the setting', sameSet(r.body.menus, ['dashboard', ...OFF1]), JSON.stringify(r.body.menus));

  const disabled = async (method: string, path: string, body?: unknown) => {
    const x = await http(method, path, UT, body);
    return x.status === 403 && x.body?.code === 'rbac.menu_disabled' ? true : `${x.status} ${x.body?.code ?? x.text.slice(0, 80)}`;
  };
  const denied = {
    analytics: await disabled('GET', '/api/analytics/summary?days=7'),
    trending: await disabled('GET', '/api/trending'),
    personaCreate: await disabled('POST', '/api/personas', { scope: 'mine', name: `rm-${tag}` }),
    personaInvalidBody: await disabled('POST', '/api/personas', { nonsense: true }),
    templates: await disabled('GET', '/api/comment-templates'),
    taskStats: await disabled('GET', '/api/tasks/stats'),
    taskCancel: await disabled('POST', '/api/tasks/00000000-0000-0000-0000-000000000000/cancel'),
    instanceActions: await disabled('POST', '/api/instances/actions', { ids: [], action: 'start' }),
    appsInstall: await disabled('POST', '/api/apps/install', {}),
  };
  check('disabled menus: their own endpoints → 403 rbac.menu_disabled (also before body validation)', Object.values(denied).every((v) => v === true), JSON.stringify(denied));
  const shared = await Promise.all(['/api/personas', '/api/tasks?limit=5', '/api/instances', '/api/instances/automation', '/api/social/accounts', '/api/media', '/api/dashboard', '/api/notifications']
    .map(async (p) => [p, (await http('GET', p, UT)).status] as const));
  check('shared endpoints still answer for the user', shared.every(([, s]) => s === 200), JSON.stringify(shared));
  const [dev] = await db.insert(schema.instances).values({ name: `rmfake-${tag}-s`, image: 'none', adbPort: 5592, status: 'stopped', spec: { width: 720, height: 1280, dpi: 320 } }).returning();
  fakeIds.push(dev!.id);
  await db.insert(schema.instanceGrants).values({ userId: userIds[0]!, instanceId: dev!.id });
  check('remote control session while 我的云机 is off → closed 4003', await sessionClose(UT, dev!.id) === 4003);
  r = await http('GET', `/api/instances/${dev!.id}/screenshot`, UT);
  check('device screenshot while 我的云机 is off → 403 rbac.menu_disabled', r.status === 403 && r.body.code === 'rbac.menu_disabled');
  const adminOk = await Promise.all(['/api/analytics/summary?days=7', '/api/trending', '/api/tasks/stats', '/api/comment-templates'].map(async (p) => (await http('GET', p, T)).status));
  check('admin unaffected (200 on every disabled menu)', adminOk.every((s) => s === 200), adminOk.join(','));

  // ---------------------------------------------------------------- endpoints shared by two menus
  r = await http('GET', '/api/publish/tasks', UT);
  check('publish runs with 排程发布 + 媒体管理 on → 200', r.status === 200, String(r.status));
  await http('PUT', '/api/settings/role-menus', T, { menus: ['social', 'content'] });
  r = await http('GET', '/api/publish/tasks', UT);
  check('publish runs with only 媒体管理 on → still 200 (shared)', r.status === 200, String(r.status));
  await http('PUT', '/api/settings/role-menus', T, { menus: ['content'] });
  const both = {
    publishRuns: await disabled('GET', '/api/publish/tasks'),
    socialCreate: await disabled('POST', '/api/social/accounts', { platform: 'instagram', handle: `rm${tag}` }),
    tracked: await disabled('GET', '/api/tracked-accounts'),
    mediaEdit: await disabled('PUT', '/api/media/00000000-0000-0000-0000-000000000000', { name: 'x' }),
  };
  check('排程发布 + 媒体管理 + 素材库 off → publish runs, account writes, tracked, media edits refused', Object.values(both).every((v) => v === true), JSON.stringify(both));
  r = await http('POST', '/api/media/upload', UT, {});
  check('media upload with 内容管理 still on → not refused by the menu switch', r.status !== 403, `${r.status} ${r.body?.code}`);
  r = await http('GET', '/api/social/accounts', UT);
  check('reading social accounts (content editor) still 200', r.status === 200);
  await http('PUT', '/api/settings/role-menus', T, { menus: [] });
  r = await http('POST', '/api/media/upload', UT, {});
  check('media upload with 素材库 and 内容管理 off → 403 rbac.menu_disabled', r.status === 403 && r.body.code === 'rbac.menu_disabled');
  r = await http('GET', '/api/auth/me', UT);
  check('no grantable menu → user menus = dashboard only', JSON.stringify(r.body.menus) === '["dashboard"]');

  // ---------------------------------------------------------------- re-enable
  r = await http('PUT', '/api/settings/role-menus', T, { menus: ALL });
  const again = await Promise.all(['/api/analytics/summary?days=7', '/api/trending', '/api/tasks/stats', '/api/publish/tasks', '/api/tracked-accounts'].map(async (p) => (await http('GET', p, UT)).status));
  check('re-enabled: every endpoint answers again', r.status === 200 && again.every((s) => s === 200), again.join(','));

  // ---------------------------------------------------------------- audit
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), eq(schema.auditLogs.action, 'settings.role_menus')));
  const okRows = audit.filter((a) => a.ok);
  check('audit settings.role_menus with the menu list (refused ones logged as failed)',
    okRows.some((a) => JSON.stringify((a.detail as any)?.menus) === JSON.stringify(['content'])) && audit.some((a) => !a.ok && a.status === 400), `${audit.length} rows`);

  // ---------------------------------------------------------------- device logs (系统日志 → 设备日志)
  const [dA, dB] = await db.insert(schema.instances).values([
    { name: `rmfake-${tag}-a`, image: 'none', adbPort: 5593, status: 'stopped', spec: { width: 720, height: 1280, dpi: 320 } },
    { name: `rmfake-${tag}-b`, image: 'none', adbPort: 5594, status: 'stopped', spec: { width: 720, height: 1280, dpi: 320 } },
  ]).returning();
  fakeIds.push(dA!.id, dB!.id);
  const base = Date.now() - 3600_000;
  const E = schema.instanceStatusEvents;
  await db.insert(E).values([
    { instanceId: dA!.id, field: 'status', from: 'stopped', to: 'starting', status: 'starting', at: new Date(base) },
    { instanceId: dA!.id, field: 'status', from: 'starting', to: 'running', status: 'running', at: new Date(base + 60_000) },
    { instanceId: dA!.id, field: 'adb', from: null, to: 'device', status: 'running', at: new Date(base + 120_000) },
    { instanceId: dA!.id, field: 'adb', from: 'device', to: 'offline', status: 'running', at: new Date(base + 180_000) }, // offline event
    { instanceId: dA!.id, field: 'adb', from: 'offline', to: 'device', status: 'running', at: new Date(base + 240_000) },
    { instanceId: dB!.id, field: 'status', from: 'running', to: 'error', status: 'error', at: new Date(base + 300_000) }, // offline event
    { instanceId: dB!.id, field: 'adb', from: 'device', to: null, status: 'stopping', at: new Date(base + 360_000) }, // transitional: not offline
  ]);
  const logs = (q: string, token = T) => http<{ items: any[]; total: number }>('GET', `/api/system/device-logs?${q}`, token);
  r = await logs(`instanceId=${dA!.id}`);
  check('device logs of A: 5 rows newest first, with the device name', r.status === 200 && r.body.total === 5 && r.body.items.length === 5
    && r.body.items[0].to === 'device' && r.body.items[4].to === 'starting' && r.body.items.every((x: any) => x.instanceName === `rmfake-${tag}-a`), r.text.slice(0, 200));
  r = await logs(`instanceId=${dA!.id}&type=adb`);
  check('type=adb on A → 3', r.body.total === 3 && r.body.items.every((x: any) => x.field === 'adb'));
  r = await logs(`instanceId=${dB!.id}&type=status`);
  check('type=status on B → 1 (error)', r.body.total === 1 && r.body.items[0].to === 'error' && r.body.items[0].offline === true);
  const offA = await logs(`instanceId=${dA!.id}&type=offline`);
  const offB = await logs(`instanceId=${dB!.id}&type=offline`);
  check('type=offline: adb lost while running + status → error; not during stopping', offA.body.total === 1 && offA.body.items[0].from === 'device' && offB.body.total === 1 && offB.body.items[0].field === 'status',
    `${offA.body.total} ${offB.body.total}`);
  r = await logs(`instanceId=${dA!.id}&from=${new Date(base + 90_000).toISOString()}&to=${new Date(base + 200_000).toISOString()}`);
  check('time range (from/to inclusive) → 2 rows', r.body.total === 2, String(r.body.total));
  const p1 = await logs(`instanceId=${dA!.id}&limit=2&offset=0`);
  const p2 = await logs(`instanceId=${dA!.id}&limit=2&offset=2`);
  const p3 = await logs(`instanceId=${dA!.id}&limit=2&offset=4`);
  const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((x: any) => x.id);
  check('paging: 2 + 2 + 1, total 5 on every page, no overlap', p1.body.total === 5 && p3.body.items.length === 1 && new Set(ids).size === 5);
  r = await logs('type=nope');
  check('bad type → 400', r.status === 400);
  r = await logs('', UT);
  check('user → 403 (admin only)', r.status === 403 && r.body.code === 'auth.admin_only', `${r.status} ${r.body?.code}`);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  if (prevRow) await db.insert(schema.settings).values({ key: 'rbac.userMenus', value: prevRow.value }).onConflictDoUpdate({ target: schema.settings.key, set: { value: prevRow.value } });
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'rbac.userMenus'));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  const left = fakeIds.length ? await db.select().from(schema.instances).where(inArray(schema.instances.id, fakeIds)) : [];
  check('cleanup: placeholder devices + user removed, setting restored', left.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
