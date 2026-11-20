/**
 * scrcpy screen source (高速画面) through the real remote-control WebSocket, like the browser, on an EXISTING phone,
 * read only. Requires: API running, STF; the scrcpy server in infra/device-tools/scrcpy/out (fetch.sh). No mocks.
 *
 *   npx tsx --env-file=../../.env scripts/scrcpy-check.ts --device <name>   # video + clipboard READ only (no input at all), e.g. bit-ins-02
 *
 * Checks: STF frames (fps / KB/s), switch to scrcpy (codec info, config + key frame, one server process on the phone,
 * fps / KB/s / device CPU, key-frame request→arrival), a second concurrent viewer (fan-out), clipboard read, switching
 * back to STF resumes its frames, the server stops after the last viewer left. Since redroid was removed (2026-11-20)
 * there are no local test devices: the input / touch-timing / STF-fallback / RBAC parts (which needed a phone the
 * test may type on) are gone; on a BitBrowser phone only this read-only mode is allowed.
 * phone-* devices are refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { config } from '../src/config.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const WS = API.replace(/^http/, 'ws');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const deviceName = arg('--device');
if (!deviceName) throw new Error('usage: scrcpy-check.ts --device <name>   (read only, on an existing phone)');
const MEASURE_S = Number(process.env.MEASURE_S ?? 10);
const results: [string, 'pass' | 'fail' | 'skip', string?][] = [];

function check(name: string, ok: boolean, detail?: string) {
  results.push([name, ok ? 'pass' : 'fail', detail]);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`FAILED: ${name}`);
}

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
  const st = { jpeg: 0, jpegBytes: 0, h264: 0, h264Bytes: 0, configs: 0, keys: 0, firstJpegAt: 0, firstKeyAt: 0, lastKeyAt: 0, closeCode: null as number | null };
  /** Arrival time and pts (ms) of delta frames, for the jitter estimate (what the browser's playout buffer follows). */
  const arrivals: { at: number; ptsMs: number }[] = [];
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
    if (flags & 2) { st.keys++; st.firstKeyAt ||= now; st.lastKeyAt = now; }
    else arrivals.push({ at: now, ptsMs: Number(b.readBigUInt64BE(1)) / 1000 });
  });
  ws.on('close', (code) => { st.closeCode = code; });
  return {
    ws, msgs, st, t0, arrivals,
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

/** Per-interval rate of one session's counters; for h264 also the arrival jitter (p50/p90 of lateness vs. pts, ms). */
async function rate(s: Session, seconds: number, kind: 'jpeg' | 'h264') {
  const f0 = s.st[kind], b0 = s.st[`${kind}Bytes`], a0 = s.arrivals.length;
  await sleep(seconds * 1000);
  const late = s.arrivals.slice(a0).map((x) => x.at - x.ptsMs);
  const min = Math.min(...late);
  const sorted = late.map((l) => l - min).sort((x, y) => x - y);
  const pct = (q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!) : null);
  return { fps: (s.st[kind] - f0) / seconds, kBps: (s.st[`${kind}Bytes`] - b0) / 1024 / seconds, ...(kind === 'h264' ? { jitterP50Ms: pct(0.5), jitterP90Ms: pct(0.9) } : {}) };
}

/** Request → arrival of a fresh key frame (encoder reset on the device; no input), median of n samples, ms. */
async function keyFrameRtt(s: Session, n = 5) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    await sleep(1200); // the hub allows one reset per second
    const before = s.st.keys, t = Date.now();
    s.send({ type: 'keyFrame' });
    await waitFor('requested key frame', () => s.st.keys > before, 10_000, 5).catch(() => null);
    if (s.st.keys > before) ms.push(s.st.lastKeyAt - t);
  }
  ms.sort((a, b) => a - b);
  return { samples: ms, medianMs: ms.length ? ms[Math.floor(ms.length / 2)]! : null };
}

/** CPU busy % over an interval from /proc/stat (the device via adb). */
async function cpuStat(read: () => Promise<string>) {
  const parse = (t: string) => { const v = t.split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number); const idle = v[3]! + (v[4] ?? 0); const total = v.reduce((a, b) => a + b, 0); return { idle, total }; };
  const a = parse(await read());
  return async () => { const b = parse(await read()); return Math.round(100 * (1 - (b.idle - a.idle) / (b.total - a.total))); };
}

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
const jar = path.resolve(config.SCRCPY_SERVER_PATH);
const measurements: Record<string, unknown> = {};
try {
  const login = await http('POST', '/api/auth/login', undefined, await withCaptcha(API, { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }));
  check('admin login', login.status === 200);
  adminToken = login.body.token;
  check('scrcpy server present', fs.existsSync(jar), jar);
  const list = (await http('GET', '/api/instances', adminToken)).body.instances as any[];

  if (deviceName.startsWith('phone-')) throw new Error('phone-* devices belong to the owner: refused');
  const inst = list.find((i) => i.name === deviceName);
  if (!inst) throw new Error(`no device named ${deviceName}`);
  const port = inst.adbPort as number;
  console.log(`device ${inst.name} (adb ${port}, ${inst.spec.width}x${inst.spec.height}) — VIDEO ONLY, no input`);
  check('no scrcpy server running before the test', (await serverProcs(port)) === 0);

  const cpu = async () => ({ device: await cpuStat(() => adb.shell(port, 'head -1 /proc/stat')) });
  const cpuEnd = async (c: Awaited<ReturnType<typeof cpu>>) => ({ device: await c.device() });

  // ---- STF
  {
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
  check('codec info JSON', typeof info.codec === 'string' && info.codec.startsWith('avc1.') && info.width > 0 && info.height > 0, `${info.codec} ${info.width}x${info.height} via ${info.via}${info.relayError ? ` (relay failed: ${info.relayError})` : ''}`);
  await waitFor('config + key frame', () => a.st.configs > 0 && a.st.keys > 0, 10_000);
  const ttffScrcpy = a.st.firstKeyAt - sw.sentAt;
  check('config and key frame within 10 s', true, `first key frame ${ttffScrcpy} ms after switching (${a.st.firstKeyAt - a.t0} ms after connecting)`);
  check('one server process on the device', (await serverProcs(port)) === 1);
  {
    const c = await cpu();
    const pc = await procCpu(port, '[s]crcpy.Server');
    const r = await rate(a, MEASURE_S, 'h264');
    measurements.scrcpy = { via: info.via, ttffMs: ttffScrcpy, ttffFromConnectMs: a.st.firstKeyAt - a.t0, ...r, cpu: await cpuEnd(c), captureProcCpuPctOfCore: await pc(), keyFrameRtt: await keyFrameRtt(a) };
    console.log(`  scrcpy: ${JSON.stringify(measurements.scrcpy)}`);
  }

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

  console.log('\nMEASUREMENTS', JSON.stringify(measurements, null, 1));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const [, r] of results) counts[r]++;
  console.log(`\n${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`);
  process.exit(process.exitCode ?? 0);
}
