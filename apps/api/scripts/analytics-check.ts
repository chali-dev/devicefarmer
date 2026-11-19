/**
 * Account analytics (账号分析) test against the real API + DB (no mocks). Read only since 2026-11-18: the official-API
 * source (task account-stats, daily schedule, "refresh now") was removed and manual entry before, so historical rows
 * are seeded straight into the tables (scripts/lib/analytics-seed.ts):
 * - Removed endpoints: POST …/stats, DELETE …/stats/:day, POST …/refresh → 404 (user and admin); no account-stats task.
 * - Exact per-day gains, per-day sums, totals, per-account sums, 7/30/1-day ranges, baseline before the window.
 * - Responses carry no connection / lastRun / apiStats / apiPosts any more.
 * - RBAC: users only see their own accounts (others 404), admins all + owner filter; the dashboard's 媒体号分析 numbers (summary 7 / 30 days) per role.
 * - Likes/comments in per-account sums and the dashboard's 7-day summary; days without data are null (chart gaps).
 * - Own posts (帖子) from stored rows: list/sort/limit/offset, publish link, RBAC.
 * Creates two temporary users and removes everything afterwards.
 * Usage (from apps/api, API running with ENABLED_PLATFORMS=all): E2E_API=http://127.0.0.1:3190 npx tsx --env-file=../../.env scripts/analytics-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { seedOwnPosts, seedStatsDay } from './lib/analytics-seed.js';
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
const day = (ago: number) => new Date(Date.now() - ago * 86400_000).toISOString().slice(0, 10);

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const h = (s: string) => `an_${tag}_${s}`;
const userIds: string[] = [];
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);

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

  // ---------------------------------------------------------------- no write endpoints; historical rows seeded directly
  const gone = await Promise.all([
    http('POST', `/api/analytics/accounts/${igM}/stats`, A, { day: day(0), followers: 1 }),
    http('DELETE', `/api/analytics/accounts/${igM}/stats/${day(0)}`, A),
    http('POST', `/api/analytics/accounts/${igM}/stats`, T, { followers: 1 }),
    http('POST', `/api/analytics/accounts/${igA}/refresh`, A), http('POST', `/api/analytics/accounts/${ytA}/refresh`, T),
  ]);
  check('write endpoints removed: POST …/stats, DELETE …/stats/:day, POST …/refresh → 404 (user and admin)', gone.every((x) => x.status === 404), gone.map((x) => x.status).join(','));
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
  for (const [id, d, v] of seed) await seedStatsDay(id, d, v);
  await seedStatsDay(igM, day(0), { followers: 1100, views: 100, shares: 7 });
  const rows0 = await db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, igM));
  check('seeded (legacy manual rows): same day again → upsert, still one row per day (4 rows)', rows0.length === 4 && rows0.every((x) => x.source === 'manual'));
  let r: { status: number; body: any; text: string };

  // ---------------------------------------------------------------- aggregates (exact)
  r = await http('GET', '/api/analytics/summary', A);
  const s = r.body;
  const dayOf = (d: string) => s.days.find((x: any) => x.day === d);
  check('summary default range: 7 days, today last', r.status === 200 && s.days.length === 7 && s.to === day(0) && s.from === day(6), r.text.slice(0, 200));
  check('summary totals (7 d): followers gained 130 (baseline before the window), views 230, shares 15, likes 9, comments 2',
    s.totals.followersGained === 130 && s.totals.views === 230 && s.totals.shares === 15 && s.totals.likes === 9 && s.totals.comments === 2, JSON.stringify(s.totals));
  check('summary totals: 5 own accounts, 2 with data, current followers 1330', s.totals.accounts === 5 && s.totals.withData === 2 && s.totals.followers === 1330, JSON.stringify(s.totals));
  check('summary accounts carry no connection / lastRun', s.accounts.every((a: any) => !('connection' in a) && !('lastRun' in a)), JSON.stringify(s.accounts[0]));
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
  const ser = r.body;
  check('account series: 7 days incl. empty ones, gains per day, account state',
    r.status === 200 && ser.days.length === 7 && ser.days[0].day === day(6) && ser.days[0].followersGained === 10 && ser.days[0].followers === 1010 &&
    ser.days[1].source === null && ser.days[6].followersGained === 60 && ser.days[6].source === 'manual' && ser.account.id === igM && !('connection' in ser.account) && !('lastRun' in ser.account) && !('apiStats' in ser),
    JSON.stringify(ser).slice(0, 400));

  // ---------------------------------------------------------------- RBAC
  r = await http('GET', '/api/analytics/summary', B);
  check('user B: summary = own account only (+20, shares 1)', r.status === 200 && r.body.accounts.length === 1 && r.body.totals.followersGained === 20 && r.body.totals.shares === 1, JSON.stringify(r.body.totals));
  const denied = await Promise.all([
    http('GET', `/api/analytics/accounts/${igM}`, B), http('GET', `/api/analytics/accounts/${igM}/posts`, B),
  ]);
  check('user B on A\'s account: series / posts → 404 social.not_found', denied.every((x) => x.status === 404 && x.body.code === 'social.not_found'), denied.map((x) => x.status).join(','));
  r = await http('GET', `/api/analytics/summary?ownerId=${uB}`, T);
  check('admin with owner filter = exactly that user\'s numbers', r.status === 200 && r.body.accounts.length === 1 && r.body.totals.followersGained === 20 && r.body.accounts[0].ownerName === `anb${tag}`);
  r = await http('GET', '/api/analytics/summary', T);
  check('admin without filter sees both users\' accounts', r.status === 200 && [igM, igB].every((id) => r.body.accounts.some((a: any) => a.id === id)));
  r = await http('GET', `/api/analytics/accounts/${igM}`, T);
  check('admin: any account\'s series', r.status === 200 && r.body.account.id === igM);
  r = await http('GET', `/api/analytics/summary?ownerId=${uB}`, A);
  check('user: owner filter is ignored (still own accounts only)', r.status === 200 && r.body.accounts.length === 5);

  // ---------------------------------------------------------------- dashboard 媒体号分析 (simplified 2026-11-19: the page reads summary?days=7|30)
  r = await http('GET', '/api/dashboard?tz=UTC', A);
  check('dashboard: no analytics widget any more (the page reads /api/analytics/summary)', r.status === 200 && !('analytics' in (r.body.widgets ?? {})), JSON.stringify(r.body.order));
  r = await http('GET', '/api/analytics/summary?days=7', A);
  const w = r.body;
  const accM = w.accounts?.find((x: any) => x.id === igM);
  check('dashboard 7 days (user A): +130 / views 230 / shares 15, the instagram account +100',
    r.status === 200 && w.totals.followersGained === 130 && w.totals.views === 230 && w.totals.shares === 15 && w.days.length === 7 && accM?.range.followersGained === 100, JSON.stringify(w.totals));
  const wDay = (d: string) => w.days.find((x: any) => x.day === d);
  check('dashboard 7 days: likes 9 / comments 2, per day likes/comments, days without data are null (not 0)',
    w.totals.likes === 9 && w.totals.comments === 2 && wDay(day(3))?.likes === 9 && wDay(day(3))?.comments === 2 && wDay(day(5))?.likes === null && wDay(day(5))?.followersGained === null
      && wDay(day(5))?.views === null, JSON.stringify(w.days));
  r = await http('GET', '/api/analytics/summary?days=30', A);
  check('dashboard 30 days (user A): 30 day points, gains at least the 7-day ones', r.status === 200 && r.body.days.length === 30 && r.body.totals.followersGained >= 130, JSON.stringify(r.body.totals));
  r = await http('GET', '/api/analytics/summary?days=7', B);
  check('dashboard 7 days (user B): +20 only', r.body.totals?.followersGained === 20 && r.body.totals.accounts === 1, JSON.stringify(r.body.totals));
  r = await http('GET', `/api/analytics/summary?days=7&ownerId=${uA}`, T);
  check('dashboard (admin viewing as A, ownerId) = A\'s numbers', r.body.totals?.followersGained === 130);

  // ---------------------------------------------------------------- no data source: nothing schedules account-stats
  const statsTasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'account-stats'), inArray(schema.tasks.refId, [igM, fb, igA, ytA, ttA, igB])));
  check('no account-stats task exists for the test accounts (no daily schedule, no refresh)', statsTasks.length === 0, String(statsTasks.length));
  r = await http('GET', `/api/analytics/accounts/${igA}`, A);
  check('account without data: series 200, every day empty (source null)', r.status === 200 && r.body.days.every((x: any) => x.source === null) && r.body.account.latest === null);

  // ---------------------------------------------------------------- own posts (帖子), stored rows
  r = await http('GET', `/api/analytics/accounts/${igA}/posts`, A);
  check('posts of an account without rows: 200, empty, no apiPosts flag', r.status === 200 && r.body.total === 0 && r.body.posts.length === 0 && !('apiPosts' in r.body), r.text.slice(0, 200));
  const old = new Date(Date.now() - 3600_000);
  const up = await seedOwnPosts(igM, 'instagram', [
    { id: '17900000000000001', caption: 'first reel', mediaType: 'VIDEO', productType: 'REELS', permalink: 'https://www.instagram.com/reel/AAA/', publishedAt: '2026-11-10T08:00:00Z', likes: 15, comments: 4 },
    { id: '17900000000000002', mediaType: 'CAROUSEL_ALBUM', productType: 'FEED', permalink: 'https://www.instagram.com/p/BBB/', publishedAt: '2026-11-08T08:00:00Z', comments: 0 },
    { id: '17900000000000003', caption: 'old photo', mediaType: 'IMAGE', productType: 'FEED', publishedAt: '2026-10-01T08:00:00Z', likes: 40, comments: 7 },
  ], old);
  check('seeded 3 historical posts', up.inserted === 3);
  // publish link: a published publish task with the same platform post id
  const [content] = await db.insert(schema.contents).values({ userId: uA, title: `an ${tag} content` }).returning();
  const [pt] = await db.insert(schema.publishTasks).values({ userId: uA, contentId: content!.id, accountId: igM, platform: 'instagram', title: 'Reel title', status: 'published', externalId: '17900000000000001', publishedAt: new Date() }).returning();
  r = await http('GET', `/api/analytics/accounts/${igM}/posts`, A);
  const lp = r.body.posts;
  check('posts list: newest first, totals likes 15+40 / comments 4+0+7, linked publish task, type/permalink, lastFetchedAt = stored time',
    r.status === 200 && r.body.total === 3 && r.body.likes === 55 && r.body.comments === 11 && lp[0].externalId === '17900000000000001' && lp[0].publish?.taskId === pt!.id
      && lp[0].publish.contentId === content!.id && lp[0].permalink === 'https://www.instagram.com/reel/AAA/' && lp[1].publish === null && lp[1].likes === null && lp[2].externalId === '17900000000000003'
      && Math.abs(Date.parse(r.body.lastFetchedAt) - old.getTime()) < 1000,
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

  // ---------------------------------------------------------------- audit
  await new Promise((res) => setTimeout(res, 800));
  const audits = await db.select().from(schema.auditLogs).where(gte(schema.auditLogs.at, t0));
  const acts = new Set(audits.map((a) => a.action));
  check('no analytics audit actions (refresh and manual entry are gone)', !acts.has('analytics.refresh') && !acts.has('analytics.stats_add') && !acts.has('analytics.stats_delete'));

  // ---------------------------------------------------------------- deletion
  await http('DELETE', `/api/social/accounts/${fb}`, A);
  check('deleting the social account deletes its stats (cascade)', (await db.select().from(schema.socialAccountStats).where(eq(schema.socialAccountStats.socialAccountId, fb))).length === 0);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  await db.delete(schema.socialAccounts).where(like(schema.socialAccounts.handle, `an_${tag}_%`));
  const left = await db.select().from(schema.socialAccounts).where(like(schema.socialAccounts.handle, `an_${tag}_%`));
  const leftStats = userIds.length ? await db.select({ id: schema.socialAccountStats.id }).from(schema.socialAccountStats)
    .innerJoin(schema.socialAccounts, eq(schema.socialAccounts.id, schema.socialAccountStats.socialAccountId)).where(inArray(schema.socialAccounts.userId, userIds)) : [];
  check('cleanup: test users, accounts, stats, posts removed', left.length === 0 && leftStats.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
