import type { FastifyPluginAsync } from 'fastify';
import WebSocket from 'ws';
import { z } from 'zod';
import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';
import { adb, stf } from '../../services.js';
import { assertInstanceAccess } from '../auth/rbac.js';
import { getInstance } from '../instances/repo.js';

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
 * Down: JPEG frames relayed from STF's screen stream. Up: JSON input events.
 * RBAC is enforced here; STF itself is never exposed to end users.
 */
export const controlRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/api/instances/:id/session', { websocket: true }, (client, req) => {
    const instanceId = req.params.id;
    let upstream: WebSocket | null = null;
    let channel: string | null = null;
    let authed = false;
    const send = (msg: object) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); };
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
          authed = true;
          clearTimeout(authTimer);
          req.log.info({ instanceId, user: user.username }, 'control session opened');

          // The screen port changes whenever STF re-creates the device worker: always resolve it fresh.
          upstream = new WebSocket(screenUrl(dev.display.url));
          upstream.binaryType = 'nodebuffer';
          upstream.on('open', () => {
            upstream!.send(`size ${inst.spec.width}x${inst.spec.height}`);
            upstream!.send('on');
          });
          upstream.on('message', (data, bin) => {
            if (client.readyState !== WebSocket.OPEN) return;
            if (bin) {
              if (client.bufferedAmount < MAX_BUFFERED) client.send(data, { binary: true });
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
          return fail(err instanceof HttpError ? err.message : 'session setup failed', err instanceof HttpError && err.statusCode === 403 ? 4003 : 4000);
        }
        return;
      }

      try {
        if (msg.type === 'touch') await stf.touch(channel!, msg.ev);
        else if (msg.type === 'key') await stf.key(channel!, msg.action, msg.key);
        else if (msg.type === 'paste') { await stf.paste(channel!, msg.text); send({ type: 'pasted' }); }
        else if (msg.type === 'typeSecure') {
          // Content is never logged or persisted; only forwarded to the device.
          for (const ch of msg.text) {
            await stf.type(channel!, ch);
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
    });
  });
};
