import type { FastifyPluginAsync } from 'fastify';
import path from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';
import { adb, stf } from '../../services.js';
import { assertInstanceAccess } from '../auth/rbac.js';
import { getInstance } from '../instances/repo.js';
import { joinScrcpy, type ScrcpyHandle, type ScrcpyViewer } from './scrcpy-hub.js';

const ClientMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string() }),
  z.object({
    type: z.literal('touch'),
    ev: z.discriminatedUnion('type', [
      z.object({ type: z.enum(['gestureStart', 'gestureStop', 'commit']) }),
      z.object({ type: z.enum(['down', 'move']), x: z.number().min(0).max(1), y: z.number().min(0).max(1), contact: z.number().int().min(0).max(9).optional(), pressure: z.number().min(0).max(1).optional() }),
      z.object({ type: z.literal('up'), contact: z.number().int().min(0).max(9).optional() }),
    ]),
  }),
  z.object({ type: z.literal('key'), action: z.enum(['down', 'up', 'press']), key: z.string().regex(/^[a-z0-9_]{1,32}$/) }),
  z.object({ type: z.literal('paste'), text: z.string().max(10_000) }),
  // Secure input (passwords): per-character key events, never via the device clipboard.
  z.object({ type: z.literal('typeSecure'), text: z.string().min(1).max(256) }),
  // 'secure': frames from the system-level capture helper, which also shows FLAG_SECURE windows.
  // 'scrcpy': H.264 from scrcpy-server (shared per device); input then goes through scrcpy too.
  z.object({ type: z.literal('screenSource'), source: z.enum(['stf', 'secure', 'scrcpy']) }),
  // Reads the device clipboard (scrcpy source only).
  z.object({ type: z.literal('getClipboard') }),
  // Latency probe: answered at once with {type:'pong', t, deviceMs, link}: deviceMs = API ↔ device round trip of the
  // path input takes (link 'relay': WebSocket ping over the scrcpy relay; 'adb': a no-op adb shell).
  z.object({ type: z.literal('ping'), t: z.number() }),
  // The browser dropped H.264 frames (decoder backlog) and needs a fresh key frame (scrcpy source only).
  z.object({ type: z.literal('keyFrame') }),
]);

const SECURE_CHAR_GAP_MS = 120; // human-like pace; bursts get reordered on redroid

const MAX_BUFFERED = 2 * 1024 * 1024; // drop frames for slow clients instead of queueing

function screenUrl(url: string): string {
  if (!config.STF_SCREEN_HOST) return url;
  const u = new URL(url);
  u.hostname = config.STF_SCREEN_HOST;
  return u.toString();
}

/**
 * Remote-control session: one WebSocket per viewer.
 * Down: JPEG frames relayed from STF's screen stream (or the secure helper), or with the scrcpy
 * source a {type:'video'} JSON message followed by binary H.264 packets ([u8 flags][u64 pts][Annex B],
 * see scrcpy-hub.ts) plus {type:'clipboard'} on device clipboard changes. Up: JSON input events.
 * RBAC is enforced here; STF itself is never exposed to end users.
 */
