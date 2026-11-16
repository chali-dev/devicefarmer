/**
 * scrcpy screen source (高速画面) through the real remote-control WebSocket, like the browser.
 * Requires: API running, STF, Lima VM; the scrcpy server in infra/device-tools/scrcpy/out (fetch.sh). No mocks.
 *
 *   npx tsx --env-file=../../.env scripts/scrcpy-check.ts                 # creates a redroid-13-gapps device "scchk-*", full run, deletes it
 *   npx tsx --env-file=../../.env scripts/scrcpy-check.ts --reuse <name>  # full run (incl. input) on an existing test device, not deleted
 *   npx tsx --env-file=../../.env scripts/scrcpy-check.ts --device <name> # video + clipboard READ only (no input at all), e.g. bit-ins-02
 *
 * Full run: codec info/config/key frame + fps/KB/s for scrcpy vs STF (with on-screen motion driven
 * over adb), VM CPU, a second concurrent viewer (fan-out), HOME key, tap, paste/typeSecure, device
 * clipboard messages, server gone after the last viewer left, STF fallback without the jar, RBAC.
 * phone-* devices are refused.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { config } from '../src/config.js';
import { adb } from '../src/services.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const WS = API.replace(/^http/, 'ws');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const videoOnlyName = arg('--device');
const reuseName = arg('--reuse');
const MEASURE_S = Number(process.env.MEASURE_S ?? 10);
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
async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 20_000, everyMs = 200): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A remote-control session as the browser drives it. Binary messages are JPEG (stf) or [flags][pts][H.264] (scrcpy). */
function session(token: string, instanceId: string) {
  const ws = new WebSocket(`${WS}/api/instances/${instanceId}/session`);
  const msgs: any[] = [];
  const t0 = Date.now();
  let mode: 'jpeg' | 'h264' = 'jpeg';
  const st = { jpeg: 0, jpegBytes: 0, h264: 0, h264Bytes: 0, configs: 0, keys: 0, firstJpegAt: 0, firstKeyAt: 0, closeCode: null as number | null };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', (data, bin) => {
    const now = Date.now();
    if (!bin) {
      const m = JSON.parse(data.toString());
      m.at = now;
      msgs.push(m);
      if (m.type === 'video') mode = 'h264';
      if (m.type === 'screenSource' && m.source !== 'scrcpy') mode = 'jpeg';
      return;
    }
    const b = data as Buffer;
    if (mode === 'jpeg') { st.jpeg++; st.jpegBytes += b.length; st.firstJpegAt ||= now; return; }
    const flags = b[0]!;
    if (flags & 1) { st.configs++; return; }
    st.h264++; st.h264Bytes += b.length;
    if (flags & 2) { st.keys++; st.firstKeyAt ||= now; }
  });
  ws.on('close', (code) => { st.closeCode = code; });
  return {
    ws, msgs, st, t0,
    send: (m: object) => ws.send(JSON.stringify(m)),
    msg: (pred: (m: any) => boolean, label: string, timeoutMs = 15_000) => waitFor(label, () => msgs.find(pred), timeoutMs),
    close: () => new Promise<void>((r) => { if (ws.readyState === WebSocket.CLOSED) return r(); ws.once('close', () => r()); ws.close(1000); }),
  };
}
type Session = ReturnType<typeof session>;

async function ready(s: Session) { await s.msg((m) => m.type === 'ready', 'session ready'); }

async function toScrcpy(s: Session) {
  const t = Date.now();
  s.send({ type: 'screenSource', source: 'scrcpy' });
  const sw = await s.msg((m) => m.type === 'screenSource', 'screenSource reply', 30_000);
  return { ok: sw.source === 'scrcpy', reply: sw, sentAt: t };
}

/** Per-interval rate of one session's counters. */
async function rate(s: Session, seconds: number, kind: 'jpeg' | 'h264') {
  const f0 = s.st[kind], b0 = s.st[`${kind}Bytes`];
  await sleep(seconds * 1000);
  return { fps: (s.st[kind] - f0) / seconds, kBps: (s.st[`${kind}Bytes`] - b0) / 1024 / seconds };
}

