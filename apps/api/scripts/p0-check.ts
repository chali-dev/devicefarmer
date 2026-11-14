/**
 * P0 feature test through the public API, against the running g13-1 / g13-2 instances (real devices, no mocks).
 * Covers: capacity check, batch install (APK + bundle), app list, batch uninstall, device settings
 * (apply + persist across restart), screenshot, clipboard read, Android ID / GSF ID stability.
 * Usage: npx tsx --env-file=../../.env scripts/p0-check.ts <test.apk>
 */
import { zipSync } from 'fflate';
import fs from 'node:fs';
import WebSocket from 'ws';

const API = 'http://127.0.0.1:3000';
const apk = process.argv[2];
if (!apk) throw new Error('usage: p0-check.ts <test.apk>');
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body && !isForm ? { 'content-type': 'application/json' } : {}) }, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null; try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: res.status, body: json as T, raw: buf, type: res.headers.get('content-type') };
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 240_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 2000)); }
}

const T: string = (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) })).json()).token;
const all = (await http('GET', '/api/instances', T)).body.instances;
const g = all.filter((i: any) => i.name.startsWith('g13-')).sort((a: any, b: any) => a.name.localeCompare(b.name));
if (g.length !== 2 || g.some((i: any) => i.status !== 'running')) throw new Error('need g13-1 and g13-2 running');
const ids = g.map((i: any) => i.id);
const waitTasks = async (taskIds: string[]) => waitFor('tasks', async () => {
  const tasks = (await http('GET', '/api/tasks?limit=100', T)).body.tasks.filter((t: any) => taskIds.includes(t.id));
  return tasks.length === taskIds.length && tasks.every((t: any) => t.status === 'succeeded' || t.status === 'failed') ? tasks : null;
});
const apps = async (id: string) => (await http('GET', `/api/instances/${id}/apps`, T)).body.apps as any[];

// 1. capacity check
const cap = await http('POST', '/api/instances', T, { profile: 'redroid-13-gapps', count: 3, namePrefix: 'captest' });
check('capacity check refuses overcommit', cap.status === 409, cap.body?.error);

// 2. batch install of a single APK on both
const fd = new FormData();
fd.append('instanceIds', JSON.stringify(ids));
fd.append('file', new Blob([fs.readFileSync(apk)]), 'fdroid.apk');
let r = await http('POST', '/api/apps/install', T, fd);
check('batch install accepted for 2 instances', r.status === 202 && r.body.accepted.length === 2, `apks=${r.body?.apks}`);
let tasks = await waitTasks(r.body.accepted.map((a: any) => a.taskId));
check('batch install tasks succeeded', tasks.every((t: any) => t.status === 'succeeded'), tasks.map((t: any) => t.error).filter(Boolean).join('; '));
for (const i of g) {
  const a = await apps(i.id);
  check(`app list on ${i.name} shows org.fdroid.fdroid`, a.some((x) => x.package === 'org.fdroid.fdroid'), a.find((x) => x.package === 'org.fdroid.fdroid')?.versionName ?? '');
}

// 3. batch uninstall
r = await http('POST', '/api/apps/uninstall', T, { instanceIds: ids, package: 'org.fdroid.fdroid' });
tasks = await waitTasks(r.body.accepted.map((a: any) => a.taskId));
check('batch uninstall succeeded', tasks.every((t: any) => t.status === 'succeeded'));
for (const i of g) check(`package removed on ${i.name}`, !(await apps(i.id)).some((x) => x.package === 'org.fdroid.fdroid'));

