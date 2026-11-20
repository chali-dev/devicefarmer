/**
 * BitBrowser (比特) cloud phones as devices through a device source, against the real BitBrowser
 * client, STF and DB (no mocks).
 *
 * Default (free, nothing is powered on): source CRUD (admin only, tested before save, unreachable
 * address refused, in-use source can't be deleted), Local API token (sealed, write-only, kept/cleared,
 * sent as x-api-key), client time zone (expiry parsing), client health + fast failure on a dead
 * client, phone list, add, a phone that is off stays
 * `stopped` (also after a few monitor rounds), duplicate add, proxy/settings endpoints gone (404), audit, delete
 * leaves the phone in BitBrowser untouched.
 *
 * `--power` (BILLED: powers a phone on until the test shuts it down): start → SSH tunnel → adb → STF
 * → running, screen size recorded, screenshot, remote-control frames + HOME key, stop → phone off,
 * tunnel closed. Uses BITBROWSER_POWER_PHONE (phone name, default Ins-02). Only phones that were off
 * are used; a phone the test switched on is always shut down at the end.
 *
 * Usage (from apps/api, API running; BitBrowser client at BITBROWSER_API_URL, default http://127.0.0.1:54345):
 *   npx tsx --env-file=../../.env scripts/bitbrowser-check.ts [--power]
 */
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { BitBrowserClient, parseLocalTime } from '../src/adapters/bitbrowser.js';
import { openSecret } from '../src/lib/secret-box.js';
import { withCaptcha } from './lib/login.js';

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const WS = API.replace(/^http/, 'ws');
const POWER = process.argv.includes('--power');
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary / 204 */ }
  return { status: res.status, body: json as T, text: buf.toString().slice(0, 300), buf, type: res.headers.get('content-type') ?? '' };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000, every = 1000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, every)); }
}
const instance = async (token: string, id: string) => (await http('GET', `/api/instances/${id}`, token)).body?.instance;
const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (ok: boolean) => { s.destroy(); resolve(ok); };
  s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(1500, () => done(false));
});
const stfAdb = (serial: string, cmd: string) => execFileSync('docker', ['exec', 'cloudphone-stf-adb-1', 'adb', '-s', serial, 'shell', cmd], { env: { ...process.env, DOCKER_HOST: '' } }).toString();

const BIT_URL = process.env.BITBROWSER_API_URL ?? 'http://127.0.0.1:54345';
const bit = new BitBrowserClient(BIT_URL);
const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const created: string[] = [];
let userId = '';
let sourceId = '';
let poweredByTest: string | null = null;
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);