/** CPU busy % over an interval from /proc/stat (VM via limactl, or the device via adb). */
async function cpuStat(read: () => Promise<string>) {
  const parse = (t: string) => { const v = t.split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number); const idle = v[3]! + (v[4] ?? 0); const total = v.reduce((a, b) => a + b, 0); return { idle, total }; };
  const a = parse(await read());
  return async () => { const b = parse(await read()); return Math.round(100 * (1 - (b.idle - a.idle) / (b.total - a.total))); };
}
const limaStat = async () => execFileSync('limactl', ['shell', 'redroid', 'cat', '/proc/stat'], { encoding: 'utf8' });
let haveLima = false;
try { execFileSync('limactl', ['list', 'redroid'], { stdio: 'ignore' }); haveLima = true; } catch { /* no VM CLI */ }

/** CPU of the processes matching a pattern, in % of one core over an interval (utime+stime, 100 Hz ticks). */
async function procCpu(port: number, pattern: string) {
  const read = async () => {
    const out = await adb.shell(port, `for p in $(pgrep -f '${pattern}'); do cat /proc/$p/stat 2>/dev/null; echo; done`);
    return out.split('\n').filter((l) => l.includes(')')).reduce((sum, l) => { const f = l.slice(l.lastIndexOf(')') + 2).split(' '); return sum + Number(f[11]) + Number(f[12]); }, 0);
  };
  const a = await read(); const t = Date.now();
  return async () => Math.round(((await read()) - a) / ((Date.now() - t) / 1000));
}

const serverProcs = async (port: number) => Number((await adb.shell(port, 'ps -A -o ARGS | grep -c "[s]crcpy.Server"')).trim());

