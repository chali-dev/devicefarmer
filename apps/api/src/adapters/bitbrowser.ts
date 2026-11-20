import { HttpError } from '../lib/errors.js';

/**
 * BitBrowser (比特) cloud phones through the BitBrowser client's local API (POST + JSON, at most 1
 * request per second: calls are serialised here). The client binds 0.0.0.0 without auth unless its
 * optional "Local API Token" is on; then every request needs `x-api-key` (source config `apiKey`). Only the endpoints below are exposed;
 * "一键新机" (profile/recover) and fingerprint/profile editing are deliberately not wrapped (owner's
 * rule: no device-identity changes from this platform).
 */
export interface BitPhone {
  id: string;
  name: string;
  groupName: string | null;
  remark: string | null;
  brand: string | null;
  model: string | null;
  country: string | null;
  city: string | null;
  /** BitBrowser's own state code (1 = on, 4 = off observed); `running()` is authoritative. */
  phoneStatus: number | null;
  /** Rental expiry of the phone, as reported (local time string). */
  expireTime: string | null;
}

export interface BitAdbInfo {
  /** SSH gateway that forwards to the phone's adbd (`ssh s@<host> -p <port> -L <local>:<target>`). */
  sshUser: string;
  sshHost: string;
  sshPort: number;
  targetHost: string;
  targetPort: number;
  /** SSH password; keep in memory only. */
  password: string;
  expiresAt: Date | null;
}

const MIN_GAP_MS = 1100;
/**
 * Reads (list, power state, adb info) fail fast so a dead client can't stall the monitor and the
 * user's power requests queued behind it; power on/off really take long on BitBrowser's side.
 */
const READ_TIMEOUT_MS = 8000;
const POWER_ON_TIMEOUT_MS = 120_000;
const POWER_TIMEOUT_MS = 60_000;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

export const bitbrowserError = (msg: string, code = 'api_error', params: Record<string, string | number> = {}) =>
  new HttpError(502, `比特云接口：${msg}`, `bitbrowser.${code}`, { msg, ...params });

/** Offset of an IANA zone from UTC at instant `t`, ms (east positive). */
function zoneOffsetMs(timeZone: string, t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(t).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(t / 1000) * 1000;
}

/**
 * "2026-11-17 17:49:47" (wall clock of the BitBrowser client) → Date. `timeZone` = the client's zone
 * (source config); without it the API host's zone is assumed. Unknown formats → null.
 */
