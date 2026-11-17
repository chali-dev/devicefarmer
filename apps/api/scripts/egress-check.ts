/**
 * Egress location (出口 IP / 国家 / 城市) of devices. Real infrastructure, no mocks.
 *
 *   npx tsx --env-file=../../.env scripts/egress-check.ts          # parsing + a local test device "egchk-*" (created, deleted)
 *   npx tsx --env-file=../../.env scripts/egress-check.ts --bit    # + read-only probe on the BitBrowser phone (adb 5700) and
 *                                                                  #   the recheck endpoint for an external phone (see below)
 *
 * Parsing: egressScript output → ProxyStatus (valid, ipinfo answering for another IP → no geo, broken JSON,
 * no egress, no curl). Local device: recheck endpoint (sidecar netns path) stores the shape, the adb probe
 * runs on the device itself, RBAC (user without grant → 403, with grant → 200), no secrets in the response.
 * --bit: the adb probe on host.docker.internal:5700 (two HTTPS GETs from the phone, nothing else), then an
 * external device row in THIS API's DB pointing at that adb port, whose source config is deliberately invalid
 * so this instance's external monitor skips it (never powers it, never opens a second SSH tunnel); only the
 * recheck endpoint runs the probe. The row is removed directly from the DB (no delete op: that would adb
 * disconnect the port the main API uses). Requires that the main API keeps the phone's tunnel open.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { egressScript, geoOf, parseEgress } from '../src/lib/egress.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const results: [string, 'pass' | 'fail' | 'skip', string?][] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push([name, ok ? 'pass' : 'fail', detail]);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`FAILED: ${name}`);
}
function skip(name: string, why: string) { results.push([name, 'skip', why]); console.log(`- ${name} skipped — ${why}`); }
async function http<T = any>(method: string, p: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 2000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
const SHAPE = ['checkedAt', 'ok', 'egressIp', 'latencyMs', 'dnsOk', 'error'];
const shapeOk = (s: any) => s && SHAPE.every((k) => k in s) && typeof s.ok === 'boolean' && !Number.isNaN(Date.parse(s.checkedAt));
const SECRET = /password|passwordEnc|secret|token|apiKey/i;

let adminToken = '';
let createdId: string | null = null;
let userId: string | null = null;
let userToken = '';
let extIds: { source: string; instance: string } | null = null;
try {
  // ---- parsing (output in the format both probes print)
  const at = new Date().toISOString();
  const geo = '{  "ip": "191.219.20.115",  "city": "Mumbai",  "region": "Maharashtra",  "country": "IN",  "org": "AS152179 X"}';
  const good = parseEgress(`ip=191.219.20.115\nt0=525.42\nt1=526.44\ndns=1\ngeo=${geo}\n`, at, 'none');
  check('parse: full probe', good.ok && good.egressIp === '191.219.20.115' && good.latencyMs === 1020 && good.dnsOk && good.country === 'IN' && good.region === 'Maharashtra' && good.city === 'Mumbai' && good.error === null, JSON.stringify(good));
  const other = parseEgress(`ip=191.219.20.115\nt0=1\nt1=2\ndns=1\ngeo=${geo.replace('191.219.20.115', '203.0.113.9')}\n`, at, 'none');
  check('parse: ipinfo saw another IP → no geo', other.ok && other.country === undefined && other.city === undefined);
  const broken = parseEgress('ip=191.219.20.115\nt0=1\nt1=2\ndns=0\ngeo={"ip": "191.2\n', at, 'none');
  check('parse: broken geo JSON → no geo, still ok', broken.ok && !broken.dnsOk && broken.country === undefined);
  const none = parseEgress('ip=\nt0=1\nt1=13\ndns=0\n', at, 'no egress here');
  check('parse: no egress', !none.ok && none.egressIp === null && none.latencyMs === null && none.error === 'no egress here');
  const garbage = parseEgress('ip=<html>blocked</html>\n', at, 'x');
  check('parse: non-IP answer is not an egress IP', !garbage.ok && garbage.egressIp === null);
  check('parse: no curl on the device', parseEgress('nocurl=1\nip=\n', at, 'x').error!.includes('curl'));
  check('geoOf: parsed object form (pool check)', geoOf({ ip: '1.2.3.4', country: 'DE', city: 'Berlin' }, '1.2.3.4').country === 'DE' && geoOf({ ip: '1.2.3.5', country: 'DE' }, '1.2.3.4').country === undefined);
  check('android script has no busybox-only commands', !egressScript('android').includes('nslookup') && egressScript('busybox').includes('nslookup'));

  const login = await http('POST', '/api/auth/login', undefined, await withCaptcha(API, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }));
  check('admin login', login.status === 200);
  adminToken = login.body.token;

  // ---- local test device: sidecar path through the API, adb probe on the device itself
  const created = await http('POST', '/api/instances', adminToken, { count: 1, namePrefix: 'egchk', profile: 'redroid-12', proxyMode: 'none' });
  if (created.status === 409 || created.status === 507) skip('local device', `refused: ${JSON.stringify(created.body)}`);
  else {
    check('test device created', created.status === 202, created.body.instances?.[0]?.name);
    createdId = created.body.instances[0].id as string;
    const inst = await waitFor('device running', async () => {
      const i = (await http('GET', `/api/instances/${createdId}`, adminToken)).body.instance;
      if (i?.status === 'error') throw new Error(`device error: ${i.lastError}`);
      return i?.status === 'running' && i.bootCompleted ? i : null;
    }, 300_000);
    const r = await http('POST', `/api/instances/${createdId}/proxy/check`, adminToken);
    check('recheck (local, sidecar netns, direct)', r.status === 200 && shapeOk(r.body.proxyStatus), JSON.stringify(r.body.proxyStatus));
    const s = r.body.proxyStatus;
    check('local direct egress measured with geo', s.ok && /^\d+\.\d+\.\d+\.\d+$/.test(s.egressIp) && typeof s.country === 'string', `${s.egressIp} ${s.country} ${s.region} ${s.city}`);
    const stored = (await http('GET', `/api/instances/${createdId}`, adminToken)).body.instance;
    check('stored in instances.proxy_status (same shape)', stored.proxyStatus?.checkedAt === s.checkedAt && stored.proxyStatus.egressIp === s.egressIp);
    // adb probe on the device itself (what external phones use); AOSP redroid may lack curl → reported, not thrown
    const viaAdb = await adb.egress(inst.adbPort);
    check('adb probe on the local device returns the shape', shapeOk(viaAdb), JSON.stringify(viaAdb));
    if (viaAdb.ok) check('adb probe egress = sidecar egress (same netns)', viaAdb.egressIp === s.egressIp, viaAdb.egressIp ?? '');
    else check('adb probe failure is explained', !!viaAdb.error, viaAdb.error ?? '');

    // RBAC
    const uname = `eg-user-${Date.now() % 100000}`;
    const upass = `pw-${crypto.randomUUID()}`;
    const u = await http('POST', '/api/users', adminToken, { username: uname, password: upass, role: 'user' });
    check('create user', u.status === 201);
    userId = u.body.user.id;
    const ut = (await http('POST', '/api/auth/login', undefined, await withCaptcha(API, { username: uname, password: upass }))).body.token;
    userToken = ut;
    const denied = await http('POST', `/api/instances/${createdId}/proxy/check`, ut);
    check('user without grant cannot recheck', denied.status === 403 || denied.status === 404, String(denied.status));
    await http('PUT', `/api/users/${userId}/grants`, adminToken, { instanceIds: [createdId] });
    const allowed = await http('POST', `/api/instances/${createdId}/proxy/check`, ut);
    check('user with grant can recheck', allowed.status === 200 && shapeOk(allowed.body.proxyStatus));
    const seen = (await http('GET', `/api/instances/${createdId}`, ut)).body.instance;
    check('user sees the egress, no secrets', !!seen.proxyStatus && !SECRET.test(JSON.stringify(seen.proxyStatus)) && !SECRET.test(JSON.stringify(allowed.body)));
  }

  // ---- BitBrowser phone (read-only)
  if (!process.argv.includes('--bit')) skip('BitBrowser phone', 'pass --bit');
  else {
    const serial = adb.serialFor(BIT_PORT);
    const states = await adb.states();
    if (states.get(serial) !== 'device') skip('BitBrowser phone', `${serial} not attached (${states.get(serial) ?? 'absent'}): phone off or main API's tunnel down`);
    else {
      const direct = await adb.egress(BIT_PORT);
      check('adb probe on the BitBrowser phone', direct.ok && /^\d+\.\d+\.\d+\.\d+$/.test(direct.egressIp!) && /^[A-Z]{2}$/.test(direct.country ?? ''), `${direct.egressIp} ${direct.country} · ${direct.region} · ${direct.city}, ${direct.latencyMs} ms, dns ${direct.dnsOk}`);
      // External row in this instance's DB only, unusable for the monitor (invalid source config).
      const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `egchk-src-${Date.now()}`, config: { apiUrl: 'not a url' } }).returning();
      const [row] = await db.insert(schema.instances).values({
        name: `egchk-ext-${Date.now() % 100000}`, engine: 'bitbrowser', sourceId: src!.id, externalId: 'egchk', profile: 'bitbrowser', image: '',
        adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true, spec: { width: 720, height: 1280, dpi: 320 },
      }).returning();
      extIds = { source: src!.id, instance: row!.id };
      const r = await http('POST', `/api/instances/${row!.id}/proxy/check`, adminToken);
      check('recheck (external phone, probe on the phone)', r.status === 200 && r.body.proxyStatus?.ok && r.body.proxyStatus.country === direct.country, JSON.stringify(r.body.proxyStatus));
      const pub = (await http('GET', `/api/instances/${row!.id}`, adminToken)).body.instance;
      check('external: stored and public (proxy null, egress set)', pub.proxy === null && pub.proxyStatus?.egressIp === r.body.proxyStatus.egressIp);
      if (userToken) {
        const denied = await http('POST', `/api/instances/${row!.id}/proxy/check`, userToken);
        check('external: user without grant cannot recheck', denied.status === 403 || denied.status === 404, String(denied.status));
      } else skip('external RBAC', 'no test user (local part skipped)');
    }
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  if (extIds) {
    await db.delete(schema.instances).where(eq(schema.instances.id, extIds.instance));
    await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, extIds.source));
    console.log('teardown: external test row removed from the DB');
  }
  if (adminToken && userId) await http('DELETE', `/api/users/${userId}`, adminToken);
  if (adminToken && createdId && !process.argv.includes('--keep')) {
    const r = await http('POST', '/api/instances/actions', adminToken, { action: 'delete', ids: [createdId] });
    console.log(`teardown: delete test device → ${r.status}`);
  }
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const [, r] of results) counts[r]++;
  console.log(`\n${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`);
  process.exit(process.exitCode ?? 0);
}
