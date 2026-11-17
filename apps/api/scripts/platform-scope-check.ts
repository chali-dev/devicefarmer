/**
 * Platform scope (ENABLED_PLATFORMS) against the real API, DB, Redis and task centre (no mocks).
 * Run with the API on the default scope (`instagram` only; ENABLED_PLATFORMS unset for API and script):
 * - option lists (/api/platforms, social, publish, tracked, platform app settings) list only instagram;
 * - anything new on youtube/tiktok/facebook → 400 platform.disabled (social accounts, limits, tracked accounts,
 *   app settings, connect, YouTube key, distribution, trending settings/refresh); instagram flows still work;
 * - rows of a disabled platform inserted straight into the DB stay listed, but schedulers skip them (account
 *   checks, account stats, tracked schedule, publish runs; verified through the task centre) and manual
 *   refresh/check/sync/retry is refused; trending reports trending.unavailable and has no dashboard widget.
 * Restores the platform app settings and removes everything it created.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:3000 npx tsx --env-file=../../.env scripts/platform-scope-check.ts
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { sealSecret } from '../src/lib/secret-box.js';
import { scheduleDailyAccountStats } from '../src/modules/analytics/analytics.js';
import { scheduleAccountChecks } from '../src/modules/platforms/check.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import '../src/modules/publish/publish.js'; // registers the 'publish' task type

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(400); }
}
const finished = (id: string) => waitFor(`task ${id}`, async () => {
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return t && ['success', 'failed', 'cancelled'].includes(t.status) ? t : null;
});
const disabled = (r: { status: number; body: any }) => r.status === 400 && r.body?.code === 'platform.disabled';
const ids = (list: any[] | undefined, key = 'id') => (list ?? []).map((x) => x[key]).sort().join(',');
const tasksFor = (refId: string, type?: string) => db.select().from(schema.tasks).where(and(eq(schema.tasks.refId, refId), type ? eq(schema.tasks.type, type) : undefined));

const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
const T: string = (await login.json()).token;
const [me] = await db.select().from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME!));
const tag = randomBytes(3).toString('hex');
const h = (s: string) => `ps_${tag}_${s}`;
const [appsBefore] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
const mediaIds: string[] = [];

try {
  // ---------------------------------------------------------------- option lists
  let r = await http('GET', '/api/platforms', T);
  check('/api/platforms: adapters + enabled = instagram only, trending + YouTube key off',
    r.status === 200 && ids(r.body.platforms) === 'instagram' && ids(r.body.enabled) === 'instagram'
    && r.body.features.trending === false && r.body.features.youtubeKey === false, r.text.slice(0, 300));
  r = await http('GET', '/api/social/platforms', T);
  check('/api/social/platforms: instagram only', r.status === 200 && ids(r.body.platforms) === 'instagram', r.text.slice(0, 200));
  r = await http('GET', '/api/publish/platforms', T);
  check('/api/publish/platforms: instagram only', r.status === 200 && ids(r.body.platforms) === 'instagram', r.text.slice(0, 200));
  r = await http('GET', '/api/tracked-accounts/platforms', T);
  check('/api/tracked-accounts/platforms: instagram only', r.status === 200 && ids(r.body.platforms) === 'instagram', r.text.slice(0, 200));
  r = await http('GET', '/api/settings/platforms', T);
  check('/api/settings/platforms: instagram app only', r.status === 200 && ids(r.body.apps, 'platform') === 'instagram', r.text.slice(0, 200));

  // ---------------------------------------------------------------- new things on disabled platforms
  for (const p of ['youtube', 'tiktok', 'facebook']) {
    r = await http('POST', '/api/social/accounts', T, { platform: p, handle: h(p) });
    check(`social account on ${p} → platform.disabled`, disabled(r), r.text.slice(0, 200));
  }
  r = await http('PUT', '/api/social/settings', T, { limits: { youtube: 2 } });
  check('per-device limit for youtube → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('PUT', '/api/social/settings', T, { limits: { instagram: 1 } });
  check('per-device limit for instagram → 200', r.status === 200, r.text.slice(0, 200));
  for (const [input, platform] of [['https://www.youtube.com/@' + h('yt'), undefined], [h('tt'), 'tiktok']] as const) {
    r = await http('POST', '/api/tracked-accounts', T, { input, platform });
    check(`tracked account ${platform ?? 'from a YouTube URL'} → platform.disabled`, disabled(r), r.text.slice(0, 200));
  }
  r = await http('POST', '/api/tracked-accounts/parse', T, { input: 'https://www.tiktok.com/@' + h('tt') });
  check('parse a TikTok URL → platform.disabled', disabled(r), r.text.slice(0, 200));
  for (const p of ['youtube', 'tiktok', 'facebook']) {
    r = await http('PUT', `/api/settings/platforms/${p}`, T, { clientId: `dummy-${tag}`, clientSecret: `cs-${randomBytes(12).toString('hex')}` });
    check(`platform app settings for ${p} → platform.disabled`, disabled(r), r.text.slice(0, 200));
  }
  r = await http('PUT', '/api/settings/youtube', T, { apiKey: `AIza${randomBytes(18).toString('hex')}` });
  check('YouTube API key → platform.disabled', disabled(r), r.text.slice(0, 200));

  // ---------------------------------------------------------------- instagram still works
  r = await http('PUT', '/api/settings/platforms/instagram', T, { clientId: `9${Date.now()}`, clientSecret: `cs-${randomBytes(12).toString('hex')}` });
  check('platform app settings for instagram → 200', r.status === 200 && r.body.app.configured === true, r.text.slice(0, 200));
  r = await http('POST', '/api/social/accounts', T, { platform: 'instagram', handle: h('ig') });
  check('instagram social account → 201', r.status === 201, r.text.slice(0, 200));
  const igId: string = r.body.account?.id;
  r = await http('POST', `/api/platforms/instagram/connect`, T, { socialAccountId: igId });
  check('instagram connect → authorize URL', r.status === 200 && String(r.body.url).startsWith('https://www.instagram.com/oauth/authorize'), r.text.slice(0, 200));
  r = await http('POST', '/api/tracked-accounts', T, { input: `https://www.instagram.com/${h('igt')}/` });
  check('instagram tracked account → 201', r.status === 201, r.text.slice(0, 200));

  // ---------------------------------------------------------------- existing rows of a disabled platform (inserted directly)
  const [yt] = await db.insert(schema.socialAccounts).values({ userId: me!.id, platform: 'youtube', handle: h('ytold') }).returning();
  const [igOld] = await db.insert(schema.socialAccounts).values({ userId: me!.id, platform: 'instagram', handle: h('igold') }).returning();
  await db.insert(schema.platformConnections).values([
    { socialAccountId: yt!.id, userId: me!.id, platform: 'youtube', accessTokenEnc: sealSecret(`ya29.fake-${tag}`), status: 'connected' as const },
    { socialAccountId: igOld!.id, userId: me!.id, platform: 'instagram', accessTokenEnc: sealSecret(`IGfake${tag}`), status: 'connected' as const },
  ]);
  const [ytTracked] = await db.insert(schema.trackedAccounts).values({
    userId: me!.id, platform: 'youtube', handle: h('ytold'), profileUrl: `https://www.youtube.com/@${h('ytold')}`,
    refreshIntervalHours: 24, nextRefreshAt: new Date(Date.now() - 60_000),
  }).returning();

  r = await http('GET', `/api/social/accounts?q=${h('ytold')}`, T);
  check('existing youtube social account stays listed', r.status === 200 && r.body.items.some((a: any) => a.id === yt!.id), r.text.slice(0, 200));
  r = await http('GET', '/api/tracked-accounts?pageSize=200', T);
  check('existing youtube tracked account stays listed', r.status === 200 && JSON.stringify(r.body).includes(ytTracked!.id), r.text.slice(0, 200));
  r = await http('POST', `/api/platforms/youtube/connect`, T, { socialAccountId: yt!.id });
  check('connect youtube → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('POST', `/api/platforms/facebook/connect`, T, { socialAccountId: yt!.id });
  check('connect facebook → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('POST', `/api/platforms/accounts/${yt!.id}/check`, T);
  check('account check of the youtube account → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('POST', `/api/analytics/accounts/${yt!.id}/refresh`, T);
  check('analytics refresh of the youtube account → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('POST', `/api/comments/accounts/${yt!.id}/sync`, T);
  check('comment sync of the youtube account → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('POST', `/api/tracked-accounts/${ytTracked!.id}/refresh`, T);
  check('refresh of the youtube tracked account → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('PATCH', `/api/tracked-accounts/${ytTracked!.id}`, T, { refreshIntervalHours: 12 });
  check('changing the youtube tracked schedule → platform.disabled', disabled(r), r.text.slice(0, 200));

  // ---------------------------------------------------------------- schedulers skip disabled platforms
  const checks = await scheduleAccountChecks(new Date(), 25 * 3600_000);
  const ytChecks = await tasksFor(yt!.id, 'social-account-check');
  const igChecks = await tasksFor(igOld!.id, 'social-account-check');
  check('account-check scheduler: instagram account scheduled, youtube one skipped (no task)', checks.hours !== null && igChecks.length >= 1 && ytChecks.length === 0, JSON.stringify(checks));
  await scheduleDailyAccountStats(new Date());
  const ytStats = await tasksFor(yt!.id, 'account-stats');
  const igStats = await tasksFor(igOld!.id, 'account-stats');
  check('account-stats scheduler: instagram account scheduled, youtube one skipped (no task)', igStats.length === 1 && ytStats.length === 0, `ig ${igStats.length} yt ${ytStats.length}`);

  r = await http('POST', '/api/collection/run', T);
  const tick = await finished(r.body.task.id);
  const tickResult = tick.result as any;
  const [ytTrackedAfter] = await db.select().from(schema.trackedAccounts).where(eq(schema.trackedAccounts.id, ytTracked!.id));
  const ytRefreshes = await tasksFor(ytTracked!.id, 'tracked-refresh');
  check('collection tick: youtube tracked slot skipped with platform.disabled, no refresh task',
    tick.status === 'success' && ytRefreshes.length === 0 && ytTrackedAfter!.scheduleSkipCode === 'platform.disabled'
    && tickResult.tracked.skipped.some((s: any) => s.id === ytTracked!.id && s.code === 'platform.disabled'), JSON.stringify(tickResult));
  check('collection tick: trending skipped (trending.unavailable)', tickResult.trending.queued === 0 && tickResult.trending.skipped === 'trending.unavailable', JSON.stringify(tickResult.trending));

  // ---------------------------------------------------------------- trending
  r = await http('GET', '/api/trending', T);
  check('trending: notice trending.unavailable, not configured, no next run', r.status === 200 && r.body.notice === 'trending.unavailable' && r.body.configured === false && r.body.nextSlotAt === null, r.text.slice(0, 200));
  r = await http('PUT', '/api/trending/settings', T, { regions: ['US'], categoryId: null, intervalHours: 24, maxResults: 10, retentionDays: 30 });
  check('trending settings → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('POST', '/api/trending/refresh', T);
  check('trending refresh → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('GET', '/api/dashboard', T);
  check('dashboard: no trending widget', r.status === 200 && !('trending' in (r.body.widgets ?? {})) && 'social' in (r.body.widgets ?? {}), Object.keys(r.body.widgets ?? {}).join(','));

  // ---------------------------------------------------------------- distribution + publish runs
  const fd = new FormData();
  fd.append('scope', 'mine');
  fd.append('file', new Blob([new Uint8Array(await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer())], { type: 'image/png' }), `${h('img')}.png`);
  r = await http('POST', '/api/media/upload', T, fd);
  const mediaId: string = r.body.item?.id;
  if (mediaId) mediaIds.push(mediaId);
  await waitFor('media ready', async () => (await http('GET', `/api/media/${mediaId}`, T)).body.item.status === 'ready', 90_000);
  r = await http('POST', '/api/contents', T, { title: h('content'), body: 'scope check', mediaIds: [mediaId] });
  const contentId: string = r.body.content?.id;
  r = await http('POST', `/api/contents/${contentId}/distribute`, T, { targets: [{ accountId: yt!.id }] });
  check('distribute to the youtube account → platform.disabled', disabled(r), r.text.slice(0, 200));
  r = await http('POST', `/api/contents/${contentId}/distribute`, T, { targets: [{ accountId: igId, scheduledAt: new Date(Date.now() + 86400_000).toISOString() }] });
  check('distribute to instagram → 201', r.status === 201 && r.body.created?.length === 1, r.text.slice(0, 200));
  const igPt = r.body.created?.[0];
  if (igPt) await http('POST', `/api/publish/tasks/${igPt.id}/cancel`, T);

  // A publish task of the youtube account scheduled before the switch: its run fails at once with platform.disabled.
  const [ytPt] = await db.insert(schema.publishTasks).values({ userId: me!.id, contentId, accountId: yt!.id, platform: 'youtube', title: 'x', caption: 'x', mediaIds: [mediaId] }).returning();
  const { task } = await createTask({ type: 'publish', userId: me!.id, label: h('yt-run'), refType: 'publish', refId: ytPt!.id, payload: { publishTaskId: ytPt!.id, attemptNo: 1 }, runAt: new Date(Date.now() + 1500) });
  await db.update(schema.publishTasks).set({ taskId: task.id }).where(eq(schema.publishTasks.id, ytPt!.id));
  const run = await finished(task.id);
  const [ytPtAfter] = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.id, ytPt!.id));
  check('scheduled youtube publish run → failed platform.disabled (no retry)', run.status === 'failed' && run.attempts === 1 && ytPtAfter!.status === 'failed' && ytPtAfter!.errorCode === 'platform.disabled', `${run.status} ${run.attempts} ${ytPtAfter!.status} ${ytPtAfter!.errorCode}`);
  r = await http('POST', `/api/publish/tasks/${ytPt!.id}/retry`, T, {});
  check('retry of the youtube publish task → platform.disabled', disabled(r), r.text.slice(0, 200));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  const sa = await db.select({ id: schema.socialAccounts.id }).from(schema.socialAccounts).where(like(schema.socialAccounts.handle, `ps_${tag}_%`));
  const ta = await db.select({ id: schema.trackedAccounts.id }).from(schema.trackedAccounts).where(like(schema.trackedAccounts.handle, `ps_${tag}_%`));
  const refIds = [...sa, ...ta].map((x) => x.id);
  await db.delete(schema.contents).where(like(schema.contents.title, `ps_${tag}_%`));
  if (refIds.length) await db.delete(schema.tasks).where(inArray(schema.tasks.refId, refIds));
  await db.delete(schema.tasks).where(like(schema.tasks.instanceName, `ps_${tag}_%`));
  if (sa.length) await db.delete(schema.socialAccounts).where(inArray(schema.socialAccounts.id, sa.map((x) => x.id)));
  if (ta.length) await db.delete(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, ta.map((x) => x.id)));
  for (const id of mediaIds) await http('DELETE', `/api/media/${id}`, T);
  if (appsBefore) await db.update(schema.settings).set({ value: appsBefore.value }).where(eq(schema.settings.key, 'platform.apps'));
  else await db.delete(schema.settings).where(eq(schema.settings.key, 'platform.apps'));
  const left = await db.select({ id: schema.socialAccounts.id }).from(schema.socialAccounts).where(like(schema.socialAccounts.handle, `ps_${tag}_%`));
  check('cleanup: accounts, tracked accounts, contents, tasks removed; app settings restored', left.length === 0);
  await closeTaskQueues();
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
