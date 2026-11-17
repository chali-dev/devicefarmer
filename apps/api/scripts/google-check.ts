/**
 * Google services test against real infrastructure (no mocks). Requires the API running.
 * Creates 2 instances of profile redroid-13-gapps (kept running for manual Google login),
 * unless instances named g13-* already exist, in which case it re-checks them.
 * Usage: npx tsx --env-file=../../.env scripts/google-check.ts [--restart]
 */
import Docker from 'dockerode';
import fs from 'node:fs';
import WebSocket from 'ws';
import { dockerFromEnv } from '../src/adapters/runtime/docker.js';
import { withCaptcha } from './lib/login.js';

const API = 'http://127.0.0.1:3000';
const docker: Docker = dockerFromEnv(process.env.DOCKER_HOST!);
const doRestart = process.argv.includes('--restart');
const report: string[] = [];
const log = (s: string) => { console.log(s); report.push(s); };

async function http<T = any>(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(API + path, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 300_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
async function sh(containerId: string, cmd: string): Promise<string> {
  const e = await docker.getContainer(containerId).exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, Tty: true });
  const s = await e.start({ hijack: true, stdin: false, Tty: true });
  return new Promise((r) => { let b = ''; s.on('data', (d: Buffer) => (b += d)); s.on('end', () => r(b.trim())); });
}
async function stats(containerId: string) {
  const s = (await docker.getContainer(containerId).stats({ stream: false })) as any;
  const mem = s.memory_stats.usage - (s.memory_stats.stats?.inactive_file ?? 0);
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
  const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus ?? 1) * 100 : 0;
  return `mem=${(mem / 1048576).toFixed(0)}MiB cpu=${cpu.toFixed(1)}%`;
}

const login = await http('POST', '/api/auth/login', undefined, await withCaptcha(API, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }));
const T: string = login.body.token;

// 1. profiles + KVM detection
const profiles = (await http('GET', '/api/profiles', T)).body.profiles as any[];
for (const p of profiles) log(`profile ${p.id}: ${p.available ? 'available' : `unavailable (${p.reason})`}`);
const emu = await http('POST', '/api/instances', T, { profile: 'emulator-playstore', count: 1, namePrefix: 'emu' });
log(`${emu.status === 409 ? '✓' : '✗'} emulator create refused without KVM/image: ${emu.status} ${emu.body?.error}`);

