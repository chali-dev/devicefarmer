import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError, type ErrorParams } from '../../lib/errors.js';
import type { Authed } from './types.js';

/** Coded platform error (`errors.platform.<code>` in the web UI). */
export const platformError = (status: number, code: string, message: string, params?: ErrorParams) =>
  new HttpError(status, message, `platform.${code}`, params);

/** Replaces every secret (tokens, client secret) in a text that may be stored or shown. */
export function scrub(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out.slice(0, 300);
}

/**
 * JSON.parse that keeps integers beyond 2^53 as their exact source text (e.g. TikTok's int64
 * publicaly_available_post_id): a plain parse would round them to a different id.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text, ((_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source ? ctx.source : v) as (k: string, v: unknown) => unknown);
}

/** Platform failure that may succeed when tried again later (rate limits, 5xx, network); everything else is final. */
export function isTransientPlatformError(err: unknown): boolean {
  return err instanceof HttpError && (err.statusCode === 429 || err.statusCode >= 500);
}

export interface FetchOpts {
  /** Platform display name for messages. */
  platform: string;
  /** Secrets that must never appear in an error message. */
  secrets?: (string | null | undefined)[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Simple per-connection pacing key (e.g. connection id): calls are spaced ≥ MIN_GAP_MS apart. */
  limiterKey?: string;
  /** Maps a non-2xx response (body parsed as JSON when possible) to a coded error. */
  mapError: (res: Response, body: unknown, msg: (raw: string | undefined) => string) => HttpError;
  /** Treat these extra statuses as success (e.g. 308 Resume Incomplete of resumable uploads). */
  okStatuses?: number[];
  /** Retries on 429 (Retry-After honoured, capped). Default 2. Only for replayable bodies. */
  retries429?: number;
}

const MIN_GAP_MS = 200;
const nextSlot = new Map<string, number>();

async function pace(key: string | undefined): Promise<void> {
  if (!key) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, at + MIN_GAP_MS);
  if (nextSlot.size > 5000) for (const [k, v] of nextSlot) if (v < now) nextSlot.delete(k);
  if (at > now) await sleep(at - now);
}

function retryAfterMs(res: Response, attempt: number): number {
  const h = res.headers.get('retry-after');
  const sec = h && /^\d+$/.test(h) ? Number(h) : NaN;
  return Math.min(30_000, Number.isFinite(sec) ? sec * 1000 : 2000 * 2 ** attempt);
}

/**
 * fetch with timeout, cancellation, per-connection pacing, bounded backoff on 429 and coded errors.
 * Network failures become platform.unreachable; the URL (which may carry a token) is never put in a message.
 */
export async function platformFetch(url: string, init: RequestInit, o: FetchOpts): Promise<{ res: Response; body: unknown }> {
  const retries = o.retries429 ?? 2;
  for (let attempt = 0; ; attempt++) {
    await pace(o.limiterKey);
    const signals = [AbortSignal.timeout(o.timeoutMs ?? 30_000), ...(o.signal ? [o.signal] : [])];
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
    } catch (err) {
      if (o.signal?.aborted) throw o.signal.reason;
      const name = (err as Error).name;
      throw platformError(502, 'unreachable', `${o.platform} 接口无法访问：${name}`, { platform: o.platform, error: name });
    }
    const text = await res.text().catch(() => '');
    let body: unknown = text;
    try { body = text ? parseJson(text) : {}; } catch { /* non-JSON body */ }
    if (res.ok || o.okStatuses?.includes(res.status)) return { res, body };
    if (res.status === 429 && attempt < retries) {
      await sleep(retryAfterMs(res, attempt), undefined, o.signal ? { signal: o.signal } : undefined);
      continue;
    }
    throw o.mapError(res, body, (raw) => scrub(raw ?? res.statusText, o.secrets ?? []));
  }
}

export const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Standard OAuth 2.0 token-endpoint errors (RFC 6749 §5.2) → coded errors. */
export function oauthTokenError(platform: string, res: Response, body: unknown, msg: (raw: string | undefined) => string): HttpError {
  const b = (body ?? {}) as { error?: unknown; error_description?: string; error_message?: string; message?: string };
  const err = typeof b.error === 'string' ? b.error : (b.error as { code?: string; type?: string } | undefined)?.code ?? '';
  const text = msg(b.error_description ?? b.error_message ?? b.message ?? (typeof b.error === 'string' ? b.error : undefined));
  if (err === 'invalid_grant' || /authorization code|code (has|is) (expired|invalid|been used)/i.test(text)) {
    return platformError(400, 'oauth_invalid_grant', `${platform} 授权码无效或已过期：${text}`, { platform, error: text });
  }
  if (err === 'invalid_client' || err === 'unauthorized_client' || res.status === 401) {
    return platformError(400, 'oauth_invalid_client', `${platform} 应用凭据无效（Client ID / Secret）：${text}`, { platform, error: text });
  }
  if (res.status === 429) return platformError(429, 'rate_limited', `${platform} 请求过于频繁，请稍后再试`, { platform });
  return platformError(502, 'oauth_failed', `${platform} 授权失败：${text}`, { platform, error: text });
}

/** Normalises a token-endpoint "expires_in" (seconds) to a date. */
export const expiresIn = (sec: unknown): Date | null => (num(sec) ? new Date(Date.now() + num(sec)! * 1000) : null);

export const splitScopes = (s: unknown, sep = /[\s,]+/): string[] => (typeof s === 'string' ? s.split(sep).map((x) => x.trim()).filter(Boolean) : []);

/**
 * Runs an optional call that needs `scope`. Returns null (= scope missing, non-fatal) when the
 * connection's granted scopes are known and lack it, or when the platform answers permission_missing.
 * Connections made before a scope was added keep working this way.
 */
export async function withOptionalScope<T>(a: Authed, scope: string, fn: () => Promise<T>): Promise<T | null> {
  const granted = a.connection.scopes;
  if (granted.length && !granted.includes(scope)) return null;
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.code === 'platform.permission_missing') return null;
    throw err;
  }
}

/** Unix seconds of a UTC day's start (YYYY-MM-DD). */
export const dayStartSec = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
