/**
 * Proxy pool (代理管理) test through the public API against real infrastructure (no mocks).
 * - Needs a reachable test proxy from the API host: `cp-testproxy2` (sing-box mixed inbound, user cpuser /
 *   cp-test-pass) published on the Android VM port 18090, which Lima forwards to 127.0.0.1:18090:
 *     docker run -d --name cp-testproxy2 -p 0.0.0.0:18090:1080 -v /srv/cloudphone/proto/testproxy:/etc/sing-box:ro \
 *       ghcr.io/sagernet/sing-box:v1.14.4 run -c /etc/sing-box/config.json
 *   (override with POOL_TEST_PROXY=host:port).
 * - Creates no Android container: binding is exercised on placeholder device rows whose sidecar id does not exist
 *   (set-proxy then only writes the sidecar config, which is verified to carry the decrypted password).
 *   Device-level traffic/kill-switch is covered by scripts/proxy-check.ts.
 * - Requires that the pool has no free usable proxies other than the ones it creates (concurrency test).
 * - Also covers the IP kind (static/dynamic/mobile) and POST /api/proxies/test (unsaved config probe). The parts of
 *   the test-endpoint check that need a working proxy are reported as SKIP when the test proxy is unreachable.
 * Usage (from apps/api, API running): npx tsx --env-file=<env> scripts/proxy-pool-check.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { inArray, like, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { assignFreeProxies, countFreeUsable, isUniqueViolation } from '../src/modules/proxies/pool.js';

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const [PHOST, PPORT] = (process.env.POOL_TEST_PROXY ?? '127.0.0.1:18090').split(':') as [string, string];
const PW = 'cp-test-pass';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const mask = (ip: string | null | undefined) => (ip ? ip.replace(/\.\d+\.\d+$/, '.x.x') : String(ip));

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
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 1000)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skipped: string[] = [];
const skip = (name: string, why: string) => { skipped.push(name); console.log(`- SKIP ${name} — ${why}`); };
const reachable = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host, port, timeout: 3000 }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false)).on('timeout', () => { s.destroy(); resolve(false); });
});
const PROXY_UP = await reachable(PHOST, Number(PPORT));
if (!PROXY_UP) console.log(`! test proxy ${PHOST}:${PPORT} is not reachable: checks that need a working proxy will fail or be skipped`);

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const waitTask = (taskId: string) => waitFor('task', async () => {
  const t = (await http('GET', '/api/tasks?limit=100', T)).body.tasks.find((x: any) => x.id === taskId);
  return t && (t.status === 'success' || t.status === 'failed') ? t : null;
});

const created: string[] = [];
const fakeIds: string[] = [];
let userId = '';
try {
  // Precondition: no foreign free usable proxies (they'd be picked by the concurrency test).
  const foreign = await countFreeUsable();
  if (foreign > 0) throw new Error(`pool already has ${foreign} free usable proxies; run on a clean pool`);

  // ---------------------------------------------------------------- CRUD + secrecy
  const good = { label: 'pp-test-good', type: 'socks5', host: PHOST, port: Number(PPORT), username: 'cpuser', password: PW, provider: 'test', notes: 'sing-box in VM' };
  let r = await http('POST', '/api/proxies', T, good);
  check('create pool proxy (201)', r.status === 201, r.text.slice(0, 120));
  const goodId: string = r.body.proxy.id; created.push(goodId);
  check('response never contains the password', !r.text.includes(PW) && !('password' in r.body.proxy) && !('passwordEnc' in r.body.proxy) && r.body.proxy.hasPassword === true);
  check('kind defaults to static', r.body.proxy.kind === 'static', r.body.proxy.kind);
  r = await http('POST', '/api/proxies', T, { ...good, label: 'dup', password: 'other' });
  check('duplicate endpoint (type, host, port, user) refused 409', r.status === 409 && r.body.code === 'proxy.duplicate', r.body?.code);
  r = await http('POST', '/api/proxies', T, { ...good, label: 'pp-test-http', type: 'http', kind: 'dynamic' });
  check('same host/port as HTTP is a different pool entry', r.status === 201);
  check('create with kind dynamic', r.body.proxy?.kind === 'dynamic', r.body.proxy?.kind);
  const httpId: string = r.body.proxy.id; created.push(httpId);
  r = await http('POST', '/api/proxies', T, { label: 'pp-test-bad', type: 'socks5', host: PHOST, port: Number(PPORT), username: 'cpuser-wrong', password: 'wrong-pass' });
  const badId: string = r.body.proxy.id; created.push(badId);
  r = await http('POST', '/api/proxies', T, { type: 'socks5', host: '192.0.2.1', port: 1080, kind: 'satellite' });
  check('unknown kind rejected 400', r.status === 400);
  r = await http('PUT', `/api/proxies/${badId}`, T, { kind: 'mobile' });
  check('update kind → mobile (no re-apply, status kept)', r.status === 200 && r.body.proxy.kind === 'mobile' && r.body.taskId === null && r.body.proxy.status === 'unchecked');
  r = await http('GET', '/api/proxies?kind=mobile', T);
  check('list filter kind=mobile', r.status === 200 && r.body.proxies.some((p: any) => p.id === badId) && r.body.proxies.every((p: any) => p.kind === 'mobile'));
  check('list returns per-kind counts (unfiltered)', typeof r.body.kindCounts?.static === 'number' && r.body.kindCounts.static >= 1 && r.body.kindCounts.dynamic >= 1 && r.body.kindCounts.mobile >= 1, JSON.stringify(r.body.kindCounts));
  r = await http('GET', '/api/proxies', T);
  check('list without kind returns every kind, each with its kind', ['static', 'dynamic', 'mobile'].every((k) => r.body.proxies.some((p: any) => p.kind === k)));
  r = await http('GET', `/api/proxies?q=${encodeURIComponent('pp-test-http, pp-test-bad')}`, T);
  check('search q: comma-separated terms match any', r.body.proxies.length === 2 && r.body.proxies.some((p: any) => p.id === httpId) && r.body.proxies.some((p: any) => p.id === badId), String(r.body.proxies?.length));
  r = await http('POST', '/api/proxies', T, { type: 'socks5', host: 'bad host!', port: 1080 });
  check('invalid host rejected 400', r.status === 400);
  r = await http('POST', '/api/proxies', T, { type: 'socks5', host: '192.0.2.1', port: 1080, password: 'x' });
  check('password without username rejected 400', r.status === 400 && r.body.code === 'proxy.password_without_username');

  r = await http('PUT', `/api/proxies/${goodId}`, T, { label: 'pp-test-good', notes: 'edited', city: 'Lab' });
  const [encBefore] = await db.select({ e: schema.proxies.passwordEnc }).from(schema.proxies).where(inArray(schema.proxies.id, [goodId]));
  check('edit without password keeps it (write-only)', r.status === 200 && r.body.proxy.hasPassword === true && r.body.proxy.notes === 'edited' && r.body.taskId === null);
  const stored = await sqlClient`select password_enc from proxies where id = ${goodId}`;
  check('password stored encrypted (v1: AES-GCM), not plaintext', String(stored[0]!.password_enc).startsWith('v1:') && !String(stored[0]!.password_enc).includes(PW) && stored[0]!.password_enc === encBefore!.e);
  const leaks = await sqlClient`select (select count(*) from proxies where proxies::text like ${'%' + PW + '%'})::int as p,
    (select count(*) from instances where instances::text like ${'%' + PW + '%'})::int as i,
    (select count(*) from audit_logs where audit_logs::text like ${'%' + PW + '%'})::int as a`;
  check('no plaintext password anywhere in proxies/instances/audit_logs', leaks[0]!.p === 0 && leaks[0]!.i === 0 && leaks[0]!.a === 0, JSON.stringify(leaks[0]));
  r = await http('GET', '/api/proxies', T);
  check('list never contains the password', r.status === 200 && !r.text.includes(PW) && !r.text.includes('passwordEnc') && !r.text.includes('v1:'));

  // ---------------------------------------------------------------- checks from the API host through the proxy
  r = await http('POST', `/api/proxies/${goodId}/check`, T);
  const gp = r.body.proxy;
  check('check through SOCKS5 proxy: ok + egress IP + latency', gp.status === 'ok' && !!gp.lastCheck?.egressIp && typeof gp.lastCheck?.latencyMs === 'number',
    `egress=${mask(gp.lastCheck?.egressIp)} ${gp.lastCheck?.latencyMs}ms geo=${gp.lastCheck?.country ?? '-'}/${gp.lastCheck?.city ? '…' : '-'}`);
  check('geo lookup recorded (country)', !!gp.lastCheck?.country, gp.lastCheck?.country ?? 'no geo (rate-limited?)');
  r = await http('POST', `/api/proxies/${badId}/check`, T);
  check('wrong credentials → failed with error', r.body.proxy.status === 'failed' && !r.body.proxy.lastCheck.egressIp && !!r.body.proxy.lastCheck.error, r.body.proxy.lastCheck.error?.slice(0, 80));
  r = await http('POST', '/api/proxies/check', T, { ids: [goodId, httpId, badId] });
  check('batch check: 2 ok (SOCKS5 + HTTP CONNECT), 1 failed', r.body.ok === 2 && r.body.failed === 1, `ok=${r.body.ok} failed=${r.body.failed}`);
  const audit0 = await sqlClient`select count(*)::int as n from audit_logs where path like '/api/proxies%check'`;
  check('checks are not audit-logged (probe)', audit0[0]!.n === 0);

  // ---------------------------------------------------------------- POST /api/proxies/test (unsaved config, stores nothing)
  const TEST_PW = `pp-test-secret-${randomBytes(4).toString('hex')}`;
  const countBefore = (await http('GET', '/api/proxies', T)).body.proxies.length;
  r = await http('POST', '/api/proxies/test', T, { type: 'socks5', host: '127.0.0.1', port: 1, username: 'nobody', password: TEST_PW });
  check('test: closed port → ok=false with error, no egress IP', r.status === 200 && r.body.result?.ok === false && !r.body.result.egressIp && !!r.body.result.error, r.body.result?.error?.slice(0, 80) ?? r.text.slice(0, 120));
  check('test: response never contains the password', !r.text.includes(TEST_PW) && !('password' in (r.body.result ?? {})));
  r = await http('POST', '/api/proxies/test', T, { type: 'http', host: '192.0.2.1', port: 70000 });
  check('test: invalid port rejected 400', r.status === 400);
  r = await http('POST', '/api/proxies/test', T, { type: 'socks5', host: '127.0.0.1', port: 1, password: 'x' });
  check('test: password without username → 400 proxy.password_without_username', r.status === 400 && r.body.code === 'proxy.password_without_username');
  r = await http('POST', '/api/proxies/test', T, { type: 'socks5', host: '127.0.0.1', port: 1, id: '00000000-0000-4000-8000-000000000000' });
  check('test: unknown id → 404 proxy.not_found', r.status === 404 && r.body.code === 'proxy.not_found');
  if (PROXY_UP) {
    r = await http('POST', '/api/proxies/test', T, { type: 'socks5', host: PHOST, port: Number(PPORT), username: 'cpuser', password: PW });
    check('test: working config → ok + egress IP + latency', r.body.result?.ok === true && !!r.body.result.egressIp && typeof r.body.result.latencyMs === 'number' && !r.text.includes(PW),
      `egress=${mask(r.body.result?.egressIp)} ${r.body.result?.latencyMs}ms`);
    r = await http('POST', '/api/proxies/test', T, { type: 'socks5', host: PHOST, port: Number(PPORT), username: 'cpuser', password: '', id: goodId });
    check('test: editing with empty password falls back to the stored one', r.body.result?.ok === true && !r.text.includes(PW));
    r = await http('POST', '/api/proxies/test', T, { type: 'socks5', host: PHOST, port: Number(PPORT), username: 'cpuser', password: '' });
    check('test: empty password without id is not filled in → fails', r.body.result?.ok === false);
    r = await http('POST', '/api/proxies/test', T, { type: 'socks5', host: PHOST, port: Number(PPORT), username: 'cpuser-wrong', password: 'wrong-pass' });
    check('test: wrong credentials → ok=false', r.body.result?.ok === false && !!r.body.result.error);
  } else {
    for (const n of ['test: working config → ok + egress IP', 'test: empty password + id falls back to the stored one', 'test: empty password without id fails', 'test: wrong credentials → ok=false']) {
      skip(n, `test proxy ${PHOST}:${PPORT} unreachable`);
    }
  }
  check('test stores nothing', (await http('GET', '/api/proxies', T)).body.proxies.length === countBefore);
  await sleep(500); // audit writes are fire-and-forget
  const auditTest = await sqlClient`select count(*)::int as n from audit_logs where path like '/api/proxies/test%'`;
  const leakTest = await sqlClient`select (select count(*) from audit_logs where audit_logs::text like ${'%' + TEST_PW + '%'})::int
    + (select count(*) from proxies where proxies::text like ${'%' + TEST_PW + '%'})::int + (select count(*) from task_logs where task_logs::text like ${'%' + TEST_PW + '%'})::int as n`;
  check('test endpoint not audit-logged, password stored nowhere', auditTest[0]!.n === 0 && leakTest[0]!.n === 0, `audit=${auditTest[0]!.n} leaks=${leakTest[0]!.n}`);

  // ---------------------------------------------------------------- bulk import
  const text = [
    'socks5://imp-u1:imp-secret-1@203.0.113.10:1080',
    'http://203.0.113.11:3128',
    '203.0.113.12:1080:imp-u3:imp-secret-3',
    '203.0.113.13:8000',
    '# comment',
    'socks5://imp-u1:imp-secret-1@203.0.113.10:1080',
    'not a proxy',
    'ftp://203.0.113.14:21',
    `socks5://cpuser:whatever@${PHOST}:${PPORT}`,
    '203.0.113.15:99999',
  ].join('\n');
  const before = (await http('GET', '/api/proxies', T)).body.proxies.length;
  r = await http('POST', '/api/proxies/import', T, { text, defaultType: 'http', dryRun: true });
  const st = (x: any) => x.results.map((l: any) => `${l.line}:${l.status}`).join(' ');
  const expected = '1:created 2:created 3:created 4:created 6:duplicate 7:invalid 8:invalid 9:duplicate 10:invalid';
  check('import dry-run: per-line created/duplicate/invalid', st(r.body) === expected, st(r.body));
  check('dry-run inserts nothing', (await http('GET', '/api/proxies', T)).body.proxies.length === before);
  r = await http('POST', '/api/proxies/import', T, { text, defaultType: 'http', provider: 'imp', kind: 'dynamic' });
  check('import: same per-line results, 4 created', st(r.body) === expected && r.body.created === 4 && r.body.duplicate === 2 && r.body.invalid === 3, `${r.body.created}/${r.body.duplicate}/${r.body.invalid}`);
  check('import results mask passwords', !r.text.includes('imp-secret'));
  const imported: string[] = r.body.results.filter((l: any) => l.id).map((l: any) => l.id);
  created.push(...imported);
  const impRows = await db.select().from(schema.proxies).where(inArray(schema.proxies.id, imported));
  const byHost = new Map(impRows.map((p) => [p.host, p]));
  check('import formats parsed (scheme/default type/host:port:user:pass)',
    byHost.get('203.0.113.10')?.type === 'socks5' && byHost.get('203.0.113.10')?.username === 'imp-u1'
    && byHost.get('203.0.113.11')?.type === 'http' && byHost.get('203.0.113.12')?.type === 'http' && byHost.get('203.0.113.12')?.username === 'imp-u3'
    && byHost.get('203.0.113.13')?.username === null && impRows.every((p) => p.provider === 'imp'));
  check('import applies the optional kind', impRows.length === 4 && impRows.every((p) => p.kind === 'dynamic'));
  check('imported passwords encrypted', impRows.filter((p) => p.passwordEnc).length === 2 && impRows.every((p) => !p.passwordEnc || (p.passwordEnc.startsWith('v1:') && !p.passwordEnc.includes('imp-secret'))));
  r = await http('POST', '/api/proxies/import', T, { text: 'socks5://imp-u1:x@203.0.113.10:1080\n203.0.113.13:8000', defaultType: 'http' });
  check('re-import → duplicates', r.body.duplicate === 2 && r.body.created === 0);
  for (const id of imported) {
    const d = await http('DELETE', `/api/proxies/${id}`, T);
    if (d.status !== 204) check(`delete free proxy ${id}`, false, String(d.status));
  }
  created.splice(created.length - imported.length);
  check('delete free proxies (204)', (await db.select().from(schema.proxies).where(inArray(schema.proxies.id, imported))).length === 0);

  // ---------------------------------------------------------------- binding (placeholder devices, no Android)
  const tag = randomBytes(3).toString('hex');
  const fakes = await db.insert(schema.instances).values([1, 2].map((n) => ({
    name: `ppfake-${tag}-${n}`, image: 'none', adbPort: 5590 + 7 + n /* 5598/5599: top of the test range */, status: 'stopped' as const,
    netContainerId: `ppfake-missing-${tag}-${n}`, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning();
  fakeIds.push(...fakes.map((f) => f.id));
  const [F1, F2] = fakes as [typeof fakes[0], typeof fakes[0]];
  r = await http('PUT', `/api/instances/${F1.id}/proxy`, T, { proxyId: goodId });
  check('bind pool proxy to device (202 + set-proxy task)', r.status === 202 && !!r.body.taskId, r.text.slice(0, 100));
  const t1 = await waitTask(r.body.taskId);
  check('set-proxy task succeeded', t1.status === 'success', t1.error ?? '');
  const inst = (await http('GET', `/api/instances/${F1.id}`, T)).body.instance;
  check('device shows pool proxy without username/password', inst.proxy?.id === goodId && inst.proxy.hasAuth === true && !('username' in inst.proxy) && !JSON.stringify(inst).includes(PW) && !JSON.stringify(inst).includes('cpuser'));
  const cfgPath = `${process.env.INSTANCE_DATA_ROOT ?? '/srv/cloudphone/instances'}/${F1.name}/net/config.json`;
  const cfg = JSON.parse(execFileSync('limactl', ['shell', 'redroid', '--', 'sudo', 'cat', cfgPath], { encoding: 'utf8' }));
  const ob = cfg.outbounds?.[0];
  const mode = execFileSync('limactl', ['shell', 'redroid', '--', 'sudo', 'stat', '-c', '%a', cfgPath], { encoding: 'utf8' }).trim();
  check('sidecar config built from pool entry with decrypted password (mode 600)', ob?.type === 'socks' && ob.server === PHOST && ob.username === 'cpuser' && ob.password === PW && mode === '600', `mode=${mode}`);

  r = await http('PUT', `/api/instances/${F2.id}/proxy`, T, { proxyId: goodId });
  check('binding a bound proxy to another device → 409', r.status === 409 && r.body.code === 'proxy.already_bound', r.body?.error);
  const dbErr = await db.update(schema.instances).set({ proxyId: goodId }).where(inArray(schema.instances.id, [F2.id])).then(() => null, (e) => e);
  check('DB constraint: proxy_id UNIQUE refuses a second device', isUniqueViolation(dbErr, 'instances_proxy_id_unique'));
  r = await http('DELETE', `/api/proxies/${goodId}`, T);
  check('delete bound proxy → 409', r.status === 409 && r.body.code === 'proxy.bound', r.body?.error);
  r = await http('GET', '/api/proxies?bound=bound', T);
  check('filter bound: shows the device', r.body.proxies.some((p: any) => p.id === goodId && p.boundInstance?.id === F1.id));
  r = await http('GET', '/api/proxies?bound=free&status=ok', T);
  check('filter free+ok: excludes the bound one', !r.body.proxies.some((p: any) => p.id === goodId) && r.body.proxies.some((p: any) => p.id === httpId));
  r = await http('GET', `/api/proxies?q=${encodeURIComponent('pp-test-b')}`, T);
  check('search q', r.body.proxies.length === 1 && r.body.proxies[0].id === badId);

  r = await http('PUT', `/api/proxies/${goodId}`, T, { password: PW });
  check('changing credentials of a bound proxy re-applies to its device', r.status === 200 && !!r.body.taskId && r.body.proxy.status === 'unchecked');
  check('re-apply task succeeded', (await waitTask(r.body.taskId)).status === 'success');
  await http('POST', `/api/proxies/${goodId}/check`, T);

  r = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 1, namePrefix: 'ppx', proxyMode: 'pick', proxyIds: [goodId] });
  check('create device picking a bound proxy → 409 (nothing created)', r.status === 409 && r.body.code === 'proxy.already_bound', r.body?.code);
  r = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 2, namePrefix: 'ppx', proxyMode: 'pick', proxyIds: [httpId] });
  check('pick count mismatch → 400', r.status === 400 && r.body.code === 'proxy.count_mismatch');
  r = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 5, namePrefix: 'ppx', proxyMode: 'auto' });
  check('auto-assign with too few free proxies → 409 proxy.not_enough_free', r.status === 409 && r.body.code === 'proxy.not_enough_free', r.body?.error);
  check('no device created by refused requests', (await db.select().from(schema.instances).where(like(schema.instances.name, 'ppx-%'))).length === 0);

  r = await http('GET', `/api/proxies/${goodId}/usage`, T);
  check('usage: current device + bind history', r.body.boundInstance?.id === F1.id && r.body.history.some((h: any) => h.event === 'bind' && h.deviceId === F1.id));

  // ---------------------------------------------------------------- user role
  const upw = randomBytes(12).toString('base64url');
  r = await http('POST', '/api/users', T, { username: `ppuser${tag}`, password: upw, role: 'user' });
  userId = r.body.user?.id ?? r.body.id;
  await http('PUT', `/api/users/${userId}/grants`, T, { instanceIds: [F1.id] });
  const U = await login(`ppuser${tag}`, upw);
  r = await http('GET', '/api/proxies', U);
  check('user: list pool → 403', r.status === 403 && r.body.code === 'proxy.admin_only');
  r = await http('POST', '/api/proxies', U, { type: 'http', host: '192.0.2.9', port: 80 });
  check('user: create → 403', r.status === 403);
  r = await http('POST', `/api/proxies/${goodId}/check`, U);
  check('user: check → 403', r.status === 403);
  r = await http('POST', '/api/proxies/test', U, { type: 'socks5', host: PHOST, port: Number(PPORT), username: 'cpuser', id: goodId });
  check('user: test endpoint → 403 proxy.admin_only (no result)', r.status === 403 && r.body.code === 'proxy.admin_only' && !('result' in (r.body ?? {})));
  r = await http('PUT', `/api/instances/${F1.id}/proxy`, U, { proxyId: null });
  check('user: bind/unbind → 403', r.status === 403 && r.body.code === 'proxy.bind_admin_only');
  r = await http('GET', `/api/instances/${F1.id}`, U);
  check('user sees granted device proxy (host/type) without secrets', r.status === 200 && r.body.instance.proxy?.host === PHOST && !r.text.includes(PW) && !r.text.includes('cpuser'));
  r = await http('GET', '/api/instances', U);
  check('user list: only granted device, no secrets', r.body.instances.length === 1 && !r.text.includes(PW) && !r.text.includes('cpuser'));

  r = await http('PUT', `/api/instances/${F1.id}/proxy`, T, { proxyId: null });
  await waitTask(r.body.taskId);
  check('unbind → proxy free again', (await http('GET', '/api/proxies?bound=free', T)).body.proxies.some((p: any) => p.id === goodId));

  // ---------------------------------------------------------------- concurrent auto-assignment (service level, real DB)
  for (const n of [1, 2]) {
    r = await http('POST', '/api/proxies', T, { label: `pp-test-c${n}`, type: 'socks5', host: `192.0.2.${100 + n}`, port: 1080 });
    created.push(r.body.proxy.id);
  }
  const free = await countFreeUsable();
  check('pool now has 4 free usable proxies (2 ok, 2 unchecked; failed excluded)', free === 4, String(free));
  const attempt = (name: string, n: number, holdMs: number, delayMs = 0) => sleep(delayMs).then(() => db.transaction(async (tx) => {
    const ids = await assignFreeProxies(tx, n);
    await tx.insert(schema.instances).values(ids.map((proxyId, i) => ({
      name: `ppc-${tag}-${name}-${i}`, image: 'none', adbPort: 40000 + Math.floor(Math.random() * 20000), status: 'stopped' as const, proxyId,
      spec: { width: 720, height: 1280, dpi: 320 },
    })));
    await sleep(holdMs);
    return ids;
  })).then((ids) => ({ ok: true as const, ids }), (e) => ({ ok: false as const, code: (e as { code?: string }).code ?? (e as Error).message }));
  const [a, b, c] = await Promise.all([attempt('a', 2, 1500), attempt('b', 2, 1500), attempt('c', 1, 0, 300)]);
  const union = new Set([...(a.ok ? a.ids : []), ...(b.ok ? b.ids : [])]);
  check('two concurrent auto-assigns get disjoint proxies', a.ok && b.ok && union.size === 4, `a=${a.ok} b=${b.ok} distinct=${union.size}`);
  check('third concurrent request (none left) refused with proxy.not_enough_free', !c.ok && c.code === 'proxy.not_enough_free', c.ok ? 'got proxies' : c.code);
  await db.delete(schema.instances).where(like(schema.instances.name, `ppc-${tag}-%`));
  const [d, e] = await Promise.all([attempt('d', 3, 1000), attempt('e', 3, 1000)]);
  check('two concurrent requests for 3 of 4: exactly one succeeds', [d, e].filter((x) => x.ok).length === 1, `${d.ok}/${e.ok}`);
  await db.delete(schema.instances).where(like(schema.instances.name, `ppc-${tag}-%`));

  // ---------------------------------------------------------------- audit
  const acts = await sqlClient`select distinct action from audit_logs where action like 'proxy.%'`;
  const have = new Set(acts.map((x) => x.action as string));
  check('audit actions recorded (proxy.create/update/delete/import/set)', ['proxy.create', 'proxy.update', 'proxy.delete', 'proxy.import', 'proxy.set'].every((x) => have.has(x)), [...have].join(','));
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  await db.delete(schema.instances).where(sql`${schema.instances.name} like 'ppc-%'`);
  for (const id of fakeIds) {
    await http('POST', '/api/instances/actions', T, { action: 'delete', ids: [id] });
    await waitFor('fake deleted', async () => (await http('GET', `/api/instances/${id}`, T)).status === 404, 60_000).catch(() => undefined);
  }
  for (const id of created) await http('DELETE', `/api/proxies/${id}`, T);
  if (userId) await http('DELETE', `/api/users/${userId}`, T);
  const left = await db.select().from(schema.proxies).where(like(schema.proxies.label, 'pp-test-%'));
  check('cleanup: test proxies and placeholder devices removed', left.length === 0 && (await db.select().from(schema.instances).where(like(schema.instances.name, 'ppfake-%'))).length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
}