// 2. create (or reuse) 2 GApps instances
let mine = (await http('GET', '/api/instances', T)).body.instances.filter((i: any) => i.name.startsWith('g13-'));
if (mine.length === 0) {
  const c = await http('POST', '/api/instances', T, { profile: 'redroid-13-gapps', count: 2, namePrefix: 'g13' });
  log(`create 2 x redroid-13-gapps: ${c.status} ${c.body.instances.map((i: any) => `${i.name}:${i.adbPort}`).join(', ')}`);
}
const t0 = Date.now();
mine = await waitFor('running', async () => {
  const r = (await http('GET', '/api/instances', T)).body.instances.filter((i: any) => i.name.startsWith('g13-'));
  const bad = r.find((i: any) => i.status === 'error');
  if (bad) throw new Error(bad.lastError);
  return r.length === 2 && r.every((i: any) => i.status === 'running' && i.stfReady) ? r : null;
});
log(`✓ both running with STF ready (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// 3. Google health (GSF ID appears after GMS check-in, which needs network; allow a few minutes)
const health = async (id: string) => (await http('POST', `/api/instances/${id}/google/check`, T)).body.google;
for (const i of mine) {
  const g = await waitFor(`GSF ID on ${i.name}`, async () => { const h = await health(i.id); return h?.gsf?.gsfId ? h : null; }, 300_000)
    .catch(async () => health(i.id));
  log(`${i.name}: GMS ${g.gms.installed ? g.gms.version : 'missing'} running=${g.gms.running} | GSF ${g.gsf.installed} id=${g.gsf.gsfId ? 'present' : 'none'} | Play ${g.playStore.version} | YouTube ${g.youtube.installed ? g.youtube.version : 'not installed'} | accounts=${g.googleAccounts}`);
  log(`${g.gms.installed && g.gms.running && g.gsf.installed && g.playStore.installed ? '✓' : '✗'} ${i.name} Google services present and running`);
  log(`  resources: ${await stats(i.containerId)}`);
}

// 4. secure input (per-character, no clipboard) into the launcher search box
const a = mine[0];
const top = () => sh(a.containerId, 'dumpsys activity activities | grep -m1 -E "mResumedActivity|ResumedActivity:"');
const ws = new WebSocket(`${API.replace('http', 'ws')}/api/instances/${a.id}/session`);
const msgs: any[] = [];
ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'auth', token: T }));
await waitFor('session ready', async () => msgs.find((m) => m.type === 'ready'), 20_000);
const send = (m: object) => ws.send(JSON.stringify(m));
send({ type: 'key', action: 'press', key: 'home' });
await waitFor('launcher', async () => (await top()).includes('launcher'), 20_000);
await new Promise((r) => setTimeout(r, 1000));
for (const ev of [{ type: 'gestureStart' }, { type: 'down', x: 400 / 720, y: 186 / 1280 }, { type: 'commit' }, { type: 'up' }, { type: 'commit' }, { type: 'gestureStop' }]) send({ type: 'touch', ev });
await waitFor('search', async () => (await top()).includes('quicksearchbox'), 20_000);
await new Promise((r) => setTimeout(r, 1000));
const clipBefore = await sh(a.containerId, 'cmd clipboard get-primary-clip 2>/dev/null || dumpsys clipboard | head -5');
const secret = 'Secure Typing 42';
send({ type: 'typeSecure', text: secret });
await waitFor('typed ack', async () => msgs.find((m) => m.type === 'typed'), 30_000);
await new Promise((r) => setTimeout(r, 800));
await sh(a.containerId, 'screencap -p /data/local/tmp/secure.png');
fs.mkdirSync('var/google', { recursive: true });
const arch = await docker.getContainer(a.containerId).getArchive({ path: '/data/local/tmp/secure.png' });
const tar = await new Promise<Buffer>((r) => { const c: Buffer[] = []; arch.on('data', (d: Buffer) => c.push(d)); arch.on('end', () => r(Buffer.concat(c))); });
fs.writeFileSync('var/google/secure.tar', tar);
const clipAfter = await sh(a.containerId, 'cmd clipboard get-primary-clip 2>/dev/null || dumpsys clipboard | head -5');
log(`${clipAfter.includes(secret) ? '✗ secure text found in device clipboard' : '✓ secure text not present in device clipboard'} (clipboard unchanged: ${clipBefore === clipAfter})`);
log('  screenshot for visual check: apps/api/var/google/secure.tar');
send({ type: 'key', action: 'press', key: 'home' });
ws.close();

// 5. persistence across restart and stop/start
if (doRestart) {
  const before = new Map<string, any>();
  for (const i of mine) before.set(i.id, await health(i.id));
  const waitRunning = (ids: string[]) => waitFor('running again', async () => {
    const r = (await http('GET', '/api/instances', T)).body.instances.filter((x: any) => ids.includes(x.id));
    return r.every((x: any) => x.status === 'running' && x.stfReady) ? r : null;
  });
  let r = await http('POST', '/api/instances/actions', T, { action: 'restart', ids: mine.map((i: any) => i.id) });
  await waitFor('restart picked up', async () => (await http('GET', `/api/instances/${mine[0].id}`, T)).body.instance.status !== 'running', 15_000).catch(() => true);
  const tr = Date.now();
  await waitRunning(mine.map((i: any) => i.id));
  log(`✓ restart: both running again (${((Date.now() - tr) / 1000).toFixed(0)}s), accepted=${r.body.accepted.length}`);
  r = await http('POST', '/api/instances/actions', T, { action: 'stop', ids: [mine[1].id] });
  await waitFor('stopped', async () => (await http('GET', `/api/instances/${mine[1].id}`, T)).body.instance.status === 'stopped');
  await http('POST', '/api/instances/actions', T, { action: 'start', ids: [mine[1].id] });
  await waitRunning([mine[1].id]);
  log('✓ stop/start of second instance done');
  for (const i of mine) {
    const after = await waitFor('gms after restart', async () => { const h = await health(i.id); return h?.gms?.running ? h : null; }, 180_000);
    const b = before.get(i.id);
    log(`${b.gsf.gsfId && b.gsf.gsfId === after.gsf.gsfId ? '✓' : '✗'} ${i.name} GSF ID unchanged after restart (${b.gsf.gsfId ? 'id kept' : 'no id before'}), accounts ${b.googleAccounts} -> ${after.googleAccounts}, YouTube ${b.youtube.installed} -> ${after.youtube.installed}`);
  }
}

fs.writeFileSync('var/google/last-run.txt', report.join('\n') + '\n');
process.exit(0);
