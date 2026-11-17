import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';

/**
 * Slider puzzle captcha (拼图验证) for the login, self-hosted.
 *
 * A challenge is a generated background (gradient + random shapes + noise, nothing downloaded) with a
 * jigsaw-shaped hole at a random x/y, plus the matching piece. The client gets both images and `y`; the
 * answer `x` stays in Redis under sha256(id) for LOGIN_CAPTCHA_TTL_SEC. Every check takes the record out
 * atomically (GETDEL / Lua), so one challenge allows exactly one try:
 * - `POST /api/auth/captcha/verify` (the web calls it on release) re-stores a correct answer once, flagged
 *   verified, so the following login can use it; a wrong one is gone.
 * - `POST /api/auth/login` consumes it for good, right or wrong, before the password is looked at.
 *
 * Accepted: |x − answer| ≤ TOLERANCE px (rendered width WIDTH) and a plausible drag `trail` of [x, ms]
 * points: ≥ 3 points with ≥ 3 distinct x, time never going back, ≥ MIN_DRAG_MS from first to last point,
 * last point at the submitted x. This only stops naive scripted posts; it is not bot detection.
 */

export const WIDTH = 320;
export const HEIGHT = 160;
/** Body square, tab radius and the piece's bounding box (square). */
const BODY = 34;
const TAB = 6;
export const PIECE = BODY + 2 * TAB + 4;
export const TOLERANCE = 5;
export const MIN_DRAG_MS = 150;

const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Redis key of a challenge (scripts/lib/login.ts reads it the same way). */
export const captchaKey = (id: string) => `captcha:${sha(id)}`;

interface Stored { x: number; y: number; at: number; verified?: boolean }

export const captchaEnabled = () => config.LOGIN_CAPTCHA === 'on';

/**
 * Client address for the rate limit. Behind the reverse proxy (Caddy on the same host) every request comes
 * from loopback, so the last X-Forwarded-For entry (the address the proxy saw) is used then; a direct
 * connection from elsewhere can't forge it.
 */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? req.ip;
  const loopback = peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
  const xff = req.headers['x-forwarded-for'];
  if (loopback && xff) {
    const last = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.slice(0, 64);
  }
  return peer;
}

