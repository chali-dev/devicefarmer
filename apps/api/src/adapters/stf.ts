import { io, type Socket } from 'socket.io-client';
import { config } from '../config.js';

export interface StfDevice {
  serial: string;
  present: boolean;
  ready: boolean;
  using: boolean;
  channel?: string;
  owner?: { email: string } | null;
  display?: { width: number; height: number; url?: string };
}

const DEVICE_FIELDS = 'serial,present,ready,using,owner,channel,display';

export class StfError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/**
 * STF integration through its public surfaces only (REST API + websocket unit),
 * acting as a single service account. End users never talk to STF directly:
 * the platform enforces RBAC and relays screen/input.
 */
export class StfAdapter {
  private cookies = new Map<string, string>();
  private loginPromise: Promise<void> | null = null;
  private socket: Socket | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly wsUrl: string,
    private readonly email: string,
    private readonly name: string,
  ) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair?.indexOf('=') ?? -1;
      if (pair && idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  /** Dev auth: STF mock auth (CSRF-protected). Replace with OAuth/LDAP unit in production. */
  private async login(): Promise<void> {
    this.cookies.clear();
    const page = await fetch(`${this.baseUrl}/auth/mock/`, { redirect: 'manual' });
    this.storeCookies(page);
    const xsrf = this.cookies.get('XSRF-TOKEN');
    if (!xsrf) throw new StfError('STF did not issue an XSRF token');
    const res = await fetch(`${this.baseUrl}/auth/api/v1/mock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xsrf-token': decodeURIComponent(xsrf), cookie: this.cookieHeader() },
      body: JSON.stringify({ name: this.name, email: this.email }),
    });
    this.storeCookies(res);
    const body = (await res.json().catch(() => null)) as { success?: boolean; redirect?: string } | null;
    if (!body?.success || !body.redirect) throw new StfError(`STF login failed (${res.status})`, res.status);
    const session = await fetch(body.redirect, { redirect: 'manual', headers: { cookie: this.cookieHeader() } });
    this.storeCookies(session);
    if (!this.cookies.has('ssid')) throw new StfError('STF did not issue a session cookie');
  }

  private async ensureLogin(force = false): Promise<void> {
    if (!force && this.cookies.has('ssid')) return;
    this.loginPromise ??= this.login().finally(() => { this.loginPromise = null; });
    await this.loginPromise;
  }

  private async api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    await this.ensureLogin();
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers, cookie: this.cookieHeader() },
    });
    if (res.status === 401 && retry) {
      await this.ensureLogin(true);
      this.resetSocket();
      return this.api<T>(path, init, false);
    }
    const body = (await res.json().catch(() => ({}))) as T & { success?: boolean; description?: string };
    if (!res.ok || body.success === false) throw new StfError(body.description ?? `STF ${path} -> ${res.status}`, res.status);
    return body;
  }

  async listDevices(): Promise<StfDevice[]> {
    const r = await this.api<{ devices: StfDevice[] }>(`/devices?fields=${DEVICE_FIELDS}`);
    return r.devices;
  }

  async getDevice(serial: string): Promise<StfDevice | null> {
    try {
      const r = await this.api<{ device: StfDevice }>(`/devices/${encodeURIComponent(serial)}?fields=${DEVICE_FIELDS}`);
      return r.device;
    } catch (err) {
      if (err instanceof StfError && err.status === 404) return null;
      throw err;
    }
  }

  /** Claims the device for the service account so nobody else can grab it in STF. */
  async claim(serial: string): Promise<void> {
    const dev = await this.getDevice(serial);
    if (!dev) throw new StfError(`device ${serial} not known to STF`, 404);
    if (dev.owner?.email === this.email) return;
    await this.api('/user/devices', { method: 'POST', body: JSON.stringify({ serial }) });
  }

  async release(serial: string): Promise<void> {
    try {
      await this.api(`/user/devices/${encodeURIComponent(serial)}`, { method: 'DELETE' });
    } catch {
      // not owned / already gone
    }
  }

  private resetSocket(): void {
    this.socket?.close();
    this.socket = null;
  }

  private connecting: Promise<Socket> | null = null;

  /**
   * Single shared socket. Concurrent callers share one in-flight connection:
   * creating a socket per caller would close the previous ones and silently
   * drop the events emitted on them.
   */
  private ws(): Promise<Socket> {
    if (this.socket?.connected) return Promise.resolve(this.socket);
    this.connecting ??= (async () => {
      await this.ensureLogin();
      this.resetSocket();
      const socket = io(this.wsUrl, {
        transports: ['websocket'],
        extraHeaders: { cookie: this.cookieHeader() },
        reconnection: true,
      });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { socket.close(); reject(new StfError('STF websocket connect timeout')); }, 8000);
        socket.once('connect', () => { clearTimeout(t); resolve(); });
        socket.once('connect_error', (e) => { clearTimeout(t); socket.close(); reject(new StfError(`STF websocket: ${e.message}`)); });
      });
      this.socket = socket;
      return socket;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /**
   * STF's device touch plugin consumes events through a SeqQueue (size 100):
   * `gestureStart(s)` unlocks it, following events must carry s+1, s+2, ... (mod 100),
   * `gestureStop` locks it again. Events outside a gesture are silently dropped,
   * so sequence numbers are owned here, per device channel, not by clients.
   */
  private seqs = new Map<string, number>();
  private nextSeq(channel: string): number {
    const n = ((this.seqs.get(channel) ?? -1) + 1) % 100;
    this.seqs.set(channel, n);
    return n;
  }

  /** Forwards one touch event (already RBAC-checked). x/y are normalised 0..1. */
  async touch(channel: string, ev: TouchEvent): Promise<void> {
    // Assign the sequence number synchronously (arrival order), before any await.
    const seq = this.nextSeq(channel);
    const s = await this.ws();
    switch (ev.type) {
      case 'gestureStart': s.emit('input.gestureStart', channel, { seq }); break;
      case 'gestureStop': s.emit('input.gestureStop', channel, { seq }); break;
      case 'down':
      case 'move':
        s.emit(ev.type === 'down' ? 'input.touchDown' : 'input.touchMove', channel,
          { seq, contact: ev.contact ?? 0, x: ev.x, y: ev.y, pressure: ev.pressure ?? 0.5 });
        break;
      case 'up': s.emit('input.touchUp', channel, { seq, contact: ev.contact ?? 0 }); break;
      case 'commit': s.emit('input.touchCommit', channel, { seq }); break;
    }
  }

  /** Convenience: a complete single tap as one gesture. */
  async tap(channel: string, x: number, y: number): Promise<void> {
    await this.touch(channel, { type: 'gestureStart' });
    await this.touch(channel, { type: 'down', x, y });
    await this.touch(channel, { type: 'commit' });
    await this.touch(channel, { type: 'up' });
    await this.touch(channel, { type: 'commit' });
    await this.touch(channel, { type: 'gestureStop' });
  }

  /** Key names are adb keycode names without KEYCODE_ (e.g. "home", "back", "app_switch"). */
  async key(channel: string, action: 'down' | 'up' | 'press', key: string): Promise<void> {
    const s = await this.ws();
    const ev = action === 'down' ? 'input.keyDown' : action === 'up' ? 'input.keyUp' : 'input.keyPress';
    s.emit(ev, channel, { key });
  }

  /**
   * Types characters as key events. Only suitable for short/slow input: on some phones,
   * fast per-key injection races and characters get lost or reordered. Use paste() for text.
   */
  async type(channel: string, text: string): Promise<void> {
    const s = await this.ws();
    s.emit('input.type', channel, { text });
  }

  /** Puts text on the device clipboard and pastes it into the focused field (reliable for text). */
  async paste(channel: string, text: string): Promise<void> {
    await this.transaction('clipboard.paste', channel, { text });
  }

  // Note: reading the device clipboard via STF ('clipboard.copy') does not work on Android 10+:
  // ClipboardService denies background apps (STFService). The scrcpy screen source reads it (modules/control/scrcpy-hub.ts).

  /** STF transaction: emit with a response channel, resolve on tx.done, reject on failure/timeout. */
  private async transaction(event: string, channel: string, data: unknown, timeoutMs = 10_000): Promise<unknown> {
    const s = await this.ws();
    const tx = `tx.${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); s.off('tx.done', onDone); s.off('tx.cancel', onCancel); };
      const onDone = (ch: string, res: { success: boolean; data?: unknown; body?: unknown }) => {
        if (ch !== tx) return;
        cleanup();
        if (res.success) resolve(res.body ?? res.data);
        else reject(new StfError(`STF ${event} failed: ${String(res.data)}`));
      };
      const onCancel = (ch: string, res: { data?: unknown }) => {
        if (ch !== tx) return;
        cleanup();
        reject(new StfError(`STF ${event} cancelled: ${String(res?.data)}`));
      };
      const timer = setTimeout(() => { cleanup(); reject(new StfError(`STF ${event} timed out`)); }, timeoutMs);
      s.on('tx.done', onDone);
      s.on('tx.cancel', onCancel);
      s.emit(event, channel, tx, data);
    });
  }

  close(): void {
    this.resetSocket();
  }
}

export type TouchEvent =
  | { type: 'gestureStart' | 'gestureStop' | 'commit' }
  | { type: 'down' | 'move'; x: number; y: number; contact?: number; pressure?: number }
  | { type: 'up'; contact?: number };

export function createStf(): StfAdapter {
  return new StfAdapter(config.STF_URL, config.STF_WS_URL, config.STF_SERVICE_EMAIL, config.STF_SERVICE_NAME);
}
