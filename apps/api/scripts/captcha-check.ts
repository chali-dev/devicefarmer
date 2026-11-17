/**
 * Login slider captcha (拼图验证) against the real API + Redis + DB (no mocks).
 * - GET /api/auth/captcha: shape, image formats/sizes (sharp metadata), piece transparency, stored answer + TTL,
 *   no caching.
 * - POST /api/auth/login: missing / malformed / wrong x / outside tolerance / no or implausible trail / reused /
 *   expired (Redis PEXPIRE) → coded 400; right x (within tolerance) → token; the captcha is checked before the
 *   password (bad captcha + wrong password or unknown user → captcha error, never 401).
 * - POST /api/auth/captcha/verify: wrong → gone; right → kept once (verified), second verify refused,
 *   login still re-checks x; parallel verifies of one challenge → exactly one succeeds.
 * - Rate limit per client IP (X-Forwarded-For from loopback = the reverse proxy case), other IPs unaffected.
 * - Audit: failed captcha logins recorded with a reason, no password/answer/id in any entry; verify not audited.
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/captcha-check.ts
 *        API started with LOGIN_CAPTCHA=off:   npx tsx --env-file=../../.env scripts/captcha-check.ts --off
 */
import { and, gte, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { captchaKey, dragTrail, storedCaptcha, withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const ADMIN = process.env.ADMIN_USERNAME ?? 'admin';
const PASS = process.env.ADMIN_PASSWORD ?? '';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const redis = new Redis(process.env.REDIS_URL!);

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}
const challenge = async (headers: Record<string, string> = {}) => http('GET', '/api/auth/captcha', undefined, headers);
async function fresh() {
  const c = (await challenge()).body;
  const s = await storedCaptcha(c.id);
  return { c, x: s!.x };
}
const login = (captcha: unknown, username = ADMIN, password = PASS) => http('POST', '/api/auth/login', { username, password, ...(captcha !== undefined ? { captcha } : {}) });
const coded = (r: { status: number; body: any }, code: string) => r.status === 400 && r.body?.code === code;
const show = (r: { status: number; body: any }) => `${r.status} ${r.body?.code ?? ''}`;

const started = new Date();

if (process.argv.includes('--off')) {
  const c = await challenge();
  check('off: GET captcha → { enabled: false }', c.status === 200 && c.body?.enabled === false && !c.body.id, JSON.stringify(c.body));
  const l = await login(undefined);
  check('off: login without captcha → 200', l.status === 200 && !!l.body?.token, show(l));
  const bad = await login(undefined, ADMIN, 'wrong-password-123');
  check('off: wrong password → 401', bad.status === 401 && bad.body?.code === 'auth.invalid_credentials', show(bad));
  const helper = await http('POST', '/api/auth/login', await withCaptcha(API, { username: ADMIN, password: PASS }));
  check('off: script helper sends no captcha and logs in', helper.status === 200, show(helper));
} else {
  // --- challenge -----------------------------------------------------------------------------------
  const r = await challenge();
  const c = r.body;
  check('GET captcha → 200 enabled', r.status === 200 && c?.enabled === true, String(r.status));
  check('not cacheable', r.headers.get('cache-control') === 'no-store', r.headers.get('cache-control') ?? '');
  check('shape: id, bg jpeg, piece png, y, width, height, pieceSize, ttlSec',
    typeof c.id === 'string' && c.id.length >= 16 && c.bg.startsWith('data:image/jpeg;base64,') && c.piece.startsWith('data:image/png;base64,')
    && c.width === 320 && c.height === 160 && Number.isInteger(c.y) && c.pieceSize > 20 && c.ttlSec > 0 && !('x' in c),
    `y=${c.y} piece=${c.pieceSize} ttl=${c.ttlSec}`);
  const bgImg = Buffer.from(c.bg.split(',')[1], 'base64');
  const pieceImg = Buffer.from(c.piece.split(',')[1], 'base64');
  const bm = await sharp(bgImg).metadata();
  const pm = await sharp(pieceImg).metadata();
  check('bg image 320×160 jpeg', bm.format === 'jpeg' && bm.width === 320 && bm.height === 160, `${bm.format} ${bm.width}×${bm.height} ${bgImg.length} B`);
  check('piece image square png with alpha', pm.format === 'png' && pm.width === c.pieceSize && pm.height === c.pieceSize && pm.hasAlpha === true, `${pm.format} ${pm.width}×${pm.height} alpha=${pm.hasAlpha}`);
  const { data: px, info } = await sharp(pieceImg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) => px[(y * info.width + x) * 4 + 3]!;
  const mid = Math.floor(c.pieceSize / 2);
  check('piece: transparent corner, opaque centre', alphaAt(0, 0) === 0 && alphaAt(c.pieceSize - 1, c.pieceSize - 1) === 0 && alphaAt(mid, mid + 4) === 255, `corner ${alphaAt(0, 0)} centre ${alphaAt(mid, mid + 4)}`);
  const stored = await storedCaptcha(c.id);
  const ttl = await redis.ttl(captchaKey(c.id));
  check('answer stored in Redis under the hashed id (x, y), TTL set', !!stored && stored.y === c.y && stored.x > c.pieceSize && stored.x + c.pieceSize <= 320 && ttl > 0 && ttl <= c.ttlSec, `x=${stored?.x} ttl=${ttl}`);
  check('raw id is not a Redis key', (await redis.exists(`captcha:${c.id}`)) === 0);
  const c2 = (await challenge()).body;
  check('two challenges differ (id, images)', c2.id !== c.id && c2.bg !== c.bg);

  // --- login refusals --------------------------------------------------------------------------------
  let l = await login(undefined);
  check('login without captcha → 400 auth.captcha_required', coded(l, 'auth.captcha_required'), show(l));
  l = await login({ id: 'x', x: 'a' });
  check('malformed captcha → 400 auth.captcha_invalid', coded(l, 'auth.captcha_invalid'), show(l));
  l = await login({ id: c.id, x: stored!.x + 20, trail: dragTrail(stored!.x + 20) });
  check('wrong x → 400 auth.captcha_invalid', coded(l, 'auth.captcha_invalid'), show(l));
  check('wrong try consumed the challenge', (await redis.exists(captchaKey(c.id))) === 0);
  l = await login({ id: c.id, x: stored!.x, trail: dragTrail(stored!.x) });
  check('reused challenge (right x after a wrong try) → 400 auth.captcha_expired', coded(l, 'auth.captcha_expired'), show(l));

  let f = await fresh();
  l = await login({ id: f.c.id, x: f.x + 6, trail: dragTrail(f.x + 6) });
  check('x off by 6 px (tolerance 5) → captcha_invalid', coded(l, 'auth.captcha_invalid'), show(l));
  f = await fresh();
  l = await login({ id: f.c.id, x: f.x });
  check('right x without trail → captcha_invalid', coded(l, 'auth.captcha_invalid'), show(l));
  f = await fresh();
  l = await login({ id: f.c.id, x: f.x, trail: [[0, 0], [f.x / 2, 20], [f.x, 60]] });
  check('drag faster than 150 ms → captcha_invalid', coded(l, 'auth.captcha_invalid'), show(l));
  f = await fresh();
  l = await login({ id: f.c.id, x: f.x, trail: [[0, 0], [f.x, 400]] });
  check('trail without intermediate points → captcha_invalid', coded(l, 'auth.captcha_invalid'), show(l));
  f = await fresh();
  l = await login({ id: f.c.id, x: f.x, trail: [[0, 300], [f.x / 2, 100], [f.x, 500]] });
  check('trail with time going back → captcha_invalid', coded(l, 'auth.captcha_invalid'), show(l));
  f = await fresh();
  await redis.pexpire(captchaKey(f.c.id), 1);
  await new Promise((r) => setTimeout(r, 30));
  l = await login({ id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  check('expired challenge → 400 auth.captcha_expired', coded(l, 'auth.captcha_expired'), show(l));
  l = await login({ id: 'AAAAAAAAAAAAAAAAAAAAAAAA', x: 100, trail: dragTrail(100) });
  check('unknown id → captcha_expired', coded(l, 'auth.captcha_expired'), show(l));

  // --- captcha before password ---------------------------------------------------------------------
  f = await fresh();
  l = await login({ id: f.c.id, x: f.x + 30, trail: dragTrail(f.x + 30) }, ADMIN, 'wrong-password-123');
  check('bad captcha + wrong password → captcha error (not 401)', coded(l, 'auth.captcha_invalid'), show(l));
  l = await login({ id: 'AAAAAAAAAAAAAAAAAAAAAAAA', x: 1, trail: dragTrail(1) }, 'no-such-user-captcha', 'whatever-123');
  check('bad captcha + unknown user → same captcha error', coded(l, 'auth.captcha_expired'), show(l));
  l = await login(undefined, 'no-such-user-captcha', 'whatever-123');
  check('no captcha + unknown user → captcha_required (username not revealed)', coded(l, 'auth.captcha_required'), show(l));
  f = await fresh();
  l = await login({ id: f.c.id, x: f.x, trail: dragTrail(f.x) }, ADMIN, 'wrong-password-123');
  check('good captcha + wrong password → 401 auth.invalid_credentials', l.status === 401 && l.body?.code === 'auth.invalid_credentials', show(l));
  l = await login({ id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  check('…and that challenge is used up (right password now) → captcha_expired', coded(l, 'auth.captcha_expired'), show(l));

  // --- success ---------------------------------------------------------------------------------------
  f = await fresh();
  l = await login({ id: f.c.id, x: f.x + 4, trail: dragTrail(f.x + 4) });
  check('right x (within 4 px) + password → 200 token', l.status === 200 && typeof l.body?.token === 'string', show(l));
  const me = await http('GET', '/api/auth/me', undefined, { authorization: `Bearer ${l.body?.token}` });
  check('token works', me.status === 200 && me.body?.user?.username === ADMIN);
  const again = await login({ id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  check('successful challenge cannot be reused → captcha_expired', coded(again, 'auth.captcha_expired'), show(again));
  const helper = await http('POST', '/api/auth/login', await withCaptcha(API, { username: ADMIN, password: PASS }));
  check('script helper (scripts/lib/login.ts) logs in', helper.status === 200, show(helper));

  // --- verify on release ---------------------------------------------------------------------------
  f = await fresh();
  let v = await http('POST', '/api/auth/captcha/verify', { id: f.c.id, x: f.x - 15, trail: dragTrail(f.x - 15) });
  check('verify wrong → 400 captcha_invalid, challenge gone', coded(v, 'auth.captcha_invalid') && (await redis.exists(captchaKey(f.c.id))) === 0, show(v));
  f = await fresh();
  const ttlBefore = await redis.pttl(captchaKey(f.c.id));
  v = await http('POST', '/api/auth/captcha/verify', { id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  const kept = await storedCaptcha(f.c.id);
  const ttlAfter = await redis.pttl(captchaKey(f.c.id));
  check('verify right → ok, kept once as verified, lifetime not extended', v.status === 200 && v.body?.ok === true && kept?.verified === true && ttlAfter > 0 && ttlAfter <= ttlBefore, `ttl ${ttlBefore} → ${ttlAfter}`);
  v = await http('POST', '/api/auth/captcha/verify', { id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  check('second verify of the same challenge → captcha_expired', coded(v, 'auth.captcha_expired'), show(v));
  f = await fresh();
  await http('POST', '/api/auth/captcha/verify', { id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  l = await login({ id: f.c.id, x: f.x + 40, trail: dragTrail(f.x + 40) });
  check('login after verify still re-checks x (wrong x → invalid)', coded(l, 'auth.captcha_invalid'), show(l));
  f = await fresh();
  await http('POST', '/api/auth/captcha/verify', { id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  l = await login({ id: f.c.id, x: f.x, trail: dragTrail(f.x) });
  check('verify then login → 200', l.status === 200 && !!l.body?.token, show(l));
  f = await fresh();
  const par = await Promise.all(Array.from({ length: 6 }, () => http('POST', '/api/auth/captcha/verify', { id: f.c.id, x: f.x, trail: dragTrail(f.x) })));
  check('6 parallel verifies of one challenge → exactly one ok', par.filter((p) => p.status === 200).length === 1, par.map((p) => p.status).join(','));

  // --- rate limit ------------------------------------------------------------------------------------
  const limit = Number(process.env.LOGIN_CAPTCHA_RATE ?? 60);
  // A fresh minute window so the count is exact.
  if (60_000 - (Date.now() % 60_000) < 15_000) await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 200));
  const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const statuses: number[] = [];
  for (let i = 0; i < limit + 1; i++) statuses.push((await challenge({ 'x-forwarded-for': `203.0.113.9, ${ip}` })).status);
  const last = await challenge({ 'x-forwarded-for': ip });
  check(`rate limit: ${limit} challenges per IP and minute, then 429 auth.captcha_rate_limited`,
    statuses.slice(0, limit).every((s) => s === 200) && statuses[limit] === 429 && last.status === 429 && last.body?.code === 'auth.captcha_rate_limited',
    `${statuses.filter((s) => s === 200).length}×200, then ${statuses[limit]}, ${show(last)}`);
  const other = await challenge({ 'x-forwarded-for': `198.51.100.250` === ip ? '198.51.100.251' : '198.51.100.250' });
  check('rate limit is per IP (another forwarded address still gets one)', other.status === 200, String(other.status));

  // --- audit -----------------------------------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 800)); // audit writes are fire-and-forget
  const rows = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, started), sql`${schema.auditLogs.path} like '/api/auth/%'`));
  const failed = rows.filter((a) => a.action === 'auth.login_failed');
  const reasons = new Set(failed.map((a) => String(a.detail?.reason)));
  check('failed captcha logins audited with reason (required/invalid/trail/expired), status 400, no user id',
    ['captcha_required', 'captcha_invalid', 'captcha_trail', 'captcha_expired'].every((x) => reasons.has(x))
    && failed.filter((a) => String(a.detail?.reason).startsWith('captcha_')).every((a) => a.status === 400 && a.userId === null),
    [...reasons].join(','));
  check('bad password after a good captcha still audited as bad_password', reasons.has('bad_password'));
  check('verify endpoint not audited', rows.every((a) => a.path !== '/api/auth/captcha/verify'));
  const dump = JSON.stringify(rows);
  check('no password, captcha id or answer in the audit rows', !dump.includes(PASS) && !dump.includes('wrong-password-123') && !dump.includes(c.id) && !dump.includes('"trail"') && !dump.includes('"x":'));
  check('successful logins audited', rows.some((a) => a.action === 'auth.login' && a.status === 200));
}

await redis.quit();
await sqlClient.end();
const failedN = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failedN}/${results.length} passed`);
process.exit(failedN ? 1 : 0);
