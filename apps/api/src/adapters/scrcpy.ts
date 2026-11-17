/**
 * Client for the official scrcpy-server (Genymobile/scrcpy v5.0.1, Apache-2.0; see
 * infra/device-tools/scrcpy/README.md). The wire format below follows that version's server sources
 * (DesktopConnection, Streamer, ControlMessageReader, DeviceMessageWriter); the browser-side approach
 * (H.264 relayed over WebSocket, decoded in the browser) follows ws-scrcpy (NetrisTV, MIT).
 *
 * One ScrcpyServer = one server process on one device:
 *  - started via `app_process` in the foreground of an adb shell stream held here (processes started
 *    over adbkit's `shell:` die when that connection closes, so this stream is the server's lifetime);
 *  - `tunnel_forward=true`: the server listens on localabstract:scrcpy_<scid as %08x>; we connect the
 *    video socket first (it carries the single dummy byte 0x00), then the control socket;
 *  - video socket: [dummy byte][u32 codec id] then 12-byte headers, each either a session packet
 *    (bit 63 set: u32 flags, u32 width, u32 height; sent on every encoder (re)start) or a frame header
 *    (u64 pts with bit 62 = config, bit 61 = key frame; u32 size) followed by the Annex B payload;
 *  - control socket: our control messages up, device messages (clipboard, clipboard ack) down.
 */
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type { AdbAdapter } from './adb.js';

export const SCRCPY_VERSION = '5.0.1';
const REMOTE_JAR = `/data/local/tmp/scrcpy-server-v${SCRCPY_VERSION}.jar`;
const CODEC_H264 = 0x68_32_36_34; // "h264"
const PACKET_FLAG_SESSION = 1n << 63n;
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = PACKET_FLAG_KEY_FRAME - 1n;
const MAX_PACKET = 16 * 1024 * 1024;
const INJECT_TEXT_MAX_BYTES = 300;

export interface ScrcpyOptions {
  maxSize: number; maxFps: number; bitRate: number
  /** Seconds between periodic key frames (scrcpy's default is 10); RESET_VIDEO still forces one at once. */
  keyFrameIntervalS?: number
}
export interface VideoPacket { config: boolean; key: boolean; pts: bigint; data: Buffer }

/** Android MotionEvent actions used by inject-touch. */
export const ACTION_DOWN = 0;
export const ACTION_UP = 1;
export const ACTION_MOVE = 2;

/**
 * STF-style key names (adb keycode names without KEYCODE_, as the web client sends them) → Android keycodes.
 * Names missing here are sent through STF instead.
 */
export const KEYCODES: Record<string, number> = {
  home: 3, back: 4, call: 5, endcall: 6, dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22, dpad_center: 23,
  volume_up: 24, volume_down: 25, power: 26, camera: 27, tab: 61, space: 62, enter: 66, del: 67, menu: 82,
  search: 84, page_up: 92, page_down: 93, escape: 111, forward_del: 112, move_home: 122, move_end: 123,
  volume_mute: 164, app_switch: 187, sleep: 223, wakeup: 224, cut: 277, copy: 278, paste: 279,
};

// ---- control message encoders (ControlMessageReader of the pinned version; all big-endian) ----

export function encodeKeycode(action: 0 | 1, keycode: number, repeat = 0, metaState = 0): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt8(0, 0); // TYPE_INJECT_KEYCODE
  b.writeUInt8(action, 1);
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(repeat, 6);
  b.writeInt32BE(metaState, 10);
  return b;
}

/** Text as key events (chars the device's KeyCharacterMap can produce). At most 300 UTF-8 bytes. */
export function encodeText(text: string): Buffer {
  const t = Buffer.from(text, 'utf8');
  if (t.length > INJECT_TEXT_MAX_BYTES) throw new Error('inject text too long');
  const b = Buffer.alloc(5 + t.length);
  b.writeUInt8(1, 0); // TYPE_INJECT_TEXT
  b.writeUInt32BE(t.length, 1);
  t.copy(b, 5);
  return b;
}

/** Position is in video pixels together with the video size it refers to; events for a stale size are ignored by the server. */
export function encodeTouch(action: number, pointerId: bigint, x: number, y: number, width: number, height: number, pressure: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt8(2, 0); // TYPE_INJECT_TOUCH_EVENT
  b.writeUInt8(action, 1);
  b.writeBigUInt64BE(BigInt.asUintN(64, pointerId), 2);
  b.writeInt32BE(x, 10);
  b.writeInt32BE(y, 14);
  b.writeUInt16BE(width, 18);
  b.writeUInt16BE(height, 20);
  // u16 fixed point, 1.0 → 0xffff
  b.writeUInt16BE(pressure >= 1 ? 0xffff : Math.max(0, Math.round(pressure * 0x10000)), 22);
  b.writeInt32BE(0, 24); // action button
  b.writeInt32BE(0, 28); // buttons (must be 0 for touch)
  return b;
}

