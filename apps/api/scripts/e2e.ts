/**
 * End-to-end test through the public HTTP/WebSocket API against real infrastructure.
 * Requires: API running (npm run dev:api), STF, Lima VM. No mocks.
 * Usage: npx tsx --env-file=../../.env scripts/e2e.ts [path/to/test.apk]
 */
import Docker from 'dockerode';
import fs from 'node:fs';
import WebSocket from 'ws';
import { dockerFromEnv } from '../src/adapters/runtime/docker.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const WS = API.replace(/^http/, 'ws');
const apkPath = process.argv[2];
const docker: Docker = dockerFromEnv(process.env.DOCKER_HOST!);
const results: [string, boolean, string?][] = [];

function check(name: string, ok: boolean, detail?: string) {
  results.push([name, ok, detail]);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`FAILED: ${name}`);
}

async function http<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 240_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function shIn(containerId: string, cmd: string): Promise<string> {
  const exec = await docker.getContainer(containerId).exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, Tty: true });
  const s = await exec.start({ hijack: true, stdin: false, Tty: true });
  return new Promise((r) => { let b = ''; s.on('data', (d: Buffer) => (b += d)); s.on('end', () => r(b.trim())); });
}

/** Opens the events WebSocket and records every status seen per instance. */
function watchEvents(token: string) {
  const seen = new Map<string, string[]>();
  const ws = new WebSocket(`${WS}/api/events`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw.toString());
    if (ev.type === 'instance.updated') {
      const list = seen.get(ev.instance.id) ?? [];
      if (list.at(-1) !== ev.instance.status) list.push(ev.instance.status);
      seen.set(ev.instance.id, list);
    }
  });
  return { seen, close: () => ws.close() };
}

function session(token: string, instanceId: string) {
  const ws = new WebSocket(`${WS}/api/instances/${instanceId}/session`);
  let frames = 0;
  let lastFrame: Buffer | null = null;
  const msgs: any[] = [];
  let closeCode: number | null = null;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', (data, bin) => {
    if (bin) { frames++; lastFrame = data as Buffer; } else msgs.push(JSON.parse(data.toString()));
  });
  ws.on('close', (code) => { closeCode = code; });
  return {
    ws, msgs,
    get frames() { return frames; },
    get lastFrame() { return lastFrame; },
    get closeCode() { return closeCode; },
    send: (m: object) => ws.send(JSON.stringify(m)),
  };
}

