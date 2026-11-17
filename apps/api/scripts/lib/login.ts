/**
 * Login for check/demo scripts through the REAL captcha path (no bypass in the API): fetch a challenge from
 * GET /api/auth/captcha, read its stored answer from Redis (scripts run with the same .env, so REDIS_URL is
 * the API's) and send it with a plausible drag trail. With LOGIN_CAPTCHA=off the body goes out unchanged.
 * Every script that calls POST /api/auth/login must build its body with `withCaptcha`.
 */
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

export interface CaptchaAnswer { id: string; x: number; trail: [number, number][] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Same key as src/modules/auth/captcha.ts `captchaKey`. */
export const captchaKey = (id: string) => `captcha:${createHash('sha256').update(id).digest('hex')}`;

/** Reads the stored answer of a challenge (null if gone). */
export async function storedCaptcha(id: string): Promise<{ x: number; y: number; at: number; verified?: boolean } | null> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set (run the script with --env-file=../../.env)');
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  try {
    const raw = await redis.get(captchaKey(id));
    return raw ? JSON.parse(raw) : null;
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

/** A drag from 0 to x over ~260 ms, like the web slider sends. */
export const dragTrail = (x: number): [number, number][] => [[0, 0], [Math.round(x / 3), 90], [Math.round((2 * x) / 3), 180], [x, 260]];

/** Fetches a challenge and solves it from Redis; null when the API has the captcha off. */
export async function solveCaptcha(api: string): Promise<CaptchaAnswer | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${api}/api/auth/captcha`);
    if (res.status === 429 && attempt < 2) {
      // Per-IP challenge limit (LOGIN_CAPTCHA_RATE per minute): wait for the next window.
      const wait = 60_000 - (Date.now() % 60_000) + 500;
      console.log(`  (captcha rate limit, waiting ${Math.round(wait / 1000)} s)`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`GET /api/auth/captcha: ${res.status} ${await res.text()}`);
    const c = await res.json() as { enabled: boolean; id?: string };
    if (!c.enabled) return null;
    const stored = await storedCaptcha(c.id!);
    if (!stored) throw new Error('captcha challenge not found in Redis (does REDIS_URL match the API?)');
    return { id: c.id!, x: stored.x, trail: dragTrail(stored.x) };
  }
}

/** `{ ...body, captcha }` for POST /api/auth/login. */
export async function withCaptcha<T extends object>(api: string, body: T): Promise<T & { captcha?: CaptchaAnswer }> {
  const captcha = await solveCaptcha(api);
  return captcha ? { ...body, captcha } : body;
}
