/**
 * Tracked accounts (追踪账号) test through the public API against the real API, DB and BullMQ queue (no mocks).
 * - Creates two temporary users (A, B) and their tracked accounts; deletes everything afterwards. Manual entry was
 *   removed (POST …/snapshots and …/posts are 404 now); history rows (legacy `manual` and `device` ones) are seeded
 *   directly in the DB to test deltas, ordering, approx flags and deletion.
 * - Never touches a phone: 采集手机 are placeholder device rows (adb ports 5566–5568, nothing listens there), so a
 *   queued refresh meets an offline phone (the reading itself is covered by tracked-device-check.ts).
 * - 采集手机 (owner decision 2026-11-19, replaces the global collector setting): picker endpoint RBAC (user: own phones,
 *   admin: any owner's), default on create (one phone → it, several / none → none), PATCH / batch POST …/phone (owner's
 *   phones only, other platforms refused, whole-batch 404), refusals tracked.no_phone / phone_not_allowed /
 *   collector_halted on refresh, 同步, 立即采集 and the scheduler, offline phone → task fails tracked.collector_offline,
 *   device deleted → phone unset, the removed settings endpoints (404), audit.
 * - Needs TikTok and YouTube enabled: run the API (and this script) with ENABLED_PLATFORMS=all.
 * - Never calls an external platform: the YouTube API key set here is a syntactically valid dummy that is cleared
 *   again before any refresh could use it. The real YouTube Data API path runs only when YOUTUBE_TEST_API_KEY is
 *   set (then it refreshes the public channel @YouTube once, costing ~3 quota units).
 * - 采集频率 by the operator: interval on create, single PATCH, batch POST /api/tracked-accounts/schedule (whole batch 404
 *   on a foreign id, platforms without a source skipped) and the capacity per 采集手机 GET /api/tracked-accounts/capacity
 *   (exact numbers recomputed from the DB, the caller's phones only, no ids/handles/owners of accounts). Assumes the default device pace
 *   (TRACKED_DEVICE_MIN_INTERVAL_SEC / TRACKED_DEVICE_MAX_PER_HOUR read from this script's env, defaults 30 / 60).
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/tracked-check.ts
 */
import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { refreshTrackedAccount, upsertPosts } from '../src/modules/tracked/tracked.js';
import { scheduleTrackedRefreshes } from '../src/modules/tracked/schedule.js';
import { scheduleFeedCollects } from '../src/modules/feed/collect.js';
import { withCaptcha } from './lib/login.js';
import { placeholders } from './lib/placeholder.js';