const ids: string[] = [];
let adminToken = '';
let viewerId: string | null = null;
try {
  // ---- auth
  const bad = await http('POST', '/api/auth/login', undefined, { username: 'admin', password: 'wrong-password' });
  check('login rejects wrong password', bad.status === 401);
  const login = await http('POST', '/api/auth/login', undefined, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
  check('admin login', login.status === 200 && !!login.body.token);
  adminToken = login.body.token;
  check('unauthenticated request rejected', (await http('GET', '/api/instances')).status === 401);

  const events = watchEvents(adminToken);

  // ---- batch create
  const created = await http('POST', '/api/instances', adminToken, { count: 2, namePrefix: 'e2e' });
  check('batch create accepted', created.status === 202 && created.body.instances.length === 2, created.body.instances?.map((i: any) => `${i.name}:${i.adbPort}`).join(', '));
  ids.push(...created.body.instances.map((i: any) => i.id));
  const t0 = Date.now();
  const running = await waitFor('both running', async () => {
    const r = await http('GET', '/api/instances', adminToken);
    const mine = r.body.instances.filter((i: any) => ids.includes(i.id));
    const failed = mine.find((i: any) => i.status === 'error');
    if (failed) throw Object.assign(new Error(failed.lastError), { fatal: true });
    return mine.every((i: any) => i.status === 'running' && i.stfReady && i.adbState === 'device') ? mine : null;
  });
  check('both instances running (docker+adb+STF)', true, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  check('status progression pushed over WebSocket', ids.every((id) => (events.seen.get(id) ?? []).includes('running')), JSON.stringify(Object.fromEntries([...events.seen].filter(([k]) => ids.includes(k)))));

  // isolation: separate data dirs + separate network namespaces
  const [a, b] = running as any[];
  const ia = await docker.getContainer(a.containerId).inspect();
  const ib = await docker.getContainer(b.containerId).inspect();
  check('separate data directories', ia.HostConfig.Binds![0] !== ib.HostConfig.Binds![0], `${ia.HostConfig.Binds![0]} | ${ib.HostConfig.Binds![0]}`);
  const nsA = await shIn(a.containerId, 'readlink /proc/1/ns/net');
  const nsB = await shIn(b.containerId, 'readlink /proc/1/ns/net');
  check('separate network namespaces', nsA !== nsB && nsA.startsWith('net:'), `${nsA} | ${nsB}`);

  // ---- remote control session
  const s = session(adminToken, a.id);
  await waitFor('session ready', async () => s.msgs.find((m) => m.type === 'ready'), 20_000);
  await waitFor('first frame', async () => s.frames > 0, 20_000);
  const f = s.lastFrame as Buffer | null;
  check('screen frames received (JPEG)', !!f && f[0] === 0xff && f[1] === 0xd8, `${s.frames} frame(s), ${f?.length} bytes`);
  const top = () => shIn(a.containerId, 'dumpsys activity activities | grep -m1 -E \"mResumedActivity|ResumedActivity:\"');
  await waitFor('launcher', async () => (await top()).includes('launcher'), 60_000);
  const tap = (x: number, y: number) => {
    for (const ev of [{ type: 'gestureStart' }, { type: 'down', x, y }, { type: 'commit' }, { type: 'up' }, { type: 'commit' }, { type: 'gestureStop' }]) s.send({ type: 'touch', ev });
  };
  const framesBefore = s.frames;
  tap(277 / 720, 799 / 1280);
  const act = await waitFor('gallery via tap', async () => { const t = await top(); return t.includes('gallery') ? t : null; }, 20_000)
    .catch((e) => { console.log('session messages:', JSON.stringify(s.msgs)); throw e; });
  check('tap through API opens Gallery', true, act.replace(/\s+/g, ' ').slice(0, 90));
  check('screen updates streamed after input', s.frames > framesBefore, `${s.frames - framesBefore} new frames`);
  s.send({ type: 'key', action: 'press', key: 'home' });
  await waitFor('home', async () => (await top()).includes('launcher'), 20_000);
  check('key "home" through API', true);
  await new Promise((r) => setTimeout(r, 800));
  tap(400 / 720, 172 / 1280);
  await waitFor('search box', async () => (await top()).includes('quicksearchbox'), 20_000);
  await new Promise((r) => setTimeout(r, 800));
  s.send({ type: 'paste', text: 'e2e paste ok' });
  await waitFor('paste ack', async () => s.msgs.find((m) => m.type === 'pasted'), 15_000);
  check('paste acknowledged by device', true);
  s.send({ type: 'key', action: 'press', key: 'home' });
  s.ws.close();

  // ---- APK install
  if (apkPath) {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(apkPath)]), 'test.apk');
    const up = await http('POST', `/api/instances/${a.id}/apk`, adminToken, fd);
    check('APK upload accepted', up.status === 202, up.body?.taskId);
    const task = await waitFor('install task', async () => {
      const t = (await http('GET', `/api/tasks?instanceId=${a.id}`, adminToken)).body.tasks.find((x: any) => x.id === up.body.taskId);
      return t && (t.status === 'success' || t.status === 'failed') ? t : null;
    }, 120_000);
    check('install task succeeded', task.status === 'success', task.error ?? '');
    const pkgs = await shIn(a.containerId, 'pm list packages org.fdroid.fdroid');
    check('package present on device', pkgs.includes('org.fdroid.fdroid'), pkgs);
  } else {
    console.log('- APK install skipped (no apk path given)');
  }

  // ---- RBAC
  const vname = `e2e-user-${Date.now() % 100000}`;
  const vpass = `pw-${crypto.randomUUID()}`;
  const vu = await http('POST', '/api/users', adminToken, { username: vname, password: vpass, role: 'user' });
  check('admin creates user', vu.status === 201);
  viewerId = vu.body.user.id;
  check('grant viewer one instance', (await http('PUT', `/api/users/${viewerId}/grants`, adminToken, { instanceIds: [a.id] })).status === 200);
  const vt = (await http('POST', '/api/auth/login', undefined, { username: vname, password: vpass })).body.token;
  const vlist = await http('GET', '/api/instances', vt);
  check('viewer sees only granted instance', vlist.body.instances.length === 1 && vlist.body.instances[0].id === a.id);
  check('viewer cannot see other instance', (await http('GET', `/api/instances/${b.id}`, vt)).status === 403);
  check('user cannot delete instance', (await http('POST', '/api/instances/actions', vt, { action: 'delete', ids: [a.id] })).status === 403);
  check('user cannot stop non-granted instance', (await http('POST', '/api/instances/actions', vt, { action: 'stop', ids: [b.id] })).status === 403);
  check('viewer cannot create instances', (await http('POST', '/api/instances', vt, { count: 1 })).status === 403);
  check('viewer cannot manage users', (await http('GET', '/api/users', vt)).status === 403);
  const vs = session(vt, a.id);
  await waitFor('viewer session frames', async () => vs.frames > 0, 20_000);
  check('viewer can remote-control granted instance', true, `${vs.frames} frame(s)`);
  vs.ws.close();
  const vdenied = session(vt, b.id);
  await waitFor('viewer denied', async () => vdenied.closeCode, 10_000);
  check('viewer session on other instance rejected', vdenied.closeCode === 4003 && vdenied.frames === 0, `close ${vdenied.closeCode}`);

  // ---- batch lifecycle
  const waitStatus = (status: string, inst: string[] = ids) => waitFor(`all ${status}`, async () => {
    const r = (await http('GET', '/api/instances', adminToken)).body.instances.filter((i: any) => inst.includes(i.id));
    const failed = r.find((i: any) => i.status === 'error');
    if (failed) throw new Error(failed.lastError);
    return r.every((i: any) => i.status === status && (status !== 'running' || (i.stfReady && i.adbState === 'device'))) ? r : null;
  });
  let r = await http('POST', '/api/instances/actions', adminToken, { action: 'restart', ids });
  check('batch restart accepted', r.status === 202 && r.body.accepted.length === 2);
  await waitFor('restart picked up', async () => (await http('GET', `/api/instances/${a.id}`, adminToken)).body.instance.status !== 'running', 15_000).catch(() => true);
  await waitStatus('running');
  check('both running again after restart', true);

  r = await http('POST', '/api/instances/actions', adminToken, { action: 'stop', ids });
  check('batch stop accepted', r.status === 202 && r.body.accepted.length === 2);
  await waitStatus('stopped');
  const st = await docker.getContainer(a.containerId).inspect();
  check('containers actually stopped', !st.State.Running, st.State.Status);
  r = await http('POST', '/api/instances/actions', adminToken, { action: 'stop', ids });
  check('stopping stopped instances is skipped', r.body.accepted.length === 0 && r.body.skipped.length === 2);

  r = await http('POST', '/api/instances/actions', adminToken, { action: 'start', ids: [a.id] });
  await waitStatus('running', [a.id]);
  if (apkPath) {
    const pkgs = await shIn(a.containerId, 'pm list packages org.fdroid.fdroid');
    check('data persisted across stop/start (installed app still present)', pkgs.includes('org.fdroid.fdroid'));
  }
  check('single start works', true);
  events.close();
} finally {
  // ---- delete everything we created
  if (adminToken && ids.length) {
    const d = await http('POST', '/api/instances/actions', adminToken, { action: 'delete', ids });
    console.log(`cleanup: delete accepted=${d.body?.accepted?.length} skipped=${JSON.stringify(d.body?.skipped)}`);
    await waitFor('instances deleted', async () => {
      const r = (await http('GET', '/api/instances', adminToken)).body.instances.filter((i: any) => ids.includes(i.id));
      return r.length === 0;
    }, 120_000).then(() => console.log('✓ batch delete removed instances')).catch((e) => console.log('✗ delete', e.message));
    const left = await docker.listContainers({ all: true, filters: { label: ['cloudphone.instance'] } });
    console.log(`${left.length === 0 ? '✓' : '✗'} no platform containers left (${left.length})`);
    const helper = await docker.createContainer({ Image: 'alpine:3.22', Cmd: ['sh', '-c', 'ls /target | grep -c "^e2e-" || true'], HostConfig: { Binds: ['/srv/cloudphone/instances:/target'] } });
    await helper.start(); await helper.wait();
    const logs = (await helper.logs({ stdout: true })).toString().replace(/[^\d]/g, '');
    await helper.remove();
    console.log(`${logs === '0' ? '✓' : '✗'} data directories removed (remaining e2e dirs: ${logs})`);
  }
  if (adminToken && viewerId) await http('DELETE', `/api/users/${viewerId}`, adminToken);
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 200);
}