try {
  const pw = randomBytes(12).toString('base64url');
  userId = (await http('POST', '/api/users', T, { username: `bb${tag}`, password: pw, role: 'user' })).body.user.id;
  const U = await login(`bb${tag}`, pw);

  // ---------------------------------------------------------------- sources
  let r = await http('POST', '/api/device-sources', U, { type: 'bitbrowser', name: `bb-${tag}`, config: { apiUrl: BIT_URL } });
  check('user: create source → 403', r.status === 403);
  r = await http('POST', '/api/device-sources', T, { type: 'bitbrowser', name: `bb-${tag}-x`, config: { apiUrl: 'http://127.0.0.1:1' } });
  check('admin: unreachable client → 400 test_failed, not saved', r.status === 400 && r.body.code === 'sources.test_failed', r.text);
  r = await http('POST', '/api/device-sources', T, { type: 'bitbrowser', name: `bb-${tag}-y`, config: { apiUrl: 'ftp://x' } });
  check('admin: bad address → 400 invalid_config', r.status === 400 && r.body.code === 'sources.invalid_config', r.text);
  r = await http('POST', '/api/device-sources', T, { type: 'bitbrowser', name: `bb-${tag}`, config: { apiUrl: `${BIT_URL}/` } });
  check('admin: create source (tested, trailing slash normalised)', r.status === 201 && r.body.source.config.apiUrl === BIT_URL, r.text);
  sourceId = r.body.source?.id;
  r = await http('POST', '/api/device-sources', T, { type: 'bitbrowser', name: `bb-${tag}`, config: { apiUrl: BIT_URL } });
  check('duplicate source name → 409', r.status === 409 && r.body.code === 'sources.name_taken', r.text);
  r = await http('PATCH', `/api/device-sources/${sourceId}`, T, { config: { apiUrl: 'http://127.0.0.1:1' } });
  check('edit to an unreachable address → 400, old config kept', r.status === 400 && (await http('GET', '/api/device-sources', T)).body.sources.find((x: any) => x.id === sourceId)?.config.apiUrl === BIT_URL, r.text);

  // ---- Local API token (secret: sealed, write-only) + client time zone + health
  const KEY = `bbkey-${randomBytes(9).toString('hex')}`;
  const srcOf = async () => (await http('GET', '/api/device-sources', T)).body.sources.find((x: any) => x.id === sourceId);
  const stored = async () => (await db.select().from(schema.deviceSources).where(eq(schema.deviceSources.id, sourceId)))[0]!.config as Record<string, unknown>;
  r = await http('PATCH', `/api/device-sources/${sourceId}`, T, { config: { apiUrl: BIT_URL, apiKey: KEY, timeZone: 'Asia/Shanghai' } });
  // The local client has its token off, so it ignores x-api-key and the save (connection test) succeeds.
  check('token + time zone saved (connection test passes with x-api-key sent)', r.status === 200 && r.body.source.config.apiKeySet === true && r.body.source.config.timeZone === 'Asia/Shanghai', r.text);
  check('token never returned (no apiKey / apiKeyEnc in the API)', !JSON.stringify(r.body).includes(KEY) && !('apiKey' in r.body.source.config) && !('apiKeyEnc' in r.body.source.config));
  const st = await stored();
  check('token stored sealed (no plaintext in the DB row)', typeof st.apiKeyEnc === 'string' && !JSON.stringify(st).includes(KEY) && !('apiKey' in st));
  r = await http('PATCH', `/api/device-sources/${sourceId}`, T, { config: { apiUrl: BIT_URL, timeZone: 'Asia/Shanghai' } });
  check('edit without apiKey keeps the saved token', r.status === 200 && (await srcOf()).config.apiKeySet === true && openSecret(String((await stored()).apiKeyEnc)) === KEY);
  r = await http('PATCH', `/api/device-sources/${sourceId}`, T, { config: { apiUrl: BIT_URL, timeZone: 'Mars/Olympus' } });
  check('unknown time zone → 400 invalid_config, old config kept', r.status === 400 && r.body.code === 'sources.invalid_config' && (await srcOf()).config.timeZone === 'Asia/Shanghai', r.text);
  r = await http('PATCH', `/api/device-sources/${sourceId}`, T, { config: { apiUrl: BIT_URL, apiKey: null } });
  check('apiKey null clears the token; time zone omitted = removed', r.status === 200 && (await srcOf()).config.apiKeySet === false && !('apiKeyEnc' in (await stored())) && !('timeZone' in (await srcOf()).config), r.text);
  const srcAuditRows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'device_source.update'));
  check('audit: the token never appears in device_source.update entries', srcAuditRows.length > 0 && !srcAuditRows.some((a) => JSON.stringify(a).includes(KEY)));
  const h = (await srcOf()).health;
  check('source health reported: client online with a recent successful call', h?.ok === true && !!h.lastOkAt && Date.now() - Date.parse(h.lastOkAt) < 120_000, JSON.stringify(h));
  check('expiry parsing in the client\'s zone: 17:49:47 Asia/Shanghai = 09:49:47Z; New York summer/winter offsets',
    parseLocalTime('2026-11-17 17:49:47', 'Asia/Shanghai')?.toISOString() === '2026-11-17T09:49:47.000Z' &&
    parseLocalTime('2026-07-01 12:00:00', 'America/New_York')?.toISOString() === '2026-07-01T16:00:00.000Z' &&
    parseLocalTime('2026-12-01 12:00:00', 'America/New_York')?.toISOString() === '2026-12-01T17:00:00.000Z' &&
    parseLocalTime('2026-11-17 17:49:47')?.getTime() === new Date('2026-11-17T17:49:47').getTime() && parseLocalTime('17:49') === null);
  {
    const dead = new BitBrowserClient('http://127.0.0.1:1');
    const e = await dead.list().then(() => null, (err) => err);
    check('dead client: coded unreachable error, health turns offline', e?.code === 'bitbrowser.unreachable' && dead.health.ok === false && !!dead.health.failingSince, String(e?.code));
    // Packets silently dropped (non-routable address): reads give up after the short read timeout, not 30 s.
    const hole = new BitBrowserClient('http://10.255.255.1:54345');
    const s0 = Date.now();
    const e2 = await hole.running('x').then(() => null, (err) => err);
    check('blackholed client: read fails in ≤ 10 s (short read timeout)', e2?.code === 'bitbrowser.unreachable' && Date.now() - s0 <= 10_000, `${Date.now() - s0} ms`);
  }
  r = await http('GET', `/api/device-sources/${sourceId}/phones`, U);
  check('user: list phones → 403', r.status === 403);
  r = await http('GET', `/api/device-sources/${sourceId}/phones`, T);
  check('admin: phone list from the BitBrowser client', r.status === 200 && r.body.phones.length > 0, r.text);
  const phones = r.body.phones as any[];
  const offPhones: any[] = [];
  for (const p of phones) if (!p.instance && !(await bit.running(p.id))) offPhones.push(p);
  const free = offPhones.find((p) => p.name !== (process.env.BITBROWSER_POWER_PHONE ?? 'Ins-02')) ?? offPhones[0];
  if (!free) throw new Error('needs a BitBrowser phone that is off and not yet added');
  console.log(`  using ${free.name} (off) for the free checks`);

  r = await http('POST', '/api/instances/external', U, { sourceId, phoneIds: [free.id] });
  check('user: add phone → 403', r.status === 403);
  r = await http('POST', '/api/instances/external', T, { sourceId, phoneIds: ['nope'] });
  check('admin: unknown phone → 404', r.status === 404 && r.body.code === 'sources.phone_not_found', r.text);
  r = await http('POST', '/api/instances/external', T, { sourceId, phoneIds: [free.id] });
  check('admin: add phone → 202 + create task', r.status === 202 && r.body.taskIds?.length === 1, r.text);
  const dev = r.body.instances?.[0];
  if (dev) created.push(dev.id);
  check('device row: engine bitbrowser, external id, port in the BitBrowser range',
    dev?.engine === 'bitbrowser' && dev.sourceId === sourceId && dev.externalId === free.id && dev.adbPort >= 5700 && dev.adbPort <= 5799 && /^bit-/.test(dev.name), JSON.stringify(dev));
  const stopped = await waitFor('stopped', async () => { const i = await instance(T, dev.id); return i?.status === 'stopped' ? i : null; }, 30_000);
  check('phone that is off → device stopped (not powered on)', stopped.status === 'stopped' && !(await bit.running(free.id)));
  r = await http('POST', '/api/instances/external', T, { sourceId, phoneIds: [free.id] });
  check('add the same phone again → 409 already_added', r.status === 409 && r.body.code === 'sources.already_added', r.text);
  r = await http('DELETE', `/api/device-sources/${sourceId}`, T);
  check('delete a source with devices → 409 in_use', r.status === 409 && r.body.code === 'sources.in_use', r.text);
  r = await http('GET', `/api/device-sources/${sourceId}/phones`, T);
  check('phone list shows the device it was added as', r.body.phones.find((p: any) => p.id === free.id)?.instance?.id === dev.id);
  r = await http('PUT', `/api/instances/${dev.id}/proxy`, T, { proxyId: null });
  check('bind proxy: endpoint removed with the proxy pool → 404', r.status === 404, r.text);
  r = await http('PATCH', `/api/instances/${dev.id}/settings`, T, { locale: 'zh-CN' });
  check('device settings: endpoint removed with redroid → 404', r.status === 404, r.text);
  console.log('  waiting 35 s for monitor rounds…');
  await new Promise((res) => setTimeout(res, 35_000));
  const still = await instance(T, dev.id);
  check('monitor keeps an off phone stopped (no error, no power-on)', still.status === 'stopped' && !still.lastError && !(await bit.running(free.id)), JSON.stringify({ s: still.status, e: still.lastError }));

  r = await http('POST', '/api/instances/actions', T, { action: 'delete', ids: [dev.id] });
  check('delete accepted', r.status === 202 && r.body.accepted.length === 1, r.text);
  await waitFor('row gone', async () => (await http('GET', `/api/instances/${dev.id}`, T)).status === 404, 30_000);
  check('device removed from the platform', true);
  check('phone still in BitBrowser and still off', (await bit.list()).some((p) => p.id === free.id) && !(await bit.running(free.id)));
  const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'device.add_external'));
  check('audit: device.add_external recorded', audit.some((a) => a.at >= t0 && JSON.stringify(a.detail).includes(free.id)));
  const srcAudit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'device_source.create'));
  check('audit: device_source.create recorded (ok + failed test)', srcAudit.filter((a) => a.at >= t0 && a.target?.startsWith(`bb-${tag}`)).length >= 2);

  // ---------------------------------------------------------------- power (billed)
  if (!POWER) {
    console.log('  (power checks skipped: pass --power; the phone is billed while on)');
  } else {
    const name = process.env.BITBROWSER_POWER_PHONE ?? 'Ins-02';
    const p = (await bit.list()).find((x) => x.name === name);
    if (!p) throw new Error(`no BitBrowser phone named ${name}`);
    if (await bit.running(p.id)) throw new Error(`${name} is already on: the power checks only use a phone that is off`);
    r = await http('POST', '/api/instances/external', T, { sourceId, phoneIds: [p.id] });
    const d = r.body.instances[0];
    created.push(d.id);
    await waitFor('stopped', async () => (await instance(T, d.id))?.status === 'stopped', 30_000);
    const tStart = Date.now();
    poweredByTest = p.id;
    r = await http('POST', '/api/instances/actions', T, { action: 'start', ids: [d.id] });
    check('start accepted', r.status === 202 && r.body.accepted.length === 1, r.text);
    const run = await waitFor('running', async () => { const i = await instance(T, d.id); if (i?.status === 'error') throw new Error(i.lastError); return i?.status === 'running' && i.stfReady ? i : null; }, 6 * 60_000, 3000)
      .catch(async (e) => { console.log('  device:', JSON.stringify(await instance(T, d.id))); throw e; });
    check(`start: phone on → tunnel → adb → STF → running (${Math.round((Date.now() - tStart) / 1000)} s)`, run.adbState === 'device' && run.bootCompleted && run.stfReady);
    check('phone reported on by BitBrowser', await bit.running(p.id));
    check('tunnel listens on 127.0.0.1 only', await portOpen(d.adbPort));
    check('screen size recorded from the phone', run.spec.width > 0 && run.spec.height > run.spec.width, JSON.stringify(run.spec));
    const shot = await http('GET', `/api/instances/${d.id}/screenshot`, T);
    check('screenshot (PNG)', shot.status === 200 && shot.buf.subarray(1, 4).toString() === 'PNG', `${shot.status} ${shot.type}`);

    const ws = new WebSocket(`${WS}/api/instances/${d.id}/session`);
    let frames = 0; let first: Buffer | null = null; const msgs: any[] = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: T })));
    ws.on('message', (data, isBin) => { if (isBin) { frames++; first ??= data as Buffer; } else msgs.push(JSON.parse(data.toString())); });
    await waitFor('session ready', async () => msgs.find((m) => m.type === 'ready'), 30_000);
    await waitFor('first frame', async () => frames > 0, 30_000);
    check('remote control: JPEG frames streamed', !!first && first[0] === 0xff && first[1] === 0xd8, `${frames} frames`);
    const serial = `host.docker.internal:${d.adbPort}`;
    const top = () => stfAdb(serial, 'dumpsys activity activities | grep -m1 topResumedActivity');
    ws.send(JSON.stringify({ type: 'key', action: 'press', key: 'home' }));
    const t = await waitFor('launcher', async () => { const x = top(); return /launcher/i.test(x) ? x : null; }, 20_000).catch(() => top());
    check('remote control: HOME key reaches the phone', /launcher/i.test(t), t.trim().slice(0, 120));
    ws.close();

    r = await http('POST', '/api/instances/actions', T, { action: 'stop', ids: [d.id] });
    check('stop accepted', r.status === 202 && r.body.accepted.length === 1, r.text);
    await waitFor('stopped', async () => (await instance(T, d.id))?.status === 'stopped', 4 * 60_000, 3000);
    const off = !(await bit.running(p.id));
    if (off) poweredByTest = null;
    check('stop: phone shut down in BitBrowser', off);
    check('stop: tunnel closed', !(await portOpen(d.adbPort)));
  }
} catch (err) {
  check(`unexpected: ${(err as Error).message}`, false);
} finally {
  for (const id of created) {
    const [row] = await db.select().from(schema.instances).where(eq(schema.instances.id, id));
    if (row) await http('POST', '/api/instances/actions', T, { action: 'delete', ids: [id] });
  }
  if (created.length) await waitFor('cleanup', async () => (await db.select().from(schema.instances).where(eq(schema.instances.engine, 'bitbrowser'))).every((r) => !created.includes(r.id)), 30_000).catch(() => undefined);
  if (sourceId) {
    const d = await http('DELETE', `/api/device-sources/${sourceId}`, T);
    check('cleanup: source deleted once it has no devices', d.status === 204, d.text);
  }
  if (poweredByTest) {
    console.log('  shutting down the phone this test powered on…');
    await bit.shutdown(poweredByTest).catch((e) => console.log('  SHUTDOWN FAILED — power it off in the BitBrowser client:', e.message));
  }
  if (userId) await http('DELETE', `/api/users/${userId}`, T);
  await sqlClient.end();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
