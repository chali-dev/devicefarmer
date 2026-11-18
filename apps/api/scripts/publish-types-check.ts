/**
 * Post types (帖子 / Reels / 限动), 立即 vs 定时 publishing, the 定时发布 calendar range query, the 今日发布 view
 * and the dashboard card, through the real HTTP API and the real task centre. No mocks. Instagram only (works
 * with the default ENABLED_PLATFORMS).
 * - Devices are placeholder `instances` rows (no Android container) kept "online" by a test-only trigger, as in
 *   publish-check.ts. Accounts without a device fail the manual precheck (publish.no_device).
 * - Publishing is manual only (official-API publishing removed on 2026-11-18): every run ends awaiting_operator
 *   with method manual and logs no API method lines; a 1 s story video (formerly refused by the API-only 3 s limit)
 *   is handed over like any other story.
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/publish-types-check.ts
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, gte, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail.slice(0, 400)}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T = any>(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json as T, text };
}
async function login(username: string, password: string): Promise<string> {
  const r = await http('POST', '/api/auth/login', undefined, await withCaptcha(API, { username, password }));
  if (!r.body?.token) throw new Error(`login ${username} failed: ${r.status}`);
  return r.body.token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(500); }
}
async function upload(token: string, name: string, data: Buffer, mime: string) {
  const fd = new FormData();
  fd.append('scope', 'mine');
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
  const r = await http('POST', '/api/media/upload', token, fd);
  if (r.status !== 201) throw new Error(`upload failed ${r.status} ${r.text}`);
  const id: string = r.body.item.id;
  const item = await waitFor(`media ${name} ready`, async () => { const x = (await http('GET', `/api/media/${id}`, token)).body.item; return x.status === 'ready' ? x : null; }, 120_000);
  return { id, duration: item.duration as number | null };
}
/** Start of "today" in `tz` (UTC instant) and the next day's start. */
function dayIn(tz: string, now = new Date()): [Date, Date] {
  const parts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const offset = (d: Date) => { const p = parts(d); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(d.getTime() / 1000) * 1000; };
  const p = parts(now);
  const midnightUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!);
  let start = midnightUtc - offset(new Date(midnightUtc));
  start = midnightUtc - offset(new Date(start));
  const nextUtc = midnightUtc + 86400_000;
  const end = nextUtc - offset(new Date(nextUtc - offset(new Date(nextUtc))));
  return [new Date(start), new Date(end)];
}
const whenOf = (x: any) => new Date(x.publishedAt ?? x.scheduledAt).getTime();

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const PINNED = 'ptc-test-pinned-online';
const userIds: string[] = [];
const fakeIds: string[] = [];
const created: any[] = []; // A's publish tasks (latest copies)
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);

const ptask = async (token: string, id: string) => (await http('GET', `/api/publish/tasks/${id}`, token)).body;
const waitStatus = (token: string, id: string, statuses: string[], ms = 60_000) =>
  waitFor(`publish task ${id} → ${statuses.join('|')}`, async () => { const r = await ptask(token, id); return statuses.includes(r?.task?.status) ? r : null; }, ms);
const remember = (x: any) => { const i = created.findIndex((c) => c.id === x.id); if (i >= 0) created[i] = x; else created.push(x); };

