import { eq, inArray, sql } from 'drizzle-orm';
import https from 'node:https';
import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { db, schema } from '../../db/index.js';
import type { PoolProxy, ProxyCheck, ProxyConfig } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { geoOf } from '../../lib/egress.js';
import { openSecret } from '../../lib/secret-box.js';

/**
 * Proxy pool (代理管理). A pool entry binds to at most one device (`instances.proxy_id` is UNIQUE);
 * the device's sidecar is configured from the pool entry, with the password decrypted only when applied.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

/** Pool entry as returned to admins: never the password, only whether one is stored. */
export type PublicProxy = Omit<PoolProxy, 'passwordEnc'> & { hasPassword: boolean; boundInstance: { id: string; name: string } | null };

export function toPublicProxy(p: PoolProxy, bound: { id: string; name: string } | null): PublicProxy {
  const { passwordEnc, ...rest } = p;
  return { ...rest, hasPassword: Boolean(passwordEnc), boundInstance: bound };
}

/** What every user who can see a device may know about its proxy (no username/password). */
export interface InstanceProxyView {
  id: string; label: string | null; type: 'socks5' | 'http'; host: string; port: number;
  country: string | null; city: string | null; hasAuth: boolean; status: PoolProxy['status'];
}

export async function proxyViews(ids: string[], exec: Exec = db): Promise<Map<string, InstanceProxyView>> {
  if (!ids.length) return new Map();
  const rows = await exec.select().from(schema.proxies).where(inArray(schema.proxies.id, [...new Set(ids)]));
  return new Map(rows.map((p) => [p.id, {
    id: p.id, label: p.label, type: p.type, host: p.host, port: p.port,
    country: p.country, city: p.city, hasAuth: Boolean(p.username), status: p.status,
  }]));
}

/** Sidecar configuration for a device's bound proxy (null = direct). Decrypts the password. */
export async function resolveProxyConfig(proxyId: string | null): Promise<ProxyConfig | null> {
  if (!proxyId) return null;
  const [p] = await db.select().from(schema.proxies).where(eq(schema.proxies.id, proxyId));
  if (!p) throw new Error('bound proxy no longer exists');
  return toConfig(p);
}

export function toConfig(p: PoolProxy): ProxyConfig {
  return {
    type: p.type, host: p.host, port: p.port,
    ...(p.username ? { username: p.username } : {}),
    ...(p.passwordEnc ? { password: openSecret(p.passwordEnc) } : {}),
  };
}

export const endpointText = (p: { type: string; host: string; port: number; label?: string | null }) =>
  p.label ? `${p.label} (${p.type}://${p.host}:${p.port})` : `${p.type}://${p.host}:${p.port}`;

// ---------------------------------------------------------------- binding (exclusive)

/** Postgres unique violation on the given constraint (drizzle wraps driver errors in `cause`). */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23505' && (!constraint || e.constraint_name === constraint)) return true;
  }
  return false;
}

/**
 * Locks the given pool entries (FOR UPDATE) and checks that none is bound to another device.
 * Concurrent binders of the same proxy serialize on the row lock and the loser sees the winner's
 * binding (READ COMMITTED re-reads per statement); the UNIQUE constraint is the final backstop.
 */
export async function lockFreeProxies(tx: Tx, ids: string[], exceptInstanceId?: string): Promise<PoolProxy[]> {
  const rows = await tx.select().from(schema.proxies).where(inArray(schema.proxies.id, ids)).for('update');
  const missing = ids.find((id) => !rows.some((r) => r.id === id));
  if (missing) throw notFound('代理不存在', 'proxy.not_found');
  const holders = await tx.select({ id: schema.instances.id, name: schema.instances.name, proxyId: schema.instances.proxyId })
    .from(schema.instances).where(inArray(schema.instances.proxyId, ids));
  const other = holders.find((h) => h.id !== exceptInstanceId);
  if (other) {
    const p = rows.find((r) => r.id === other.proxyId)!;
    throw conflict(`代理 ${endpointText(p)} 已绑定到设备 ${other.name}`, 'proxy.already_bound', { proxy: endpointText(p), name: other.name });
  }
  return rows;
}

/** Free = bound to no device. Auto-assignment takes usable ones (ok first, then unchecked). */
const FREE = sql`not exists (select 1 from ${schema.instances} i where i.proxy_id = ${schema.proxies.id})`;
const USABLE = sql`${schema.proxies.status} in ('ok', 'unchecked')`;

export async function countFreeUsable(exec: Exec = db): Promise<number> {
  const [r] = await exec.select({ n: sql<number>`count(*)::int` }).from(schema.proxies).where(sql`${FREE} and ${USABLE}`);
  return r?.n ?? 0;
}

/**
 * Picks `count` distinct free usable proxies and locks them for the caller's transaction.
 * SKIP LOCKED: concurrent creations never wait for or take the same rows.
 */