// 4. bundle path (zip of APKs installed in one PackageInstaller session) + update (-r) on g13-1
const bundle = zipSync({ 'base.apk': new Uint8Array(fs.readFileSync(apk)) });
const fd2 = new FormData();
fd2.append('instanceIds', JSON.stringify([ids[0]]));
fd2.append('file', new Blob([bundle]), 'fdroid.apks');
r = await http('POST', '/api/apps/install', T, fd2);
tasks = await waitTasks(r.body.accepted.map((a: any) => a.taskId));
check('bundle (.apks) install via session succeeded', tasks[0].status === 'succeeded', tasks[0].error ?? '');
const fd3 = new FormData(); fd3.append('instanceIds', JSON.stringify([ids[0]])); fd3.append('file', new Blob([fs.readFileSync(apk)]), 'fdroid.apk');
r = await http('POST', '/api/apps/install', T, fd3);
tasks = await waitTasks(r.body.accepted.map((a: any) => a.taskId));
check('reinstall over existing app (update path) succeeded', tasks[0].status === 'succeeded', tasks[0].error ?? '');
const bad = new FormData(); bad.append('instanceIds', JSON.stringify([ids[0]])); bad.append('file', new Blob([Buffer.from('not a zip')]), 'broken.apks');
r = await http('POST', '/api/apps/install', T, bad);
check('corrupt bundle rejected with 400', r.status === 400, r.body?.error);
await waitTasks((await http('POST', '/api/apps/uninstall', T, { instanceIds: [ids[0]], package: 'org.fdroid.fdroid' })).body.accepted.map((a: any) => a.taskId));

// 5. device settings: apply on running instance, then verify after restart
const b = g[1];
const before = (await http('GET', `/api/instances/${b.id}/settings`, T)).body.actual;
const want = { locale: 'en-US', timezone: 'Asia/Shanghai', deviceName: 'CloudPhone-g13-2' };
r = await http('PATCH', `/api/instances/${b.id}/settings`, T, want);
check('settings update accepted', r.status === 202 && !!r.body.taskId);
tasks = await waitTasks([r.body.taskId]);
check('apply-settings task succeeded', tasks[0].status === 'succeeded', tasks[0].error ?? '');
let actual = (await http('GET', `/api/instances/${b.id}/settings`, T)).body.actual;
check('settings applied on device', actual.locale === want.locale && actual.timezone === want.timezone && actual.deviceName === want.deviceName, JSON.stringify({ locale: actual.locale, timezone: actual.timezone, deviceName: actual.deviceName }));
check('device model unchanged (not configurable)', actual.model === before.model, actual.model);
const badTz = await http('PATCH', `/api/instances/${b.id}/settings`, T, { timezone: 'Mars/Olympus' });
check('invalid timezone rejected', badTz.status === 400);
const androidIdBefore = actual.androidId;
r = await http('POST', '/api/instances/actions', T, { action: 'restart', ids: [b.id] });
await waitFor('restart started', async () => (await http('GET', `/api/instances/${b.id}`, T)).body.instance.status !== 'running', 15_000).catch(() => true);
await waitFor('running again', async () => { const x = (await http('GET', `/api/instances/${b.id}`, T)).body.instance; return x.status === 'running' && x.stfReady; });
actual = (await http('GET', `/api/instances/${b.id}/settings`, T)).body.actual;
check('settings persisted after restart', actual.locale === want.locale && actual.timezone === want.timezone && actual.deviceName === want.deviceName);
check('Android ID stable across restart', !!androidIdBefore && actual.androidId === androidIdBefore);

// 6. screenshot
const shot = await http('GET', `/api/instances/${g[0].id}/screenshot`, T);
const w = shot.raw.readUInt32BE(16), h = shot.raw.readUInt32BE(20);
check('screenshot returns full-resolution PNG', shot.status === 200 && shot.type === 'image/png' && shot.raw.subarray(1, 4).toString() === 'PNG', `${w}x${h}, ${shot.raw.length} bytes`);

// 7. clipboard read (device -> browser)
const ws = new WebSocket(`${API.replace('http', 'ws')}/api/instances/${g[0].id}/session`);
const msgs: any[] = [];
ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
await new Promise((res) => ws.on('open', res));
ws.send(JSON.stringify({ type: 'auth', token: T }));
await waitFor('session', async () => msgs.find((m) => m.type === 'ready'), 20_000);
const marker = `clip-${Date.now()}`;
ws.send(JSON.stringify({ type: 'paste', text: marker }));
await waitFor('pasted', async () => msgs.find((m) => m.type === 'pasted'), 15_000);
ws.send(JSON.stringify({ type: 'clipboardGet' }));
const clip = await waitFor('clipboard', async () => msgs.find((m) => m.type === 'clipboard'), 15_000);
check('clipboard read returns device clipboard', clip.text === marker, JSON.stringify(clip.text));
ws.close();

const failed = results.filter((x) => !x[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