export function parseLocalTime(s: unknown, timeZone?: string): Date | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s) : null;
  if (!m) return null;
  if (!timeZone) { const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`); return Number.isNaN(d.getTime()) ? null : d; }
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  // Two passes settle DST edges: the offset is the zone's offset at the resulting instant.
  let t = wall - zoneOffsetMs(timeZone, wall);
  t = wall - zoneOffsetMs(timeZone, t);
  return new Date(t);
}

/** Valid IANA time zone name (as Intl understands it). */
export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** What the platform knows about one BitBrowser client (shown with the source). */
export interface BitHealth {
  /** null = no call yet since the API started. */
  ok: boolean | null;
  lastOkAt: string | null;
  failingSince: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
}
export interface BitClientOptions { apiKey?: string | null; timeZone?: string | null }

/** Parses `/phone/adb/get`'s `command` (an ssh -L line). Only plain host/port tokens are accepted. */
export function parseAdbCommand(command: string): Omit<BitAdbInfo, 'password' | 'expiresAt'> {
  const m = /\bssh\b.*?\s([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)\s+-p\s+(\d+)\s+-L\s+(?:[\w.]+:)?\d+:([A-Za-z0-9.-]+):(\d+)/.exec(command);
  if (!m || !HOST_RE.test(m[2]!) || !HOST_RE.test(m[4]!)) throw bitbrowserError('unexpected adb command format', 'adb_format');
  return { sshUser: m[1]!, sshHost: m[2]!, sshPort: Number(m[3]), targetHost: m[4]!, targetPort: Number(m[5]) };
}

export class BitBrowserClient {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  readonly health: BitHealth = { ok: null, lastOkAt: null, failingSince: null, lastError: null, lastErrorCode: null };

  constructor(private readonly baseUrl: string, public options: BitClientOptions = {}) {}

  /** One request at a time, ≥ MIN_GAP_MS apart. */
  private call<T = unknown>(path: string, body: Record<string, unknown>, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.last + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      try {
        const data = await this.request<T>(path, body, timeoutMs);
        Object.assign(this.health, { ok: true, lastOkAt: new Date().toISOString(), failingSince: null });
        return data;
      } catch (err) {
        const e = err as HttpError;
        // Only "the client itself is not usable" counts as unhealthy; a refused call (success:false) doesn't.
        if (e.code === 'bitbrowser.unreachable' || e.code === 'bitbrowser.unauthorized') {
          Object.assign(this.health, { ok: false, failingSince: this.health.failingSince ?? new Date().toISOString() });
        }
        Object.assign(this.health, { lastError: e.message.slice(0, 200), lastErrorCode: e.code ?? null });
        throw err;
      } finally {
        this.last = Date.now();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async request<T>(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw bitbrowserError(`client unreachable (${(err as Error).message})`, 'unreachable');
    }
    if (res.status === 401 || res.status === 403) {
      throw bitbrowserError(`HTTP ${res.status}: the client's Local API Token is on and the source's API key is missing or wrong`, 'unauthorized', { status: res.status });
    }
    const json = await res.json().catch(() => null) as { success?: boolean; msg?: string; data?: T } | null;
    if (!res.ok || !json) throw bitbrowserError(`HTTP ${res.status}`);
    if (json.success !== true) throw bitbrowserError(String(json.msg ?? 'request failed').slice(0, 200));
    return json.data as T;
  }

  async list(): Promise<BitPhone[]> {
    const out: BitPhone[] = [];
    for (let page = 0; page < 50; page++) {
      const d = await this.call<{ list?: Record<string, unknown>[]; totalNum?: number }>('/phone/list', { page, pageSize: 100 });
      for (const p of d.list ?? []) {
        const s = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? p[k] as string : null);
        out.push({
          id: String(p.id), name: s('name') ?? String(p.id), groupName: s('groupName'), remark: s('remark'),
          brand: s('deviceBrand'), model: s('modelName'), country: s('country'), city: s('city'),
          phoneStatus: typeof p.phoneStatus === 'number' ? p.phoneStatus : null, expireTime: s('expireTime'),
        });
      }
      if (!d.list?.length || out.length >= (d.totalNum ?? 0)) break;
    }
    return out;
  }

  async running(id: string): Promise<boolean> {
    return (await this.call<boolean>('/phone/running', { id })) === true;
  }

  /** Power on. Billed from now until shutdown. */
  async open(id: string): Promise<void> {
    await this.call('/phone/openphone', { id }, POWER_ON_TIMEOUT_MS);
  }

  async shutdown(id: string): Promise<void> {
    await this.call('/phone/shutdown', { id }, POWER_TIMEOUT_MS);
  }

  /**
   * Installs an app from BitBrowser's app store (`appId` = the store's id of that app version). Asynchronous on
   * BitBrowser's side: the call returns before the app is on the phone (check with adb `pm path`).
   */
  async installApp(id: string, appId: string): Promise<void> {
    await this.call('/phone/installApp', { id, appId }, POWER_TIMEOUT_MS);
  }

  async adbEnable(id: string): Promise<void> {
    await this.call('/phone/adb/enable', { ids: [id] }, POWER_TIMEOUT_MS);
  }

  /** ADB tunnel parameters; enables adb first when the client reports it off. */
  async adbInfo(id: string): Promise<BitAdbInfo> {
    let d: Record<string, unknown> | null = null;
    try {
      d = await this.call<Record<string, unknown>>('/phone/adb/get', { id });
    } catch { /* adb off: enable below */ }
    if (!d?.command || !d.key) {
      await this.adbEnable(id);
      await new Promise((r) => setTimeout(r, 3000));
      d = await this.call<Record<string, unknown>>('/phone/adb/get', { id });
    }
    if (typeof d?.command !== 'string' || typeof d.key !== 'string') throw bitbrowserError('no adb info', 'adb_unavailable');
    return { ...parseAdbCommand(d.command), password: d.key, expiresAt: parseLocalTime(d.expireTime, this.options.timeZone ?? undefined) };
  }
}

const clients = new Map<string, BitBrowserClient>();
/**
 * One client (and so one 1-request-per-second queue and one health record) per BitBrowser client
 * address; the options (API key, time zone) follow the latest source config using that address.
 */
export function bitbrowserClient(apiUrl: string, options: BitClientOptions = {}): BitBrowserClient {
  const key = apiUrl.replace(/\/+$/, '');
  let c = clients.get(key);
  if (!c) { c = new BitBrowserClient(key, options); clients.set(key, c); }
  else c.options = options;
  return c;
}