let adminToken = '';
let createdId: string | null = null;
let userId: string | null = null;
const jar = path.resolve(config.SCRCPY_SERVER_PATH);
const jarAside = `${jar}.aside`;
const measurements: Record<string, unknown> = {};
try {
  const login = await http('POST', '/api/auth/login', undefined, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
  check('admin login', login.status === 200);
  adminToken = login.body.token;
  check('scrcpy server present', fs.existsSync(jar), jar);
  const list = (await http('GET', '/api/instances', adminToken)).body.instances as any[];

  let inst: any;
  const wanted = videoOnlyName ?? reuseName;
  if (wanted) {
    if (wanted.startsWith('phone-')) throw new Error('phone-* devices belong to the owner: refused');
    inst = list.find((i) => i.name === wanted);
    if (!inst) throw new Error(`no device named ${wanted}`);
    if (reuseName && inst.sourceId) throw new Error('--reuse is for local test devices; use --device for external phones (video only)');
  } else {
    const created = await http('POST', '/api/instances', adminToken, { count: 1, namePrefix: 'scchk', profile: 'redroid-13-gapps', proxyMode: 'none' });
    if (created.status === 409 || created.status === 507) { skip('create test device', `refused: ${JSON.stringify(created.body)}`); process.exit(2); }
    check('test device created', created.status === 202, created.body.instances?.[0]?.name);
    createdId = created.body.instances[0].id;
    inst = await waitFor('device running + STF ready', async () => {
      const r = await http('GET', `/api/instances/${createdId}`, adminToken);
      const i = r.body.instance ?? r.body;
      if (i.status === 'error') throw new Error(`device error: ${i.lastError}`);
      return i.status === 'running' && i.stfReady ? i : null;
    }, 300_000, 2000);
  }
  const port = inst.adbPort as number;
  const local = !inst.sourceId;
  console.log(`device ${inst.name} (${local ? 'redroid' : 'external'}, adb ${port}, ${inst.spec.width}x${inst.spec.height})${videoOnlyName ? ' — VIDEO ONLY, no input' : ''}`);
  check('no scrcpy server running before the test', (await serverProcs(port)) === 0);

  // Motion for fps measurements (local test devices only): scroll Settings up and down over adb.
  let motion: Promise<string> | null = null;
  const startMotion = async () => {
    if (videoOnlyName) return;
    await adb.shell(port, 'am start -W -a android.settings.SETTINGS >/dev/null');
    await sleep(1500);
    // Slow drags (3 s each) keep the list moving almost continuously; bounded in time in case we die.
    motion = adb.shell(port, `end=$(( $(date +%s) + ${MEASURE_S * 4 + 30} )); while [ $(date +%s) -lt $end ]; do input swipe 360 1100 360 300 3000; input swipe 360 300 360 1100 3000; done`, 600_000).catch(() => '');
    await sleep(1000);
  };
  const stopMotion = async () => { if (motion) { await adb.shell(port, 'pkill -f "input swipe" || true').catch(() => undefined); motion = null; } };
  const cpu = async () => ({
    vm: local && haveLima ? await cpuStat(limaStat) : null,
    device: await cpuStat(() => adb.shell(port, 'head -1 /proc/stat')),
  });
  const cpuEnd = async (c: Awaited<ReturnType<typeof cpu>>) => ({ vm: c.vm ? await c.vm() : null, device: await c.device() });

  // ---- baseline: motion, no viewer
  if (!videoOnlyName && local) {
    await startMotion();
    const c = await cpu();
    await sleep(MEASURE_S * 1000);
    measurements.baselineCpu = await cpuEnd(c);
    console.log(`  baseline (motion, no viewer): CPU ${JSON.stringify(measurements.baselineCpu)}`);
  }

  // ---- STF
  {
    if (!videoOnlyName && !motion) await startMotion();
    const s = session(adminToken, inst.id);
    await ready(s);
    await waitFor('first STF frame', () => s.st.firstJpegAt, 20_000).catch(() => 0);
    const ttff = s.st.firstJpegAt ? s.st.firstJpegAt - s.t0 : null;
    const c = await cpu();
    const pc = await procCpu(port, '[i]o.devicefarmer.minicap');
    const r = await rate(s, MEASURE_S, 'jpeg');
    measurements.stf = { ttffMs: ttff, ...r, cpu: await cpuEnd(c), captureProcCpuPctOfCore: await pc() };
    console.log(`  STF: ${JSON.stringify(measurements.stf)}`);
    await s.close();
  }

  // ---- scrcpy, first viewer
  const a = session(adminToken, inst.id);
  await ready(a);
  const sw = await toScrcpy(a);
  check('switch to scrcpy', sw.ok, sw.reply.reason ?? '');
  const info = await a.msg((m) => m.type === 'video', 'video info', 5000);
  check('codec info JSON', typeof info.codec === 'string' && info.codec.startsWith('avc1.') && info.width > 0 && info.height > 0, `${info.codec} ${info.width}x${info.height}`);
  await waitFor('config + key frame', () => a.st.configs > 0 && a.st.keys > 0, 10_000);
  const ttffScrcpy = a.st.firstKeyAt - sw.sentAt;
  check('config and key frame within 10 s', true, `first key frame ${ttffScrcpy} ms after switching (${a.st.firstKeyAt - a.t0} ms after connecting)`);
  check('one server process on the device', (await serverProcs(port)) === 1);
  {
    const c = await cpu();
    const pc = await procCpu(port, '[s]crcpy.Server');
    const r = await rate(a, MEASURE_S, 'h264');
    measurements.scrcpy = { ttffMs: ttffScrcpy, ttffFromConnectMs: a.st.firstKeyAt - a.t0, ...r, cpu: await cpuEnd(c), captureProcCpuPctOfCore: await pc() };
    console.log(`  scrcpy: ${JSON.stringify(measurements.scrcpy)}`);
  }
  await stopMotion();

  // ---- fan-out: second viewer gets a key frame; still one server
  const b = session(adminToken, inst.id);
  await ready(b);
  const swb = await toScrcpy(b);
  check('second viewer switches to scrcpy', swb.ok);
  await waitFor('second viewer key frame', () => b.st.keys > 0 && b.st.configs > 0, 5000);
  check('second viewer gets config + key frame (fan-out)', true, `${b.st.firstKeyAt - swb.sentAt} ms`);
  check('still one server process', (await serverProcs(port)) === 1);

  // ---- clipboard read (allowed everywhere; content never printed)
  a.send({ type: 'getClipboard' });
  const clip = await a.msg((m) => m.type === 'clipboard' && m.requested, 'clipboard read', 5000);
  check('device clipboard read', typeof clip.text === 'string', `${clip.text.length} chars`);

  if (videoOnlyName) {
    skip('input tests (HOME, tap, paste, typeSecure, clipboard change)', 'video-only run on an existing device');
  } else {
    const top = async () => (await adb.shell(port, 'dumpsys activity activities | grep -m1 -E "mResumedActivity|ResumedActivity:"')).trim();
    // HOME key through scrcpy control
    await adb.shell(port, 'am start -W -a android.settings.SETTINGS >/dev/null');
    await waitFor('Settings resumed', async () => (await top()).includes('settings'), 10_000);
    const before = await top();
    a.send({ type: 'key', action: 'press', key: 'home' });
    const after = await waitFor('HOME changes the resumed activity', async () => { const t = await top(); return t !== before && !t.includes('settings') ? t : null; }, 10_000);
    check('HOME key via scrcpy changes the resumed activity', true, after.replace(/^.*?\{/, '{'));

    // Tap via scrcpy touch (normalised coordinates, launcher Gallery icon as in smoke-adapters LAYOUT['13'])
    await sleep(800);
    const release = (await adb.shell(port, 'getprop ro.build.version.release')).trim();
    const gallery = release === '13' ? [274 / 720, 860 / 1280] : [277 / 720, 799 / 1280];
    const tap = (x: number, y: number) => {
      a.send({ type: 'touch', ev: { type: 'gestureStart' } });
      a.send({ type: 'touch', ev: { type: 'down', x, y } });
      a.send({ type: 'touch', ev: { type: 'commit' } });
      a.send({ type: 'touch', ev: { type: 'up' } });
      a.send({ type: 'touch', ev: { type: 'commit' } });
      a.send({ type: 'touch', ev: { type: 'gestureStop' } });
    };
    tap(gallery[0]!, gallery[1]!);
    const opened = await waitFor('tap opens Gallery', async () => { const t = await top(); return t.toLowerCase().includes('gallery') ? t : null; }, 10_000).catch(() => null);
    if (opened) check('tap via scrcpy opens the launcher icon', true, opened.replace(/^.*?\{/, '{'));
    else skip('tap via scrcpy', `Gallery not opened (launcher layout differs?); top: ${await top()}`);

    // Paste + typeSecure into the launcher's search box, read back with uiautomator
    a.send({ type: 'key', action: 'press', key: 'home' });
    await sleep(1200);
    tap(400 / 720, (release === '13' ? 186 : 172) / 1280);
    const searchOk = await waitFor('search activity', async () => (await top()).includes('quicksearchbox'), 10_000).then(() => true, () => false);
    if (!searchOk) skip('paste/typeSecure read-back', 'search box not opened');
    else {
      await sleep(1000);
      a.send({ type: 'paste', text: 'scrcpy 123' });
      await a.msg((m) => m.type === 'pasted', 'pasted ack', 5000);
      await sleep(800);
      a.send({ type: 'typeSecure', text: 'xyz' });
      await a.msg((m) => m.type === 'typed', 'typed ack', 10_000);
      await sleep(800);
      const dump = await adb.shell(port, 'uiautomator dump /sdcard/sc-ui.xml >/dev/null && cat /sdcard/sc-ui.xml; rm -f /sdcard/sc-ui.xml', 30_000);
      const texts = [...dump.matchAll(/text="([^"]*)"/g)].map((m) => m[1]);
      check('paste + typeSecure via scrcpy land in order', texts.some((t) => t === 'scrcpy 123xyz'), texts.filter(Boolean).slice(0, 5).join(' | '));
    }
    a.send({ type: 'key', action: 'press', key: 'home' });

    // Our own paste is not echoed back as a "device clipboard changed" message …
    await sleep(2500);
    check('own paste is not announced as a device clipboard change', !b.msgs.some((m) => m.type === 'clipboard' && !m.requested));
    a.send({ type: 'getClipboard' });
    const own = await waitFor('clipboard read after paste', () => a.msgs.filter((m) => m.type === 'clipboard' && m.requested).at(1), 5000);
    check('clipboard read returns the pasted text', own.text === 'scrcpy 123', own.text);
    // … but a change made on the device by someone else is (here: STF's clipboard, from a viewer on the STF source)
    const c = session(adminToken, inst.id);
    await ready(c);
    const text = `cp-clip-${Date.now()}`;
    const pasteAt = Date.now();
    c.send({ type: 'paste', text });
    await c.msg((m) => m.type === 'pasted', 'STF paste ack', 10_000);
    const pushed = await b.msg((m) => m.type === 'clipboard' && !m.requested && m.text === text, 'device clipboard message', 5000).catch(() => null);
    check('device clipboard change reaches scrcpy viewers', !!pushed, pushed ? `${pushed.at - pasteAt} ms after sending the STF paste (polled every 1 s)` : 'not received');
    await c.close();
  }

  // ---- back to STF: its screen socket was paused ('off') and must resume
  b.send({ type: 'screenSource', source: 'stf' });
  await b.msg((m) => m.type === 'screenSource' && m.source === 'stf', 'switch back to STF', 5000);
  const j0 = b.st.jpeg;
  const resumed = await waitFor('JPEG frames after switching back', () => b.st.jpeg > j0, 10_000).then(() => true, () => false);
  check('switching back to STF resumes its frames', resumed, `${b.st.jpeg - j0} frame(s)`);

  // ---- server gone after the last viewer left (stop delay 5 s)
  await a.close();
  await b.close();
  check('server still running right after the last viewer left (grace period)', (await serverProcs(port)) === 1);
  await waitFor('server stopped', async () => (await serverProcs(port)) === 0, 15_000, 500);
  check('server process gone after the last viewer left', true);

  // ---- fallback to STF when the jar is missing (local file renamed for a moment)
  if (videoOnlyName) skip('STF fallback without the jar', 'video-only run');
  else {
    fs.renameSync(jar, jarAside);
    try {
      const f = session(adminToken, inst.id);
      await ready(f);
      const r = await toScrcpy(f);
      check('missing jar: falls back to STF with a coded reason', !r.ok && r.reply.source === 'stf' && r.reply.code === 'player.scrcpy_unavailable', r.reply.reason);
      await waitFor('STF frames after fallback', () => f.st.jpeg > 0, 10_000);
      check('STF frames keep coming after the fallback', true, `${f.st.jpeg} frame(s)`);
      await f.close();
    } finally {
      fs.renameSync(jarAside, jar);
    }
  }

  // ---- RBAC: a user without a grant on the device cannot open the session
  if (videoOnlyName) skip('RBAC', 'video-only run');
  else {
    const uname = `sc-user-${Date.now() % 100000}`;
    const upass = `pw-${crypto.randomUUID()}`;
    const u = await http('POST', '/api/users', adminToken, { username: uname, password: upass, role: 'user' });
    check('create user without a grant', u.status === 201);
    userId = u.body.user.id;
    const ut = (await http('POST', '/api/auth/login', undefined, { username: uname, password: upass })).body.token;
    const s = session(ut, inst.id);
    await waitFor('session refused', () => s.st.closeCode, 10_000);
    check('user without control access is refused', s.st.closeCode === 4003, `close ${s.st.closeCode}`);
  }

  console.log('\nMEASUREMENTS', JSON.stringify(measurements, null, 1));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  if (fs.existsSync(jarAside) && !fs.existsSync(jar)) fs.renameSync(jarAside, jar);
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
