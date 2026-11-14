/**
 * Social accounts (社交账号) test through the public API against the real API + DB (no mocks).
 * - Creates no Android container: device links use placeholder `instances` rows (adb ports 5586–5589, no containers);
 *   one is deleted through the real device delete job to verify that accounts are unlinked and logged.
 * - Creates two temporary users (A, B) with generated passwords and removes everything afterwards.
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/social-check.ts
 */
import { randomBytes } from 'node:crypto';
import { eq, inArray, like } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 500)); }
}
const logsOf = async (token: string, id: string) => (await http('GET', `/api/social/accounts/${id}/logs`, token)).body.logs as any[];

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const h = (s: string) => `sc_${tag}_${s}`;
const userIds: string[] = [];
const fakeIds: string[] = [];
let proxyId = '';
const [limitsBefore] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'social.limits'));
const t0 = new Date();

try {
  // ---------------------------------------------------------------- setup: users + placeholder devices
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `sc${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`sca${tag}`, pw);
  const B = await login(`scb${tag}`, pw);
  const fakes = await db.insert(schema.instances).values([1, 2, 3, 4].map((n) => ({
    name: `scfake-${tag}-${n}`, image: 'none', adbPort: 5585 + n, status: 'stopped' as const, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning();
  fakeIds.push(...fakes.map((f) => f.id));
  const [D1, D2, D3, D4] = fakes as [typeof fakes[0], typeof fakes[0], typeof fakes[0], typeof fakes[0]];
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: [D1.id] });
  await http('PUT', `/api/users/${uB}/grants`, T, { instanceIds: [D2.id] });

  // ---------------------------------------------------------------- platforms + limits setting
  let r = await http('GET', '/api/social/platforms', A);
  check('platform registry: instagram/youtube/tiktok, default limit 1',
    r.status === 200 && ['instagram', 'youtube', 'tiktok'].every((p) => r.body.platforms.some((x: any) => x.id === p && x.limit === 1)), r.text);
  r = await http('GET', '/api/social/settings', A);
  check('user: GET limits settings → 403', r.status === 403);
  r = await http('PUT', '/api/social/settings', A, { limits: { instagram: 5 } });
  check('user: PUT limits settings → 403', r.status === 403);
  r = await http('PUT', '/api/social/settings', T, { limits: { myspace: 2 } });
  check('admin: unknown platform in limits → 400', r.status === 400);
  r = await http('PUT', '/api/social/settings', T, { limits: { instagram: 0 } });
  check('admin: limit 0 → 400', r.status === 400);
  r = await http('PUT', '/api/social/settings', T, { limits: { instagram: 1, youtube: 1, tiktok: 1 } });
  check('admin: save limits', r.status === 200 && r.body.limits.instagram === 1);

  // ---------------------------------------------------------------- create + validation
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: `@${h('Alpha')}`, displayName: 'Alpha', notes: 'n1', password: 'should-be-ignored' });
  check('user A: create instagram account (201), leading @ stripped, profile URL derived',
    r.status === 201 && r.body.account.handle === h('Alpha') && r.body.account.profileUrl === `https://www.instagram.com/${h('Alpha')}/` && r.body.account.userId === uA, r.text.slice(0, 200));
  const a1: string = r.body.account.id;
  check('no password field is stored or returned', !('password' in r.body.account) && !Object.keys(r.body.account).some((k) => /pass/i.test(k)));
  r = await http('POST', '/api/social/accounts', B, { platform: 'instagram', handle: h('ALPHA') });
  check('duplicate (platform, lower(handle)) across owners → 409 social.account_exists', r.status === 409 && r.body.code === 'social.account_exists', r.text);
  r = await http('POST', '/api/social/accounts', A, { platform: 'youtube', handle: h('Alpha') });
  check('same handle on another platform is allowed', r.status === 201, r.text);
  const y1: string = r.body.account.id;
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: 'bad handle!' });
  check('invalid handle → 400', r.status === 400);
  r = await http('POST', '/api/social/accounts', A, { platform: 'myspace', handle: h('x') });
  check('unknown platform → 400', r.status === 400);
  r = await http('POST', '/api/social/accounts', A, { platform: 'tiktok', handle: h('x'), profileUrl: 'javascript:alert(1)' });
  check('non-http profile URL → 400', r.status === 400);
  r = await http('POST', '/api/social/accounts', A, { platform: 'tiktok', handle: h('x'), ownerId: uB });
  check('user cannot create for another owner → 403', r.status === 403 && r.body.code === 'social.admin_only', r.text);
  r = await http('POST', '/api/social/accounts', T, { platform: 'tiktok', handle: h('Bee'), ownerId: uB });
  check('admin creates an account for user B', r.status === 201 && r.body.account.userId === uB && r.body.account.ownerName === `scb${tag}`);
  const b1: string = r.body.account.id;

  // ---------------------------------------------------------------- device links: grants + limit
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { instanceId: D2.id });
  check('user A: link to a device without grant → 403', r.status === 403 && r.body.code === 'auth.no_instance_access', r.text);
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { instanceId: '00000000-0000-4000-8000-000000000000' });
  check('link to a missing device → 404', r.status === 404 && r.body.code === 'instances.not_found', r.text);
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { instanceId: D1.id });
  check('user A: link to granted device', r.status === 200 && r.body.account.instance?.id === D1.id && r.body.account.instance.accessible === true, r.text);
  r = await http('POST', '/api/social/accounts', A, { platform: 'instagram', handle: h('Second'), instanceId: D1.id });
  check('second instagram account on the same device → 409 social.device_limit', r.status === 409 && r.body.code === 'social.device_limit' && r.body.params?.limit === 1, r.text);
  check('refused create left no row', (await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.handle, h('Second')))).length === 0);
  r = await http('PUT', `/api/social/accounts/${y1}`, A, { instanceId: D1.id });
  check('a youtube account on the same device is allowed (per-platform limit)', r.status === 200);
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { instanceId: D1.id, notes: 'n1' });
  check('re-saving the same link does not count itself', r.status === 200);

  // Race: 6 concurrent links of different instagram accounts to one device, limit 1 → exactly 1 wins.
  const raceIds: string[] = [];
  for (let i = 0; i < 6; i++) raceIds.push((await http('POST', '/api/social/accounts', T, { platform: 'instagram', handle: h(`race${i}`) })).body.account.id);
  let rs = await Promise.all(raceIds.map((id) => http('PUT', `/api/social/accounts/${id}`, T, { instanceId: D3.id })));
  let [{ n } = { n: 0 }] = await sqlClient`select count(*)::int as n from social_accounts where instance_id = ${D3.id} and platform = 'instagram'` as any;
  check('concurrent links (limit 1): exactly 1 succeeds, others 409', rs.filter((x) => x.status === 200).length === 1 && rs.filter((x) => x.status === 409 && x.body.code === 'social.device_limit').length === 5 && n === 1,
    `${rs.map((x) => x.status)} n=${n}`);
  // Race: 6 concurrent creates with a device, limit 3 → exactly 3.
  await http('PUT', '/api/social/settings', T, { limits: { instagram: 3 } });
  rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => http('POST', '/api/social/accounts', T, { platform: 'instagram', handle: h(`rc${i}`), instanceId: D4.id })));
  [{ n } = { n: 0 }] = await sqlClient`select count(*)::int as n from social_accounts where instance_id = ${D4.id} and platform = 'instagram'` as any;
  check('concurrent creates (limit 3): exactly 3 succeed', rs.filter((x) => x.status === 201).length === 3 && n === 3, `${rs.map((x) => x.status)} n=${n}`);
  await http('PUT', '/api/social/settings', T, { limits: { instagram: 1 } });
  r = await http('PUT', `/api/social/accounts/${b1}`, T, { instanceId: D1.id });
  check('admin may link any owner\'s account to any device', r.status === 200 && r.body.account.instance?.id === D1.id);
  r = await http('GET', `/api/social/accounts/${b1}`, B);
  check('owner without a grant sees the device as not accessible and no proxy', r.status === 200 && r.body.account.instance?.accessible === false && r.body.account.proxy === null);

  // ---------------------------------------------------------------- derived proxy
  const [px] = await db.insert(schema.proxies).values({ label: `sc-${tag}`, type: 'socks5', host: '192.0.2.77', port: 1080, username: 'scuser', passwordEnc: 'v1:dummy' }).returning();
  proxyId = px!.id;
  await db.update(schema.instances).set({ proxyId }).where(eq(schema.instances.id, D1.id));
  r = await http('GET', `/api/social/accounts/${a1}`, A);
  check('proxy is derived from the device (no credentials)', r.body.account.proxy?.id === proxyId && r.body.account.proxy.host === '192.0.2.77'
    && !r.text.includes('scuser') && !r.text.includes('v1:dummy') && r.body.account.proxy.hasAuth === true, r.text.slice(0, 300));
  await db.update(schema.instances).set({ proxyId: null }).where(eq(schema.instances.id, D1.id));
  r = await http('GET', `/api/social/accounts/${a1}`, A);
  check('device proxy removed → account shows no proxy', r.body.account.proxy === null);

  // ---------------------------------------------------------------- isolation (404 for others' rows)
  r = await http('GET', `/api/social/accounts/${a1}`, B);
  check('user B: GET A\'s account → 404', r.status === 404 && r.body.code === 'social.not_found');
  r = await http('PUT', `/api/social/accounts/${a1}`, B, { notes: 'x' });
  check('user B: PUT A\'s account → 404', r.status === 404);
  r = await http('POST', `/api/social/accounts/${a1}/checked`, B, {});
  check('user B: mark A\'s account checked → 404', r.status === 404);
  r = await http('GET', `/api/social/accounts/${a1}/logs`, B);
  check('user B: A\'s logs → 404', r.status === 404);
  r = await http('DELETE', `/api/social/accounts/${a1}`, B);
  check('user B: DELETE A\'s account → 404', r.status === 404);
  r = await http('POST', '/api/social/accounts/batch', B, { ids: [a1, b1], action: 'unlink' });
  check('user B: batch including A\'s account → 404, nothing changed', r.status === 404 && (await http('GET', `/api/social/accounts/${b1}`, T)).body.account.instance?.id === D1.id);
  r = await http('GET', '/api/social/accounts?pageSize=200', B);
  check('user B: list shows only own accounts', r.body.items.every((x: any) => x.userId === uB) && r.body.items.some((x: any) => x.id === b1));
  r = await http('GET', `/api/social/accounts?ownerId=${uA}`, B);
  check('user B: ownerId filter is ignored (still only own)', r.body.items.every((x: any) => x.userId === uB));
  r = await http('GET', `/api/social/accounts?ownerId=${uA}&pageSize=200`, T);
  check('admin: list filtered by owner', r.body.items.length === 2 && r.body.items.every((x: any) => x.userId === uA && x.ownerName === `sca${tag}`));

  // ---------------------------------------------------------------- groups
  r = await http('POST', '/api/social/groups', A, { name: 'Main' });
  check('user A: create group', r.status === 201);
  const gA: string = r.body.group.id;
  r = await http('POST', '/api/social/groups', A, { name: 'MAIN' });
  check('duplicate group name (case-insensitive, same owner) → 409', r.status === 409 && r.body.code === 'social.group_exists');
  r = await http('POST', '/api/social/groups', B, { name: 'Main' });
  check('same group name for another user is fine', r.status === 201);
  const gB: string = r.body.group.id;
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { groupId: gB });
  check('user A: assign B\'s group → 404', r.status === 404 && r.body.code === 'social.group_not_found');
  r = await http('PUT', `/api/social/accounts/${b1}`, T, { groupId: gA });
  check('admin: group of another owner → 409 social.group_owner_mismatch', r.status === 409 && r.body.code === 'social.group_owner_mismatch');
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { groupId: gA });
  check('user A: move account into own group', r.status === 200 && r.body.account.groupName === 'Main');
  r = await http('GET', '/api/social/groups', A);
  check('user A: groups list = own only, with counts', r.body.groups.length === 1 && r.body.groups[0].count === 1);
  r = await http('GET', `/api/social/groups?ownerId=${uB}`, T);
  check('admin: groups of user B', r.body.groups.length === 1 && r.body.groups[0].id === gB);
  r = await http('PUT', `/api/social/groups/${gA}`, B, { name: 'hijack' });
  check('user B: rename A\'s group → 404', r.status === 404);
  r = await http('GET', `/api/social/accounts?groupId=${gA}`, A);
  check('filter by group', r.body.total === 1 && r.body.items[0].id === a1);
  r = await http('GET', '/api/social/accounts?groupId=none', A);
  check('filter ungrouped', r.body.total === 1 && r.body.items[0].id === y1);

  // ---------------------------------------------------------------- tags
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { tags: [`Foo${tag}`, `bar${tag}`, `FOO${tag}`] });
  check('tags deduplicated case-insensitively', r.status === 200 && r.body.account.tags.length === 2, JSON.stringify(r.body.account?.tags));
  r = await http('PUT', `/api/social/accounts/${y1}`, A, { tags: [`FOO${tag}`] });
  check('existing tag spelling wins', r.body.account.tags[0] === `Foo${tag}`, JSON.stringify(r.body.account?.tags));
  r = await http('GET', `/api/social/accounts?tags=foo${tag}`, A);
  check('tag filter (case-insensitive)', r.body.total === 2);
  r = await http('GET', `/api/social/accounts?tags=foo${tag},BAR${tag}`, A);
  check('multi-tag filter = all tags', r.body.total === 1 && r.body.items[0].id === a1);
  r = await http('GET', '/api/social/tags', B);
  check('user B: tag suggestions exclude A\'s tags', !r.body.tags.includes(`Foo${tag}`));
  r = await http('POST', '/api/social/accounts/batch', A, { ids: [a1, y1], action: 'add-tags', tags: [`baz${tag}`] });
  check('batch add tags', r.status === 200 && r.body.changed === 2);
  r = await http('POST', '/api/social/accounts/batch', A, { ids: [a1, y1], action: 'remove-tags', tags: [`FOO${tag}`] });
  check('batch remove tags (case-insensitive)', r.status === 200 && r.body.changed === 2 && (await http('GET', `/api/social/accounts?tags=foo${tag}`, A)).body.total === 0);
  r = await http('GET', `/api/social/accounts?q=${encodeURIComponent(`baz${tag}`)}`, A);
  check('search matches tags', r.body.total === 2);
  r = await http('GET', `/api/social/accounts?q=${encodeURIComponent(h('alpha'))}&platform=youtube`, A);
  check('search + platform filter', r.body.total === 1 && r.body.items[0].id === y1);
  r = await http('GET', `/api/social/accounts?pageSize=1&page=2`, A);
  check('pagination', r.body.total === 2 && r.body.items.length === 1 && r.body.page === 2);

  // ---------------------------------------------------------------- status + checks + exception filter
  r = await http('GET', '/api/social/accounts?exception=true', A);
  check('no exceptions yet (unknown login is not an exception)', r.body.total === 0);
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { loginStatus: 'needs_verification' });
  check('set login status', r.status === 200 && r.body.account.loginStatus === 'needs_verification' && r.body.account.exception === true);
  r = await http('PUT', `/api/social/accounts/${y1}`, A, { accountStatus: 'limited', lastError: 'upload blocked' });
  r = await http('GET', '/api/social/accounts?exception=true', A);
  check('exception filter: login problem + limited account', r.body.total === 2);
  r = await http('POST', `/api/social/accounts/${a1}/checked`, A, { loginStatus: 'logged_in', message: 'verified on phone' });
  check('mark checked sets last_checked_at + status', r.status === 200 && !!r.body.account.lastCheckedAt && r.body.account.loginStatus === 'logged_in' && r.body.account.exception === false);
  r = await http('POST', `/api/social/accounts/${y1}/checked`, A, { accountStatus: 'active', lastError: '' });
  check('check clears last error', r.body.account.lastError === null && r.body.account.exception === false);
  r = await http('GET', '/api/social/accounts?exception=true', A);
  check('exception filter empty again', r.body.total === 0);
  r = await http('GET', '/api/social/accounts?loginStatus=logged_in', A);
  check('login status filter', r.body.total === 1 && r.body.items[0].id === a1);
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { loginStatus: 'bogus' });
  check('invalid status → 400', r.status === 400);

  // ---------------------------------------------------------------- logs
  const L = await logsOf(A, a1);
  const has = (action: string, field: string | null, pred: (l: any) => boolean = () => true) => L.some((l) => l.action === action && l.field === field && pred(l));
  check('log: create', has('create', null, (l) => l.actorName === `sca${tag}`));
  check('log: link (to device name)', has('link', 'device', (l) => l.toValue === D1.name));
  check('log: group change', has('update', 'group', (l) => l.fromValue === null && l.toValue === 'Main'));
  check('log: tags change', has('update', 'tags'));
  check('log: login status from → to', has('status', 'loginStatus', (l) => l.fromValue === 'unknown' && l.toValue === 'needs_verification'));
  check('log: checked with message', has('checked', null, (l) => l.message === 'verified on phone'));
  check('log: no entry for a no-op save', L.filter((l) => l.field === 'notes').length === 0);
  r = await http('PUT', `/api/social/accounts/${a1}`, A, { notes: 'changed' });
  check('log: notes change', (await logsOf(A, a1)).some((l) => l.field === 'notes' && l.fromValue === 'n1' && l.toValue === 'changed'));
  const raceLinkLogs = await sqlClient`select count(*)::int as n from social_account_logs where account_id in ${sqlClient(raceIds)} and action = 'link'`;
  check('race: exactly one link log (refused links write none)', (raceLinkLogs[0] as any).n === 1);

  // ---------------------------------------------------------------- batch move group / unlink
  r = await http('POST', '/api/social/accounts/batch', A, { ids: [a1, y1], action: 'move-group', groupId: gA });
  check('batch move group (only moved rows count)', r.status === 200 && r.body.changed === 1);
  r = await http('POST', '/api/social/accounts/batch', A, { ids: [y1], action: 'unlink' });
  check('batch unlink', r.status === 200 && r.body.changed === 1 && (await logsOf(A, y1)).some((l) => l.action === 'unlink' && l.fromValue === D1.name));
  r = await http('PUT', `/api/social/accounts/${y1}`, A, { instanceId: D1.id });

  // ---------------------------------------------------------------- group deletion
  r = await http('DELETE', `/api/social/groups/${gA}`, A);
  check('delete group → accounts ungrouped + logged', r.status === 204 && (await http('GET', `/api/social/accounts/${a1}`, A)).body.account.groupId === null
    && (await logsOf(A, a1)).some((l) => l.field === 'group' && l.message === 'group deleted'));

  // ---------------------------------------------------------------- device deletion (real delete job) unlinks + logs
  const del = await http('POST', '/api/instances/actions', T, { action: 'delete', ids: [D1.id] });
  check('delete placeholder device via the device API', del.status < 300, del.text.slice(0, 200));
  await waitFor('device deleted', async () => (await http('GET', `/api/instances/${D1.id}`, T)).status === 404, 90_000);
  fakeIds.splice(fakeIds.indexOf(D1.id), 1);
  for (const [id, tok, who] of [[a1, A, 'a1'], [y1, A, 'y1'], [b1, T, 'b1']] as const) {
    const acc = (await http('GET', `/api/social/accounts/${id}`, tok)).body.account;
    const ul = (await logsOf(tok, id)).find((l) => l.action === 'unlink' && l.message === 'device deleted');
    check(`device deletion: ${who} unlinked + system log (from ${D1.name})`, acc.instanceId === null && !!ul && ul.fromValue === D1.name && ul.actorId === null);
  }
  // FK backstop for a raw delete
  const rawAcc = (await http('POST', '/api/social/accounts', T, { platform: 'tiktok', handle: h('raw'), instanceId: D2.id })).body.account.id;
  await db.delete(schema.instances).where(eq(schema.instances.id, D2.id));
  fakeIds.splice(fakeIds.indexOf(D2.id), 1);
  const [raw] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, rawAcc));
  check('FK backstop: raw device delete sets instance_id null', raw?.instanceId === null);

  // ---------------------------------------------------------------- delete account
  r = await http('DELETE', `/api/social/accounts/${y1}`, A);
  check('user A: delete own account', r.status === 204 && (await http('GET', `/api/social/accounts/${y1}`, A)).status === 404);
  r = await http('POST', '/api/social/accounts/batch', T, { ids: raceIds, action: 'delete' });
  check('admin: batch delete', r.status === 200 && (await db.select().from(schema.socialAccounts).where(inArray(schema.socialAccounts.id, raceIds))).length === 0);

  // ---------------------------------------------------------------- audit
  await new Promise((res) => setTimeout(res, 800));
  const acts = await db.select().from(schema.auditLogs).where(like(schema.auditLogs.action, 'social.%'));
  const recent = acts.filter((a) => a.at >= t0);
  const actSet = new Set(recent.map((a) => a.action));
  const want = ['social.account_create', 'social.account_update', 'social.account_checked', 'social.account_delete', 'social.batch.add-tags',
    'social.batch.unlink', 'social.batch.move-group', 'social.batch.delete', 'social.group_create', 'social.group_delete', 'social.settings_update'];
  check('audit actions recorded', want.every((x) => actSet.has(x)), want.filter((x) => !actSet.has(x)).join(','));
  check('audit target for account update is "platform @handle"', recent.some((a) => a.action === 'social.account_update' && a.target === `instagram @${h('Alpha')}`));
  check('audit delete keeps the target name', recent.some((a) => a.action === 'social.account_delete' && a.target === `youtube @${h('Alpha')}`));
  check('audit never stores notes or error text', !recent.some((a) => JSON.stringify(a.detail).includes('upload blocked') || JSON.stringify(a.detail).includes('verified on phone')));

  // ---------------------------------------------------------------- user deletion cascades
  r = await http('DELETE', `/api/users/${uB}`, T);
  const leftB = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.userId, uB));
  const leftG = await db.select().from(schema.socialAccountGroups).where(eq(schema.socialAccountGroups.userId, uB));
  check('deleting a user removes their accounts and groups (cascade)', r.status === 204 && leftB.length === 0 && leftG.length === 0, r.text);
  userIds.splice(userIds.indexOf(uB), 1);
  const aLogs = await logsOf(A, a1);
  check('logs written by a deleted actor survive (actor name kept)', aLogs.length > 0);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(schema.socialAccounts).where(like(schema.socialAccounts.handle, `sc_${tag}_%`));
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  if (proxyId) await db.delete(schema.proxies).where(eq(schema.proxies.id, proxyId));
  if (limitsBefore) await db.update(schema.settings).set({ value: limitsBefore.value }).where(eq(schema.settings.key, 'social.limits'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'social.limits'));
  const left = await db.select().from(schema.socialAccounts).where(like(schema.socialAccounts.handle, `sc_${tag}_%`));
  const leftDev = await db.select().from(schema.instances).where(like(schema.instances.name, `scfake-${tag}-%`));
  check('cleanup: test accounts, devices, users removed', left.length === 0 && leftDev.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
