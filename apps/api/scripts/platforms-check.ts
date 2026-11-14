/**
 * Official platform integrations (平台接入) test against the real API + DB + Redis (no mocks).
 * - App credentials: admin-only, client secret write-only (never in responses, DB plaintext or audit).
 * - OAuth connect: authorization URLs (client id, redirect, scopes, PKCE, state) for YouTube, Instagram, TikTok.
 * - Callback: forged / reused / expired / other-browser / wrong-platform state refused; provider error;
 *   an invalid code against Google's REAL token endpoint (dummy client id) returns a mapped error.
 * - Connections: tokens never in responses, events, task rows/logs, account logs or audit; RBAC isolation; disconnect.
 * - social-account-check: manual-only without a connection; with placeholder connections holding fake tokens
 *   the REAL YouTube / Instagram Graph / TikTok endpoints reject them → connection expired, account logged_out;
 *   an expired token is refreshed at Google's REAL token endpoint (fails with the dummy client) → expired.
 * - publish availability reasons (service layer) with placeholder media rows.
 * Real network calls go only to Google / Meta / TikTok with dummy or fake values; Meta/TikTok token
 * exchanges are NOT called (they would need real app ids).
 * Creates two temporary users and removes everything afterwards.
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/platforms-check.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { Redis } from 'ioredis';
import WebSocket from 'ws';
import { config } from '../src/config.js';
import { db, schema, sqlClient } from '../src/db/index.js';
import { sealSecret } from '../src/lib/secret-box.js';
import { apiPublishUnavailableReason } from '../src/modules/platforms/service.js';

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, {
    method, redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 / redirect */ }
  return { status: res.status, body: json as T, text, headers: res.headers };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 400)); }
}
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');

/** Starts a connect and returns state + binding cookie ("name=value"). */
async function connect(token: string, platform: string, socialAccountId: string) {
  const r = await http('POST', `/api/platforms/${platform}/connect`, token, { socialAccountId });
  const setCookie = r.headers.get('set-cookie') ?? '';
  const url = r.body?.url ? new URL(r.body.url) : null;
  return { r, url, state: url?.searchParams.get('state') ?? '', cookie: setCookie.split(';')[0] ?? '', setCookie };
}
async function callback(platform: string, query: Record<string, string>, cookie?: string) {
  const r = await http('GET', `/api/platforms/${platform}/callback?${new URLSearchParams(query)}`, null, undefined, cookie ? { cookie } : {});
  const loc = r.headers.get('location') ?? '';
  const u = loc ? new URL(loc) : null;
  return { status: r.status, loc, result: u?.searchParams.get('result'), code: u?.searchParams.get('code'), account: u?.searchParams.get('account') };
}
async function runCheck(token: string, accountId: string) {
  const r = await http('POST', `/api/platforms/accounts/${accountId}/check`, token);
  if (r.status !== 202) return { r, task: null as any };
  const task = await waitFor('check task', async () => {
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, r.body.taskId));
    return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
  });
  return { r, task };
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const h = (s: string) => `pc_${tag}_${s}`;
const SECRET = `cs-${randomBytes(12).toString('hex')}`;
const FAKE = { ya: `ya29.fake-${randomBytes(16).toString('hex')}`, yaR: `1//fake-${randomBytes(16).toString('hex')}`, yb: `ya29.fake-${randomBytes(16).toString('hex')}`, ybR: `1//fake-${randomBytes(16).toString('hex')}`, ig: `IGfake${randomBytes(16).toString('hex')}`, tt: `act.fake${randomBytes(16).toString('hex')}`, ttR: `rft.fake${randomBytes(16).toString('hex')}` };
const SECRETS = [SECRET, ...Object.values(FAKE)];
const leaks = (s: string) => SECRETS.filter((x) => s.includes(x));
const userIds: string[] = [];
const mediaIds: string[] = [];
const [appsBefore] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
const redis = new Redis(config.REDIS_URL);
// Audit/task timestamps come from Postgres (defaultNow), whose clock may differ from this host's
// (Docker Desktop VM drift): take the start time from the database.
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const events: string[] = [];
let ws: WebSocket | null = null;

