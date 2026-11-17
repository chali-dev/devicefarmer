import path from 'node:path';
import { config } from '../../config.js';
import {
  ACTION_DOWN, ACTION_MOVE, ACTION_UP, KEYCODES, ScrcpyServer, encodeGetClipboard, encodeKeycode, encodeResetVideo,
  encodeSetClipboard, encodeText, encodeTouch, h264CodecString, type VideoPacket,
} from '../../adapters/scrcpy.js';
import { adb } from '../../services.js';

/**
 * One scrcpy server per device, shared by every viewer (fan-out). Late joiners get the cached config
 * packet (SPS/PPS) and last key frame at once, then frames from the next key frame on, which is
 * requested with RESET_VIDEO. A viewer whose socket backs up drops frames until the next key frame.
 * The server stops STOP_DELAY_MS after the last viewer left.
 */

export interface ScrcpyViewer {
  /** Binary packet for the browser: [u8 flags: 1 = config, 2 = key frame][u64 pts BE][Annex B data]. */
  sendBinary(data: Buffer): void;
  sendJson(msg: object): void;
  buffered(): number;
  /** The shared server ended (device gone, server crashed). */
  onEnd(reason: string): void;
}

export interface ScrcpyHandle {
  touch(ev: { type: 'down' | 'move'; x: number; y: number; contact?: number; pressure?: number } | { type: 'up'; contact?: number }): void;
  /** false: no scrcpy keycode for that name (the caller uses STF instead). */
  key(action: 'down' | 'up' | 'press', name: string): boolean;
  paste(text: string): void;
  /** Key events for each character, never through the clipboard. At most 300 UTF-8 bytes per call. */
  type(text: string): void;
  /** Current device clipboard text ('' when empty: the server does not answer then). */
  getClipboard(): Promise<string>;
  /** A fresh key frame for everyone (rate-limited), e.g. after the browser dropped frames. */
  requestKeyFrame(): void;
  leave(): void;
}

const STOP_DELAY_MS = 5000;
const MAX_BUFFERED = 2 * 1024 * 1024;
const CLIPBOARD_POLL_MS = 1000;
const RESET_MIN_GAP_MS = 1000;
/** No answer to a clipboard read within this time = empty clipboard (the server sends nothing then). */
const CLIPBOARD_EMPTY_MS = 1500;

interface ViewerState { v: ScrcpyViewer; needKey: boolean }

class Share {
  readonly server: ScrcpyServer;
  readonly viewers = new Set<ViewerState>();
  readonly ready: Promise<void>;
  config: Buffer | null = null;
  codec: string | null = null;
  lastKey: Buffer | null = null;
  stopTimer: NodeJS.Timeout | null = null;
  pollTimer: NodeJS.Timeout | null = null;
  /** Last known device clipboard; undefined until the first read (baseline, not announced). */
  clipboard: string | undefined;
  clipWaiters: ((text: string) => void)[] = [];
  lastReset = 0;
  /** Last position per pointer, for 'up' events (the client sends no coordinates there). */
  pointers = new Map<number, { x: number; y: number }>();

  constructor(readonly adbPort: number, external: boolean) {
    // External phones stream through a narrow tunnel (BitBrowser: ~1-2 Mb/s): a bit rate above what it
    // carries queues up in the tunnel and the picture lags further and further behind.
    this.server = new ScrcpyServer(adb, adbPort, path.resolve(config.SCRCPY_SERVER_PATH), {
      maxSize: config.SCRCPY_MAX_SIZE, maxFps: config.SCRCPY_MAX_FPS,
      bitRate: external ? config.SCRCPY_BIT_RATE_EXTERNAL : config.SCRCPY_BIT_RATE,
      // A key frame (~40 KB) takes several round trips through the tunnel and stalls the picture each
      // time; viewers that need one (late join, dropped frames) request it with RESET_VIDEO anyway.
      ...(external ? { keyFrameIntervalS: config.SCRCPY_KEY_INTERVAL_EXTERNAL_S } : {}),
    });
    this.server.on('packet', (p: VideoPacket) => this.onPacket(p));
    this.server.on('clipboard', (text: string) => this.onClipboard(text));
    this.server.on('close', (reason: string) => {
      if (shares.get(adbPort) === this) shares.delete(adbPort);
      if (this.stopTimer) clearTimeout(this.stopTimer);
      if (this.pollTimer) clearInterval(this.pollTimer);
      for (const w of this.clipWaiters) w(this.clipboard ?? '');
      this.clipWaiters = [];
      const vs = [...this.viewers];
      this.viewers.clear();
      for (const s of vs) s.v.onEnd(reason);
    });
    this.ready = this.server.start().then(() => {
      this.pollTimer = setInterval(() => { if (this.viewers.size) this.server.send(encodeGetClipboard()); }, CLIPBOARD_POLL_MS);
      this.server.send(encodeGetClipboard());
      // The server answers nothing while the clipboard is empty: then the baseline is "".
      setTimeout(() => { if (this.clipboard === undefined) this.clipboard = ''; }, CLIPBOARD_EMPTY_MS);
    });
  }