export const controlRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/api/instances/:id/session', { websocket: true }, (client, req) => {
    const instanceId = req.params.id;
    let upstream: WebSocket | null = null;
    let channel: string | null = null;
    let adbPort = 0;
    let external = false;
    let source: 'stf' | 'secure' | 'scrcpy' = 'stf';
    let secureStream: import('node:stream').Duplex | null = null;
    let scrcpy: ScrcpyHandle | null = null;
    let authed = false;
    const send = (msg: object) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); };
    /** STF keeps encoding JPEGs for this socket only while 'on': pause it while scrcpy delivers the screen. */
    const stfScreen = (on: boolean) => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(on ? 'on' : 'off'); };
    const viewer: ScrcpyViewer = {
      sendBinary: (data) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true }); },
      sendJson: send,
      buffered: () => client.bufferedAmount,
      onEnd: (reason) => {
        scrcpy = null;
        if (source !== 'scrcpy') return;
        source = 'stf';
        stfScreen(true);
        send({ type: 'screenSource', source: 'stf', reason: `scrcpy ended: ${reason}`, code: 'player.scrcpy_ended', params: { error: reason } });
      },
    };
    const leaveScrcpy = () => { scrcpy?.leave(); scrcpy = null; };
    const stopSecure = () => { secureStream?.destroy(); secureStream = null; };
    const fail = (message: string, code = 4000) => { send({ type: 'error', message }); client.close(code, message.slice(0, 100)); };
    const authTimer = setTimeout(() => { if (!authed) fail('auth timeout', 4001); }, 5000);

    client.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      let msg: z.infer<typeof ClientMsg>;
      try { msg = ClientMsg.parse(JSON.parse(raw.toString())); } catch { return send({ type: 'error', message: 'bad message' }); }

      if (!authed) {
        if (msg.type !== 'auth') return fail('auth required', 4001);
        try {
          const user = await app.userFromToken(msg.token);
          await assertInstanceAccess(user, instanceId, 'control');
          const inst = await getInstance(instanceId);
          if (!inst) return fail('instance not found', 4004);
          if (inst.status !== 'running') return fail('instance is not running', 4009);
          const serial = adb.serialFor(inst.adbPort);
          await stf.claim(serial);
          const dev = await stf.getDevice(serial);
          if (!dev?.channel || !dev.display?.url) return fail('device not ready in STF', 4009);
          channel = dev.channel;
          adbPort = inst.adbPort;
          external = !!inst.sourceId;
          authed = true;
          clearTimeout(authTimer);
          req.log.info({ instanceId, user: user.username }, 'control session opened');

          // The screen port changes whenever STF re-creates the device worker: always resolve it fresh.
          upstream = new WebSocket(screenUrl(dev.display.url));
          upstream.binaryType = 'nodebuffer';
          upstream.on('open', () => {
            upstream!.send(`size ${inst.spec.width}x${inst.spec.height}`);
            if (source !== 'scrcpy') upstream!.send('on');
          });
          upstream.on('message', (data, bin) => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (bin) {
              if (source === 'stf' && client.bufferedAmount < MAX_BUFFERED) client.send(data, { binary: true });
            } else {
              const text = data.toString();
              if (text.startsWith('start ')) {
                try { send({ type: 'screen', ...JSON.parse(text.slice(6)) }); } catch { /* ignore */ }
              }
            }
          });
          upstream.on('close', () => fail('screen stream closed', 4010));
          upstream.on('error', (err) => fail(`screen stream error: ${err.message}`, 4010));
          send({ type: 'ready', width: inst.spec.width, height: inst.spec.height });
        } catch (err) {
          if (!(err instanceof HttpError)) req.log.warn({ err, instanceId }, 'control session setup failed');
          return fail(err instanceof HttpError ? err.message : `session setup failed: ${(err as Error).message}`, err instanceof HttpError && err.statusCode === 403 ? 4003 : 4000);
        }
        return;
      }

      try {
        // While scrcpy delivers the screen, input goes through its control socket (STF's touch
        // gestures don't apply: scrcpy takes plain down/move/up per pointer).
        const sc = source === 'scrcpy' ? scrcpy : null;
        if (msg.type === 'touch') {
          if (sc) { if (msg.ev.type === 'down' || msg.ev.type === 'move' || msg.ev.type === 'up') sc.touch(msg.ev); }
          else await stf.touch(channel!, msg.ev);
        }
        else if (msg.type === 'key') { if (!sc?.key(msg.action, msg.key)) await stf.key(channel!, msg.action, msg.key); }
        else if (msg.type === 'paste') { if (sc) sc.paste(msg.text); else await stf.paste(channel!, msg.text); send({ type: 'pasted' }); }
        else if (msg.type === 'ping') {
          const relay = sc?.relayRttMs();
          send({ type: 'pong', t: msg.t, ...(relay !== undefined ? { deviceMs: relay, link: 'relay' } : { deviceMs: adb.rttMs(adbPort), link: 'adb' }) });
        }
        else if (msg.type === 'keyFrame') sc?.requestKeyFrame();
        else if (msg.type === 'getClipboard') {
          if (!sc) return send({ type: 'error', message: 'device clipboard needs the scrcpy source', code: 'player.clipboard_needs_scrcpy' });
          // Content is only forwarded to this (control-authorised) viewer, never logged.
          send({ type: 'clipboard', text: await sc.getClipboard(), requested: true });
        }
        else if (msg.type === 'screenSource') {
          if (msg.source === source) return;
          if (msg.source === 'scrcpy') {
            const prev = source;
            source = 'scrcpy'; // stop relaying JPEGs while it starts; the canvas keeps the last frame
            try {
              scrcpy = await joinScrcpy(adbPort, viewer, external);
            } catch (err) {
              req.log.warn({ err, instanceId }, 'scrcpy start failed');
              source = prev;
              send({ type: 'screenSource', source, reason: `高速画面不可用：${(err as Error).message}`, code: 'player.scrcpy_unavailable', params: { error: (err as Error).message } });
              return;
            }
            if (client.readyState !== WebSocket.OPEN) { leaveScrcpy(); return; }
            stopSecure();
            stfScreen(false);
          } else if (msg.source === 'secure') {
            try {
              secureStream = await adb.openSecureCapture(adbPort, path.resolve(config.CAPTURE_DEX_PATH));
            } catch (err) {
              req.log.warn({ err, instanceId }, 'secure capture failed');
              send({ type: 'screenSource', source: 'stf', reason: `受保护画面不可用：${(err as Error).message}`, code: 'player.secure_unavailable', params: { error: (err as Error).message } });
              return;
            }
            let buf: Buffer = Buffer.alloc(0);
            secureStream.on('data', (chunk: Buffer) => {
              buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
              while (buf.length >= 4) {
                const len = buf.readUInt32BE(0);
                if (len > 20 * 1024 * 1024) { secureStream?.destroy(); return; } // corrupt stream
                if (buf.length < 4 + len) break;
                const frame = buf.subarray(4, 4 + len);
                buf = buf.subarray(4 + len);
                if (source === 'secure' && client.readyState === WebSocket.OPEN && client.bufferedAmount < MAX_BUFFERED) client.send(frame, { binary: true });
              }
            });
            secureStream.on('close', () => { if (source === 'secure') { source = 'stf'; send({ type: 'screenSource', source: 'stf', reason: 'secure capture ended', code: 'player.secure_ended' }); } });
            secureStream.on('error', () => undefined);
            if (source === 'scrcpy') { leaveScrcpy(); stfScreen(true); }
            source = 'secure';
          } else {
            if (source === 'scrcpy') { leaveScrcpy(); stfScreen(true); }
            source = 'stf';
            stopSecure();
          }
          send({ type: 'screenSource', source });
        }
        else if (msg.type === 'typeSecure') {
          // Content is never logged or persisted; only forwarded to the device.
          for (const ch of msg.text) {
            if (source === 'scrcpy' && scrcpy) scrcpy.type(ch);
            else await stf.type(channel!, ch);
            await new Promise((r) => setTimeout(r, SECURE_CHAR_GAP_MS));
          }
          send({ type: 'typed', count: [...msg.text].length });
        }
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      }
    });

    client.on('close', () => {
      clearTimeout(authTimer);
      upstream?.close();
      secureStream?.destroy();
      leaveScrcpy();
    });
  });
};
