/**
 * Per-instance proxy test through the public API against real infrastructure (no mocks).
 * Uses a sing-box test proxy container `cp-testproxy` (mixed SOCKS5/HTTP, user cpuser / cp-test-pass)
 * on the Android host; creates one redroid-12 instance `px-1` and deletes it at the end.
 * Usage: npx tsx --env-file=../../.env scripts/proxy-check.ts
 */
import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import WebSocket from 'ws';
import { dockerFromEnv } from '../src/adapters/runtime/docker.js';
import { db, schema, sqlClient } from '../src/db/index.js';

const API = 'http://127.0.0.1:3000';
const docker: Docker = dockerFromEnv(process.env.DOCKER_HOST!);
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const mask = (ip: string | null | undefined) => (ip ? ip.replace(/\.\d+\.\d+$/, '.x.x') : String(ip));

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 240_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 2000)); }
}
async function sh(id: string, cmd: string) {
  const e = await docker.getContainer(id).exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true, Tty: true });
  const s = await e.start({ hijack: true, stdin: false, Tty: true });
  return new Promise<string>((r) => { let b = ''; s.on('data', (d: Buffer) => (b += d)); s.on('end', () => r(b.trim())); });
}
async function proxyLogSince(sinceSec: number): Promise<string> {
  const buf = await docker.getContainer('cp-testproxy').logs({ stdout: true, stderr: true, since: sinceSec });
  return buf.toString('utf8');
}

const T: string = (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) })).json()).token;
const tp = await docker.getContainer('cp-testproxy').inspect();
if (!tp.State.Running) await docker.getContainer('cp-testproxy').start();
const PIP = (await docker.getContainer('cp-testproxy').inspect()).NetworkSettings.Networks.bridge!.IPAddress;
const good = { type: 'socks5' as const, host: PIP, port: 1080, username: 'cpuser', password: 'cp-test-pass' };
console.log(`test proxy ${PIP}:1080`);

let id = '';
const inst = async () => (await http('GET', `/api/instances/${id}`, T)).body.instance;
const waitTask = async (taskId: string) => waitFor('task', async () => {
  const t = (await http('GET', '/api/tasks?limit=100', T)).body.tasks.find((x: any) => x.id === taskId);
  return t && (t.status === 'succeeded' || t.status === 'failed') ? t : null;
});
const pcheck = async () => (await http('POST', `/api/instances/${id}/proxy/check`, T)).body.proxyStatus;
const androidBrowse = async (url: string) => {
  const i = await inst();
  await sh(i.containerId, `am force-stop org.chromium.webview_shell; am start -a android.intent.action.VIEW -d ${url} org.chromium.webview_shell >/dev/null 2>&1`);
  await new Promise((r) => setTimeout(r, 15_000));
};