/** copyKey 0 = none: just read; the server answers with a clipboard device message (clipboard_autosync=false). */
export function encodeGetClipboard(copyKey: 0 | 1 | 2 = 0): Buffer {
  return Buffer.from([8, copyKey]);
}

/** Sets the device clipboard; paste=true also presses KEYCODE_PASTE. sequence 0 = no ack requested. */
export function encodeSetClipboard(sequence: bigint, text: string, paste: boolean): Buffer {
  const t = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(14 + t.length);
  b.writeUInt8(9, 0); // TYPE_SET_CLIPBOARD
  b.writeBigUInt64BE(sequence, 1);
  b.writeUInt8(paste ? 1 : 0, 9);
  b.writeUInt32BE(t.length, 10);
  t.copy(b, 14);
  return b;
}

/** Restarts the encoder: a new session packet, config packet and key frame follow. */
export function encodeResetVideo(): Buffer {
  return Buffer.from([17]); // TYPE_RESET_VIDEO
}

/** WebCodecs codec string ("avc1.PPCCLL") from the SPS in an Annex B config packet. */
export function h264CodecString(config: Buffer): string | null {
  for (let i = 0; i + 4 < config.length; i++) {
    if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3]! & 0x1f) === 7 && i + 6 < config.length) {
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(config[i + 4]!)}${hex(config[i + 5]!)}${hex(config[i + 6]!)}`;
    }
  }
  return null;
}

/**
 * Events: 'session' (width, height) on every encoder (re)start, 'packet' (VideoPacket),
 * 'clipboard' (text), 'close' (reason). After 'close' the instance is dead.
 */
export class ScrcpyServer extends EventEmitter {
  readonly scid = randomInt(1, 0x7fff_ffff).toString(16).padStart(8, '0');
  width = 0;
  height = 0;
  closed = false;
  private shellStream: Duplex | null = null;
  private video: Duplex | null = null;
  private control: Duplex | null = null;
  private readonly logTail: string[] = [];

  constructor(private readonly adb: AdbAdapter, readonly adbPort: number, private readonly jarPath: string, private readonly opts: ScrcpyOptions) {
    super();
  }

  /** Last lines the server printed (its own error messages). */
  get log(): string { return this.logTail.join('\n'); }

  /** Pushes the jar if needed, starts the server and connects both sockets. Resolves when the H.264 stream header arrived. */
  async start(timeoutMs = 15_000): Promise<void> {
    await this.adb.pushIfMissing(this.adbPort, this.jarPath, REMOTE_JAR);
    const args = [
      SCRCPY_VERSION, `scid=${this.scid}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'control=true',
      'video_codec=h264', `max_size=${this.opts.maxSize}`, `max_fps=${this.opts.maxFps}`, `video_bit_rate=${this.opts.bitRate}`,
      // read the clipboard on request (polled by the hub) instead of autosync, so a viewer can also ask for it
      'clipboard_autosync=false',
      // MediaFormat KEY_I_FRAME_INTERVAL (scrcpy applies codec options after its own default)
      ...(this.opts.keyFrameIntervalS ? [`video_codec_options=i-frame-interval:int=${this.opts.keyFrameIntervalS}`] : []),
      // keep the versioned jar (cleanup=true deletes it at start), never wake/turn off the screen, no device name packet
      'cleanup=false', 'power_on=false', 'send_device_meta=false',
    ];
    const device = this.adb.device(this.adbPort);
    const sh = await device.shell(`CLASSPATH=${REMOTE_JAR} exec app_process / com.genymobile.scrcpy.Server ${args.join(' ')}`);
    this.shellStream = sh;
    let partial = '';
    sh.on('data', (c: Buffer) => {
      const lines = (partial + c.toString('utf8')).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) { this.logTail.push(l.trim()); if (this.logTail.length > 20) this.logTail.shift(); }
    });
    sh.on('close', () => this.close('server exited'));
    sh.on('error', () => undefined);

    const deadline = Date.now() + timeoutMs;
    const fail = (msg: string) => new Error(`${msg}${this.log ? `: ${this.log.split('\n').slice(-3).join(' | ')}` : ''}`);
    // The socket only exists once the server is listening: retry like scrcpy's client (100 ms apart).
    let video: Duplex | null = null;
    let first: Buffer | null = null;
    while (!first) {
      if (this.closed) throw fail('scrcpy server exited');
      if (Date.now() > deadline) { this.close('start timeout'); throw fail('scrcpy server did not start'); }
      try {
        video = await device.openLocal(`localabstract:scrcpy_${this.scid}`);
        first = await firstChunk(video, 2000);
      } catch {
        video?.destroy();
        video = null;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (first[0] !== 0) { video!.destroy(); this.close('bad dummy byte'); throw fail('unexpected scrcpy handshake'); }
    this.video = video;
    this.control = await device.openLocal(`localabstract:scrcpy_${this.scid}`);
    this.control.on('error', () => undefined);
    this.control.on('close', () => this.close('control socket closed'));
    this.readDeviceMessages(this.control);

    const header = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('no video stream header')), Math.max(1000, deadline - Date.now()));
      this.once('codec', (id: number) => {
        clearTimeout(timer);
        if (id === CODEC_H264) resolve();
        else reject(fail(id === 0 ? 'video disabled by the device' : id === 1 ? 'video configuration error on the device' : `unexpected codec 0x${id.toString(16)}`));
      });
      this.once('close', (reason: string) => { clearTimeout(timer); reject(fail(reason)); });
    });
    this.readVideo(video!, first.subarray(1));
    try { await header; } catch (err) { this.close('start failed'); throw err; }
  }

  send(msg: Buffer): void {
    if (!this.closed && this.control) this.control.write(msg);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.shellStream?.destroy();
    // Closing the sockets/shell ends the server; make sure in case the shell stream lingers.
    void this.adb.shell(this.adbPort, `pkill -f 'scid=${this.scid}' || true`, 5000).catch(() => undefined);
    this.emit('close', reason);
  }

  private readVideo(sock: Duplex, initial: Buffer): void {
    let buf: Buffer = Buffer.alloc(0);
    let codecRead = false;
    let pending: { flags: bigint; size: number } | null = null;
    const onData = (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (!codecRead) {
          if (buf.length < 4) return;
          codecRead = true;
          this.emit('codec', buf.readUInt32BE(0));
          buf = buf.subarray(4);
          continue;
        }
        if (!pending) {
          if (buf.length < 12) return;
          const head = buf.readBigUInt64BE(0);
          if (head & PACKET_FLAG_SESSION) {
            this.width = buf.readUInt32BE(4);
            this.height = buf.readUInt32BE(8);
            buf = buf.subarray(12);
            this.emit('session', this.width, this.height);
            continue;
          }
          const size = buf.readUInt32BE(8);
          if (size > MAX_PACKET) { this.close('corrupt video stream'); return; }
          pending = { flags: head, size };
          buf = buf.subarray(12);
        }
        if (buf.length < pending.size) return;
        const data = Buffer.from(buf.subarray(0, pending.size)); // copy: detach from the receive buffer
        buf = buf.subarray(pending.size);
        const config = (pending.flags & PACKET_FLAG_CONFIG) !== 0n;
        this.emit('packet', { config, key: !config && (pending.flags & PACKET_FLAG_KEY_FRAME) !== 0n, pts: config ? 0n : pending.flags & PTS_MASK, data } satisfies VideoPacket);
        pending = null;
      }
    };
    sock.on('data', onData);
    sock.on('error', () => undefined);
    sock.on('close', () => this.close('video socket closed'));
    if (initial.length) onData(initial);
    sock.resume(); // paused by firstChunk()
  }

  private readDeviceMessages(sock: Duplex): void {
    let buf: Buffer = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 1) return;
        const type = buf[0];
        if (type === 0) { // TYPE_CLIPBOARD: u32 len + UTF-8
          if (buf.length < 5) return;
          const len = buf.readUInt32BE(1);
          if (buf.length < 5 + len) return;
          this.emit('clipboard', buf.subarray(5, 5 + len).toString('utf8'));
          buf = buf.subarray(5 + len);
        } else if (type === 1) { // TYPE_ACK_CLIPBOARD: u64 sequence
          if (buf.length < 9) return;
          buf = buf.subarray(9);
        } else if (type === 2) { // TYPE_UHID_OUTPUT: u16 id, u16 len, data (unused)
          if (buf.length < 5) return;
          const len = buf.readUInt16BE(3);
          if (buf.length < 5 + len) return;
          buf = buf.subarray(5 + len);
        } else {
          this.close(`unknown device message ${type}`);
          return;
        }
      }
    });
  }
}

/** First chunk of a freshly opened stream; rejects if it ends first (nothing listening yet). */
function firstChunk(s: Duplex, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, c?: Buffer) => {
      clearTimeout(timer);
      s.off('data', onData); s.off('end', onEnd); s.off('close', onEnd); s.off('error', onErr);
      if (err) reject(err); else { s.pause(); resolve(c!); }
    };
    const onData = (c: Buffer) => done(null, c);
    const onEnd = () => done(new Error('closed'));
    const onErr = (e: Error) => done(e);
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);
    s.on('data', onData); s.once('end', onEnd); s.once('close', onEnd); s.once('error', onErr);
  });
}