export async function assignFreeProxies(tx: Tx, count: number): Promise<string[]> {
  const rows = await tx.select({ id: schema.proxies.id }).from(schema.proxies)
    .where(sql`${FREE} and ${USABLE}`)
    .orderBy(sql`(${schema.proxies.status} = 'ok') desc`, sql`(${schema.proxies.lastCheck}->>'latencyMs')::int asc nulls last`, schema.proxies.createdAt)
    .limit(count)
    .for('update', { skipLocked: true });
  if (rows.length < count) {
    throw conflict(`空闲可用代理不足：需要 ${count} 个，当前 ${rows.length} 个`, 'proxy.not_enough_free', { need: count, free: rows.length });
  }
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------- check from the API host

const CHECK_TIMEOUT_MS = 15_000;
const UA = 'cloudphone-proxy-check';

function agentFor(p: ProxyConfig): Agent {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@` : '';
  // socks5h: the proxy resolves names (as a residential exit would for the device).
  return p.type === 'socks5'
    ? new SocksProxyAgent(`socks5h://${auth}${p.host}:${p.port}`, { timeout: CHECK_TIMEOUT_MS })
    : new HttpsProxyAgent(`http://${auth}${p.host}:${p.port}`, { timeout: CHECK_TIMEOUT_MS }) as unknown as Agent;
}

function getJson(url: string, agent: Agent): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers: { 'user-agent': UA, accept: 'application/json' }, timeout: CHECK_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { body += d; if (body.length > 64 * 1024) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`${new URL(url).host} HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body) as Record<string, unknown>); } catch { reject(new Error(`${new URL(url).host}: invalid JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${CHECK_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
  });
}

const IPV4_OR_6 = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i;

/** Connects through the proxy from the API host: egress IP (ipify) + geo (ipinfo), latency of the first request. */
export async function probeProxy(p: ProxyConfig): Promise<ProxyCheck> {
  const at = new Date().toISOString();
  const agent = agentFor(p);
  try {
    const t0 = performance.now();
    const ipr = await getJson('https://api.ipify.org?format=json', agent);
    const latencyMs = Math.round(performance.now() - t0);
    const ip = typeof ipr.ip === 'string' && IPV4_OR_6.test(ipr.ip) ? ipr.ip : null;
    if (!ip) return { at, ok: false, egressIp: null, latencyMs: null, country: null, city: null, error: 'no egress IP returned' };
    // Geo is best effort (rate limits must not fail a working proxy).
    const geo = geoOf(await getJson('https://ipinfo.io/json', agent).catch(() => null), ip);
    return { at, ok: true, egressIp: ip, latencyMs, country: geo.country ?? null, city: geo.city ?? null, error: null };
  } catch (err) {
    return { at, ok: false, egressIp: null, latencyMs: null, country: null, city: null, error: (err as Error).message.slice(0, 300) || 'connection failed' };
  } finally {
    agent.destroy();
  }
}

/** Checks one pool entry and stores the result (country/city filled from geo when not set). */
export async function checkPoolProxy(p: PoolProxy): Promise<PoolProxy> {
  let result: ProxyCheck;
  try { result = await probeProxy(toConfig(p)); } catch (err) {
    result = { at: new Date().toISOString(), ok: false, egressIp: null, latencyMs: null, country: null, city: null, error: (err as Error).message };
  }
  const [row] = await db.update(schema.proxies).set({
    status: result.ok ? 'ok' : 'failed', lastCheck: result,
    ...(result.ok && !p.country && result.country ? { country: result.country } : {}),
    ...(result.ok && !p.city && result.city ? { city: result.city } : {}),
  }).where(eq(schema.proxies.id, p.id)).returning();
  return row ?? p;
}

/** Runs `fn` over items with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

// ---------------------------------------------------------------- bulk import parsing

export interface ParsedProxy { type: 'socks5' | 'http'; host: string; port: number; username: string | null; password: string | null }
export const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

/**
 * One proxy per line:
 *   socks5://user:pass@host:port · http://host:port · user:pass@host:port · host:port:user:pass · host:port
 * Schemes socks/socks5/socks5h → socks5, http → http. Lines without a scheme use `defaultType`.
 */
export function parseProxyLine(line: string, defaultType: 'socks5' | 'http'): ParsedProxy | string {
  let s = line.trim();
  let type: 'socks5' | 'http' = defaultType;
  const m = /^([a-z0-9]+):\/\//i.exec(s);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    if (scheme === 'socks' || scheme === 'socks5' || scheme === 'socks5h') type = 'socks5';
    else if (scheme === 'http') type = 'http';
    else return `unsupported scheme "${scheme}"`;
    s = s.slice(m[0].length).replace(/\/+$/, '');
  }
  let username: string | null = null;
  let password: string | null = null;
  let hostPort: string;
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    const cred = s.slice(0, at);
    hostPort = s.slice(at + 1);
    const c = cred.indexOf(':');
    try {
      username = decodeURIComponent(c >= 0 ? cred.slice(0, c) : cred);
      password = c >= 0 ? decodeURIComponent(cred.slice(c + 1)) : null;
    } catch { return 'invalid percent-encoding in credentials'; }
  } else {
    const parts = s.split(':');
    if (parts.length === 4) { [, , username, password] = parts as [string, string, string, string]; hostPort = `${parts[0]}:${parts[1]}`; }
    else if (parts.length === 2) hostPort = s;
    else return 'expected host:port, host:port:user:pass or scheme://[user:pass@]host:port';
  }
  const hp = /^([^:]+):(\d{1,5})$/.exec(hostPort);
  if (!hp) return 'expected host:port';
  const host = hp[1]!;
  const port = Number(hp[2]);
  if (!HOST_RE.test(host)) return 'invalid host (hostname or IPv4)';
  if (port < 1 || port > 65535) return 'port out of range';
  if (username === '') username = null;
  if (password === '') password = null;
  if ((username?.length ?? 0) > 200 || (password?.length ?? 0) > 200) return 'credentials too long';
  if (password && !username) return 'password without username';
  return { type, host, port, username, password };
}

/** Line as shown back to the client: password masked. */
export const maskedLine = (p: ParsedProxy) => `${p.type}://${p.username ? `${p.username}${p.password ? ':***' : ''}@` : ''}${p.host}:${p.port}`;
export const endpointKey = (p: { type: string; host: string; port: number; username: string | null }) =>
  `${p.type}|${p.host.toLowerCase()}|${p.port}|${p.username ?? ''}`;
