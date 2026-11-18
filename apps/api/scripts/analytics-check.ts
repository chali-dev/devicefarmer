/**
 * Account analytics (账号分析) test against the real API + DB + Redis and the real platform APIs (no mocks).
 * - Manual entry was removed (owner decision 2026-11-18): POST …/stats and DELETE …/stats/:day are 404. Daily rows
 *   (legacy `manual` source) are seeded through the real upsert (upsertDay) → exact per-day gains, per-day sums, totals,
 *   per-account sums, 7/30/1-day ranges, baseline before the window, idempotent upserts.
 * - RBAC: users only see their own accounts (others 404), admins all + owner filter; dashboard widget per role.
 * - "Refresh now" through the task centre with placeholder connections holding fake tokens: the REAL
 *   Instagram Graph / YouTube Data APIs reject them → task failed with platform.auth_expired, the account's
 *   status untouched, no stats written. TikTok connection without user.info.stats → coded, non-fatal
 *   analytics.scope_missing (no platform call). Unsupported platform / no connection / refresh in progress refused.
 * - Daily scheduler: one task per connected account and UTC day (key account-stats:<id>:<day>), idempotent,
 *   expired connections skipped, spread over the day.
 * - Likes/comments in per-account sums and the dashboard widget; days without data are null (chart gaps).
 * - Own posts (帖子): the Instagram collector on Graph responses in the documented shape (no real IG account here:
 *   paging via cursors.after, page cap), the real upsert (first_seen kept, counters updated), list/sort/limit, publish
 *   link, RBAC; the fake-token refresh writes no posts.
 * - No token in responses, task rows/logs, audit; audit entries recorded.
 * Creates two temporary users and removes everything afterwards.
 * Usage (from apps/api, API running with ENABLED_PLATFORMS=all): ENABLED_PLATFORMS=all E2E_API=http://127.0.0.1:3102 npx tsx --env-file=../../.env scripts/analytics-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { sealSecret } from '../src/lib/secret-box.js';
import { POST_PAGES, scheduleDailyAccountStats, upsertAccountPosts, upsertDay } from '../src/modules/analytics/analytics.js';
import { collectOwnPosts } from '../src/modules/platforms/instagram.js';
import { createTask } from '../src/modules/tasks/core.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 400)); }
}
const finished = (id: string) => waitFor(`task ${id}`, async () => {
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
});
const day = (ago: number) => new Date(Date.now() - ago * 86400_000).toISOString().slice(0, 10);

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const h = (s: string) => `an_${tag}_${s}`;
const SECRET = `cs-${randomBytes(12).toString('hex')}`;
const FAKE = { ig: `IGfake${randomBytes(16).toString('hex')}`, yt: `ya29.fake-${randomBytes(16).toString('hex')}`, ytR: `1//fake-${randomBytes(16).toString('hex')}`, tt: `act.fake${randomBytes(16).toString('hex')}`, ttR: `rft.fake${randomBytes(16).toString('hex')}` };
const SECRETS = [SECRET, ...Object.values(FAKE)];
const leaks = (s: string) => SECRETS.filter((x) => s.includes(x));
const userIds: string[] = [];
const [appsBefore] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const responses: string[] = [];
const taskIds: string[] = [];

try {
  // ---------------------------------------------------------------- setup
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `an${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`ana${tag}`, pw);
  const B = await login(`anb${tag}`, pw);
  const mk = async (token: string, platform: string, handle: string) => (await http('POST', '/api/social/accounts', token, { platform, handle })).body.account.id as string;
  const igM = await mk(A, 'instagram', h('igm'));
  const fb = await mk(A, 'facebook', h('fb'));
  const igA = await mk(A, 'instagram', h('iga'));
  const ytA = await mk(A, 'youtube', h('yta'));
  const ttA = await mk(A, 'tiktok', h('tta'));
  const igB = await mk(B, 'instagram', h('igb'));
  check('setup: 6 social accounts created', [igM, fb, igA, ytA, ttA, igB].every(Boolean));

  // ---------------------------------------------------------------- manual entry removed; rows seeded through upsertDay
  const gone = await Promise.all([
    http('POST', `/api/analytics/accounts/${igM}/stats`, A, { day: day(0), followers: 1 }),
    http('DELETE', `/api/analytics/accounts/${igM}/stats/${day(0)}`, A),
    http('POST', `/api/analytics/accounts/${igM}/stats`, T, { followers: 1 }),
  ]);
  check('manual stats endpoints removed: POST …/stats and DELETE …/stats/:day → 404 (user and admin)', gone.every((x) => x.status === 404), gone.map((x) => x.status).join(','));
  const seed: [string, string, Record<string, number>][] = [
    [igM, day(9), { followers: 1000 }],
    [igM, day(6), { followers: 1010, views: 50, shares: 3 }],
    [igM, day(3), { followers: 1040, views: 70, shares: 5, likes: 9, comments: 2 }],
    [igM, day(0), { followers: 1100, views: 100, shares: 7 }],
    [fb, day(7), { followers: 200 }],
    [fb, day(1), { followers: 230, views: 10 }],
    [igB, day(2), { followers: 500 }],
    [igB, day(0), { followers: 520, shares: 1 }],
  ];
  for (const [id, d, v] of seed) await upsertDay(db, id, d, v, 'manual');
  await upsertDay(db, igM, day(0), { followers: 1100, views: 100, shares: 7 }, 'manual');
  const rows0 = await db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, igM));
  check('seeded (legacy manual rows): same day again → upsert, still one row per day (4 rows)', rows0.length === 4 && rows0.every((x) => x.source === 'manual'));
  let r: { status: number; body: any; text: string };

  // ---------------------------------------------------------------- aggregates (exact)
  r = await http('GET', '/api/analytics/summary', A);
  responses.push(r.text);
  const s = r.body;
  const dayOf = (d: string) => s.days.find((x: any) => x.day === d);
  check('summary default range: 7 days, today last', r.status === 200 && s.days.length === 7 && s.to === day(0) && s.from === day(6), r.text.slice(0, 200));
  check('summary totals (7 d): followers gained 130 (baseline before the window), views 230, shares 15, likes 9, comments 2',
    s.totals.followersGained === 130 && s.totals.views === 230 && s.totals.shares === 15 && s.totals.likes === 9 && s.totals.comments === 2, JSON.stringify(s.totals));
  check('summary totals: 5 own accounts, 2 with data, current followers 1330', s.totals.accounts === 5 && s.totals.withData === 2 && s.totals.followers === 1330, JSON.stringify(s.totals));
  check('per-day sums: d6 +10/50/3, d3 +30/70/5, d1 +30/10/–, d0 +60/100/7, d5 empty',
    dayOf(day(6)).followersGained === 10 && dayOf(day(6)).views === 50 && dayOf(day(6)).shares === 3 &&
    dayOf(day(3)).followersGained === 30 && dayOf(day(3)).views === 70 && dayOf(day(3)).shares === 5 &&
    dayOf(day(1)).followersGained === 30 && dayOf(day(1)).views === 10 && dayOf(day(1)).shares === null &&
    dayOf(day(0)).followersGained === 60 && dayOf(day(0)).views === 100 && dayOf(day(0)).shares === 7 &&
    dayOf(day(5)).followersGained === null && dayOf(day(5)).views === null, JSON.stringify(s.days));
  const accOf = (id: string) => s.accounts.find((a: any) => a.id === id);
  check('per-account sums: instagram +100 / views 220 / shares 15, facebook +30 / views 10',
    accOf(igM)?.range.followersGained === 100 && accOf(igM)?.range.views === 220 && accOf(igM)?.range.shares === 15 &&
    accOf(fb)?.range.followersGained === 30 && accOf(fb)?.range.views === 10 && accOf(igM)?.latest.followers === 1100, JSON.stringify(accOf(igM)));
  check('per-account sums carry likes 9 / comments 2 (account table columns); accounts without them stay null',
    accOf(igM)?.range.likes === 9 && accOf(igM)?.range.comments === 2 && accOf(fb)?.range.likes === null && accOf(fb)?.range.comments === null, JSON.stringify(accOf(fb)?.range));
  check('per-day sums: days without any data are null for every metric (gaps, not 0)',
    [day(5), day(4), day(2)].every((d) => ['followersGained', 'views', 'likes', 'shares', 'comments'].every((k) => dayOf(d)[k] === null)), JSON.stringify([dayOf(day(5)), dayOf(day(2))]));
  check('user summary lists only own accounts', !s.accounts.some((a: any) => a.id === igB) && s.accounts.length === 5);
  r = await http('GET', '/api/analytics/summary?days=30', A);
  check('30-day range: 30 days, same gains (first readings have no gain)', r.status === 200 && r.body.days.length === 30 && r.body.totals.followersGained === 130 && r.body.totals.views === 230, JSON.stringify(r.body.totals));
  r = await http('GET', '/api/analytics/summary?days=1', A);
  check('1-day range: today only, +60 / views 100', r.status === 200 && r.body.days.length === 1 && r.body.totals.followersGained === 60 && r.body.totals.views === 100, JSON.stringify(r.body.totals));
  r = await http('GET', '/api/analytics/summary?days=91', A);
  check('range > 90 days → 400', r.status === 400);
  r = await http('GET', '/api/analytics/summary?platform=facebook', A);
  check('platform filter', r.status === 200 && r.body.accounts.length === 1 && r.body.totals.followersGained === 30);
  r = await http('GET', `/api/analytics/accounts/${igM}?days=7`, A);
  responses.push(r.text);
  const ser = r.body;
  check('account series: 7 days incl. empty ones, gains per day, account state',
    r.status === 200 && ser.days.length === 7 && ser.days[0].day === day(6) && ser.days[0].followersGained === 10 && ser.days[0].followers === 1010 &&
    ser.days[1].source === null && ser.days[6].followersGained === 60 && ser.days[6].source === 'manual' && ser.account.id === igM && ser.account.connection === null && ser.apiStats === true,
    JSON.stringify(ser).slice(0, 400));

  // ---------------------------------------------------------------- RBAC
  r = await http('GET', '/api/analytics/summary', B);
  check('user B: summary = own account only (+20, shares 1)', r.status === 200 && r.body.accounts.length === 1 && r.body.totals.followersGained === 20 && r.body.totals.shares === 1, JSON.stringify(r.body.totals));
  const denied = await Promise.all([
    http('GET', `/api/analytics/accounts/${igM}`, B), http('GET', `/api/analytics/accounts/${igM}/posts`, B), http('POST', `/api/analytics/accounts/${igA}/refresh`, B),
  ]);
  check('user B on A\'s account: series / posts / refresh → 404 social.not_found', denied.every((x) => x.status === 404 && x.body.code === 'social.not_found'), denied.map((x) => x.status).join(','));
  r = await http('GET', `/api/analytics/summary?ownerId=${uB}`, T);
  check('admin with owner filter = exactly that user\'s numbers', r.status === 200 && r.body.accounts.length === 1 && r.body.totals.followersGained === 20 && r.body.accounts[0].ownerName === `anb${tag}`);
  r = await http('GET', '/api/analytics/summary', T);
  check('admin without filter sees both users\' accounts', r.status === 200 && [igM, igB].every((id) => r.body.accounts.some((a: any) => a.id === id)));
  r = await http('GET', `/api/analytics/accounts/${igM}`, T);
  check('admin: any account\'s series', r.status === 200 && r.body.account.id === igM);
  r = await http('GET', `/api/analytics/summary?ownerId=${uB}`, A);
  check('user: owner filter is ignored (still own accounts only)', r.status === 200 && r.body.accounts.length === 5);

  // ---------------------------------------------------------------- dashboard widget
  const tz = 'UTC';
  r = await http('GET', `/api/dashboard?tz=${tz}`, A);
  const w = r.body.widgets?.analytics;
  check('dashboard widget (user A): +130 / views 230 / shares 15, top = the instagram account',
    r.status === 200 && w?.followersGained7d === 130 && w.views7d === 230 && w.shares7d === 15 && w.trend.length === 7 && w.top[0]?.id === igM && w.top[0].gain === 100, JSON.stringify(w));
  const wDay = (d: string) => w?.trend.find((x: any) => x.day === d);
  check('dashboard widget: likes7d 9 / comments7d 2, trend carries likes/comments per day, days without data are null (not 0)',
    w?.likes7d === 9 && w.comments7d === 2 && wDay(day(3))?.likes === 9 && wDay(day(3))?.comments === 2 && wDay(day(5))?.likes === null && wDay(day(5))?.followersGained === null
      && wDay(day(5))?.views === null, JSON.stringify(w?.trend));
  r = await http('GET', `/api/dashboard?tz=${tz}`, B);
  check('dashboard widget (user B): +20 only', r.body.widgets?.analytics?.followersGained7d === 20 && r.body.widgets.analytics.accounts === 1, JSON.stringify(r.body.widgets?.analytics));
  r = await http('GET', `/api/dashboard?tz=${tz}&userId=${uA}`, T);
  check('dashboard widget (admin viewing as A) = A\'s numbers', r.body.widgets?.analytics?.followersGained7d === 130);

  // ---------------------------------------------------------------- refresh via the task centre (real platform APIs, fake tokens)
  const apps: [string, Record<string, unknown>][] = [
    ['youtube', { clientId: `000000000000-${tag}dummy.apps.googleusercontent.com`, clientSecret: SECRET }],
    ['instagram', { clientId: `9${Date.now()}`, clientSecret: SECRET }],
    ['tiktok', { clientId: `aw${tag}dummykey`, clientSecret: SECRET }],
  ];
  for (const [p, b] of apps) await http('PUT', `/api/settings/platforms/${p}`, T, b);
  const conn = (accountId: string, platform: string, access: string, refresh: string | null, scopes: string[]) => ({
    socialAccountId: accountId, userId: uA, platform, externalAccountId: `fake-${platform}`, externalAccountName: `Fake ${platform}`, scopes,
    accessTokenEnc: sealSecret(access), refreshTokenEnc: refresh ? sealSecret(refresh) : null, expiresAt: new Date(Date.now() + 3 * 3600_000),
    status: 'connected' as const, connectedBy: uA,
  });
  await db.insert(schema.platformConnections).values([
    conn(igA, 'instagram', FAKE.ig, null, ['instagram_business_basic', 'instagram_business_manage_insights']),
    conn(ytA, 'youtube', FAKE.yt, FAKE.ytR, ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly']),
    // Made before user.info.stats was requested: the scope is missing.
    conn(ttA, 'tiktok', FAKE.tt, FAKE.ttR, ['user.info.basic', 'video.upload']),
  ]);
  r = await http('POST', `/api/analytics/accounts/${fb}/refresh`, A);
  check('refresh: platform without a stats API → 400 analytics.unsupported', r.status === 400 && r.body.code === 'analytics.unsupported', r.text);
  r = await http('POST', `/api/analytics/accounts/${igM}/refresh`, A);
  check('refresh: no connection → 409 analytics.not_connected', r.status === 409 && r.body.code === 'analytics.not_connected', r.text);

  const refresh = async (id: string) => {
    const x = await http('POST', `/api/analytics/accounts/${id}/refresh`, A);
    if (x.status !== 202) return { r: x, task: null as any };
    taskIds.push(x.body.taskId);
    return { r: x, task: await finished(x.body.taskId) };
  };
  const statsOf = async (id: string) => db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, id));
  let k = await refresh(igA);
  let [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, igA));
  let [pc] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.socialAccountId, igA));
  check('Instagram refresh with a fake token (real Graph API) → task failed, error code platform.auth_expired',
    k.r.status === 202 && k.task?.status === 'failed' && k.task.errorCode === 'platform.auth_expired', JSON.stringify({ s: k.task?.status, c: k.task?.errorCode, e: k.task?.error }));
  check('… account status untouched, no stats written, connection marked expired',
    acc?.loginStatus === 'unknown' && acc.lastError === null && (await statsOf(igA)).length === 0 && pc?.status === 'expired');
  k = await refresh(ytA);
  [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, ytA));
  check('YouTube refresh with a fake token (real Data API) → task failed, platform.auth_expired; account untouched, nothing written',
    k.task?.status === 'failed' && k.task.errorCode === 'platform.auth_expired' && acc?.loginStatus === 'unknown' && (await statsOf(ytA)).length === 0,
    JSON.stringify({ s: k.task?.status, c: k.task?.errorCode, e: k.task?.error }));
  k = await refresh(ttA);
  const ttRows = await statsOf(ttA);
  check('TikTok connection without user.info.stats → task success, coded non-fatal analytics.scope_missing',
    k.task?.status === 'success' && (k.task.result as any)?.outcome === 'partial' && (k.task.result as any)?.code === 'analytics.scope_missing' &&
    (k.task.result as any)?.missingScopes?.[0] === 'user.info.stats', JSON.stringify({ s: k.task?.status, r: k.task?.result, e: k.task?.error }));
  check('… today\'s row records the missing metrics (no values)', ttRows.length === 1 && ttRows[0]!.day === day(0) && ttRows[0]!.missing.includes('followers') && ttRows[0]!.followers === null);
  r = await http('GET', `/api/analytics/accounts/${ttA}`, A);
  check('… series shows missing metrics and the last run', r.body.account.missing.includes('followers') && r.body.account.lastRun?.status === 'success' && r.body.account.connection === 'connected');
  const tLogs = await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, k.task.id));
  check('… task log has the scope-missing warning', tLogs.some((l) => l.level === 'warn' && /scope missing/.test(l.message)));

  // ---------------------------------------------------------------- own posts (帖子)
  check('Instagram refresh with a fake token stored no posts', (await db.select().from(schema.socialAccountPosts).where(eq(schema.socialAccountPosts.socialAccountId, igA))).length === 0);
  r = await http('GET', `/api/analytics/accounts/${igA}/posts`, A);
  check('posts of the failed account: 200, empty, apiPosts true (Instagram)', r.status === 200 && r.body.total === 0 && r.body.posts.length === 0 && r.body.apiPosts === true, r.text.slice(0, 200));
  r = await http('GET', `/api/analytics/accounts/${ytA}/posts`, A);
  check('YouTube posts: apiPosts false (not implemented yet), empty', r.status === 200 && r.body.apiPosts === false && r.body.total === 0, r.text.slice(0, 200));
  // Graph /me/media pages in the documented response shape (no real IG account here): the real collector code, its own paging.
  const graphPages: Record<string, any> = {
    '': { data: [
      { id: '17900000000000001', caption: 'first reel', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/AAA/', timestamp: '2026-11-10T08:00:00+0000', like_count: 12, comments_count: 3 },
      { id: '17900000000000002', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/BBB/', timestamp: '2026-11-08T08:00:00+0000', comments_count: 0 },
    ], paging: { cursors: { before: 'b1', after: 'a1' }, next: 'https://graph.instagram.com/v21.0/123/media?after=a1&access_token=REDACTED' } },
    a1: { data: [
      { id: '17900000000000003', caption: 'old photo', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'http://insecure.example/x', timestamp: '2026-10-01T08:00:00+0000', like_count: 40, comments_count: 7 },
    ], paging: { cursors: { before: 'b2', after: 'a2' } } },
  };
  const calls: Record<string, string>[] = [];
  const get = async <X>(path: string, params: Record<string, string>) => { calls.push({ path, ...params }); return graphPages[params.after ?? ''] as X; };
  const ownPosts = await collectOwnPosts(get, '123', POST_PAGES);
  check('collectOwnPosts: follows paging.next via cursors.after (own path/params, no token URL), stops on the last page, fields mapped',
    calls.length === 2 && calls[0]!.path === '123/media' && calls[1]!.after === 'a1' && calls.every((c) => /like_count/.test(c.fields!) && c.limit === '25') && ownPosts.length === 3
      && ownPosts[0]!.likes === 12 && ownPosts[0]!.productType === 'REELS' && ownPosts[1]!.likes === null && ownPosts[2]!.permalink === null, JSON.stringify({ calls, ownPosts }));
  calls.length = 0;
  await collectOwnPosts(get, '123', 1);
  check('collectOwnPosts: page cap honoured (1 page)', calls.length === 1);
  const up1 = await upsertAccountPosts(igM, 'instagram', ownPosts, new Date(Date.now() - 3600_000));
  const [p1Before] = await db.select().from(schema.socialAccountPosts).where(and(eq(schema.socialAccountPosts.socialAccountId, igM), eq(schema.socialAccountPosts.externalId, '17900000000000001')));
  const up2 = await upsertAccountPosts(igM, 'instagram', [{ ...ownPosts[0]!, likes: 15, comments: 4 }, { ...ownPosts[2]!, likes: null }]);
  const postRows = await db.select().from(schema.socialAccountPosts).where(eq(schema.socialAccountPosts.socialAccountId, igM));
  const p1 = postRows.find((p) => p.externalId === '17900000000000001');
  const p3 = postRows.find((p) => p.externalId === '17900000000000003');
  check('upsertAccountPosts: 3 inserted, then 2 updated (no duplicates); counts updated, first_seen kept, fetched_at moved, missing like count keeps the old one',
    up1.inserted === 3 && up2.inserted === 0 && up2.updated === 2 && postRows.length === 3 && p1?.likes === 15 && p1.comments === 4
      && p1.firstSeenAt.getTime() === p1Before!.firstSeenAt.getTime() && p1.fetchedAt.getTime() > p1Before!.fetchedAt.getTime() && p3?.likes === 40, JSON.stringify({ up1, up2, p1, p3 }));
  // publish link: a published publish task with the same platform post id
  const [content] = await db.insert(schema.contents).values({ userId: uA, title: `an ${tag} content` }).returning();
  const [pt] = await db.insert(schema.publishTasks).values({ userId: uA, contentId: content!.id, accountId: igM, platform: 'instagram', title: 'Reel title', status: 'published', externalId: '17900000000000001', publishedAt: new Date() }).returning();
  r = await http('GET', `/api/analytics/accounts/${igM}/posts`, A);
  responses.push(r.text);
  const lp = r.body.posts;
  check('posts list: newest first, totals likes 15+40 / comments 4+0+7, linked publish task, type/permalink',
    r.status === 200 && r.body.total === 3 && r.body.likes === 55 && r.body.comments === 11 && lp[0].externalId === '17900000000000001' && lp[0].publish?.taskId === pt!.id
      && lp[0].publish.contentId === content!.id && lp[0].permalink === 'https://www.instagram.com/reel/AAA/' && lp[1].publish === null && lp[1].likes === null && lp[2].externalId === '17900000000000003',
    r.text.slice(0, 400));
  r = await http('GET', `/api/analytics/accounts/${igM}/posts?sort=likes&limit=1`, A);
  check('posts: sort=likes (nulls last) + limit', r.status === 200 && r.body.posts.length === 1 && r.body.posts[0].externalId === '17900000000000003' && r.body.total === 3);
  r = await http('GET', `/api/analytics/accounts/${igM}/posts?sort=comments&offset=2`, A);
  check('posts: sort=comments + offset', r.status === 200 && r.body.posts.length === 1 && r.body.posts[0].externalId === '17900000000000002');
  r = await http('GET', `/api/analytics/accounts/${igM}/posts?limit=101`, A);
  check('posts: limit > 100 → 400', r.status === 400);
  r = await http('GET', `/api/analytics/accounts/${igM}/posts`, B);
  check('posts RBAC: user B on A\'s account → 404 social.not_found', r.status === 404 && r.body.code === 'social.not_found');
  r = await http('GET', `/api/analytics/accounts/${igM}/posts`, T);
  check('posts RBAC: admin sees any account\'s posts', r.status === 200 && r.body.total === 3);
  await db.delete(schema.contents).where(eq(schema.contents.id, content!.id));

  // in progress
  const blocker = await createTask({ type: 'account-stats', userId: uA, label: 'blocker', refType: 'social-account', refId: ttA, payload: { socialAccountId: ttA }, runAt: new Date(Date.now() + 3600_000) });
  taskIds.push(blocker.task.id);
  r = await http('POST', `/api/analytics/accounts/${ttA}/refresh`, A);
  check('refresh while a stats task is pending → 409 analytics.refresh_in_progress', r.status === 409 && r.body.code === 'analytics.refresh_in_progress', r.text);
  await http('POST', `/api/tasks/${blocker.task.id}/cancel`, A);

  // ---------------------------------------------------------------- daily scheduler
  await db.update(schema.platformConnections).set({ status: 'connected' }).where(eq(schema.platformConnections.socialAccountId, igA));
  await db.update(schema.platformConnections).set({ status: 'expired' }).where(eq(schema.platformConnections.socialAccountId, ytA));
  const mine = [igA, ytA, ttA];
  const dailyTasks = async (d: string) => (await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'account-stats'), inArray(schema.tasks.refId, mine))))
    .filter((t) => t.idempotencyKey?.endsWith(`:${d}`));
  const first = await scheduleDailyAccountStats(new Date(), { spread: false });
  const second = await scheduleDailyAccountStats(new Date(), { spread: false });
  let daily = await dailyTasks(day(0));
  taskIds.push(...daily.map((t) => t.id));
  check('daily run: one task per connected account (expired skipped), key account-stats:<id>:<day>, owner = account owner',
    daily.length === 2 && daily.every((t) => t.idempotencyKey === `account-stats:${t.refId}:${day(0)}` && t.createdBy === uA) && !daily.some((t) => t.refId === ytA),
    JSON.stringify(daily.map((t) => t.idempotencyKey)));
  check('daily run is idempotent (second call creates nothing)', first.created <= 2 && second.created === 0, JSON.stringify({ first, second }));
  const done = await Promise.all(daily.map((t) => finished(t.id)));
  const igDaily = done.find((t) => t.refId === igA);
  const ttDaily = done.find((t) => t.refId === ttA);
  check('daily tasks ran: Instagram (fake token) failed platform.auth_expired, TikTok partial scope_missing',
    igDaily?.status === 'failed' && igDaily.errorCode === 'platform.auth_expired' && ttDaily?.status === 'success' && (ttDaily.result as any)?.code === 'analytics.scope_missing',
    JSON.stringify(done.map((t) => [t.status, t.errorCode, t.result])));
  check('TikTok rerun the same day: still one row (upsert)', (await statsOf(ttA)).length === 1);
  // Tomorrow's run, spread over the day (future slots → scheduled, then cancelled here).
  await db.update(schema.platformConnections).set({ status: 'connected' }).where(inArray(schema.platformConnections.socialAccountId, mine));
  const tomorrow = new Date(Date.now() + 86400_000);
  const spread = await scheduleDailyAccountStats(tomorrow);
  daily = await dailyTasks(day(-1));
  taskIds.push(...daily.map((t) => t.id));
  const start = Date.parse(`${day(-1)}T00:00:00Z`);
  check('spread: tomorrow\'s tasks are scheduled at per-account times within the day',
    spread.created >= 3 && daily.length === 3 && daily.every((t) => t.status === 'scheduled' && t.runAt && t.runAt.getTime() > Date.now() && t.runAt.getTime() < start + 86400_000 + 3600_000) &&
    new Set(daily.map((t) => t.runAt!.getTime())).size === 3, JSON.stringify(daily.map((t) => [t.status, t.runAt])));
  for (const t of daily) await http('POST', `/api/tasks/${t.id}/cancel`, T);

  // ---------------------------------------------------------------- no secrets anywhere
  await new Promise((res) => setTimeout(res, 800));
  const allTasks = await db.select().from(schema.tasks).where(inArray(schema.tasks.id, taskIds));
  const allLogs = await db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, taskIds));
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  for (const id of [igA, ytA, ttA]) responses.push((await http('GET', `/api/analytics/accounts/${id}`, A)).text);
  responses.push((await http('GET', '/api/analytics/summary', T)).text, (await http('GET', '/api/dashboard', A)).text);
  check('no token or client secret in API responses', !responses.some((x) => leaks(x).length) && !responses.some((x) => /accessToken|refreshToken|v1:/.test(x)));
  check('no token in task rows / task logs', !leaks(JSON.stringify(allTasks)).length && !leaks(JSON.stringify(allLogs)).length);
  check('task payloads only carry the account id', allTasks.every((t) => JSON.stringify(Object.keys(t.payload ?? {})) === '["socialAccountId"]'));

  // ---------------------------------------------------------------- audit
  const acts = new Set(audits.map((a) => a.action));
  const want = ['analytics.refresh'];
  check('audit actions recorded', want.every((x) => acts.has(x)), want.filter((x) => !acts.has(x)).join(','));
  check('no audit entry for the removed manual endpoints', !acts.has('analytics.stats_add') && !acts.has('analytics.stats_delete'));
  check('audit: refused refresh recorded as failed', audits.some((a) => a.action === 'analytics.refresh' && a.status === 409 && a.targetId === igM));
  check('audit never stores the secret or tokens', !leaks(JSON.stringify(audits)).length);

  // ---------------------------------------------------------------- deletion
  await http('DELETE', `/api/social/accounts/${fb}`, A);
  check('deleting the social account deletes its stats (cascade)', (await statsOf(fb)).length === 0);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(schema.socialAccounts).where(like(schema.socialAccounts.handle, `an_${tag}_%`));
  if (taskIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));
  if (appsBefore) await db.insert(schema.settings).values({ key: 'platform.apps', value: appsBefore.value }).onConflictDoUpdate({ target: schema.settings.key, set: { value: appsBefore.value } });
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
  const left = await db.select().from(schema.socialAccounts).where(like(schema.socialAccounts.handle, `an_${tag}_%`));
  const leftStats = userIds.length ? await db.select({ id: schema.socialAccountStats.id }).from(schema.socialAccountStats)
    .innerJoin(schema.socialAccounts, eq(schema.socialAccounts.id, schema.socialAccountStats.socialAccountId)).where(inArray(schema.socialAccounts.userId, userIds)) : [];
  check('cleanup: test users, accounts, stats, connections, tasks removed', left.length === 0 && leftStats.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