try {
  // ---------------------------------------------------------------- setup
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `pc${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`pca${tag}`, pw);
  const B = await login(`pcb${tag}`, pw);
  const mk = async (token: string, platform: string, handle: string) => (await http('POST', '/api/social/accounts', token, { platform, handle })).body.account.id as string;
  const ya = await mk(A, 'youtube', h('ya'));
  const ia = await mk(A, 'instagram', h('ia'));
  const ta = await mk(A, 'tiktok', h('ta'));
  const tb = await mk(A, 'tiktok', h('tb'));
  const yb = await mk(B, 'youtube', h('yb'));
  ws = new WebSocket(`${API.replace('http', 'ws')}/api/events`);
  ws.on('message', (m) => events.push(m.toString()));
  await new Promise<void>((res) => ws!.on('open', () => { ws!.send(JSON.stringify({ type: 'auth', token: T })); res(); }));

  // ---------------------------------------------------------------- credentials
  await db.delete(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
  let r = await http('GET', '/api/platforms', A);
  check('GET /api/platforms: 3 adapters, none configured, capabilities declared',
    r.status === 200 && r.body.platforms.length === 3 && r.body.platforms.every((p: any) => p.configured === false && typeof p.capabilities.publishVideo === 'boolean'), r.text.slice(0, 300));
  check('platforms list for users carries no client id', !/clientId/.test(r.text));
  let c = await connect(A, 'youtube', ya);
  check('connect without credentials → 400 platform.not_configured', c.r.status === 400 && c.r.body.code === 'platform.not_configured', c.r.text);
  r = await http('GET', '/api/settings/platforms', A);
  check('user: GET platform credentials → 403', r.status === 403);
  r = await http('PUT', '/api/settings/platforms/youtube', A, { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET });
  check('user: PUT platform credentials → 403', r.status === 403);
  r = await http('PUT', '/api/settings/platforms/instagram', T, { clientSecret: SECRET });
  check('admin: secret without client id → 400 platform.client_id_required', r.status === 400 && r.body.code === 'platform.client_id_required', r.text);
  r = await http('PUT', '/api/settings/platforms/youtube', T, { clientId: 'dummy', clientSecret: 'short' });
  check('admin: invalid secret (too short) → 400', r.status === 400);
  r = await http('PUT', '/api/settings/platforms/myspace', T, { clientId: 'abcdef' });
  check('admin: unknown platform → 400', r.status === 400);
  const GID = `000000000000-${tag}dummy.apps.googleusercontent.com`;
  r = await http('PUT', '/api/settings/platforms/youtube', T, { clientId: GID, clientSecret: SECRET });
  check('admin: save YouTube credentials, secret write-only',
    r.status === 200 && r.body.app.clientSecretSet === true && r.body.app.configured === true && !leaks(r.text).length && r.body.app.redirectUri === `${config.WEB_ORIGIN}/api/platforms/youtube/callback`, r.text);
  r = await http('PUT', '/api/settings/platforms/instagram', T, { clientId: `9${Date.now()}`, clientSecret: SECRET });
  check('admin: save Instagram credentials', r.status === 200 && r.body.app.configured);
  r = await http('PUT', '/api/settings/platforms/tiktok', T, { clientId: `aw${tag}dummykey`, clientSecret: SECRET });
  check('admin: save TikTok credentials', r.status === 200 && r.body.app.configured);
  r = await http('GET', '/api/settings/platforms', T);
  check('admin GET credentials: secret never returned', r.status === 200 && r.body.apps.length === 3 && !leaks(r.text).length && r.body.apps.every((a: any) => a.clientSecretSet));
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
  check('DB stores the client secret sealed (no plaintext)', !!row && !JSON.stringify(row.value).includes(SECRET) && JSON.stringify(row.value).includes('v1:'));
  r = await http('GET', '/api/platforms', A);
  let tt = r.body.platforms.find((p: any) => p.id === 'tiktok');
  check('TikTok without direct-post audit: draftOnly, scopes without video.publish', tt.capabilities.draftOnly === true && !tt.scopes.includes('video.publish'));
  check('TikTok: comments declared unsupported; YouTube/Instagram supported',
    !tt.capabilities.commentsRead && r.body.platforms.filter((p: any) => p.id !== 'tiktok').every((p: any) => p.capabilities.commentsRead && p.capabilities.commentsReply));
  r = await http('PUT', '/api/settings/platforms/tiktok', T, { options: { directPost: true } });
  tt = (await http('GET', '/api/platforms', A)).body.platforms.find((p: any) => p.id === 'tiktok');
  check('TikTok directPost option: not draft-only, requests video.publish', r.status === 200 && tt.capabilities.draftOnly === false && tt.scopes.includes('video.publish'));
  r = await http('PUT', '/api/settings/platforms/tiktok', T, { options: { directPost: false } });
  r = await http('PUT', '/api/settings/platforms/tiktok', T, { clientSecret: null });
  check('admin: clearing the secret makes the platform unconfigured', r.status === 200 && r.body.app.configured === false && r.body.app.clientSecretSet === false);
  await http('PUT', '/api/settings/platforms/tiktok', T, { clientSecret: SECRET });

  // ---------------------------------------------------------------- connect URLs
  c = await connect(A, 'youtube', ya);
  const q = c.url?.searchParams;
  check('YouTube connect → Google authorization URL', c.r.status === 200 && c.url?.origin === 'https://accounts.google.com' && c.url.pathname === '/o/oauth2/v2/auth', c.r.text);
  check('… client_id, redirect_uri, response_type=code, offline access',
    q?.get('client_id') === GID && q?.get('redirect_uri') === `${config.WEB_ORIGIN}/api/platforms/youtube/callback` && q?.get('response_type') === 'code' && q?.get('access_type') === 'offline');
  check('… scopes youtube.upload, youtube.force-ssl, youtube.readonly',
    ['youtube.upload', 'youtube.force-ssl', 'youtube.readonly'].every((s) => q?.get('scope')?.split(' ').includes(`https://www.googleapis.com/auth/${s}`)));
  check('… PKCE S256 challenge (43 chars) and a 43-char random state',
    q?.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(q?.get('code_challenge') ?? '') && /^[A-Za-z0-9_-]{43}$/.test(c.state));
  check('… binding cookie: HttpOnly, SameSite=Lax, Path=/api/platforms, 10 min', /HttpOnly/.test(c.setCookie) && /SameSite=Lax/.test(c.setCookie) && /Path=\/api\/platforms/.test(c.setCookie) && /Max-Age=600/.test(c.setCookie));
  const stored = await redis.get(`oauth:state:${sha(c.state)}`);
  const ttl = await redis.ttl(`oauth:state:${sha(c.state)}`);
  check('state stored server-side by hash only, verifier sealed, TTL ≤ 600 s',
    !!stored && !(await redis.keys('oauth:state:*')).some((k) => k.includes(c.state)) && JSON.parse(stored).verifierEnc.startsWith('v1:') && JSON.parse(stored).userId === uA && ttl > 0 && ttl <= 600);
  const ci = await connect(A, 'instagram', ia);
  check('Instagram connect → Instagram Login URL with business scopes (comma-separated), no PKCE',
    ci.url?.origin === 'https://www.instagram.com' && ci.url.pathname === '/oauth/authorize' &&
    ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments'].every((s) => ci.url!.searchParams.get('scope')!.split(',').includes(s)) &&
    !ci.url.searchParams.has('code_challenge') && ci.url.searchParams.get('redirect_uri') === `${config.WEB_ORIGIN}/api/platforms/instagram/callback`, ci.r.text);
  const ct = await connect(A, 'tiktok', ta);
  check('TikTok connect → Login Kit URL with client_key and user.info.basic,video.upload',
    ct.url?.origin === 'https://www.tiktok.com' && ct.url.searchParams.get('client_key') === `aw${tag}dummykey` && ct.url.searchParams.get('scope') === 'user.info.basic,video.upload', ct.r.text);
  r = (await connect(A, 'youtube', yb)).r;
  check('user A: connect B\'s account → 404', r.status === 404 && r.body.code === 'social.not_found', r.text);
  r = (await connect(A, 'youtube', ia)).r;
  check('connect an Instagram account via /youtube → 400 platform.account_platform_mismatch', r.status === 400 && r.body.code === 'platform.account_platform_mismatch', r.text);
  r = (await connect(T, 'youtube', yb)).r;
  check('admin: connect any user\'s account → 200', r.status === 200 && !!r.body.url);
  r = await http('POST', '/api/platforms/youtube/connect', null, { socialAccountId: ya });
  check('connect without login → 401', r.status === 401);

  // ---------------------------------------------------------------- callback: state handling
  let cb = await callback('youtube', { state: randomBytes(32).toString('base64url'), code: 'x' }, c.cookie);
  check('callback with a forged state → redirect with platform.oauth_state_invalid',
    cb.status === 302 && cb.loc.startsWith(`${config.WEB_ORIGIN}/social?`) && cb.result === 'error' && cb.code === 'platform.oauth_state_invalid', cb.loc);
  cb = await callback('youtube', { code: 'x' });
  check('callback without state → platform.oauth_state_invalid', cb.code === 'platform.oauth_state_invalid', cb.loc);
  // Other browser / other user: B starts their own flow and comes back with A's state.
  const cB = await connect(T, 'youtube', yb);
  cb = await callback('youtube', { state: c.state, code: 'x' }, cB.cookie);
  check('callback with A\'s state from another browser/user (other cookie) → platform.oauth_state_mismatch', cb.code === 'platform.oauth_state_mismatch', cb.loc);
  cb = await callback('youtube', { state: c.state, code: 'x' }, c.cookie);
  check('the same state again (even with the right cookie) → platform.oauth_state_invalid (single use)', cb.code === 'platform.oauth_state_invalid', cb.loc);
  const forgedCookie = `${cB.cookie.split('=')[0]}=${randomBytes(24).toString('base64url')}`;
  cb = await callback('youtube', { state: cB.state, code: 'x' }, forgedCookie);
  check('callback with a forged binding cookie → platform.oauth_state_mismatch', cb.code === 'platform.oauth_state_mismatch', cb.loc);
  let c2 = await connect(A, 'youtube', ya);
  await redis.expire(`oauth:state:${sha(c2.state)}`, 1);
  await new Promise((res) => setTimeout(res, 1600));
  cb = await callback('youtube', { state: c2.state, code: 'x' }, c2.cookie);
  check('callback after the state expired → platform.oauth_state_invalid', cb.code === 'platform.oauth_state_invalid', cb.loc);
  c2 = await connect(A, 'youtube', ya);
  cb = await callback('instagram', { state: c2.state, code: 'x' }, c2.cookie);
  check('YouTube state used on the Instagram callback → platform.oauth_state_invalid', cb.code === 'platform.oauth_state_invalid', cb.loc);
  c2 = await connect(A, 'youtube', ya);
  cb = await callback('youtube', { state: c2.state, error: 'access_denied' }, c2.cookie);
  check('provider error=access_denied → platform.oauth_denied (account id returned to the UI)', cb.code === 'platform.oauth_denied' && cb.account === ya, cb.loc);
  c2 = await connect(A, 'youtube', ya);
  cb = await callback('youtube', { state: c2.state, code: `4/0Afake${randomBytes(20).toString('hex')}` }, c2.cookie);
  check('invalid code at Google\'s real token endpoint → mapped error (invalid client / invalid grant)',
    cb.result === 'error' && (cb.code === 'platform.oauth_invalid_client' || cb.code === 'platform.oauth_invalid_grant'), cb.loc);
  console.log(`  (Google answered → ${cb.code})`);
  const [noConn] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, ya));
  check('no connection stored after failed callbacks', !noConn);

  // ---------------------------------------------------------------- placeholder connections (fake tokens)
  const conn = (accountId: string, userId: string, platform: string, access: string, refresh: string | null, expiresAt: Date, ext: string) => ({
    socialAccountId: accountId, userId, platform, externalAccountId: ext, externalAccountName: `Fake ${platform}`, scopes: ['fake.scope'],
    accessTokenEnc: sealSecret(access), refreshTokenEnc: refresh ? sealSecret(refresh) : null, expiresAt, status: 'connected' as const, connectedBy: userId,
  });
  await db.insert(schema.platformConnections).values([
    conn(ya, uA, 'youtube', FAKE.ya, FAKE.yaR, new Date(Date.now() + 3600_000), 'UCfake'),
    conn(yb, uB, 'youtube', FAKE.yb, FAKE.ybR, new Date(Date.now() - 60_000), 'UCfakeB'),
    conn(ia, uA, 'instagram', FAKE.ig, null, new Date(Date.now() + 30 * 86400_000), '17841400000000000'),
    conn(tb, uA, 'tiktok', FAKE.tt, FAKE.ttR, new Date(Date.now() + 3600_000), '-000fakeopenid'),
  ]);
  r = await http('GET', '/api/platforms/connections', A);
  check('user A: lists only own connections (3), no token fields or ciphertext',
    r.status === 200 && r.body.connections.length === 3 && !r.body.connections.some((x: any) => x.socialAccountId === yb) &&
    !/accessToken|refreshToken|v1:/.test(r.text) && !leaks(r.text).length, r.text.slice(0, 300));
  r = await http('GET', `/api/platforms/connections?accountIds=${ya},${yb}`, B);
  check('user B: asking for A\'s account ids returns only B\'s', r.status === 200 && r.body.connections.length === 1 && r.body.connections[0].socialAccountId === yb);
  r = await http('GET', `/api/platforms/connections?accountIds=${ya},${yb}`, T);
  check('admin: sees both', r.status === 200 && r.body.connections.length === 2);
  r = await http('GET', '/api/platforms/connections?accountIds=nope', A);
  check('connections filter validates ids → 400', r.status === 400);
  r = await http('DELETE', `/api/platforms/accounts/${ya}/connection`, B);
  check('user B: disconnect A\'s account → 404', r.status === 404);
  r = await http('POST', `/api/platforms/accounts/${ya}/check`, B);
  check('user B: check A\'s account → 404', r.status === 404);

  // ---------------------------------------------------------------- account checks (task centre)
  let k = await runCheck(A, ta);
  const [taRow] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, ta));
  check('check without connection: task success, outcome manual_only, account unchanged',
    k.r.status === 202 && k.task?.status === 'success' && (k.task.result as any)?.outcome === 'manual_only' && taRow!.loginStatus === 'unknown' && taRow!.lastCheckedAt === null, JSON.stringify(k.task));
  k = await runCheck(A, ya);
  let [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, ya));
  let [pc] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, ya));
  check('YouTube check with a fake token (real API rejects it) → authorisation_invalid, connection expired, account logged_out',
    k.task?.status === 'success' && (k.task.result as any)?.outcome === 'authorisation_invalid' && (k.task.result as any)?.code === 'platform.auth_expired' &&
    pc?.status === 'expired' && pc.lastErrorCode === 'platform.auth_expired' && acc?.loginStatus === 'logged_out' && !!acc.lastError && !!acc.lastCheckedAt,
    JSON.stringify({ task: k.task?.result, err: k.task?.error, pc: pc?.status, code: pc?.lastErrorCode, acc: acc?.loginStatus }));
  const logs = (await http('GET', `/api/social/accounts/${ya}/logs`, A)).body.logs as any[];
  check('account log: checked + status change written', logs.some((l) => l.action === 'checked') && logs.some((l) => l.action === 'status' && l.field === 'loginStatus' && l.toValue === 'logged_out'));
  k = await runCheck(A, ya);
  check('a second check on an expired connection does not call the platform (auth_expired at once)', k.task?.status === 'success' && (k.task.result as any)?.code === 'platform.auth_expired');
  k = await runCheck(T, yb);
  [pc] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, yb));
  const ybLogs = await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, k.task?.id));
  check('expired token: refresh at Google\'s real token endpoint fails (dummy client) → connection expired, check result auth_expired',
    k.task?.status === 'success' && (k.task.result as any)?.code === 'platform.auth_expired' && pc?.status === 'expired' && /invalid|client|grant/i.test(pc.lastError ?? ''),
    JSON.stringify({ task: k.task?.result, err: k.task?.error, pc: pc?.lastError }));
  check('refresh failure is not logged with the refresh token', !ybLogs.some((l) => leaks(JSON.stringify(l)).length));
  k = await runCheck(A, ia);
  [pc] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, ia));
  check('Instagram check with a fake token (real Graph API, OAuthException 190) → auth_expired, connection expired',
    k.task?.status === 'success' && (k.task.result as any)?.code === 'platform.auth_expired' && pc?.status === 'expired', JSON.stringify({ r: k.task?.result, e: k.task?.error, pc: pc?.lastError }));
  k = await runCheck(A, tb);
  [pc] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, tb));
  check('TikTok check with a fake token (real API, access_token_invalid) → auth_expired, connection expired',
    k.task?.status === 'success' && (k.task.result as any)?.code === 'platform.auth_expired' && pc?.status === 'expired', JSON.stringify({ r: k.task?.result, e: k.task?.error, pc: pc?.lastError }));

  // ---------------------------------------------------------------- publish availability (service layer)
  const media = await db.insert(schema.mediaAssets).values([
    { ownerType: 'user' as const, ownerId: uA, name: `${h('jpg')}`, fileName: 'a.jpg', storage: 'local' as const, fileKey: `users/${uA}/images/${tag}a.jpg`, fileType: 'image' as const, mimeType: 'image/jpeg', fileSize: 10, checksum: 'x', status: 'ready' as const },
    { ownerType: 'user' as const, ownerId: uA, name: `${h('png')}`, fileName: 'b.png', storage: 'local' as const, fileKey: `users/${uA}/images/${tag}b.png`, fileType: 'image' as const, mimeType: 'image/png', fileSize: 10, checksum: 'x', status: 'ready' as const },
    { ownerType: 'user' as const, ownerId: uA, name: `${h('mp4')}`, fileName: 'c.mp4', storage: 'local' as const, fileKey: `users/${uA}/videos/${tag}c.mp4`, fileType: 'video' as const, mimeType: 'video/mp4', fileSize: 10, checksum: 'x', status: 'ready' as const },
  ]).returning();
  mediaIds.push(...media.map((m) => m.id));
  const [jpg, png, mp4] = media as [typeof media[0], typeof media[0], typeof media[0]];
  await db.update(schema.platformConnections).set({ status: 'connected' }).where(inArray(schema.platformConnections.socialAccountId, [ia, tb, ya]));
  const accRows = await db.select().from(schema.socialAccounts).where(inArray(schema.socialAccounts.id, [ya, ia, ta, tb]));
  const byId = (id: string) => accRows.find((x) => x.id === id)!;
  const reason = async (id: string, m: typeof media) => (await apiPublishUnavailableReason(byId(id), { media: m }))?.code ?? null;
  check('publish reason: account without connection → platform.not_connected', (await reason(ta, [mp4])) === 'platform.not_connected');
  check('publish reason: YouTube image → platform.media_unsupported', (await reason(ya, [jpg])) === 'platform.media_unsupported');
  check('publish reason: YouTube video → available', (await reason(ya, [mp4])) === null);
  check('publish reason: Instagram PNG → platform.media_unsupported (JPEG only)', (await reason(ia, [png])) === 'platform.media_unsupported');
  check('publish reason: Instagram JPEG on local storage → platform.media_url_unavailable', (await reason(ia, [jpg])) === 'platform.media_url_unavailable');
  check('publish reason: TikTok image → platform.media_unsupported; video on local storage → available (FILE_UPLOAD)',
    (await reason(tb, [jpg])) === 'platform.media_unsupported' && (await reason(tb, [mp4])) === null);
  await db.update(schema.platformConnections).set({ status: 'expired' }).where(eq(schema.platformConnections.socialAccountId, ya));
  check('publish reason: expired connection → platform.auth_expired', (await reason(ya, [mp4])) === 'platform.auth_expired');

  // ---------------------------------------------------------------- disconnect
  r = await http('DELETE', `/api/platforms/accounts/${ya}/connection`, A);
  const [gone] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, ya));
  check('owner: disconnect → tokens deleted; Google revoke attempted (fake token → revoked:false)', r.status === 200 && r.body.revoked === false && !gone, r.text);
  const dLogs = (await http('GET', `/api/social/accounts/${ya}/logs`, A)).body.logs as any[];
  check('account log: disconnect recorded', dLogs.some((l) => l.action === 'disconnect'));
  r = await http('DELETE', `/api/platforms/accounts/${ya}/connection`, A);
  check('disconnect again → 404 platform.not_connected', r.status === 404 && r.body.code === 'platform.not_connected');
  r = await http('DELETE', `/api/platforms/accounts/${ia}/connection`, A);
  check('Instagram disconnect: no revoke endpoint → revoked:null, tokens deleted', r.status === 200 && r.body.revoked === null);
  r = await http('DELETE', `/api/platforms/accounts/${yb}/connection`, T);
  check('admin: disconnect another user\'s account', r.status === 200);
  await http('DELETE', `/api/social/accounts/${tb}`, A);
  const [cascaded] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, tb));
  check('deleting the social account deletes its connection (cascade)', !cascaded);

  // ---------------------------------------------------------------- no secrets anywhere
  await new Promise((res) => setTimeout(res, 800));
  const taskRows = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'social-account-check'), gte(schema.tasks.createdAt, t0)));
  const taskLogRows = taskRows.length ? await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, taskRows.map((t) => t.id))) : [];
  const accLogs = await db.select().from(schema.socialAccountLogs).where(inArray(schema.socialAccountLogs.accountId, [ya, ia, ta, yb]));
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  check('no token or client secret in task rows / task logs / account logs',
    !leaks(JSON.stringify(taskRows)).length && !leaks(JSON.stringify(taskLogRows)).length && !leaks(JSON.stringify(accLogs)).length);
  check('task payloads only carry the account id', taskRows.every((t) => JSON.stringify(Object.keys(t.payload ?? {})) === '["socialAccountId"]'));
  check(`WebSocket events (${events.length}) never contain tokens or the secret`, events.length > 0 && !events.some((e) => leaks(e).length));

  // ---------------------------------------------------------------- audit
  const acts = new Set(audits.map((a) => a.action));
  const want = ['platform.credentials_update', 'platform.connect_start', 'platform.connect_failed', 'platform.account_check', 'platform.disconnect'];
  check('audit actions recorded', want.every((x) => acts.has(x)), want.filter((x) => !acts.has(x)).join(','));
  check('audit never stores the secret or tokens', !leaks(JSON.stringify(audits)).length);
  check('audit: credentials update records only whether the secret was set',
    audits.some((a) => a.action === 'platform.credentials_update' && (a.detail as any)?.confidential === 'set' && a.target === 'youtube'));
  check('audit: failed callback recorded with the user, account and error code',
    audits.some((a) => a.action === 'platform.connect_failed' && a.userId === uA && a.targetId === ya && (a.detail as any)?.code === 'platform.oauth_denied'));
  check('audit: callback with a forged state recorded anonymously', audits.some((a) => a.action === 'platform.connect_failed' && a.userId === null && (a.detail as any)?.code === 'platform.oauth_state_invalid'));
  check('audit: disconnect target is the account', audits.some((a) => a.action === 'platform.disconnect' && a.target === `youtube @${h('ya')}`));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  ws?.close();
  if (mediaIds.length) await db.delete(schema.mediaAssets).where(inArray(schema.mediaAssets.id, mediaIds));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(schema.socialAccounts).where(like(schema.socialAccounts.handle, `pc_${tag}_%`));
  if (appsBefore) await db.insert(schema.settings).values({ key: 'platform.apps', value: appsBefore.value }).onConflictDoUpdate({ target: schema.settings.key, set: { value: appsBefore.value } });
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
  for (const key of await redis.keys('oauth:state:*')) {
    const v = await redis.get(key);
    if (v && userIds.some((u) => v.includes(u))) await redis.del(key);
  }
  await redis.quit();
  const left = await db.select().from(schema.socialAccounts).where(like(schema.socialAccounts.handle, `pc_${tag}_%`));
  const leftConn = userIds.length ? await db.select().from(schema.platformConnections).where(inArray(schema.platformConnections.userId, userIds)) : [];
  check('cleanup: test accounts, connections, users removed', left.length === 0 && leftConn.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