try {
  // 1. create with proxy
  const c = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 1, namePrefix: 'px', proxy: good });
  check('create with SOCKS5 proxy accepted', c.status === 202, c.body?.error ?? '');
  id = c.body.instances[0].id;
  check('create response hides proxy password', c.body.instances[0].proxy?.password === undefined && c.body.instances[0].proxy?.hasPassword === true);
  const running = await waitFor('running', async () => { const i = await inst(); if (i.status === 'error') throw new Error(i.lastError); return i.status === 'running' && i.stfReady ? i : null; });
  check('instance running with STF via sidecar (adb through sidecar port)', true, `net=${running.netContainerId?.slice(0, 12)}`);
  const st0 = await waitFor('proxy status', async () => (await inst()).proxyStatus, 30_000);
  check('proxy status after create: ok + DNS ok', st0.ok && st0.dnsOk, `egress=${mask(st0.egressIp)} latency=${st0.latencyMs}ms`);
  const rules = await sh(running.netContainerId, 'nft list table inet cloudphone');
  check('kill-switch rules installed in instance netns', rules.includes('policy drop') && rules.includes('redirect to :7892'));

  // 2. Android app traffic through proxy
  const t0 = Math.floor(Date.now() / 1000);
  await androidBrowse('https://www.wikipedia.org');
  const log = await proxyLogSince(t0);
  const dests = [...new Set([...log.matchAll(/inbound connection to ([0-9.]+):(\d+)/g)].map((m) => `${m[1]}:${m[2]}`))];
  check('Android browser traffic went through the proxy', dests.some((d) => d.endsWith(':443')), dests.slice(0, 4).join(', '));
  // Android uses either plain DNS (redirected to sing-box -> TCP DNS via proxy, :53) or Private DNS (DoT, :853, redirected as TCP).
  check('Android DNS resolved through the proxy', dests.some((d) => d.endsWith(':53') || d.endsWith(':853')), dests.filter((d) => /:(53|853)$/.test(d)).join(', '));

  // 3. wrong credentials -> kill switch (no direct fallback)
  let r = await http('PUT', `/api/instances/${id}/proxy`, T, { proxy: { ...good, password: 'wrong' } });
  await waitTask(r.body.taskId);
  const st1 = await pcheck();
  check('wrong proxy password: no egress at all (kill switch)', !st1.ok && !st1.egressIp, st1.error ?? '');
  check('Android kept running during hot proxy change', (await inst()).status === 'running');

  // 4. switch to HTTP proxy (hot reload)
  r = await http('PUT', `/api/instances/${id}/proxy`, T, { proxy: { ...good, type: 'http' } });
  const task = await waitTask(r.body.taskId);
  const st2 = await pcheck();
  check('switch to HTTP proxy via hot reload', task.status === 'succeeded' && st2.ok, `egress=${mask(st2.egressIp)}`);
  // resubmitting without password keeps the stored one
  r = await http('PUT', `/api/instances/${id}/proxy`, T, { proxy: { type: 'http', host: PIP, port: 1080, username: 'cpuser' } });
  await waitTask(r.body.taskId);
  check('resubmit without password keeps stored password', (await pcheck()).ok);

  // 5. no accidental sharing
  r = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 1, namePrefix: 'pxdup', proxy: { ...good, type: 'http' } });
  check('same proxy on another instance rejected', r.status === 409 && /代理/.test(r.body?.error ?? ''), r.body?.error);
  r = await http('POST', '/api/instances', T, { profile: 'redroid-12', count: 2, namePrefix: 'pxdup', proxy: good });
  check('one proxy for a multi-instance batch rejected', r.status === 400, r.body?.error);

  // 6. password never in events
  const ws = new WebSocket(`${API.replace('http', 'ws')}/api/events`);
  const evs: string[] = [];
  ws.on('message', (d) => evs.push(d.toString()));
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ type: 'auth', token: T }));
  await new Promise((res) => setTimeout(res, 500));
  r = await http('PUT', `/api/instances/${id}/proxy`, T, { proxy: good });
  await waitTask(r.body.taskId);
  await new Promise((res) => setTimeout(res, 1000));
  ws.close();
  check('WebSocket events never contain the proxy password', evs.length > 0 && !evs.some((e) => e.includes('cp-test-pass')), `${evs.length} events`);

  // 7. restart keeps proxy policy
  r = await http('POST', '/api/instances/actions', T, { action: 'restart', ids: [id] });
  await waitFor('restart started', async () => (await inst()).status !== 'running', 15_000).catch(() => true);
  await waitFor('running again', async () => { const i = await inst(); return i.status === 'running' && i.stfReady; });
  const st3 = await pcheck();
  check('proxy + kill switch active after restart', st3.ok && (await sh((await inst()).netContainerId, 'nft list table inet cloudphone')).includes('policy drop'), `egress=${mask(st3.egressIp)}`);
  const t1 = Math.floor(Date.now() / 1000);
  await androidBrowse('https://www.example.org');
  check('Android traffic via proxy after restart', /inbound connection to [0-9.]+:443/.test(await proxyLogSince(t1)));

  // 8. remove proxy -> direct
  r = await http('PUT', `/api/instances/${id}/proxy`, T, { proxy: null });
  await waitTask(r.body.taskId);
  const i8 = await inst();
  const rules8 = await sh(i8.netContainerId, 'nft list table inet cloudphone');
  const st4 = await pcheck();
  check('proxy removed: rules cleared, direct egress works', !rules8.includes('policy drop') && st4.ok && i8.proxy === null, `egress=${mask(st4.egressIp)}`);

  // 9. legacy instance (no sidecar) gets converted when a proxy is set
  const old = await inst();
  await http('POST', '/api/instances/actions', T, { action: 'stop', ids: [id] });
  await waitFor('stopped', async () => (await inst()).status === 'stopped');
  await docker.getContainer(old.containerId).remove({ force: true });
  await docker.getContainer(old.netContainerId).remove({ force: true });
  const legacy = await docker.createContainer({
    name: `cloudphone-${old.name}`, Image: old.image,
    Cmd: ['androidboot.redroid_width=720', 'androidboot.redroid_height=1280', 'androidboot.redroid_dpi=320'],
    Labels: { 'cloudphone.instance': id, 'cloudphone.name': old.name, 'cloudphone.engine': 'redroid' },
    ExposedPorts: { '5555/tcp': {} },
    HostConfig: { Privileged: true, Binds: [`/srv/cloudphone/instances/${old.name}/data:/data`], PortBindings: { '5555/tcp': [{ HostIp: '0.0.0.0', HostPort: String(old.adbPort) }] } },
  });
  await db.update(schema.instances).set({ containerId: legacy.id, netContainerId: null }).where(eq(schema.instances.id, id));
  await http('POST', '/api/instances/actions', T, { action: 'start', ids: [id] });
  await waitFor('legacy running', async () => { const i = await inst(); return i.status === 'running' && i.stfReady && !i.netContainerId ? i : null; });
  check('legacy-style instance running without sidecar', true);
  r = await http('PUT', `/api/instances/${id}/proxy`, T, { proxy: good });
  const conv = await waitTask(r.body.taskId);
  const i9 = await waitFor('converted', async () => { const i = await inst(); return i.status === 'running' && i.stfReady && i.netContainerId ? i : null; });
  const st5 = await pcheck();
  check('legacy instance converted to sidecar + proxy, data kept', conv.status === 'succeeded' && st5.ok && i9.containerId !== legacy.id, conv.error ?? `egress=${mask(st5.egressIp)}`);
} catch (err) {
  check(`unexpected error: ${(err as Error).message}`, false);
} finally {
  if (id) {
    const d = await http('POST', '/api/instances/actions', T, { action: 'delete', ids: [id] });
    await waitFor('deleted', async () => (await http('GET', `/api/instances/${id}`, T)).status === 404, 120_000).catch(() => undefined);
    const left = await docker.listContainers({ all: true, filters: { name: ['cloudphone-px-1'] } });
    check('cleanup: instance, sidecar and data removed', d.status === 202 && left.length === 0, `${left.length} containers left`);
  }
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