  videoInfo() {
    return { type: 'video', codec: this.codec, width: this.server.width, height: this.server.height };
  }

  requestKeyFrame() {
    const now = Date.now();
    if (now - this.lastReset < RESET_MIN_GAP_MS) return;
    this.lastReset = now;
    this.server.send(encodeResetVideo());
  }

  private onPacket(p: VideoPacket) {
    if (p.config) {
      this.config = p.data;
      this.codec = h264CodecString(p.data) ?? this.codec;
      this.lastKey = null;
      const info = this.videoInfo();
      for (const s of this.viewers) { s.v.sendJson(info); s.v.sendBinary(frame(p)); s.needKey = true; }
      return;
    }
    const f = frame(p);
    if (p.key) this.lastKey = f;
    let starved = false;
    for (const s of this.viewers) {
      if (s.needKey && !p.key) continue;
      if (s.v.buffered() > MAX_BUFFERED) { s.needKey = true; starved = true; continue; }
      s.needKey = false;
      s.v.sendBinary(f);
    }
    if (starved) this.requestKeyFrame();
  }

  private onClipboard(text: string) {
    const known = this.clipboard;
    this.clipboard = text;
    for (const w of this.clipWaiters) w(text);
    this.clipWaiters = [];
    if (known !== undefined && known !== text) for (const s of this.viewers) s.v.sendJson({ type: 'clipboard', text });
  }

  add(v: ScrcpyViewer): ViewerState {
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    const s: ViewerState = { v, needKey: true };
    this.viewers.add(s);
    if (this.config) {
      v.sendJson(this.videoInfo());
      v.sendBinary(frame({ config: true, key: false, pts: 0n, data: this.config }));
      if (this.lastKey) v.sendBinary(this.lastKey);
      // The cached key frame is stale relative to the frames now flowing: wait for a fresh one.
      this.requestKeyFrame();
    }
    return s;
  }

  remove(s: ViewerState) {
    if (!this.viewers.delete(s) || this.viewers.size || this.server.closed) return;
    this.stopTimer = setTimeout(() => this.server.close('idle'), STOP_DELAY_MS);
  }
}

const shares = new Map<number, Share>();

function frame(p: VideoPacket): Buffer {
  const b = Buffer.alloc(9 + p.data.length);
  b.writeUInt8((p.config ? 1 : 0) | (p.key ? 2 : 0), 0);
  b.writeBigUInt64BE(p.pts, 1);
  p.data.copy(b, 9);
  return b;
}

/** Whether a scrcpy server is currently streaming this device (its link is busy with video). */
export function scrcpyActive(adbPort: number): boolean {
  return shares.has(adbPort);
}

/** Joins (starting if needed) the device's scrcpy session. Rejects if the server can't be started. */
export async function joinScrcpy(adbPort: number, viewer: ScrcpyViewer, external = false): Promise<ScrcpyHandle> {
  let share = shares.get(adbPort);
  if (!share || share.server.closed) {
    share = new Share(adbPort, external);
    shares.set(adbPort, share);
    share.ready.catch(() => { if (shares.get(adbPort) === share) shares.delete(adbPort); });
  }
  const sh = share;
  const state = sh.add(viewer);
  try {
    await sh.ready;
  } catch (err) {
    sh.viewers.delete(state);
    throw err;
  }
  const srv = sh.server;
  const toPx = (x: number, y: number) => ({
    x: Math.min(srv.width - 1, Math.round(x * srv.width)),
    y: Math.min(srv.height - 1, Math.round(y * srv.height)),
  });
  let left = false;
  return {
    touch(ev) {
      if (!srv.width) return;
      const id = ev.contact ?? 0;
      if (ev.type === 'up') {
        const p = sh.pointers.get(id);
        if (!p) return;
        sh.pointers.delete(id);
        srv.send(encodeTouch(ACTION_UP, BigInt(id), p.x, p.y, srv.width, srv.height, 0));
        return;
      }
      const p = toPx(ev.x, ev.y);
      sh.pointers.set(id, p);
      srv.send(encodeTouch(ev.type === 'down' ? ACTION_DOWN : ACTION_MOVE, BigInt(id), p.x, p.y, srv.width, srv.height, ev.pressure ?? 1));
    },
    key(action, name) {
      const code = KEYCODES[name];
      if (code === undefined) return false;
      if (action !== 'up') srv.send(encodeKeycode(0, code));
      if (action !== 'down') srv.send(encodeKeycode(1, code));
      return true;
    },
    paste(text) {
      sh.clipboard = text; // our own change: not announced back as a device clipboard change
      srv.send(encodeSetClipboard(0n, text, true));
    },
    type(text) {
      srv.send(encodeText(text));
    },
    getClipboard() {
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => { sh.clipWaiters = sh.clipWaiters.filter((w) => w !== done); resolve(''); }, CLIPBOARD_EMPTY_MS);
        const done = (t: string) => { clearTimeout(timer); resolve(t); };
        sh.clipWaiters.push(done);
        srv.send(encodeGetClipboard());
      });
    },
    requestKeyFrame() {
      sh.requestKeyFrame();
    },
    leave() {
      if (left) return;
      left = true;
      sh.remove(state);
    },
  };
}

