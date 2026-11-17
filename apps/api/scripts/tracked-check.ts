/**
 * Tracked accounts (追踪账号) test through the public API against the real API, DB and BullMQ queue (no mocks).
 * - Creates two temporary users (A, B), their tracked accounts, snapshots and posts; deletes everything afterwards.
 * - Never calls an external platform: the YouTube API key set here is a syntactically valid dummy that is cleared
 *   again before any refresh could use it. The real YouTube Data API path runs only when YOUTUBE_TEST_API_KEY is
 *   set (then it refreshes the public channel @YouTube once, costing ~3 quota units).
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/tracked-check.ts
 */
import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema, sqlClient } from '../src/db/index.js';
import { refreshTrackedAccount } from '../src/modules/tracked/tracked.js';
import { withCaptcha } from './lib/login.js';

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
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
    input: 'https://www.instagram.com/NatGeo/', category: 'Media', tags: ['Travel', 'travel', ' Photo '], notes: 'nat geo',
  });
  check('create (URL) 201, tags normalised, manual_only data mode', r.status === 201 && r.body.account.platform === 'instagram'
    && r.body.account.handle === 'natgeo' && JSON.stringify(r.body.account.tags) === '["travel","photo"]'
    && r.body.account.status === 'active' && r.body.account.dataMode === 'manual_only' && r.body.account.followers === null, r.text.slice(0, 160));
  const ig = r.body.account; accountIds.push(ig.id);
  r = await http('POST', '/api/tracked-accounts', A.token, { input: '@NATGEO', platform: 'instagram' });
  check('duplicate (same user, platform, handle) refused 409 tracked.duplicate', r.status === 409 && r.body.code === 'tracked.duplicate');
  r = await http('POST', '/api/tracked-accounts', B.token, { input: 'natgeo', platform: 'instagram', category: 'B-cat' });
  check('another user may track the same account', r.status === 201);
  const igB = r.body.account; accountIds.push(igB.id);
  r = await http('POST', '/api/tracked-accounts', A.token, { input: `https://www.youtube.com/channel/${CH}`, category: 'Creators', tags: ['travel'] });
  const yt = r.body.account; accountIds.push(yt.id);
  check('YouTube account: external id from URL, data mode api_unconfigured (no key)', r.status === 201 && yt.externalId === CH && yt.dataMode === 'api_unconfigured', yt?.dataMode);
  r = await http('POST', '/api/tracked-accounts', A.token, { input: 'https://www.tiktok.com/@Khaby.Lame', favorite: true, displayName: 'Khaby' });
  const tt = r.body.account; accountIds.push(tt.id);
  check('create TikTok as favorite', r.status === 201 && tt.favorite === true && tt.displayName === 'Khaby');

  r = await http('PATCH', `/api/tracked-accounts/${ig.id}`, A.token, { displayName: 'National Geographic', bio: 'bio', avatarUrl: 'https://example.org/a.jpg' });
  check('update profile fields', r.status === 200 && r.body.account.displayName === 'National Geographic' && r.body.account.avatarUrl === 'https://example.org/a.jpg');
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

  // ---------------------------------------------------------------- snapshots + delta
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();
  r = await http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, {});
  check('empty snapshot → 400 tracked.snapshot_empty', r.status === 400 && r.body.code === 'tracked.snapshot_empty');
  r = await http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, { followers: 5, capturedAt: iso(now + 3600_000) });
  check('future snapshot → 400 tracked.future_time', r.status === 400 && r.body.code === 'tracked.future_time');
  r = await http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, { followers: -1 });
  check('negative count → 400', r.status === 400);
  r = await http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, { followers: 1000, following: 10, posts: 50, capturedAt: iso(now - 2 * day) });
  check('manual snapshot 201 (source manual)', r.status === 201 && r.body.snapshot.source === 'manual' && r.body.snapshot.followers === 1000);
  const snap1 = r.body.snapshot.id;
  await http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, { followers: 1200, posts: 52, capturedAt: iso(now - day) });
  await http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, { following: 11, capturedAt: iso(now - 3600_000) });
  r = await http('GET', `/api/tracked-accounts/${ig.id}`, A.token);
  let a = r.body.account;
  check('latest followers 1200, delta +200 (snapshot without followers ignored)', a.followers === 1200 && a.followersDelta === 200 && a.latest.following === 11 && a.latest.followers === null,
    `followers=${a.followers} delta=${a.followersDelta}`);
  check('manual entry updates last checked + source', a.lastSource === 'manual' && Math.abs(new Date(a.lastCheckedAt).getTime() - (now - 3600_000)) < 2000);
  await http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, A.token, { followers: 1100 });
  a = (await http('GET', `/api/tracked-accounts/${ig.id}`, A.token)).body.account;
  check('drop to 1100 → delta −100', a.followers === 1100 && a.followersDelta === -100);
  r = await http('GET', `/api/tracked-accounts/${ig.id}/snapshots`, A.token);
  const times = r.body.snapshots.map((s: any) => new Date(s.capturedAt).getTime());
  check('snapshot history returned oldest first (4 rows)', r.body.snapshots.length === 4 && times.every((t: number, i: number) => i === 0 || t >= times[i - 1]));
  r = await http('DELETE', `/api/tracked-accounts/${ig.id}/snapshots/${snap1}`, A.token);
  check('delete snapshot 204', r.status === 204);
  r = await http('DELETE', `/api/tracked-accounts/${ig.id}/snapshots/${snap1}`, A.token);
  check('delete it again → 404 tracked.snapshot_not_found', r.status === 404 && r.body.code === 'tracked.snapshot_not_found');
  r = await http('POST', `/api/tracked-accounts/${yt.id}/snapshots`, A.token, { followers: 300, capturedAt: iso(now - day) });
  r = await http('GET', `/api/tracked-accounts/${yt.id}`, A.token);
  check('single snapshot → delta null', r.body.account.followers === 300 && r.body.account.followersDelta === null);

  // ---------------------------------------------------------------- posts (dedupe by external id)
  r = await http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { externalId: 'C1', title: 'First', views: 10, publishedAt: iso(now - 3 * day) });
  check('add post 201 created', r.status === 201 && r.body.created === true && r.body.post.title === 'First');
  const first = r.body.post;
  await sleep(20);
  r = await http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { externalId: 'C1', views: 20, likes: 3 });
  const p2 = r.body.post;
  check('same external id → 200 updated (title kept, metrics updated, first seen unchanged)', r.status === 200 && r.body.created === false
    && p2.id === first.id && p2.title === 'First' && p2.views === 20 && p2.likes === 3 && p2.firstSeenAt === first.firstSeenAt
    && new Date(p2.lastSeenAt) > new Date(first.lastSeenAt) && p2.publishedAt === first.publishedAt);
  r = await http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { url: 'https://www.instagram.com/p/XYZ/', title: 'By URL', publishedAt: iso(now - day) });
  const byUrl = r.body.post;
  r = await http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { url: 'https://www.instagram.com/p/XYZ#frag' });
  check('post without id deduplicated by URL', r.status === 200 && r.body.post.id === byUrl.id && byUrl.externalId === 'https://www.instagram.com/p/XYZ');
  r = await http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { title: 'nothing' });
  check('post without id or URL → 400 tracked.post_id_required', r.status === 400 && r.body.code === 'tracked.post_id_required');
  r = await http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { url: 'javascript:alert(1)' });
  check('non-http post URL rejected 400', r.status === 400);
  await http('POST', `/api/tracked-accounts/${ig.id}/posts`, A.token, { externalId: 'undated', title: 'no date' });
  r = await http('GET', `/api/tracked-accounts/${ig.id}/posts`, A.token);
  check('posts ordered by published date desc, undated last', r.body.total === 3 && r.body.posts.map((p: any) => p.externalId).join(',') === `https://www.instagram.com/p/XYZ,C1,undated`,
    r.body.posts.map((p: any) => p.externalId).join(','));
  r = await http('DELETE', `/api/tracked-accounts/${ig.id}/posts/${byUrl.id}`, A.token);
  check('delete post 204', r.status === 204);

  // ---------------------------------------------------------------- filters + facets
  const list = async (qs: string, tok = A.token) => (await http('GET', `/api/tracked-accounts?${qs}`, tok)).body;
  const idsOf = (b: any) => b.items.map((x: any) => x.id).sort().join(',');
  const want = (...xs: any[]) => xs.map((x) => x.id).sort().join(',');
  check('filter platform', idsOf(await list('platform=instagram')) === want(ig));
  check('filter category', idsOf(await list('category=Creators')) === want(yt));
  check("filter category 'none'", idsOf(await list('category=none')) === want(tt));
  check('filter tag (case-insensitive)', idsOf(await list('tag=TRAVEL')) === want(ig, yt));
  check('filter favorites', idsOf(await list('favorite=true')) === want(tt));
  check('filter status', idsOf(await list('status=paused')) === want(tt));
  check('search display name / handle', idsOf(await list('q=geographic')) === want(ig) && idsOf(await list('q=khaby')) === want(tt));
  const fac = (await http('GET', '/api/tracked-accounts/facets', A.token)).body;
  check('facets: own categories and tags only', JSON.stringify(fac.categories) === '["Creators","Media"]' && JSON.stringify(fac.tags) === '["photo","travel"]', JSON.stringify(fac));
  const all = await list('');
  check('list favorites first, total 3', all.total === 3 && all.items[0].id === tt.id);

  // ---------------------------------------------------------------- RBAC isolation
  const b404 = await Promise.all([
    http('GET', `/api/tracked-accounts/${ig.id}`, B.token),
    http('PATCH', `/api/tracked-accounts/${ig.id}`, B.token, { favorite: true }),
    http('DELETE', `/api/tracked-accounts/${ig.id}`, B.token),
    http('GET', `/api/tracked-accounts/${ig.id}/snapshots`, B.token),
    http('POST', `/api/tracked-accounts/${ig.id}/snapshots`, B.token, { followers: 1 }),
    http('GET', `/api/tracked-accounts/${ig.id}/posts`, B.token),
    http('POST', `/api/tracked-accounts/${ig.id}/posts`, B.token, { externalId: 'x' }),
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

  // ---------------------------------------------------------------- refresh via the real queue
  r = await http('POST', `/api/tracked-accounts/${ig.id}/refresh`, A.token);
  check('refresh manual-only account → 202 task (manualOnly)', r.status === 202 && !!r.body.taskId && r.body.manualOnly === true, r.text.slice(0, 120));
  const t1 = await waitTask(r.body.taskId);
  const [taskRow] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, r.body.taskId));
  check('task row reaches succeeded (type tracked-refresh, ref tracked_account)', t1.status === 'success' && taskRow!.type === 'tracked-refresh'
    && taskRow!.refType === 'tracked_account' && taskRow!.refId === ig.id && taskRow!.instanceId === null, `${t1.status} ${t1.error ?? ''}`);
  a = (await http('GET', `/api/tracked-accounts/${ig.id}`, A.token)).body.account;
  check('manual-only refresh leaves the account active without error; lastRefresh exposed', a.status === 'active' && !a.lastError && a.lastRefresh?.status === 'success');
  // Refresh dedupe: an unfinished refresh task blocks another.
  const [fake] = await db.insert(schema.tasks).values({ type: 'tracked-refresh', refType: 'tracked_account', refId: ig.id, status: 'running', instanceName: 'test' }).returning();
  r = await http('POST', `/api/tracked-accounts/${ig.id}/refresh`, A.token);
  check('refresh while one is running → 409 tracked.refresh_in_progress', r.status === 409 && r.body.code === 'tracked.refresh_in_progress');
  await db.delete(schema.tasks).where(eq(schema.tasks.id, fake!.id));
  r = await http('POST', `/api/tracked-accounts/${tt.id}/refresh`, A.token);
  check('refresh paused account → 409 tracked.paused', r.status === 409 && r.body.code === 'tracked.paused');
  r = await http('POST', `/api/tracked-accounts/${yt.id}/refresh`, A.token);
  check('refresh YouTube without API key → 400 tracked.youtube_no_api_key (no task)', r.status === 400 && r.body.code === 'tracked.youtube_no_api_key');
  r = await http('POST', '/api/tracked-accounts/refresh', A.token, { ids: [ig.id, yt.id, tt.id, igB.id] });
  const sk = Object.fromEntries((r.body.skipped ?? []).map((s: any) => [s.id, s.code]));
  check('batch refresh: queued manual-only, skipped no-key / paused / foreign (not_found)', r.status === 202 && r.body.queued.length === 1 && r.body.queued[0].id === ig.id
    && sk[yt.id] === 'tracked.youtube_no_api_key' && sk[tt.id] === 'tracked.paused' && sk[igB.id] === 'tracked.not_found', JSON.stringify(sk));
  if (r.body.queued[0]) check('batch task succeeds', (await waitTask(r.body.queued[0].taskId)).status === 'success');
  // The job function itself (what a scheduler would call) with no key: coded error, account marked error.
  const err = await refreshTrackedAccount(yt.id).then(() => null, (e) => e as { code?: string });
  a = (await http('GET', `/api/tracked-accounts/${yt.id}`, A.token)).body.account;
  check('refreshTrackedAccount(YouTube, no key) throws tracked.youtube_no_api_key and marks the account error',
    err?.code === 'tracked.youtube_no_api_key' && a.status === 'error' && a.lastErrorCode === 'tracked.youtube_no_api_key' && !!a.lastCheckedAt);
  check('error status filter', idsOf(await list('status=error')) === want(yt));
  r = await http('PATCH', `/api/tracked-accounts/${yt.id}`, A.token, { status: 'active' });
  check('error account can be set active again', r.body.account?.status === 'active');
  check('refreshTrackedAccount on a manual-only platform → manual_only', (await refreshTrackedAccount(ig.id)).outcome === 'manual_only');

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
    check('platforms: YouTube API configured; Instagram/TikTok manual only', ytp.api?.configured === true && plat.find((p: any) => p.id === 'instagram').api === null && !JSON.stringify(plat).includes(DUMMY_KEY));
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
  const need = ['tracked.create', 'tracked.update', 'tracked.snapshot_add', 'tracked.snapshot_delete', 'tracked.post_add', 'tracked.post_delete', 'tracked.refresh', 'tracked.refresh_batch',
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
  await http('POST', `/api/tracked-accounts/${igB.id}/snapshots`, B.token, { followers: 7 });
  await http('POST', `/api/tracked-accounts/${igB.id}/posts`, B.token, { externalId: 'b1' });
  r = await http('DELETE', `/api/users/${B.id}`, T);
  const leftB = await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.userId, B.id));
  check('deleting a user with tracked data succeeds (cascade)', r.status === 204 && leftB.length === 0);
  if (r.status === 204) userIds.splice(userIds.indexOf(B.id), 1);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack ?? (err as Error).message}`, false);
} finally {
  if (keyTouched) await http('PUT', '/api/settings/youtube', T, { apiKey: null });
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