const ph = placeholders('trk');

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function http<T = any>(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitTask(taskId: string, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (t && (t.status === 'success' || t.status === 'failed')) return t;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for task ${taskId} (${t?.status})`);
    await sleep(300);
  }
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('hex');
const userIds: string[] = [];
const accountIds: string[] = [];
let keyTouched = false;
let keyWasSet = false;
const DUMMY_KEY = `AIzaDummy${randomBytes(15).toString('hex')}`;
const CH = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
const devIds: string[] = [];
let pA1 = ''; let pA2 = ''; let pB = '';

try {
  // ---------------------------------------------------------------- users
  const mk = async (name: string) => {
    const r = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
    const id = r.body.user?.id ?? r.body.id; userIds.push(id);
    return { id, token: await login(name, pw) };
  };
  const A = await mk(`tra${tag}`);
  const B = await mk(`trb${tag}`);

  // ---------------------------------------------------------------- URL / handle normalisation
  const parse = (input: string, platform?: string) => http('POST', '/api/tracked-accounts/parse', A.token, { input, platform });
  const ok: [string, string | undefined, string, string, string, string | null][] = [
    ['https://www.youtube.com/@MrBeast', undefined, 'youtube', 'mrbeast', 'https://www.youtube.com/@mrbeast', null],
    ['youtube.com/@MrBeast/videos?view=0#x', undefined, 'youtube', 'mrbeast', 'https://www.youtube.com/@mrbeast', null],
    [`https://m.youtube.com/channel/${CH}/featured`, undefined, 'youtube', CH, `https://www.youtube.com/channel/${CH}`, CH],
    ['@SomeHandle', 'youtube', 'youtube', 'somehandle', 'https://www.youtube.com/@somehandle', null],
    [CH, 'youtube', 'youtube', CH, `https://www.youtube.com/channel/${CH}`, CH],
    ['https://www.instagram.com/NatGeo/?hl=en', undefined, 'instagram', 'natgeo', 'https://www.instagram.com/natgeo/', null],
    ['natgeo', 'instagram', 'instagram', 'natgeo', 'https://www.instagram.com/natgeo/', null],
    ['https://www.tiktok.com/@Khaby.Lame?lang=en', undefined, 'tiktok', 'khaby.lame', 'https://www.tiktok.com/@khaby.lame', null],
    ['@khaby.lame', 'tiktok', 'tiktok', 'khaby.lame', 'https://www.tiktok.com/@khaby.lame', null],
  ];
  let allOk = true;
  for (const [input, platform, p, handle, url, ext] of ok) {
    const r = await parse(input, platform);
    const g = r.body?.profile;
    const good = r.status === 200 && g.platform === p && g.handle === handle && g.profileUrl === url && g.externalId === ext;
    if (!good) { allOk = false; console.log('   ', input, r.status, r.text.slice(0, 160)); }
  }
  check(`URL/handle normalisation: ${ok.length} valid forms`, allOk);
  const bad: [string, string | undefined, string][] = [
    ['https://example.com/@foo', undefined, 'tracked.unsupported_host'],
    ['https://evil.youtube.com.attacker.net/@x', undefined, 'tracked.unsupported_host'],
    ['https://www.instagram.com/p/Cabc123/', undefined, 'tracked.bad_profile_url_for'],
    ['https://www.instagram.com/explore/', undefined, 'tracked.bad_profile_url_for'],
    ['https://www.tiktok.com/khaby', undefined, 'tracked.bad_profile_url_for'],
    ['https://www.youtube.com/c/legacy', undefined, 'tracked.bad_profile_url_for'],
    ['https://www.youtube.com/watch?v=abc', undefined, 'tracked.bad_profile_url_for'],
    ['https://www.instagram.com/natgeo', 'tiktok', 'tracked.platform_mismatch'],
    ['ftp://youtube.com/@x', undefined, 'tracked.bad_profile_url'],
    ['natgeo', undefined, 'tracked.platform_required'],
    ['bad handle!', 'instagram', 'tracked.bad_handle'],
    ['javascript:alert(1)', 'youtube', 'tracked.bad_handle'],
    ['@a', 'tiktok', 'tracked.bad_handle'],
  ];
  allOk = true;
  for (const [input, platform, code] of bad) {
    const r = await parse(input, platform);
    if (r.status !== 400 || r.body?.code !== code) { allOk = false; console.log('   ', input, r.status, r.body?.code); }
  }
  check(`invalid inputs rejected with codes: ${bad.length} cases`, allOk);
  const auditParse = await sqlClient`select count(*)::int as n from audit_logs where path = '/api/tracked-accounts/parse'`;
  check('parse preview is not audit-logged', auditParse[0]!.n === 0);

  // ---------------------------------------------------------------- CRUD
  let r = await http('POST', '/api/tracked-accounts', A.token, {
    // `category` (removed: folded into tags) is what an old client may still send: silently ignored, not a 400.
    input: 'https://www.instagram.com/NatGeo/', category: 'Media', tags: ['Travel', 'travel', ' Photo '], notes: 'nat geo',
  });
  check('create (URL) 201, tags normalised, device data mode without a phone (A has none), 定时采集 24 h by default', r.status === 201 && r.body.account.platform === 'instagram'
    && r.body.account.handle === 'natgeo' && JSON.stringify(r.body.account.tags) === '["travel","photo"]'
    && r.body.account.status === 'active' && r.body.account.dataMode === 'device_unconfigured' && r.body.account.instanceId === null && r.body.account.phone === null && r.body.account.followers === null
    && r.body.account.refreshIntervalHours === 24 && !!r.body.account.nextRefreshAt, r.text.slice(0, 160));
  const ig = r.body.account; accountIds.push(ig.id);
  const igCat = async () => (await sqlClient`select count(*)::int as n from information_schema.columns where table_name = 'tracked_accounts' and column_name = 'category'`)[0]!.n;
  check('create: category in the body ignored (no category in the response, the column is gone)', !('category' in ig) && await igCat() === 0, r.text.slice(0, 160));
  r = await http('POST', '/api/tracked-accounts', A.token, { input: '@NATGEO', platform: 'instagram' });
  check('duplicate (same user, platform, handle) refused 409 tracked.duplicate', r.status === 409 && r.body.code === 'tracked.duplicate');
  r = await http('POST', '/api/tracked-accounts', B.token, { input: 'natgeo', platform: 'instagram', tags: ['b-only'] });
  check('another user may track the same account', r.status === 201);
  const igB = r.body.account; accountIds.push(igB.id);
  r = await http('POST', '/api/tracked-accounts', A.token, { input: `https://www.youtube.com/channel/${CH}`, tags: ['travel'] });
  const yt = r.body.account; accountIds.push(yt.id);
  check('YouTube account: external id from URL, data mode api_unconfigured (no key), no default schedule', r.status === 201 && yt.externalId === CH && yt.dataMode === 'api_unconfigured' && yt.refreshIntervalHours === null, yt?.dataMode);
  r = await http('POST', '/api/tracked-accounts', A.token, { input: 'https://www.tiktok.com/@Khaby.Lame', favorite: true, displayName: 'Khaby' });
  const tt = r.body.account; accountIds.push(tt.id);
  check('create TikTok as favorite', r.status === 201 && tt.favorite === true && tt.displayName === 'Khaby');

  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { displayName: 'National Geographic', bio: 'bio', avatarUrl: 'https://example.org/a.jpg' });
  check('update profile fields', r.status === 200 && r.body.account.displayName === 'National Geographic' && r.body.account.avatarUrl === 'https://example.org/a.jpg');
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { notes: 'nat geo 2', category: 'Media' });
  check('update: category ignored (200, no category in the response, column is gone)', r.status === 200 && r.body.account.notes === 'nat geo 2'
    && !('category' in r.body.account) && await igCat() === 0, r.text.slice(0, 160));
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { avatarUrl: 'javascript:alert(1)' });
  check('non-http avatar URL rejected 400', r.status === 400);
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, {});
  check('empty update → 400 common.nothing_to_update', r.status === 400 && r.body.code === 'common.nothing_to_update');
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { status: 'error' });
  check("status 'error' cannot be set by hand", r.status === 400);
  r = await http('PATCH', `/api/tracked-accounts/${tt.id}`, A.token, { status: 'paused', favorite: false });
  check('pause + unfavorite', r.status === 200 && r.body.account.status === 'paused' && r.body.account.favorite === false);
  r = await http('PATCH', `/api/tracked-accounts/${tt.id}`, A.token, { favorite: true });
  check('favorite again', r.body.account?.favorite === true);

  // ---------------------------------------------------------------- manual entry removed; history seeded in the DB
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();
  const gone = await Promise.all([
    http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, { followers: 1 }),
    http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { externalId: 'x' }),
  ]);
  check('manual entry endpoints removed: POST …/snapshots and …/posts → 404', gone.every((x) => x.status === 404), gone.map((x) => x.status).join(','));
  const TS = schema.trackedAccountSnapshots;
  const seed = async (accountId: string, at: number, v: Partial<typeof TS.$inferInsert>) =>
    (await db.insert(TS).values({ trackedAccountId: accountId, capturedAt: new Date(at), source: 'manual', ...v }).returning())[0]!;
  const snap1 = (await seed(ig.id, now - 2 * day, { followers: 1000, following: 10, posts: 50 })).id;
  await seed(ig.id, now - day, { followers: 1200, posts: 52, source: 'device', approx: ['followers'] });
  await seed(ig.id, now - 3600_000, { following: 11, source: 'device' });
  r = await http('GET', `/api/tracked-accounts/${ig.id}`, A.token);
  let a = r.body.account;
  check('seeded history: latest followers 1200, delta +200 (snapshot without followers ignored), latest source/approx exposed',
    a.followers === 1200 && a.followersDelta === 200 && a.latest.following === 11 && a.latest.followers === null && a.latest.source === 'device' && Array.isArray(a.latest.approx),
    `followers=${a.followers} delta=${a.followersDelta}`);
  await seed(ig.id, now, { followers: 1100, source: 'device' });
  a = (await http('GET', `/api/tracked-accounts/${ig.id}`, A.token)).body.account;
  check('drop to 1100 → delta −100', a.followers === 1100 && a.followersDelta === -100);
  r = await http('GET', `/api/tracked-accounts/${ig.id}/snapshots`, A.token);
  const times = r.body.snapshots.map((s: any) => new Date(s.capturedAt).getTime());
  check('snapshot history returned oldest first (4 rows), approx list and legacy manual rows readable',
    r.body.snapshots.length === 4 && times.every((t: number, i: number) => i === 0 || t >= times[i - 1])
    && r.body.snapshots[0].source === 'manual' && JSON.stringify(r.body.snapshots[1].approx) === '["followers"]');
  r = await http('DELETE', `/api/tracked-accounts/${ig.id}/snapshots/${snap1}`, A.token);
  check('delete snapshot 204', r.status === 204);
  r = await http('DELETE', `/api/tracked-accounts/${ig.id}/snapshots/${snap1}`, A.token);
  check('delete it again → 404 tracked.snapshot_not_found', r.status === 404 && r.body.code === 'tracked.snapshot_not_found');
  await seed(yt.id, now - day, { followers: 300, source: 'api' });
  r = await http('GET', `/api/tracked-accounts/${yt.id}`, A.token);
  check('single snapshot → delta null', r.body.account.followers === 300 && r.body.account.followersDelta === null);

  // ---------------------------------------------------------------- posts (upsert by external id; listing; delete)
  const P = (externalId: string, extra: Record<string, unknown> = {}) => ({ externalId, url: null, title: null, publishedAt: null, views: null, likes: null, comments: null, ...extra });
  const u1 = await upsertPosts(db, ig.id, [P('C1', { title: 'First', views: 10, publishedAt: new Date(now - 3 * day) })], 'api');
  const [first] = await db.select().from(schema.trackedPosts).where(eq(schema.trackedPosts.id, u1.ids[0]!));
  await sleep(20);
  const u2 = await upsertPosts(db, ig.id, [P('C1', { views: 20, likes: 3 })], 'api');
  const [p2] = await db.select().from(schema.trackedPosts).where(eq(schema.trackedPosts.id, u2.ids[0]!));
  check('post upsert: same external id updated (title kept, metrics updated, first seen unchanged)', u1.inserted === 1 && u2.inserted === 0
    && p2!.id === first!.id && p2!.title === 'First' && p2!.views === 20 && p2!.likes === 3 && p2!.firstSeenAt.getTime() === first!.firstSeenAt.getTime()
    && p2!.lastSeenAt > first!.lastSeenAt);
  const u3 = await upsertPosts(db, ig.id, [P('XYZ', { url: 'https://www.instagram.com/p/XYZ/', publishedAt: new Date(now - day) }), P('undated', { title: 'no date' })], 'api');
  r = await http('GET', `/api/tracked-accounts/${ig.id}/posts`, A.token);
  check('posts ordered by published date desc, undated last', r.body.total === 3 && r.body.posts.map((p: any) => p.externalId).join(',') === 'XYZ,C1,undated',
    r.body.posts.map((p: any) => p.externalId).join(','));
  r = await http('DELETE', `/api/tracked-accounts/${ig.id}/posts/${u3.ids[0]}`, A.token);
  check('delete post 204', r.status === 204);
  void iso;

  // ---------------------------------------------------------------- filters + facets
  const list = async (qs: string, tok = A.token) => (await http('GET', `/api/tracked-accounts?${qs}`, tok)).body;
  const idsOf = (b: any) => b.items.map((x: any) => x.id).sort().join(',');
  const want = (...xs: any[]) => xs.map((x) => x.id).sort().join(',');
  check('filter platform', idsOf(await list('platform=instagram')) === want(ig));
  check('removed category filter is ignored (all rows)', idsOf(await list('category=Creators')) === want(ig, yt, tt));
  check('filter tag (case-insensitive)', idsOf(await list('tag=TRAVEL')) === want(ig, yt));
  check('filter favorites', idsOf(await list('favorite=true')) === want(tt));
  check('filter status', idsOf(await list('status=paused')) === want(tt));
  check('search display name / handle', idsOf(await list('q=geographic')) === want(ig) && idsOf(await list('q=khaby')) === want(tt));
  const fac = (await http('GET', '/api/tracked-accounts/facets', A.token)).body;
  check('facets: own tags only, no categories', !('categories' in fac) && JSON.stringify(fac.tags) === '["photo","travel"]', JSON.stringify(fac));
  const all = await list('');
  check('list favorites first, total 3', all.total === 3 && all.items[0].id === tt.id);

  // ---------------------------------------------------------------- RBAC isolation
  const b404 = await Promise.all([
    http('GET', `/api/tracked-accounts/${ig.id}`, B.token),
    http('PATCH', `/api/tracked-accounts/${ig.id}`, B.token, { favorite: true }),
    http('DELETE', `/api/tracked-accounts/${ig.id}`, B.token),
    http('GET', `/api/tracked-accounts/${ig.id}/snapshots`, B.token),
    http('DELETE', `/api/tracked-accounts/${ig.id}/snapshots/00000000-0000-0000-0000-000000000000`, B.token),
    http('GET', `/api/tracked-accounts/${ig.id}/posts`, B.token),
    http('POST', `/api/tracked-accounts/${ig.id}/refresh`, B.token),
  ]);
  check("user B gets 404 tracked.not_found on all of A's account routes", b404.every((x) => x.status === 404 && x.body.code === 'tracked.not_found'), b404.map((x) => x.status).join(','));
  const lb = await list('', B.token);
  check("B's list contains only B's account", idsOf(lb) === want(igB));
  r = await http('GET', `/api/tracked-accounts?ownerId=${A.id}`, B.token);
  check('non-admin ownerId filter for another user → 403', r.status === 403 && r.body.code === 'tracked.admin_only');
  const la = await list('', T);
  check('admin sees all users (owner names included)', la.items.some((x: any) => x.id === igB.id && x.ownerName === `trb${tag}`) && la.items.some((x: any) => x.id === ig.id));
  check('admin owner filter', idsOf(await list(`ownerId=${B.id}`, T)) === want(igB));
  r = await http('GET', `/api/tracked-accounts/${ig.id}/snapshots`, T);
  check("admin can read A's history", r.status === 200 && r.body.snapshots.length === 3);

  // ---------------------------------------------------------------- refresh only where a data source exists
  // The web UI shows 刷新 / 立即刷新 / 批量刷新 and the 定时采集 controls only when dataMode !== 'manual_only'.
  const modes = Object.fromEntries((await list('', A.token)).items.map((x: any) => [x.platform, x.dataMode]));
  check('data modes that drive the UI: Instagram device_unconfigured (no 采集手机), TikTok manual_only (no source), YouTube api_unconfigured',
    modes.instagram === 'device_unconfigured' && modes.tiktok === 'manual_only' && modes.youtube === 'api_unconfigured', JSON.stringify(modes));
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { refreshIntervalHours: 6 });
  check('Instagram schedule can be changed (6 h)', r.status === 200 && r.body.account.refreshIntervalHours === 6);
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { refreshIntervalHours: null });
  check('Instagram schedule can be switched off', r.status === 200 && r.body.account.refreshIntervalHours === null && r.body.account.nextRefreshAt === null);
  r = await http('PATCH', `/api/tracked-accounts/${tt.id}`, A.token, { refreshIntervalHours: 6 });
  check('schedule on a platform without a source is refused (400 tracked.schedule_manual_only)', r.status === 400 && r.body.code === 'tracked.schedule_manual_only');
  r = await http('POST', `/api/tracked-accounts/${ig.id}/refresh`, A.token);
  check('Instagram refresh without a 采集手机 → 400 tracked.no_phone (no task)', r.status === 400 && r.body.code === 'tracked.no_phone');
  // Refresh dedupe: an unfinished refresh task blocks another.
  const [fake] = await db.insert(schema.tasks).values({ type: 'tracked-refresh', refType: 'tracked_account', refId: ig.id, status: 'running', instanceName: 'test' }).returning();
  r = await http('POST', '/api/tracked-accounts/refresh', A.token, { ids: [ig.id] });
  check('refresh while one is running → skipped tracked.refresh_in_progress', r.body.skipped?.[0]?.code === 'tracked.refresh_in_progress');
  await db.delete(schema.tasks).where(eq(schema.tasks.id, fake!.id));
  r = await http('POST', `/api/tracked-accounts/${tt.id}/refresh`, A.token);
  check('refresh paused account → 409 tracked.paused', r.status === 409 && r.body.code === 'tracked.paused');
  r = await http('POST', `/api/tracked-accounts/${yt.id}/refresh`, A.token);
  check('refresh YouTube without API key → 400 tracked.youtube_no_api_key (no task)', r.status === 400 && r.body.code === 'tracked.youtube_no_api_key');
  r = await http('POST', '/api/tracked-accounts/refresh', A.token, { ids: [ig.id, yt.id, tt.id, igB.id] });
  const sk = Object.fromEntries((r.body.skipped ?? []).map((s: any) => [s.id, s.code]));
  check('batch refresh: skipped no-phone / no-key / paused / foreign (not_found)', r.status === 202 && r.body.queued.length === 0
    && sk[ig.id] === 'tracked.no_phone' && sk[yt.id] === 'tracked.youtube_no_api_key' && sk[tt.id] === 'tracked.paused' && sk[igB.id] === 'tracked.not_found', JSON.stringify(sk));
  // A platform without a source: a refresh is the documented no-op task (the UI does not offer it).
  await http('PATCH', `/api/tracked-accounts/${tt.id}`, A.token, { status: 'active' });
  r = await http('POST', `/api/tracked-accounts/${tt.id}/refresh`, A.token);
  check('API refresh on a platform without a source → 202 no-op task (manualOnly)', r.status === 202 && !!r.body.taskId && r.body.manualOnly === true, r.text.slice(0, 120));
  const t1 = await waitTask(r.body.taskId);
  const [taskRow] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, r.body.taskId));
  check('task row reaches succeeded (type tracked-refresh, ref tracked_account)', t1.status === 'success' && taskRow!.type === 'tracked-refresh'
    && taskRow!.refType === 'tracked_account' && taskRow!.refId === tt.id && taskRow!.instanceId === null, `${t1.status} ${t1.error ?? ''}`);
  a = (await http('GET', `/api/tracked-accounts/${tt.id}`, A.token)).body.account;
  check('no-source refresh leaves the account active without error; lastRefresh exposed', a.status === 'active' && !a.lastError && a.lastRefresh?.status === 'success');
  await http('PATCH', `/api/tracked-accounts/${tt.id}`, A.token, { status: 'paused' });
  // The job function itself (what a scheduler would call) with no key: coded error, account marked error.
  const err = await refreshTrackedAccount(yt.id).then(() => null, (e) => e as { code?: string });
  a = (await http('GET', `/api/tracked-accounts/${yt.id}`, A.token)).body.account;
  check('refreshTrackedAccount(YouTube, no key) throws tracked.youtube_no_api_key and marks the account error',
    err?.code === 'tracked.youtube_no_api_key' && a.status === 'error' && a.lastErrorCode === 'tracked.youtube_no_api_key' && !!a.lastCheckedAt);
  check('error status filter', idsOf(await list('status=error')) === want(yt));
  r = await http('PATCH', `/api/tracked-accounts/${yt.id}`, A.token, { status: 'active' });
  check('error account can be set active again', r.body.account?.status === 'active');
  check('refreshTrackedAccount on a platform without a source → manual_only', (await refreshTrackedAccount(tt.id)).outcome === 'manual_only');
  const igErr = await refreshTrackedAccount(ig.id).then(() => null, (e) => e as { code?: string });
  check('refreshTrackedAccount(Instagram, no 采集手机) → tracked.no_phone, no phone touched', igErr?.code === 'tracked.no_phone');
  await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { status: 'active' });

  // ---------------------------------------------------------------- 采集频率: create with an interval, batch, capacity
  {
    const sectionStart = new Date().toISOString();
    const HOUR = 3600_000;
    const inHour = (x: string | null) => !!x && new Date(x).getTime() > Date.now() - 5_000 && new Date(x).getTime() <= Date.now() + HOUR;
    const mkAcc = async (body: Record<string, unknown>, tok = A.token) => {
      const res = await http('POST', '/api/tracked-accounts', tok, body);
      if (res.body?.account?.id) accountIds.push(res.body.account.id);
      return res;
    };
    r = await mkAcc({ input: `fq1${tag}`, platform: 'instagram', refreshIntervalHours: 6 });
    const f1 = r.body.account;
    check('create Instagram with 采集频率 6 h → 201, interval 6, first slot within the hour', r.status === 201 && f1.refreshIntervalHours === 6 && inHour(f1.nextRefreshAt), r.text.slice(0, 160));
    r = await mkAcc({ input: `fq2${tag}`, platform: 'instagram', refreshIntervalHours: null });
    const f2 = r.body.account;
    check('create Instagram with 采集频率 off (null) → no interval, no slot', r.status === 201 && f2.refreshIntervalHours === null && f2.nextRefreshAt === null);
    r = await mkAcc({ input: `https://www.youtube.com/@fq3${tag}`, refreshIntervalHours: 12 });
    const f3 = r.body.account;
    check('create YouTube (API source) with 12 h → 201, interval 12', r.status === 201 && f3.refreshIntervalHours === 12 && inHour(f3.nextRefreshAt));
    r = await mkAcc({ input: `@fq4${tag}`, platform: 'tiktok', refreshIntervalHours: 6 });
    const ttRows = await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.handle, `fq4${tag}`));
    check('create TikTok (no source) with an interval → 400 tracked.schedule_manual_only, nothing created', r.status === 400 && r.body.code === 'tracked.schedule_manual_only' && ttRows.length === 0, r.text.slice(0, 120));
    r = await mkAcc({ input: `@fq4${tag}`, platform: 'tiktok', refreshIntervalHours: null });
    const f4 = r.body.account;
    check('create TikTok with interval off → 201', r.status === 201 && f4.refreshIntervalHours === null);
    const badIv = await Promise.all([5, 0, 1.5, '24', -24].map((v) => mkAcc({ input: `fqbad${tag}`, platform: 'instagram', refreshIntervalHours: v })));
    check('create with an unsupported interval (5, 0, 1.5, "24", -24) → 400, nothing created', badIv.every((x) => x.status === 400)
      && (await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.handle, `fqbad${tag}`))).length === 0, badIv.map((x) => x.status).join(','));
    r = await http('PATCH', `/api/tracked-accounts/${f1.id}`, A.token, { refreshIntervalHours: 7 });
    check('list edit (PATCH) with an unsupported interval → 400', r.status === 400);
    r = await http('PATCH', `/api/tracked-accounts/${f2.id}`, A.token, { refreshIntervalHours: 48 });
    check('list edit (PATCH) 48 h on an account that was off → interval + slot', r.status === 200 && r.body.account.refreshIntervalHours === 48 && inHour(r.body.account.nextRefreshAt));

    // ---- capacity per 采集手机 (every account on the phone; recomputed exactly from the DB)
    // A gets two placeholder phones (pA1 running, pA2 stopped), B one (pB); nothing listens on their adb ports.
    const devs = await ph.insert([1, 2, 3].map((n) => ({
      name: `trk-${tag}-${n}`, adbPort: 5565 + n, status: (n === 2 ? 'stopped' : 'running') as 'running' | 'stopped', adbState: n === 2 ? null : 'device',
      bootCompleted: n !== 2,
    })));
    devIds.push(...devs.map((d) => d.id));
    [pA1, pA2, pB] = devs.map((d) => d.id) as [string, string, string];
    await db.insert(schema.instanceGrants).values([{ userId: A.id, instanceId: pA1 }, { userId: A.id, instanceId: pA2 }, { userId: B.id, instanceId: pB }]);
    await http('PATCH', `/api/tracked-accounts/${f1.id}`, A.token, { instanceId: pA1 });
    await http('PATCH', `/api/tracked-accounts/${f2.id}`, A.token, { instanceId: pA2 });
    const minSec = Number(process.env.TRACKED_DEVICE_MIN_INTERVAL_SEC ?? 30);
    const maxHr = Number(process.env.TRACKED_DEVICE_MAX_PER_HOUR ?? 60);
    const capLimit = Math.min(maxHr, Math.floor(3600 / minSec));
    const dbLoad = async (inst: string) => {
      const [x] = await sqlClient`select count(*)::int as n, coalesce(sum(1.0 / refresh_interval_hours), 0)::float8 as v from tracked_accounts
        where platform = 'instagram' and instance_id = ${inst} and refresh_interval_hours is not null and status <> 'paused'`;
      return { n: x!.n as number, v: Math.round(Number(x!.v) * 100) / 100 };
    };
    const cap = async (tok: string, ownerId?: string) => http('GET', `/api/tracked-accounts/capacity${ownerId ? `?ownerId=${ownerId}` : ''}`, tok);
    const capOf = async (tok: string, inst: string) => (await cap(tok)).body.phones.find((x: any) => x.instanceId === inst);
    let exp = await dbLoad(pA1);
    const [cA, cB, cTA, cAB] = await Promise.all([cap(A.token), cap(B.token), cap(T, A.id), cap(A.token, B.id)]);
    const ci = cA.body.phones?.find((x: any) => x.instanceId === pA1);
    check("capacity: per phone of the caller (A: pA1 + pA2, by name), pA1's scheduled accounts and visits/hour exactly as in the DB; limit min(max/h, 3600/min interval)",
      cA.status === 200 && cA.body.phones.map((x: any) => x.instanceId).join() === [pA1, pA2].join() && ci?.scheduledAccounts === exp.n && ci.visitsPerHour === exp.v
      && ci.capacityPerHour === capLimit && ci.overloaded === (exp.v > capLimit) && exp.n === 1
      && cA.body.pace.minIntervalSec === minSec && cA.body.pace.maxPerHour === maxHr && cA.body.pace.capacityPerHour === capLimit,
      `${JSON.stringify(cA.body)} vs db ${JSON.stringify(exp)}`);
    check("capacity: B sees only B's phone; A asking for B's phones → 403; admin with ?ownerId=A gets exactly A's view",
      cB.body.phones.map((x: any) => x.instanceId).join() === pB && cAB.status === 403 && cTA.text === cA.text, `${cB.text} ${cAB.status}`);
    const leakIds = [ig.id, igB.id, f1.id, A.id, B.id];
    check('capacity: aggregates only (keys pace/phones; no account ids, handles or usernames)',
      Object.keys(cA.body).sort().join() === 'pace,phones' && Object.keys(ci).sort().join() === 'capacityPerHour,instanceId,name,overloaded,scheduledAccounts,visitsPerHour'
      && !leakIds.some((x) => cB.text.includes(x)) && !cB.text.includes('natgeo') && !cA.text.includes(`fq1${tag}`), cB.text);
    // Change one account 6 h → 1 h: +1 − 1/6 visits/hour on its phone; pause it: it drops out.
    const before1 = ci.visitsPerHour as number;
    await http('PATCH', `/api/tracked-accounts/${f1.id}`, A.token, { refreshIntervalHours: 1 });
    exp = await dbLoad(pA1);
    let c2 = await capOf(T, pA1);
    check("capacity follows A's change (6 h → 1 h, seen by the admin): +0.83 visits/hour on pA1, count unchanged",
      c2.visitsPerHour === exp.v && Math.abs(c2.visitsPerHour - before1 - (1 - 1 / 6)) < 0.011 && c2.scheduledAccounts === ci.scheduledAccounts, `${before1} → ${c2.visitsPerHour}`);
    await http('PATCH', `/api/tracked-accounts/${f1.id}`, A.token, { status: 'paused' });
    exp = await dbLoad(pA1);
    c2 = await capOf(A.token, pA1);
    check('capacity: a paused account is not counted (the scheduler skips it)', c2.scheduledAccounts === ci.scheduledAccounts - 1 && c2.visitsPerHour === exp.v);
    await http('PATCH', `/api/tracked-accounts/${f1.id}`, A.token, { status: 'active' });
    const moved = await http('PATCH', `/api/tracked-accounts/${f1.id}`, A.token, { instanceId: pA2 });
    const [m1, m2] = [await capOf(A.token, pA1), await capOf(A.token, pA2)];
    check('capacity: moving the account to pA2 moves its load (pA1 → 0, pA2 = DB)', moved.status === 200 && m1.visitsPerHour === 0 && m1.scheduledAccounts === 0
      && m2.visitsPerHour === (await dbLoad(pA2)).v && m2.scheduledAccounts === (await dbLoad(pA2)).n, JSON.stringify([m1, m2]));
    await http('PATCH', `/api/tracked-accounts/${f1.id}`, A.token, { instanceId: pA1 });
    // Over the limit: seed (limit + 1) hourly accounts of user A on pA1 directly → overloaded, nothing refused.
    const many = await db.insert(schema.trackedAccounts).values(Array.from({ length: capLimit + 1 }, (_, i) => ({
      userId: A.id, platform: 'instagram', handle: `cap${i}${tag}`, profileUrl: `https://www.instagram.com/cap${i}${tag}/`, refreshIntervalHours: 1, nextRefreshAt: new Date(Date.now() + HOUR), instanceId: pA1,
    }))).returning({ id: schema.trackedAccounts.id });
    accountIds.push(...many.map((x) => x.id));
    exp = await dbLoad(pA1);
    c2 = await capOf(A.token, pA1);
    check(`capacity over the limit (${capLimit + 1} more hourly accounts on pA1) → overloaded, exact numbers; pA2 unaffected`,
      c2.overloaded === true && c2.visitsPerHour === exp.v && c2.scheduledAccounts === exp.n && exp.v > capLimit && (await capOf(A.token, pA2)).overloaded === false, JSON.stringify(c2));
    r = await http('PATCH', `/api/tracked-accounts/${f2.id}`, A.token, { refreshIntervalHours: 1, instanceId: pA1 });
    check('saving while overloaded is not refused (200)', r.status === 200 && r.body.account.refreshIntervalHours === 1 && r.body.account.instanceId === pA1);
    await db.delete(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, many.map((x) => x.id)));
    c2 = await capOf(A.token, pA1);
    check('capacity back under the limit after removing them', c2.overloaded === false && c2.visitsPerHour === (await dbLoad(pA1)).v);

    // ---- batch 设置采集频率
    const batch = (ids: string[], hours: unknown, tok = A.token) => http('POST', '/api/tracked-accounts/schedule', tok, { ids, refreshIntervalHours: hours });
    const rowOf = async (id: string) => (await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, id)))[0]!;
    await db.update(schema.trackedAccounts).set({ scheduleSkipCode: 'tracked.paused' }).where(eq(schema.trackedAccounts.id, f1.id));
    r = await batch([f1.id, f2.id, f3.id, f4.id, f1.id], 24);
    const r1 = await rowOf(f1.id);
    check('batch 24 h: 3 updated (IG, IG, YouTube), TikTok skipped tracked.schedule_manual_only, duplicate ids once',
      r.status === 200 && [...r.body.updated].sort().join() === [f1.id, f2.id, f3.id].sort().join() && r.body.unchanged.length === 0
      && r.body.skipped.length === 1 && r.body.skipped[0].id === f4.id && r.body.skipped[0].code === 'tracked.schedule_manual_only', r.text.slice(0, 300));
    check('batch writes like a single PATCH: interval 24, first slot within the hour, skip code cleared',
      r1.refreshIntervalHours === 24 && inHour(r1.nextRefreshAt!.toISOString()) && r1.scheduleSkipCode === null
      && (await rowOf(f3.id)).refreshIntervalHours === 24 && (await rowOf(f4.id)).refreshIntervalHours === null);
    const slot1 = r1.nextRefreshAt!.getTime();
    r = await batch([f1.id, f2.id], 24);
    check('batch with the same interval again → unchanged, slot kept', r.status === 200 && r.body.updated.length === 0 && r.body.unchanged.length === 2
      && (await rowOf(f1.id)).nextRefreshAt!.getTime() === slot1);
    r = await batch([f1.id, f4.id], null);
    check('batch off: IG switched off (slot cleared); TikTok off is allowed (unchanged)', r.status === 200 && r.body.updated.join() === f1.id
      && r.body.unchanged.join() === f4.id && r.body.skipped.length === 0 && (await rowOf(f1.id)).nextRefreshAt === null);
    r = await batch([f1.id, igB.id], 6);
    check("batch with another user's account → whole batch 404 tracked.not_found, nothing written",
      r.status === 404 && r.body.code === 'tracked.not_found' && (await rowOf(f1.id)).refreshIntervalHours === null && (await rowOf(igB.id)).refreshIntervalHours === 24, r.text.slice(0, 120));
    r = await batch([f1.id, '00000000-0000-0000-0000-000000000000'], 6);
    check('batch with an unknown id → 404, nothing written', r.status === 404 && (await rowOf(f1.id)).refreshIntervalHours === null);
    r = await batch([igB.id], 6);
    check("user A batch on B's account alone → 404", r.status === 404);
    const bad = await Promise.all([batch([f1.id], 5), batch([], 6), batch(['nope'], 6), http('POST', '/api/tracked-accounts/schedule', A.token, { ids: [f1.id] })]);
    check('batch validation: unsupported interval, empty ids, non-uuid, missing interval → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join(','));
    r = await batch([igB.id], 12, B.token);
    check('user B batch on own account → updated', r.status === 200 && r.body.updated.join() === igB.id && (await rowOf(igB.id)).refreshIntervalHours === 12);
    r = await batch([f1.id, igB.id, f4.id], 3, T);
    check("admin batch across users (A's and B's) → updated both, TikTok skipped", r.status === 200 && r.body.updated.length === 2
      && (await rowOf(f1.id)).refreshIntervalHours === 3 && (await rowOf(igB.id)).refreshIntervalHours === 3 && r.body.skipped[0]?.code === 'tracked.schedule_manual_only');

    // ---- audit: batch action with counts + interval only; create records the interval
    await sleep(500);
    const sb = await sqlClient`select user_id, detail from audit_logs where action = 'tracked.schedule_batch' and at >= ${sectionStart}::timestamptz order by at`;
    const ok200 = sb.filter((x) => x.detail?.updated !== undefined);
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    check('audit tracked.schedule_batch: one entry per batch call, detail = count + interval (+ result counts), never ids',
      sb.length >= 8 && ok200.length === 5 && sb.every((x) => !uuidRe.test(JSON.stringify(x.detail)))
      && JSON.stringify(Object.entries(ok200[0]!.detail).sort()) === JSON.stringify(Object.entries({ count: 5, refreshIntervalHours: 24, updated: 3, unchanged: 0, skipped: 1 }).sort()),
      `${sb.length} entries, first ${JSON.stringify(ok200[0]?.detail)}`);
    const [ca] = await sqlClient`select detail from audit_logs where action = 'tracked.create' and target = ${`Instagram @fq1${tag}`}`;
    check('audit tracked.create records the chosen interval', ca?.detail?.refreshIntervalHours === 6, JSON.stringify(ca));
    await db.delete(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, [f1.id, f2.id, f3.id, f4.id]));
  }

  // ---------------------------------------------------------------- 采集手机 (own cloud phone per tracked account)
  {
    const sectionStart = new Date().toISOString();
    const TA = schema.trackedAccounts;
    const rowOf = async (id: string) => (await db.select().from(TA).where(eq(TA.id, id)))[0]!;
    const C = await (async () => {
      const name = `trc${tag}`;
      const u = await http('POST', '/api/users', T, { username: name, password: pw, role: 'user' });
      const id = u.body.user?.id ?? u.body.id; userIds.push(id);
      return { id, token: await login(name, pw) };
    })();

    // ---- settings endpoints of the removed global collector
    const gone = await Promise.all([http('GET', '/api/settings/tracked-collectors', T), http('PUT', '/api/settings/tracked-collectors/instagram', T, { instanceId: pA1 })]);
    check('removed: GET/PUT /api/settings/tracked-collectors → 404', gone.every((x) => x.status === 404), gone.map((x) => x.status).join(','));

    // ---- picker endpoint
    let r = await http('GET', '/api/tracked-accounts/phones', A.token);
    const pick = r.body.items ?? [];
    check("picker (user A): exactly A's phones by name with state fields, no other user's",
      r.status === 200 && pick.map((x: any) => x.id).join() === [pA1, pA2].join() && pick[1].status === 'stopped' && pick[1].online === false
      && pick.every((x: any) => Object.keys(x).sort().join() === 'external,halted,id,instagramLinked,name,online,status'), r.text.slice(0, 300));
    r = await http('GET', `/api/tracked-accounts/phones?ownerId=${B.id}`, A.token);
    check("picker: a user asking for another owner's phones → 403 tracked.admin_only", r.status === 403 && r.body.code === 'tracked.admin_only');
    r = await http('GET', `/api/tracked-accounts/phones?ownerId=${A.id}`, A.token);
    check('picker: a user may pass their own id', r.status === 200 && r.body.items.length === 2);
    const [rTA, rTB, rT, rC] = await Promise.all([
      http('GET', `/api/tracked-accounts/phones?ownerId=${A.id}`, T), http('GET', `/api/tracked-accounts/phones?ownerId=${B.id}`, T),
      http('GET', '/api/tracked-accounts/phones', T), http('GET', '/api/tracked-accounts/phones', C.token),
    ]);
    check("picker (admin): by owner (A's two, B's one); own = every device (an admin owner may use any phone); C has none",
      rTA.body.items.map((x: any) => x.id).join() === [pA1, pA2].join() && rTB.body.items.map((x: any) => x.id).join() === pB
      && [pA1, pA2, pB].every((d) => rT.body.items.some((x: any) => x.id === d)) && rC.status === 200 && rC.body.items.length === 0);
    // an Instagram social account linked to pA1 → instagramLinked
    const [sa] = await db.insert(schema.socialAccounts).values({ userId: A.id, platform: 'instagram', handle: `trsa${tag}`, instanceId: pA1 }).returning();
    r = await http('GET', '/api/tracked-accounts/phones', A.token);
    check('picker: instagramLinked on the phone an Instagram account is synced to', r.body.items.find((x: any) => x.id === pA1)?.instagramLinked === true
      && r.body.items.find((x: any) => x.id === pA2)?.instagramLinked === false);
    await db.delete(schema.socialAccounts).where(eq(schema.socialAccounts.id, sa!.id));

    // ---- default on create
    const mkA = async (body: Record<string, unknown>, tok: string) => {
      const res = await http('POST', '/api/tracked-accounts', tok, body);
      if (res.body?.account?.id) accountIds.push(res.body.account.id);
      return res;
    };
    await db.insert(schema.instanceGrants).values({ userId: C.id, instanceId: pA2 });
    r = await mkA({ input: `ph1${tag}`, platform: 'instagram' }, C.token);
    const c1 = r.body.account;
    check('create (owner with exactly one phone, instanceId omitted) → that phone, data mode device, phone view',
      r.status === 201 && c1.instanceId === pA2 && c1.dataMode === 'device' && c1.phone?.id === pA2 && c1.phone.allowed === true && c1.phone.halted === false
      && c1.phone.name === `trk-${tag}-2` && c1.phone.online === false, r.text.slice(0, 300));
    r = await mkA({ input: `ph2${tag}`, platform: 'instagram' }, A.token);
    const a2 = r.body.account;
    check('create (owner with two phones, omitted) → no phone, device_unconfigured', r.status === 201 && a2.instanceId === null && a2.phone === null && a2.dataMode === 'device_unconfigured');
    r = await mkA({ input: `ph3${tag}`, platform: 'instagram', instanceId: pA2 }, A.token);
    const a3 = r.body.account;
    check('create with an own phone → set', r.status === 201 && a3.instanceId === pA2);
    r = await mkA({ input: `ph4${tag}`, platform: 'instagram', instanceId: pB }, A.token);
    const n4 = await db.select().from(TA).where(eq(TA.handle, `ph4${tag}`));
    check("create with another user's phone → 400 tracked.phone_not_allowed, nothing created", r.status === 400 && r.body.code === 'tracked.phone_not_allowed' && n4.length === 0);
    r = await mkA({ input: `https://www.youtube.com/@ph5${tag}`, instanceId: pA1 }, A.token);
    check('create YouTube with a phone → 400 tracked.phone_unsupported', r.status === 400 && r.body.code === 'tracked.phone_unsupported');
    r = await mkA({ input: `https://www.youtube.com/@ph6${tag}` }, C.token);
    check('create YouTube (omitted) → no phone even with exactly one', r.status === 201 && r.body.account.instanceId === null && r.body.account.phone === null);
    r = await mkA({ input: `ph7${tag}`, platform: 'instagram', instanceId: null }, C.token);
    check('create Instagram with instanceId null → no phone (the single-phone default only applies when omitted)', r.status === 201 && r.body.account.instanceId === null);
    r = await mkA({ input: `ph8${tag}`, platform: 'instagram', instanceId: 'nope' }, A.token);
    check('create with a non-uuid instanceId → 400', r.status === 400);

    // ---- PATCH
    r = await http('PATCH', `/api/tracked-accounts/${a2.id}`, A.token, { instanceId: pA1 });
    check('PATCH own phone → 200', r.status === 200 && r.body.account.instanceId === pA1 && r.body.account.phone?.id === pA1);
    r = await http('PATCH', `/api/tracked-accounts/${a2.id}`, A.token, { instanceId: pB });
    check("PATCH another user's phone → 400 tracked.phone_not_allowed, unchanged", r.status === 400 && r.body.code === 'tracked.phone_not_allowed' && (await rowOf(a2.id)).instanceId === pA1);
    r = await http('PATCH', `/api/tracked-accounts/${a2.id}`, A.token, { instanceId: '00000000-0000-0000-0000-000000000000' });
    check('PATCH unknown device → 400 tracked.phone_not_allowed (existence not revealed)', r.status === 400 && r.body.code === 'tracked.phone_not_allowed');
    r = await http('PATCH', `/api/tracked-accounts/${a2.id}`, T, { instanceId: pB });
    check("admin PATCH on A's account with B's phone → 400 (the owner's phones count, not the admin's)", r.status === 400 && r.body.code === 'tracked.phone_not_allowed');
    r = await http('PATCH', `/api/tracked-accounts/${a2.id}`, T, { instanceId: pA2 });
    check("admin PATCH on A's account with A's phone → 200", r.status === 200 && r.body.account.instanceId === pA2);
    r = await http('PATCH', `/api/tracked-accounts/${a2.id}`, B.token, { instanceId: pB });
    check("B PATCHing A's account → 404", r.status === 404);
    r = await http('PATCH', `/api/tracked-accounts/${yt.id}`, A.token, { instanceId: pA1 });
    check('PATCH a phone on YouTube → 400 tracked.phone_unsupported', r.status === 400 && r.body.code === 'tracked.phone_unsupported');
    r = await http('PATCH', `/api/tracked-accounts/${a2.id}`, A.token, { instanceId: null });
    check('PATCH null clears it', r.status === 200 && r.body.account.instanceId === null && r.body.account.dataMode === 'device_unconfigured');
    r = await mkA({ input: `pha${tag}`, platform: 'instagram' }, T);
    const adm = r.body.account;
    r = await http('PATCH', `/api/tracked-accounts/${adm.id}`, T, { instanceId: pB });
    check("admin's own account may use any phone (B's)", r.status === 200 && r.body.account.instanceId === pB && r.body.account.phone.allowed === true);

    // ---- batch POST /api/tracked-accounts/phone
    const pbatch = (ids: string[], instanceId: unknown, tok = A.token) => http('POST', '/api/tracked-accounts/phone', tok, { ids, instanceId });
    r = await pbatch([a2.id, a3.id, yt.id, a2.id], pA2);
    check('batch: IG rows set (one updated, one already there = unchanged), YouTube skipped tracked.phone_unsupported, duplicates once',
      r.status === 200 && r.body.updated.join() === a2.id && r.body.unchanged.join() === a3.id && r.body.skipped.length === 1
      && r.body.skipped[0].id === yt.id && r.body.skipped[0].code === 'tracked.phone_unsupported' && (await rowOf(a2.id)).instanceId === pA2, r.text.slice(0, 300));
    r = await pbatch([a2.id, igB.id], pA1);
    check("batch with another user's account → whole batch 404 tracked.not_found, nothing written",
      r.status === 404 && r.body.code === 'tracked.not_found' && (await rowOf(a2.id)).instanceId === pA2);
    r = await pbatch([a2.id], pB);
    check("batch with another user's phone → row skipped tracked.phone_not_allowed", r.status === 200 && r.body.updated.length === 0 && r.body.skipped[0]?.code === 'tracked.phone_not_allowed' && (await rowOf(a2.id)).instanceId === pA2);
    r = await pbatch([a2.id, igB.id, c1.id], pB, T);
    check("admin batch across owners with B's phone → B's row updated, A's and C's skipped tracked.phone_not_allowed",
      r.status === 200 && r.body.updated.join() === igB.id && r.body.skipped.length === 2 && r.body.skipped.every((s: any) => s.code === 'tracked.phone_not_allowed')
      && (await rowOf(igB.id)).instanceId === pB, r.text.slice(0, 300));
    r = await pbatch([a2.id], null);
    check('batch null clears', r.status === 200 && r.body.updated.join() === a2.id && (await rowOf(a2.id)).instanceId === null);
    const badB = await Promise.all([pbatch([], pA1), pbatch(['x'], pA1), http('POST', '/api/tracked-accounts/phone', A.token, { ids: [a2.id] }), pbatch([a2.id], 'nope')]);
    check('batch validation: empty ids, non-uuid id, missing instanceId, non-uuid instanceId → 400', badB.every((x) => x.status === 400), badB.map((x) => x.status).join(','));

    // ---- refusals: no phone / not allowed / halted / offline
    const codes = async (id: string, tok = A.token) => Promise.all([
      http('POST', `/api/tracked-accounts/${id}/refresh`, tok), http('POST', `/api/tracked-accounts/${id}/sync`, tok), http('POST', `/api/tracked-accounts/${id}/collect`, tok),
    ]);
    let cs = await codes(a2.id);
    check('no phone: refresh / 同步 / 立即采集 → 400 tracked.no_phone, no task', cs.every((x) => x.status === 400 && x.body.code === 'tracked.no_phone')
      && (await db.select().from(schema.tasks).where(eq(schema.tasks.refId, a2.id))).length === 0, cs.map((x) => `${x.status} ${x.body?.code}`).join(','));
    r = await http('POST', '/api/tracked-accounts/refresh', A.token, { ids: [a2.id] });
    check('no phone: batch refresh skips tracked.no_phone', r.body.skipped?.[0]?.code === 'tracked.no_phone');
    // phone taken away from the owner after it was set: refused at run time, list shows it as not allowed
    await db.insert(schema.instanceGrants).values({ userId: A.id, instanceId: pB });
    await http('PATCH', `/api/tracked-accounts/${a2.id}`, A.token, { instanceId: pB });
    await db.delete(schema.instanceGrants).where(sql`${schema.instanceGrants.userId} = ${A.id} and ${schema.instanceGrants.instanceId} = ${pB}`);
    cs = await codes(a2.id);
    const la = (await http('GET', `/api/tracked-accounts/${a2.id}`, A.token)).body.account;
    check("phone no longer the owner's: refresh / 同步 / 立即采集 → 400 tracked.phone_not_allowed; item phone.allowed false, device_unconfigured",
      cs.every((x) => x.status === 400 && x.body.code === 'tracked.phone_not_allowed') && la.phone?.id === pB && la.phone.allowed === false && la.dataMode === 'device_unconfigured',
      cs.map((x) => `${x.status} ${x.body?.code}`).join(','));
    // halted phone (risk.halts): refresh / sync 409 collector_halted, collect 409 feed.device_halted
    await http('PATCH', `/api/tracked-accounts/${a2.id}`, A.token, { instanceId: pA1 });
    const [hrow] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'risk.halts'));
    const halts0 = (hrow?.value as Record<string, unknown> | undefined) ?? {};
    await db.insert(schema.settings).values({ key: 'risk.halts', value: { ...halts0, [pA1]: { at: new Date().toISOString(), code: 'tracked.collector_challenge', source: 'collector', platform: 'instagram' } } })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: { ...halts0, [pA1]: { at: new Date().toISOString(), code: 'tracked.collector_challenge', source: 'collector', platform: 'instagram' } } } });
    cs = await codes(a2.id);
    const lh = (await http('GET', `/api/tracked-accounts/${a2.id}`, A.token)).body.account;
    const phonePick = (await http('GET', '/api/tracked-accounts/phones', A.token)).body.items.find((x: any) => x.id === pA1);
    check('halted phone: refresh / 同步 → 409 tracked.collector_halted, 立即采集 → 409 feed.device_halted; item + picker say halted',
      cs[0].status === 409 && cs[0].body.code === 'tracked.collector_halted' && cs[1].body.code === 'tracked.collector_halted' && cs[2].status === 409 && cs[2].body.code === 'feed.device_halted'
      && lh.phone?.halted === true && lh.dataMode === 'device_unconfigured' && phonePick?.halted === true, cs.map((x) => `${x.status} ${x.body?.code}`).join(','));
    await db.update(schema.settings).set({ value: halts0 }).where(eq(schema.settings.key, 'risk.halts'));
    // own phone set, not halted: queued, the placeholder phone is offline → the task fails tracked.collector_offline
    await http('PATCH', `/api/tracked-accounts/${a2.id}`, A.token, { refreshIntervalHours: null });
    r = await http('POST', `/api/tracked-accounts/${a2.id}/refresh`, A.token);
    const off = r.status === 202 ? await waitTask(r.body.taskId) : null;
    check('own phone set: refresh queued (202), placeholder offline → task fails tracked.collector_offline, account error',
      r.status === 202 && off?.status === 'failed' && off.errorCode === 'tracked.collector_offline' && (await rowOf(a2.id)).lastErrorCode === 'tracked.collector_offline', `${r.status} ${off?.errorCode}`);
    r = await http('POST', `/api/tracked-accounts/${a2.id}/collect`, A.token);
    const offF = r.status === 202 ? await waitTask(r.body.task.id) : null;
    check('立即采集 on the own phone: queued (202), offline → feed task fails feed.offline', r.status === 202 && offF?.status === 'failed' && offF.errorCode === 'feed.offline', `${r.status} ${offF?.errorCode} ${r.text.slice(0, 100)}`);
    const fd = (await http('GET', `/api/tracked-accounts/${a2.id}/feed`, A.token)).body;
    check("tracked feed API: collection state names the account's own phone", fd.collect?.instanceId === pA1 && fd.collect.halted === false, JSON.stringify(fd.collect).slice(0, 200));

    // ---- 定时采集 skips with the phone codes (no task)
    const due = new Date(Date.now() - 60_000);
    await db.update(TA).set({ refreshIntervalHours: 24, nextRefreshAt: due, status: 'active' }).where(inArray(TA.id, [a3.id, c1.id]));
    await db.update(TA).set({ instanceId: null }).where(eq(TA.id, a3.id));
    await db.update(TA).set({ instanceId: pB }).where(eq(TA.id, c1.id)); // C has no grant on pB
    const before = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.refId, [a3.id, c1.id]));
    const sres = await scheduleTrackedRefreshes();
    const [s3, s1] = [await rowOf(a3.id), await rowOf(c1.id)];
    const after = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.refId, [a3.id, c1.id]));
    check('scheduler: slot skipped with tracked.no_phone / tracked.phone_not_allowed, slot advanced, no task',
      s3.scheduleSkipCode === 'tracked.no_phone' && s1.scheduleSkipCode === 'tracked.phone_not_allowed' && s3.nextRefreshAt!.getTime() > Date.now()
      && sres.skipped.some((s) => s.id === a3.id && s.code === 'tracked.no_phone') && after.length === before.length, JSON.stringify(sres.skipped.filter((s) => [a3.id, c1.id].includes(s.id))));
    // feed schedule: only tracked accounts whose phone is set, the owner's, running and not halted
    await db.update(TA).set({ instanceId: pA1, status: 'active', refreshIntervalHours: 24 }).where(eq(TA.id, a2.id));
    await db.update(schema.instances).set({ status: 'running', adbState: 'device' }).where(eq(schema.instances.id, pA1));
    const feedBefore = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(sql`${schema.tasks.type} = 'feed-collect' and ${schema.tasks.refId} in (${a2.id}, ${a3.id}, ${c1.id})`);
    await scheduleFeedCollects(new Date(), 24 * 3600_000 + 60_000);
    const feedTasks = await db.select({ refId: schema.tasks.refId }).from(schema.tasks).where(sql`${schema.tasks.type} = 'feed-collect' and ${schema.tasks.refId} in (${a2.id}, ${a3.id}, ${c1.id}) and ${schema.tasks.idempotencyKey} like 'feed:tracked:%'`);
    check('feed schedule: a slot for the account on its own running phone, none without a phone or on a phone not the owner\'s',
      feedTasks.some((x) => x.refId === a2.id) && !feedTasks.some((x) => x.refId === a3.id || x.refId === c1.id), `${feedBefore.length} → ${JSON.stringify(feedTasks)}`);
    await db.delete(schema.tasks).where(sql`${schema.tasks.type} = 'feed-collect' and ${schema.tasks.refId} in (${a2.id}, ${a3.id}, ${c1.id}) and ${schema.tasks.status} in ('pending', 'scheduled')`);
    await db.update(TA).set({ refreshIntervalHours: null, nextRefreshAt: null }).where(inArray(TA.id, [a2.id, a3.id, c1.id]));

    // ---- device deleted → phone unset (FK set null)
    await db.update(TA).set({ instanceId: pA2 }).where(eq(TA.id, a3.id));
    await db.delete(schema.instances).where(eq(schema.instances.id, pA2));
    devIds.splice(devIds.indexOf(pA2), 1);
    const z = (await http('GET', `/api/tracked-accounts/${a3.id}`, A.token)).body.account;
    check('device deleted → the account has no phone (instance_id null), device_unconfigured', z.instanceId === null && z.phone === null && z.dataMode === 'device_unconfigured');

    // ---- audit
    await sleep(500);
    const pa = await sqlClient`select detail from audit_logs where action = 'tracked.phone_batch' and at >= ${sectionStart}::timestamptz order by at`;
    const okB = pa.filter((x) => x.detail?.updated !== undefined);
    check('audit tracked.phone_batch: one entry per call, detail = count + instanceId (+ result counts), no account ids',
      pa.length >= 6 && okB.length >= 4 && JSON.stringify(Object.entries(okB[0]!.detail).sort()) === JSON.stringify(Object.entries({ count: 4, instanceId: pA2, updated: 1, unchanged: 1, skipped: 1 }).sort())
      && !pa.some((x) => JSON.stringify(x.detail).includes(a2.id)), `${pa.length} ${JSON.stringify(okB[0]?.detail)}`);
    const [up] = await sqlClient`select detail from audit_logs where action = 'tracked.update' and target_id = ${a2.id} and detail->>'instanceId' = ${pA1} limit 1`;
    const [crt] = await sqlClient`select detail from audit_logs where action = 'tracked.create' and target = ${`Instagram @ph1${tag}`}`;
    check('audit: PATCH records instanceId; create records the phone chosen (default included)', !!up && crt?.detail?.instanceId === pA2, JSON.stringify(crt));
  }

  // ---------------------------------------------------------------- YouTube API key: admin only, write-only, encrypted
  r = await http('GET', '/api/settings/youtube', A.token);
  const r2 = await http('PUT', '/api/settings/youtube', A.token, { apiKey: DUMMY_KEY });
  check('non-admin cannot read or set the API key (403)', r.status === 403 && r2.status === 403);
  const before = (await http('GET', '/api/settings/youtube', T)).body.youtube;
  keyWasSet = before.apiKeySet;
  if (before.apiKeySet && !process.env.YOUTUBE_TEST_API_KEY) {
    check('API key write-only checks skipped: a key is already configured in this DB (not overwritten)', true);
  } else {
    r = await http('PUT', '/api/settings/youtube', T, { apiKey: 'short' });
    check('malformed key rejected 400', r.status === 400);
    keyTouched = true;
    r = await http('PUT', '/api/settings/youtube', T, { apiKey: DUMMY_KEY });
    check('admin sets key: response says set, never contains it', r.status === 200 && r.body.youtube.apiKeySet === true && !r.text.includes(DUMMY_KEY));
    const g = await http('GET', '/api/settings/youtube', T);
    check('GET shows only apiKeySet', g.body.youtube.apiKeySet === true && !g.text.includes(DUMMY_KEY) && !g.text.includes('v1:'));
    const plat = (await http('GET', '/api/tracked-accounts/platforms', A.token)).body.platforms;
    const ytp = plat.find((p: any) => p.id === 'youtube');
    check('platforms: YouTube API configured; Instagram a device source (configured per account by its 采集手机); TikTok none', ytp.api?.configured === true && ytp.api.kind === 'api'
      && plat.find((p: any) => p.id === 'instagram').api?.kind === 'device' && plat.find((p: any) => p.id === 'tiktok').api === null && !JSON.stringify(plat).includes(DUMMY_KEY));
    const lst = (await http('GET', `/api/tracked-accounts/${yt.id}`, A.token)).body.account;
    check('account data mode becomes api', lst.dataMode === 'api');
    const [st] = await sqlClient`select value::text as v from settings where key = 'youtube'`;
    check('key stored encrypted (v1:), not in plaintext', String(st!.v).includes('v1:') && !String(st!.v).includes(DUMMY_KEY));
    r = await http('PUT', '/api/settings/youtube', T, { apiKey: null });
    check('admin clears the key', r.body.youtube?.apiKeySet === false);
    await sleep(300);
    const leaks = await sqlClient`select (select count(*) from audit_logs where audit_logs::text like ${'%' + DUMMY_KEY + '%'})::int as a,
      (select count(*) from settings where settings::text like ${'%' + DUMMY_KEY + '%'})::int as s`;
    check('no plaintext key in audit_logs or settings', leaks[0]!.a === 0 && leaks[0]!.s === 0);
  }

  // ---------------------------------------------------------------- optional: real YouTube Data API (only with a real key)
  if (process.env.YOUTUBE_TEST_API_KEY) {
    keyTouched = true;
    await http('PUT', '/api/settings/youtube', T, { apiKey: process.env.YOUTUBE_TEST_API_KEY });
    r = await http('POST', '/api/tracked-accounts', A.token, { input: 'https://www.youtube.com/@YouTube' });
    const live = r.body.account; accountIds.push(live.id);
    r = await http('POST', `/api/tracked-accounts/${live.id}/refresh`, A.token);
    const lt = await waitTask(r.body.taskId, 60_000);
    a = (await http('GET', `/api/tracked-accounts/${live.id}`, A.token)).body.account;
    const posts = (await http('GET', `/api/tracked-accounts/${live.id}/posts`, A.token)).body;
    check('LIVE YouTube refresh: task succeeded, channel id, subscriber snapshot, recent videos', lt.status === 'success' && /^UC/.test(a.externalId ?? '')
      && a.latest?.source === 'api' && a.latest.followers > 0 && posts.total > 0, `${lt.status} ${lt.error ?? ''} posts=${posts.total}`);
    await http('PUT', '/api/settings/youtube', T, { apiKey: null });
  }

  // ---------------------------------------------------------------- audit
  await sleep(500);
  const acts = await sqlClient`select distinct action from audit_logs where action like 'tracked.%' or action = 'settings.youtube_api_key'`;
  const have = new Set(acts.map((x) => x.action as string));
  const need = ['tracked.create', 'tracked.update', 'tracked.snapshot_delete', 'tracked.post_delete', 'tracked.refresh', 'tracked.refresh_batch',
    ...(keyTouched ? ['settings.youtube_api_key'] : [])];
  check('audit actions recorded', need.every((x) => have.has(x)), [...have].sort().join(','));
  const [cr] = await sqlClient`select target, detail from audit_logs where action = 'tracked.create' and user_id = ${A.id} order by at limit 1`;
  check('audit create entry has a readable target + id', cr?.target === 'Instagram @natgeo' && cr?.detail?.id === ig.id, JSON.stringify(cr));
  const [ka] = await sqlClient`select detail from audit_logs where action = 'settings.youtube_api_key' order by at desc limit 1`;
  if (keyTouched) check('key audit detail only says set/cleared', ka && Object.keys(ka.detail).join() === 'set');

  // ---------------------------------------------------------------- delete account and user (cascade)
  r = await http('DELETE', `/api/tracked-accounts/${ig.id}`, A.token);
  const leftS = await db.select().from(schema.trackedAccountSnapshots).where(eq(schema.trackedAccountSnapshots.trackedAccountId, ig.id));
  const leftP = await db.select().from(schema.trackedPosts).where(eq(schema.trackedPosts.trackedAccountId, ig.id));
  check('delete account 204; snapshots and posts cascade', r.status === 204 && leftS.length === 0 && leftP.length === 0);
  await seed(igB.id, Date.now(), { followers: 7, source: 'device' });
  await upsertPosts(db, igB.id, [P('b1')], 'api');
  r = await http('DELETE', `/api/users/${B.id}`, T);
  const leftB = await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.userId, B.id));
  check('deleting a user with tracked data succeeds (cascade)', r.status === 204 && leftB.length === 0);
  if (r.status === 204) userIds.splice(userIds.indexOf(B.id), 1);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  if (keyTouched) await http('PUT', '/api/settings/youtube', T, { apiKey: null });
  if (devIds.length) {
    const halts = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'risk.halts')))[0]?.value as Record<string, unknown> | undefined;
    if (halts && devIds.some((d) => d in halts)) {
      for (const d of devIds) delete halts[d];
      await db.update(schema.settings).set({ value: halts }).where(eq(schema.settings.key, 'risk.halts'));
    }
    await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
  }
  await ph.cleanup();
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (accountIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.refId, accountIds));
  // rows of the admin (采集手机 checks) are not removed by deleting the test users
  if (accountIds.length) await db.delete(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, accountIds));
  const left = await db.select().from(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000']));
  const leftUsers = await db.select().from(schema.users).where(sql`${schema.users.username} like ${`tr_${tag}`}`);
  check('cleanup: test users, accounts and tasks removed', left.length === 0 && leftUsers.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
