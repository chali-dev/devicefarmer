import { HttpError } from '../lib/errors.js';

/**
 * BitBrowser (比特) cloud phones through the BitBrowser client's local API (POST + JSON, no key,
 * at most 1 request per second: calls are serialised here). Only the endpoints below are exposed;
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
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

export const bitbrowserError = (msg: string, code = 'api_error', params: Record<string, string | number> = {}) =>
  new HttpError(502, `比特云接口：${msg}`, `bitbrowser.${code}`, { msg, ...params });

/** "2026-11-17 17:49:47" (client local time) → Date; unknown formats → null. */
function parseLocalTime(s: unknown): Date | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return null;
  const d = new Date(s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses `/phone/adb/get`'s `command` (an ssh -L line). Only plain host/port tokens are accepted. */
export function parseAdbCommand(command: string): Omit<BitAdbInfo, 'password' | 'expiresAt'> {
  const m = /\bssh\b.*?\s([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)\s+-p\s+(\d+)\s+-L\s+(?:[\w.]+:)?\d+:([A-Za-z0-9.-]+):(\d+)/.exec(command);
  if (!m || !HOST_RE.test(m[2]!) || !HOST_RE.test(m[4]!)) throw bitbrowserError('unexpected adb command format', 'adb_format');
  return { sshUser: m[1]!, sshHost: m[2]!, sshPort: Number(m[3]), targetHost: m[4]!, targetPort: Number(m[5]) };
}

export class BitBrowserClient {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private readonly baseUrl: string) {}

  /** One request at a time, ≥ MIN_GAP_MS apart. */
  private call<T = unknown>(path: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.last + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      let res: Response;
      try {
        res = await fetch(new URL(path, this.baseUrl), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw bitbrowserError(`client unreachable (${(err as Error).message})`, 'unreachable');
      } finally {
        this.last = Date.now();
      }
      const json = await res.json().catch(() => null) as { success?: boolean; msg?: string; data?: T } | null;
      if (!res.ok || !json) throw bitbrowserError(`HTTP ${res.status}`);
      if (json.success !== true) throw bitbrowserError(String(json.msg ?? 'request failed').slice(0, 200));
      return json.data as T;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
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
    await this.call('/phone/openphone', { id }, 120_000);
  }

  async shutdown(id: string): Promise<void> {
    await this.call('/phone/shutdown', { id }, 60_000);
  }

  async adbEnable(id: string): Promise<void> {
    await this.call('/phone/adb/enable', { ids: [id] }, 60_000);
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
    return { ...parseAdbCommand(d.command), password: d.key, expiresAt: parseLocalTime(d.expireTime) };
  }
}

const clients = new Map<string, BitBrowserClient>();
/** One client (and so one 1-request-per-second queue) per BitBrowser client address. */
export function bitbrowserClient(apiUrl: string): BitBrowserClient {
  const key = apiUrl.replace(/\/+$/, '');
  let c = clients.get(key);
  if (!c) { c = new BitBrowserClient(key); clients.set(key, c); }
  return c;
}
