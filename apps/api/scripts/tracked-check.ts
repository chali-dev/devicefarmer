/**
 * Tracked accounts (追踪账号) test through the public API against the real API, DB and BullMQ queue (no mocks).
 * - Creates two temporary users (A, B) and their tracked accounts; deletes everything afterwards. Manual entry was
 *   removed (POST …/snapshots and …/posts are 404 now); history rows (legacy `manual` and `device` ones) are seeded
 *   directly in the DB to test deltas, ordering, approx flags and deletion.
 * - Never touches a phone: an Instagram collector device configured in this DB is unset for the run and restored
 *   afterwards (the collector itself is covered by tracked-device-check.ts).
 * - Needs TikTok and YouTube enabled: run the API (and this script) with ENABLED_PLATFORMS=all.
 * - Never calls an external platform: the YouTube API key set here is a syntactically valid dummy that is cleared
 *   again before any refresh could use it. The real YouTube Data API path runs only when YOUTUBE_TEST_API_KEY is
 *   set (then it refreshes the public channel @YouTube once, costing ~3 quota units).
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/tracked-check.ts
 */
import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { refreshTrackedAccount, upsertPosts } from '../src/modules/tracked/tracked.js';
import { migrateTrackedIgSchedule } from '../src/db/tracked-schedule-migration.js';
import { withCaptcha } from './lib/login.js';

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
const prevCollector = (await http('GET', '/api/settings/tracked-collectors', T)).body?.collectors?.find((c: any) => c.platform === 'instagram')?.instanceId ?? null;
if (prevCollector) await http('PUT', '/api/settings/tracked-collectors/instagram', T, { instanceId: null });

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
  check('create (URL) 201, tags normalised, collector data mode (no collector set), 定时采集 24 h by default', r.status === 201 && r.body.account.platform === 'instagram'
    && r.body.account.handle === 'natgeo' && JSON.stringify(r.body.account.tags) === '["travel","photo"]'
    && r.body.account.status === 'active' && r.body.account.dataMode === 'device_unconfigured' && r.body.account.followers === null
    && r.body.account.refreshIntervalHours === 24 && !!r.body.account.nextRefreshAt, r.text.slice(0, 160));
  const ig = r.body.account; accountIds.push(ig.id);
  const igCat = async () => (await db.select({ c: schema.trackedAccounts.category }).from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, ig.id)))[0]?.c;
  check('create: category in the body ignored (no category in the response, column stays null)', !('category' in ig) && await igCat() === null, r.text.slice(0, 160));
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
  check('update: category ignored (200, no category in the response, column stays null)', r.status === 200 && r.body.account.notes === 'nat geo 2'
    && !('category' in r.body.account) && await igCat() === null, r.text.slice(0, 160));
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

  // ---------------------------------------------------------------- data migration: existing Instagram rows → 定时采集 24 h, once
  {
    const TA = schema.trackedAccounts;
    const marker = `migration.tracked_ig_schedule.test-${tag}`;
    const legacy = await db.insert(TA).values([
      { userId: A.id, platform: 'instagram', handle: `mig1${tag}`, profileUrl: `https://www.instagram.com/mig1${tag}/` },
      { userId: A.id, platform: 'instagram', handle: `mig2${tag}`, profileUrl: `https://www.instagram.com/mig2${tag}/` },
      { userId: A.id, platform: 'youtube', handle: `mig3${tag}`, profileUrl: `https://www.youtube.com/@mig3${tag}` },
    ]).returning();
    accountIds.push(...legacy.map((x) => x.id));
    const ids = legacy.map((x) => x.id);
    const m1 = await migrateTrackedIgSchedule(sqlClient, () => undefined, { marker, onlyIds: ids });
    const after1 = await db.select().from(TA).where(inArray(TA.id, ids));
    const ig1 = after1.filter((x) => x.platform === 'instagram');
    check('IG schedule migration: existing Instagram rows without an interval → 24 h, first slot within the hour; YouTube untouched',
      m1.updated === 2 && !m1.skipped && ig1.every((x) => x.refreshIntervalHours === 24 && !!x.nextRefreshAt && x.nextRefreshAt.getTime() - Date.now() <= 3600_000)
      && after1.find((x) => x.platform === 'youtube')!.refreshIntervalHours === null, JSON.stringify(m1));
    await db.update(TA).set({ refreshIntervalHours: null, nextRefreshAt: null }).where(eq(TA.id, ids[0]!));
    const m2 = await migrateTrackedIgSchedule(sqlClient, () => undefined, { marker, onlyIds: ids });
    const [off] = await db.select().from(TA).where(eq(TA.id, ids[0]!));
    check('IG schedule migration runs once: rerun is a no-op, an interval switched off afterwards stays off', m2.skipped && m2.updated === 0 && off!.refreshIntervalHours === null);
    await db.delete(schema.settings).where(eq(schema.settings.key, marker));
    await db.delete(TA).where(inArray(TA.id, ids));
  }

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
  check('data modes that drive the UI: Instagram device_unconfigured (no collector), TikTok manual_only (no source), YouTube api_unconfigured',
    modes.instagram === 'device_unconfigured' && modes.tiktok === 'manual_only' && modes.youtube === 'api_unconfigured', JSON.stringify(modes));
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { refreshIntervalHours: 6 });
  check('Instagram schedule can be changed (6 h)', r.status === 200 && r.body.account.refreshIntervalHours === 6);
  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { refreshIntervalHours: null });
  check('Instagram schedule can be switched off', r.status === 200 && r.body.account.refreshIntervalHours === null && r.body.account.nextRefreshAt === null);
  r = await http('PATCH', `/api/tracked-accounts/${tt.id}`, A.token, { refreshIntervalHours: 6 });
  check('schedule on a platform without a source is refused (400 tracked.schedule_manual_only)', r.status === 400 && r.body.code === 'tracked.schedule_manual_only');
  r = await http('POST', `/api/tracked-accounts/${ig.id}/refresh`, A.token);
  check('Instagram refresh without a collector device → 400 tracked.collector_unset (no task)', r.status === 400 && r.body.code === 'tracked.collector_unset');
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
  check('batch refresh: skipped no-collector / no-key / paused / foreign (not_found)', r.status === 202 && r.body.queued.length === 0
    && sk[ig.id] === 'tracked.collector_unset' && sk[yt.id] === 'tracked.youtube_no_api_key' && sk[tt.id] === 'tracked.paused' && sk[igB.id] === 'tracked.not_found', JSON.stringify(sk));
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
  check('refreshTrackedAccount(Instagram, no collector) → tracked.collector_unset, no phone touched', igErr?.code === 'tracked.collector_unset');
  await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { status: 'active' });

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
    check('platforms: YouTube API configured; Instagram a device source (not configured); TikTok none', ytp.api?.configured === true && ytp.api.kind === 'api'
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
  if (prevCollector) await http('PUT', '/api/settings/tracked-collectors/instagram', T, { instanceId: prevCollector });
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (accountIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.refId, accountIds));
  const left = await db.select().from(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000']));
  const leftUsers = await db.select().from(schema.users).where(sql`${schema.users.username} like ${`tr_${tag}`}`);
  check('cleanup: test users, accounts and tasks removed', left.length === 0 && leftUsers.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
