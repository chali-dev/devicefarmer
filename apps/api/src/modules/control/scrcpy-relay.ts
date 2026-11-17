/**
 * Relay listener (experimental, SCRCPY_RELAY_URL): the device helper CpRelay connects here over a
 * WebSocket for each scrcpy socket (video, control) instead of us reaching them through adb.
 *
 * A separate WebSocket server on 127.0.0.1:SCRCPY_RELAY_PORT, so a tunnel (ngrok) exposes only this,
 * never the API. Each server start registers a random token (kept hashed, single use per channel,
 * expires with the start deadline); the helper sends it in X-Relay-Token. Anything else is refused
 * before the upgrade.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { config } from '../../config.js';
import type { RelayWait } from '../../adapters/scrcpy.js';

const PATH = '/scrcpy-relay';
/** Ping interval: keeps idle sockets (control) open through the tunnel and measures the relay round trip. */
const PING_MS = 2000;

interface Pending { take: Map<string, (s: Duplex) => void>; fail: (e: Error) => void; timer: NodeJS.Timeout }
const pending = new Map<string, Pending>();
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
/** Last ping → pong round trip per relay stream (CpRelay answers pings at once), ms. */
const rtt = new WeakMap<Duplex, number>();

/** API ↔ device round trip over this relay stream, null until the first pong. */
export function relayRttMs(stream: Duplex): number | null {
  return rtt.get(stream) ?? null;
}

/** Registers a token and waits for the helper's connections, one per channel. */
export function expectRelay(channels: string[], timeoutMs: number): RelayWait {
  const token = randomBytes(24).toString('base64url');
  const key = hash(token);
  const streams: Record<string, Promise<Duplex>> = {};
  const take = new Map<string, (s: Duplex) => void>();
  const rejects: ((e: Error) => void)[] = [];
  for (const ch of channels) {
    streams[ch] = new Promise<Duplex>((resolve, reject) => { take.set(ch, resolve); rejects.push(reject); });
    streams[ch]!.catch(() => undefined); // a channel nobody awaits after an earlier failure
  }
  const fail = (e: Error) => { pending.delete(key); clearTimeout(entry.timer); for (const r of rejects) r(e); };
  const entry: Pending = { take, fail, timer: setTimeout(() => fail(new Error('relay did not connect')), timeoutMs) };
  pending.set(key, entry);
  return { token, streams, cancel: () => fail(new Error('relay cancelled')) };
}

let wss: WebSocketServer | null = null;

/** Starts the listener when the relay is configured. */
export function startRelayListener(log: { info(o: object, m: string): void; warn(o: object, m: string): void }): void {
  if (!config.SCRCPY_RELAY_URL || wss) return;
  wss = new WebSocketServer({
    host: '127.0.0.1', port: config.SCRCPY_RELAY_PORT, maxPayload: 1024 * 1024,
    verifyClient: ({ req }, cb) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const token = req.headers['x-relay-token'];
      const p = url.pathname === PATH && typeof token === 'string' ? pending.get(hash(token)) : undefined;
      const ch = url.searchParams.get('ch') ?? '';
      if (!p || !p.take.has(ch)) return cb(false, 401);
      cb(true);
    },
  });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = hash(String(req.headers['x-relay-token']));
    const ch = url.searchParams.get('ch') ?? '';
    const p = pending.get(key);
    const resolve = p?.take.get(ch);
    if (!p || !resolve) return ws.close(1008); // raced with expiry or a second use
    p.take.delete(ch);
    if (!p.take.size) { pending.delete(key); clearTimeout(p.timer); }
    const stream = createWebSocketStream(ws);
    let sentAt = 0;
    const ping = () => { sentAt = performance.now(); ws.ping(); };
    ws.on('pong', () => { if (sentAt) rtt.set(stream, Math.round(performance.now() - sentAt)); sentAt = 0; });
    const timer = setInterval(ping, PING_MS);
    ws.on('close', () => clearInterval(timer));
    ping();
    resolve(stream);
  });
  wss.on('error', (err) => log.warn({ err }, 'scrcpy relay listener error'));
  log.info({ port: config.SCRCPY_RELAY_PORT, url: config.SCRCPY_RELAY_URL }, 'scrcpy relay listener started');
}