try {
  // ---------------------------------------------------------------- setup
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) userIds.push((await http('POST', '/api/users', T, { username: `ptc${n}${tag}`, password: pw, role: 'user' })).body.user.id);
  const [uA, uB] = userIds as [string, string];
  const A = await login(`ptca${tag}`, pw);
  const B = await login(`ptcb${tag}`, pw);
  await sqlClient.unsafe(`create or replace function ptc_test_pin_online() returns trigger language plpgsql as $$
    begin if new.image = '${PINNED}' then new.status := 'running'; new.adb_state := 'device'; end if; return new; end $$`);
  await sqlClient.unsafe('drop trigger if exists ptc_test_pin_online on instances');
  await sqlClient.unsafe('create trigger ptc_test_pin_online before update on instances for each row execute function ptc_test_pin_online()');
  const fakes = await db.insert(schema.instances).values([0, 1].map((i) => ({ name: `ptcfake-${tag}-on${i}`, status: 'running' as const, adbState: 'device', image: PINNED, adbPort: 5590 + i, spec: { width: 720, height: 1280, dpi: 320 } }))).returning();
  fakeIds.push(...fakes.map((f) => f.id));
  const [DON, DON2] = fakes;
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: fakeIds });
  const acc = async (token: string, body: Record<string, unknown>) => {
    const r = await http('POST', '/api/social/accounts', token, { platform: 'instagram', handle: `ptc_${tag}_${randomBytes(2).toString('hex')}`, ...body });
    if (r.status !== 201) throw new Error(`account create failed ${r.status} ${r.text}`);
    return r.body.account as { id: string; handle: string };
  };
  const igOn = await acc(A, { instanceId: DON!.id, loginStatus: 'logged_in' });
  const igNoDev = await acc(A, { loginStatus: 'logged_in' });
  const igApi = await acc(A, { instanceId: DON2!.id, loginStatus: 'logged_in' });
  const igB = await acc(B, { loginStatus: 'logged_in' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-'));
  const ff = (args: string[]) => promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', ...args]);
  const vid = async (name: string, secs: number) => {
    const out = path.join(tmp, name);
    await ff(['-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=160x284:rate=5`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', out]);
    return fs.readFileSync(out);
  };
  const jpg = (r: number) => sharp({ create: { width: 360, height: 640, channels: 3, background: { r, g: 120, b: 80 } } }).jpeg().toBuffer();
  const [img1, img2, v5, v70, v1] = await Promise.all([
    upload(A, 'ptc-1.jpg', await jpg(10), 'image/jpeg'), upload(A, 'ptc-2.jpg', await jpg(60), 'image/jpeg'),
    upload(A, 'ptc-5s.mp4', await vid('5s.mp4', 5), 'video/mp4'), upload(A, 'ptc-70s.mp4', await vid('70s.mp4', 70), 'video/mp4'),
    upload(A, 'ptc-1s.mp4', await vid('1s.mp4', 1.5), 'video/mp4'),
  ]);
  const imgB = await upload(B, 'ptc-b.jpg', await jpg(200), 'image/jpeg');
  fs.rmSync(tmp, { recursive: true, force: true });
  check('setup: 2 users, 2 placeholder devices, 4 accounts, media ready with durations', Math.round(v5.duration ?? 0) === 5 && Math.round(v70.duration ?? 0) === 70, JSON.stringify([v5, v70]));

  const content = async (token: string, title: string, mediaIds: string[]) => {
    const r = await http('POST', '/api/contents', token, { title: `ptc-${tag} ${title}`, body: 'Body text', mediaIds, platformHints: { instagram: { caption: 'IG caption' } } });
    if (r.status !== 201) throw new Error(`content ${title}: ${r.status} ${r.text}`);
    return r.body.content.id as string;
  };
  const dist = (token: string, cid: string, targets: Record<string, unknown>[]) => http('POST', `/api/contents/${cid}/distribute`, token, { targets });

  // ---------------------------------------------------------------- capability table
  let r = await http('GET', '/api/publish/platforms', A);
  const ig = r.body.platforms.find((p: any) => p.id === 'instagram');
  check('GET /api/publish/platforms: Instagram post types feed/reel/story with their rules',
    JSON.stringify(ig?.postTypes) === '["feed","reel","story"]' && ig.capability.postTypes.reel.media.kinds.join() === 'video' && ig.capability.postTypes.story.media.maxVideoSec === 60 && ig.capability.postTypes.story.caption === false, JSON.stringify(ig));

  // ---------------------------------------------------------------- validation per type
  const cImg1 = await content(A, 'one image', [img1.id]);
  const cImg2 = await content(A, 'two images', [img1.id, img2.id]);
  const cV5 = await content(A, 'video 5s', [v5.id]);
  const cV70 = await content(A, 'video 70s', [v70.id]);
  const cMix = await content(A, 'image+video', [img1.id, v5.id]);
  const extra = await Promise.all(Array.from({ length: 9 }, async (_, i) => (await upload(A, `ptc-x${i}.jpg`, await jpg(100 + i * 10), 'image/jpeg')).id));
  const c11 = await content(A, 'eleven', [img1.id, img2.id, ...extra]);
  const bad = async (name: string, cid: string, postType: string, code: string) => {
    const x = await dist(A, cid, [{ accountId: igOn.id, postType }]);
    check(`validation: ${name} → 400 ${code}`, x.status === 400 && x.body.code === code && x.body.params?.postType === postType, x.text);
  };
  await bad('reel with an image', cImg1, 'reel', 'publish.media_kind');
  await bad('reel with two media', cMix, 'reel', 'publish.media_count');
  await bad('story with two images', cImg2, 'story', 'publish.media_count');
  await bad('story with a 70 s video', cV70, 'story', 'publish.video_too_long');
  await bad('feed with 11 media', c11, 'feed', 'publish.media_count');
  r = await dist(A, cImg1, [{ accountId: igOn.id, postType: 'carousel' }]);
  check('unknown post type → 400 (schema)', r.status === 400, r.text);
  const noneCreated = await db.select().from(schema.publishTasks).where(inArray(schema.publishTasks.contentId, [cImg1, cImg2, cV70, cMix, c11]));
  check('rejected distributions created nothing', noneCreated.length === 0);

  // ---------------------------------------------------------------- immediate: story via the manual method (device online)
  r = await dist(A, cV5, [{ accountId: igOn.id, postType: 'story', caption: 'ignored caption', hashtags: ['ignored'] }]);
  const story = r.body.created?.[0];
  check('immediate story: 201, postType story, caption + hashtags dropped (stories have none)', r.status === 201 && story?.postType === 'story' && story.caption === '' && story.hashtags.length === 0 && story.text === '', r.text);
  let d = await waitStatus(A, story.id, ['awaiting_operator', 'failed']);
  check('story run → awaiting_operator via manual', d.task.status === 'awaiting_operator' && d.task.method === 'manual', JSON.stringify(d.task.errorCode));
  check('publish logs carry the post type (distributed, run started, handed over)',
    ['distributed', 'handed over to an operator: publish by hand on the bound device, then record the outcome'].every((m) => d.logs.some((l: any) => l.message === m && l.data?.postType === 'story'))
    && d.logs.some((l: any) => l.message.startsWith('run started') && l.data?.postType === 'story'), JSON.stringify(d.logs.map((l: any) => [l.message, l.data?.postType])));
  const taskRow = await db.select().from(schema.tasks).where(eq(schema.tasks.id, d.task.taskId));
  check('task-centre label names the type', !!taskRow[0]?.instanceName?.startsWith('instagram story @'), JSON.stringify(taskRow[0]?.instanceName));
  r = await http('POST', `/api/publish/tasks/${story.id}/outcome`, A, { result: 'published', url: `https://example.invalid/ptc/${tag}/story` });
  check('operator records the story as published', r.status === 200 && r.body.task.status === 'published' && r.body.task.postType === 'story', r.text);
  remember(r.body.task);

  // immediate reel on an account without a device → manual precheck fails
  r = await dist(A, cV5, [{ accountId: igNoDev.id, postType: 'reel' }]);
  const reel = r.body.created?.[0];
  d = await waitStatus(A, reel.id, ['failed', 'awaiting_operator']);
  check('immediate reel without device → failed publish.no_device (no silent success)', d.task.status === 'failed' && d.task.errorCode === 'publish.no_device' && d.task.postType === 'reel', JSON.stringify(d.task));
  remember(d.task);

  // ---------------------------------------------------------------- scheduled: feed carousel + feed later this week
  const soon = new Date(Date.now() + 2 * 3600_000);
  r = await dist(A, cImg2, [{ accountId: igOn.id, scheduledAt: soon.toISOString() }]);
  const feedSoon = r.body.created?.[0];
  check('scheduled feed (carousel): status scheduled, postType feed by default', r.status === 201 && feedSoon?.status === 'scheduled' && feedSoon.postType === 'feed' && feedSoon.caption === 'IG caption', r.text);
  remember(feedSoon);
  const [run] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, feedSoon.taskId));
  check('scheduled: task-centre task waits with run_at = scheduled time', run?.status === 'scheduled' && Math.abs(new Date(run.runAt!).getTime() - soon.getTime()) < 1000, JSON.stringify(run?.status));
  const later = new Date(Date.now() + 3 * 86400_000);
  r = await dist(A, cImg1, [{ accountId: igOn.id, scheduledAt: later.toISOString(), postType: 'story' }]);
  const storyLater = r.body.created?.[0];
  remember(storyLater);
  r = await http('PATCH', `/api/publish/tasks/${storyLater.id}`, A, { caption: 'try a caption', hashtags: ['x'] });
  check('editing a story keeps it caption-free', r.status === 200 && r.body.task.caption === '' && r.body.task.hashtags.length === 0, r.text);
  r = await http('POST', `/api/publish/tasks/${storyLater.id}/reschedule`, A, { scheduledAt: new Date(later.getTime() + 3600_000).toISOString() });
  check('reschedule keeps the post type', r.status === 200 && r.body.task.postType === 'story' && r.body.task.status === 'scheduled', r.text);
  remember(r.body.task);

  // ---------------------------------------------------------------- calendar range (the page's week) + filters
  const now = new Date();
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const weekEnd = new Date(weekStart.getTime()); weekEnd.setDate(weekEnd.getDate() + 7);
  const range = (from: Date, to: Date, extra = '') => http('GET', `/api/publish/tasks?from=${from.toISOString()}&to=${to.toISOString()}&sort=scheduled_asc&limit=500${extra}`, A);
  r = await range(weekStart, weekEnd);
  const expectWeek = created.filter((x) => whenOf(x) >= weekStart.getTime() && whenOf(x) < weekEnd.getTime()).map((x) => x.id).sort();
  const gotWeek = r.body.items.map((x: any) => x.id).sort();
  check(`calendar week ${weekStart.toISOString().slice(0, 10)}: exactly the tasks of the week, scheduled ones included (${expectWeek.length})`,
    JSON.stringify(gotWeek) === JSON.stringify(expectWeek) && gotWeek.includes(feedSoon.id) === (soon < weekEnd), JSON.stringify({ gotWeek, expectWeek }));
  r = await range(new Date(now.getTime() - 86400_000), new Date(now.getTime() + 8 * 86400_000), '&postType=story');
  check('postType=story filter returns only stories (incl. the scheduled one in 3 days)', r.body.items.length === 2 && r.body.items.every((x: any) => x.postType === 'story') && r.body.items.some((x: any) => x.id === storyLater.id), JSON.stringify(r.body.items.map((x: any) => x.postType)));
  check('byPostType ignores the type filter', r.body.byPostType.story === 2 && r.body.byPostType.reel === 1 && r.body.byPostType.feed === 1, JSON.stringify(r.body.byPostType));
  r = await http('GET', '/api/publish/tasks?status=published,failed,cancelled&postType=reel,story', A);
  check('history: postType csv + status filter', r.body.total === 2 && r.body.byStatus.published === 1 && r.body.byStatus.failed === 1, JSON.stringify(r.body.byStatus));

  // ---------------------------------------------------------------- today view + dashboard per time zone
  for (const tz of ['Asia/Shanghai', 'America/Los_Angeles']) {
    const [from, to] = dayIn(tz);
    const mine = created.filter((x) => whenOf(x) >= from.getTime() && whenOf(x) < to.getTime() && x.status !== 'cancelled');
    const want = { feed: 0, reel: 0, story: 0 } as Record<string, number>;
    for (const x of mine) want[x.postType]++;
    r = await http('GET', `/api/publish/tasks?from=${from.toISOString()}&to=${to.toISOString()}&status=pending,scheduled,running,awaiting_operator,published,failed`, A);
    const dash = (await http('GET', `/api/dashboard?tz=${encodeURIComponent(tz)}`, A)).body.widgets.publishToday;
    check(`today in ${tz} (${from.toISOString()} – ${to.toISOString()}): list byPostType = dashboard = expected ${JSON.stringify(want)}`,
      ['feed', 'reel', 'story'].every((k) => r.body.byPostType[k] === want[k] && dash?.byType[k] === want[k]) && dash.total === mine.length && r.body.total === mine.length,
      JSON.stringify({ list: r.body.byPostType, dash }));
  }
  r = await http('GET', `/api/dashboard?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, A);
  const local = r.body.widgets.publishToday;
  check('dashboard (local tz): the published story counts as published today', local?.published.story >= 1 && local.byStatus.published >= 1, JSON.stringify(local));

  // ---------------------------------------------------------------- RBAC
  const cB = await content(B, 'b story', [imgB.id]);
  r = await dist(B, cB, [{ accountId: igB.id, postType: 'story' }]);
  const bStory = r.body.created?.[0];
  await waitStatus(B, bStory.id, ['failed', 'awaiting_operator']);
  r = await http('GET', '/api/publish/tasks?postType=story', B);
  check('B sees only own stories', r.body.total === 1 && r.body.items[0].id === bStory.id);
  r = await http('GET', `/api/publish/tasks/${story.id}`, B);
  check("B cannot open A's task (404)", r.status === 404);
  r = await http('GET', `/api/publish/tasks?ownerId=${uA}`, B);
  check('B cannot filter by another owner (403)', r.status === 403);
  r = await http('GET', `/api/publish/tasks?ownerId=${uA}&postType=story`, T);
  check("admin sees A's stories with the owner filter", r.body.total === 2);
  const dB = (await http('GET', '/api/dashboard', B)).body.widgets.publishToday;
  const dA = (await http('GET', '/api/dashboard', A)).body.widgets.publishToday;
  const dT = (await http('GET', `/api/dashboard?userId=${uB}`, T)).body.widgets.publishToday;
  check("dashboard is scoped: B counts only B's story; admin's per-user view of B matches", dB?.byType.story === 1 && dB.total === 1 && JSON.stringify(dT) === JSON.stringify(dB) && dA.byType.story >= 1, JSON.stringify({ dA, dB, dT }));
  r = await dist(A, cImg1, [{ accountId: igB.id, postType: 'story' }]);
  check("A cannot target B's account", r.status === 404 || r.status === 400, r.text);

  // ---------------------------------------------------------------- manual only (no API method any more)
  r = await dist(A, cV5, [{ accountId: igApi.id, postType: 'reel' }]);
  const manReel = r.body.created?.[0];
  d = await waitStatus(A, manReel.id, ['awaiting_operator', 'failed', 'published']);
  const noApi = (x: any) => !x.logs.some((l: any) => /^(method |publishing via|check: method|publish request sent)/.test(l.message));
  check('reel → manual → awaiting_operator, no API method lines in the log', d.task.status === 'awaiting_operator' && d.task.method === 'manual' && noApi(d),
    JSON.stringify(d.logs.map((l: any) => l.message)));
  remember(d.task);
  const cV1 = await content(A, 'short story', [v1.id]);
  r = await dist(A, cV1, [{ accountId: igApi.id, postType: 'story' }]);
  const shortStory = r.body.created?.[0];
  check('a 1 s story video is accepted (no API-only duration limit)', r.status === 201 && !!shortStory, r.text);
  d = await waitStatus(A, shortStory.id, ['awaiting_operator', 'failed', 'published']);
  check('short story → awaiting_operator via manual', d.task.status === 'awaiting_operator' && d.task.method === 'manual' && noApi(d), `${d.task.status} ${d.task.errorCode}`);
  remember(d.task);

  // ---------------------------------------------------------------- audit
  await sleep(500);
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), eq(schema.auditLogs.username, `ptca${tag}`)));
  const distAudit = audit.filter((a) => a.action === 'content.distribute' && a.status === 201);
  check('audit: content.distribute details carry the post types', distAudit.some((a) => JSON.stringify((a.detail as any).postTypes) === '["story"]') && distAudit.some((a) => JSON.stringify((a.detail as any).postTypes) === '["reel"]'),
    JSON.stringify(distAudit.map((a) => a.detail)));
  check('audit: outcome + reschedule + edit recorded', ['publish.outcome_published', 'publish.reschedule', 'publish.update'].every((x) => audit.some((a) => a.action === x)));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  // Waiting scheduler tasks first (their BullMQ jobs), then the users with everything they own.
  for (const x of created) if (['pending', 'scheduled'].includes(x.status)) await http('POST', `/api/publish/tasks/${x.id}/cancel`, T).catch(() => undefined);
  const refIds = (await db.select({ id: schema.publishTasks.id }).from(schema.publishTasks).where(inArray(schema.publishTasks.userId, userIds.length ? userIds : ['00000000-0000-0000-0000-000000000000']))).map((x) => x.id);
  if (refIds.length) await db.delete(schema.tasks).where(and(eq(schema.tasks.refType, 'publish'), inArray(schema.tasks.refId, refIds)));
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  await sqlClient.unsafe('drop trigger if exists ptc_test_pin_online on instances').catch(() => undefined);
  await sqlClient.unsafe('drop function if exists ptc_test_pin_online()').catch(() => undefined);
  const left = await db.select().from(schema.publishTasks).where(inArray(schema.publishTasks.userId, userIds.length ? userIds : ['00000000-0000-0000-0000-000000000000']));
  check('cleanup: users (with contents, accounts, publish tasks), device, trigger', left.length === 0);
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