async function rateLimit(ip: string): Promise<void> {
  const key = `captcha:rate:${sha(ip).slice(0, 32)}:${Math.floor(Date.now() / 60_000)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 70);
  if (n > config.LOGIN_CAPTCHA_RATE) throw new HttpError(429, '获取验证过于频繁，请稍后再试', 'auth.captcha_rate_limited');
}

// --- rendering --------------------------------------------------------------------------------------

const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${Math.round(h) % 360},${Math.round(s)}%,${Math.round(l)}%,${a.toFixed(2)})`;

/** Jigsaw outline inside the PIECE box: tab on top and right, notch on the left. */
function piecePath(): string {
  const L = 2, T = 2 * TAB + 2, s = BODY, r = TAB, h = s / 2 - r;
  return `M${L},${T} h${h} a${r},${r} 0 1 1 ${2 * r},0 h${h} v${h} a${r},${r} 0 1 1 0,${2 * r} v${h} `
    + `h${-s} v${-h} a${r},${r} 0 1 0 0,${-2 * r} z`;
}

function backgroundSvg(): string {
  const hue = rnd(0, 360);
  const parts: string[] = [];
  for (let i = 0; i < 14; i++) {
    const h = hue + rnd(-80, 80), fill = hsl(h, rnd(40, 80), rnd(30, 75), rnd(0.25, 0.7));
    const cx = rnd(0, WIDTH), cy = rnd(0, HEIGHT), size = rnd(12, 70);
    const kind = i % 3;
    if (kind === 0) parts.push(`<circle cx="${cx}" cy="${cy}" r="${size / 2}" fill="${fill}"/>`);
    else if (kind === 1) parts.push(`<rect x="${cx}" y="${cy}" width="${size}" height="${size * rnd(0.4, 1.2)}" fill="${fill}" transform="rotate(${rnd(0, 90)} ${cx} ${cy})"/>`);
    else {
      const pts = [0, 1, 2].map(() => `${cx + rnd(-size, size)},${cy + rnd(-size, size)}`).join(' ');
      parts.push(`<polygon points="${pts}" fill="${fill}"/>`);
    }
  }
  for (let i = 0; i < 6; i++) {
    parts.push(`<line x1="${rnd(0, WIDTH)}" y1="${rnd(0, HEIGHT)}" x2="${rnd(0, WIDTH)}" y2="${rnd(0, HEIGHT)}" stroke="${hsl(hue + rnd(-120, 120), 60, rnd(30, 80), 0.5)}" stroke-width="${rnd(1, 4)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hsl(hue, 60, 55)}"/>`
    + `<stop offset="1" stop-color="${hsl(hue + rnd(60, 180), 60, 45)}"/></linearGradient></defs>`
    + `<rect width="100%" height="100%" fill="url(#g)"/>${parts.join('')}</svg>`;
}

/** Per-pixel grey noise with low alpha, composited over the background. */
function noise(): Buffer {
  const buf = randomBytes(WIDTH * HEIGHT * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i + 1] = buf[i]!; buf[i + 2] = buf[i]!; buf[i + 3] = buf[i + 3]! % 40; }
  return buf;
}

const shapeSvg = (fill: string, stroke: string, strokeWidth: number) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIECE}" height="${PIECE}"><path d="${piecePath()}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/></svg>`);

async function render(x: number, y: number): Promise<{ bg: Buffer; piece: Buffer }> {
  const raw = { width: WIDTH, height: HEIGHT, channels: 4 as const };
  const base = await sharp(Buffer.from(backgroundSvg()))
    .ensureAlpha()
    .composite([{ input: noise(), raw }])
    .raw()
    .toBuffer();
  const [bg, piece] = await Promise.all([
    sharp(base, { raw }).composite([{ input: shapeSvg('rgba(0,0,0,0.5)', 'rgba(255,255,255,0.75)', 1.5), left: x, top: y }])
      .flatten().jpeg({ quality: 82 }).toBuffer(),
    sharp(await sharp(base, { raw }).extract({ left: x, top: y, width: PIECE, height: PIECE }).png().toBuffer())
      .composite([
        { input: shapeSvg('#fff', 'none', 0), blend: 'dest-in' },
        { input: shapeSvg('none', 'rgba(255,255,255,0.95)', 2) },
      ])
      .png().toBuffer(),
  ]);
  return { bg, piece };
}

export interface Challenge { id: string; bg: string; piece: string; y: number; width: number; height: number; pieceSize: number; ttlSec: number }

export async function createChallenge(req: FastifyRequest): Promise<Challenge> {
  await rateLimit(clientIp(req));
  const x = randomInt(PIECE + 12, WIDTH - PIECE - 6 + 1);
  const y = randomInt(6, HEIGHT - PIECE - 6 + 1);
  const { bg, piece } = await render(x, y);
  const id = randomBytes(18).toString('base64url');
  const stored: Stored = { x, y, at: Date.now() };
  await redis.set(captchaKey(id), JSON.stringify(stored), 'EX', config.LOGIN_CAPTCHA_TTL_SEC);
  return {
    id, y, width: WIDTH, height: HEIGHT, pieceSize: PIECE, ttlSec: config.LOGIN_CAPTCHA_TTL_SEC,
    bg: `data:image/jpeg;base64,${bg.toString('base64')}`,
    piece: `data:image/png;base64,${piece.toString('base64')}`,
  };
}

// --- checking ---------------------------------------------------------------------------------------

const Answer = z.object({
  id: z.string().min(8).max(64),
  x: z.number().finite(),
  trail: z.array(z.tuple([z.number().finite(), z.number().finite()])).max(500).optional(),
});
export type CaptchaAnswer = z.infer<typeof Answer>;

/** Why an answer was refused (audit detail; never the values themselves). */
export type CaptchaFailure = 'captcha_required' | 'captcha_expired' | 'captcha_invalid' | 'captcha_trail';

export class CaptchaError extends HttpError {
  constructor(readonly reason: CaptchaFailure) {
    super(400,
      reason === 'captcha_required' ? '请先完成拼图验证' : reason === 'captcha_expired' ? '验证已失效，请重新验证' : '拼图验证未通过，请重试',
      reason === 'captcha_required' ? 'auth.captcha_required' : reason === 'captcha_expired' ? 'auth.captcha_expired' : 'auth.captcha_invalid');
  }
}

function plausibleTrail(trail: [number, number][] | undefined, x: number): boolean {
  if (!trail || trail.length < 3) return false;
  for (let i = 1; i < trail.length; i++) if (trail[i]![1] < trail[i - 1]![1]) return false;
  if (trail.at(-1)![1] - trail[0]![1] < MIN_DRAG_MS) return false;
  if (new Set(trail.map((p) => Math.round(p[0]))).size < 3) return false;
  return Math.abs(trail.at(-1)![0] - x) <= TOLERANCE;
}

// GET + PTTL + DEL in one step: concurrent tries on one challenge can't both see it.
const TAKE = `local v = redis.call('GET', KEYS[1]) if not v then return false end local t = redis.call('PTTL', KEYS[1]) redis.call('DEL', KEYS[1]) return {v, t}`;

/**
 * Takes the challenge out of Redis and checks the answer. `keepIfRight` (the verify-on-release endpoint)
 * stores a correct, not yet verified answer again for the rest of its lifetime, flagged verified.
 */
export async function checkCaptcha(input: unknown, opts: { keepIfRight?: boolean } = {}): Promise<void> {
  if (input === undefined || input === null) throw new CaptchaError('captcha_required');
  const parsed = Answer.safeParse(input);
  if (!parsed.success) throw new CaptchaError('captcha_invalid');
  const a = parsed.data;
  const r = (await redis.eval(TAKE, 1, captchaKey(a.id))) as [string, number] | null;
  if (!r) throw new CaptchaError('captcha_expired');
  const stored = JSON.parse(r[0]) as Stored;
  if (Math.abs(a.x - stored.x) > TOLERANCE) throw new CaptchaError('captcha_invalid');
  if (!plausibleTrail(a.trail, a.x)) throw new CaptchaError('captcha_trail');
  if (opts.keepIfRight) {
    if (stored.verified) throw new CaptchaError('captcha_expired');
    if (r[1] > 0) await redis.set(captchaKey(a.id), JSON.stringify({ ...stored, verified: true }), 'PX', r[1]);
  }
}

export const isCaptchaError = (e: unknown): e is CaptchaError => e instanceof CaptchaError;
