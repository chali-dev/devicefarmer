/**
 * Content management (内容管理) + publish scheduler (定时发布) through the real HTTP API, the real task centre
 * (BullMQ worker in the API), real media processing (sharp / ffmpeg). No mocks.
 * - Devices are placeholder `instances` rows (no Android container): "online" = status running + adb state device,
 *   held by a test-only trigger against the monitor (created and dropped by this script).
 *   Pushing media to a real phone is not covered here. Instagram runs try the `device` method (云手机发帖) first: adb
 *   doesn't see the placeholder phone, so they are handed to an operator (reason publish.device_offline), as before.
 * - The device-offline retry path waits for one retry backoff (PUBLISH_RETRY_BACKOFF_MS, default 30 s).
 * Usage (from apps/api, API running): npx tsx --env-file=../../.env scripts/publish-check.ts
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import '../src/modules/publish/publish.js'; // registers the 'publish' task type (for the idempotency checks below)

const API = `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
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
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(500); }
}
async function upload(token: string, scope: string, name: string, data: Buffer, mime: string) {
  const fd = new FormData();
  fd.append('scope', scope);
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
  const r = await http('POST', '/api/media/upload', token, fd);
  if (r.status !== 201) throw new Error(`upload failed ${r.status} ${r.text}`);
  const id: string = r.body.item.id;
  await waitFor(`media ${name} ready`, async () => ((await http('GET', `/api/media/${id}`, token)).body.item.status === 'ready'), 90_000);
  return id;
}

const T = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const userIds: string[] = [];
const fakeIds: string[] = [];
const publicMedia: string[] = [];
const ptIds = new Set<string>();
// Audit/task timestamps come from Postgres (defaultNow), whose clock may differ from this host's
// (Docker Desktop VM drift): take the start time from the database.
const t0 = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const PINNED = 'pc-test-pinned-online';

const ptask = async (token: string, id: string) => (await http('GET', `/api/publish/tasks/${id}`, token)).body;
async function waitStatus(token: string, id: string, statuses: string[], ms = 60_000) {
  let last: any = null;
  try {
    return await waitFor(`publish task ${id} → ${statuses.join('|')}`, async () => { last = await ptask(token, id); return statuses.includes(last?.task?.status) ? last : null; }, ms);
  } catch (err) {
    throw new Error(`${(err as Error).message} (last: ${last?.task?.status}, runs: ${JSON.stringify(last?.runs?.map((x: any) => [x.status, x.runAt, x.startedAt, x.errorCode]))})`);
  }
}
const contentStatus = async (token: string, id: string) => (await http('GET', `/api/contents/${id}`, token)).body.content.status as string;

try {
  // ---------------------------------------------------------------- setup: users, placeholder devices, accounts, media
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `pc${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`pca${tag}`, pw);
  const B = await login(`pcb${tag}`, pw);
  // The monitor marks container-less rows as error every 5 s. A test-only trigger keeps placeholder rows whose
  // image is PINNED "online" (running + adb device); it is dropped in `finally`.
  await sqlClient.unsafe(`create or replace function pc_test_pin_online() returns trigger language plpgsql as $$
    begin if new.image = '${PINNED}' then new.status := 'running'; new.adb_state := 'device'; end if; return new; end $$`);
  await sqlClient.unsafe('drop trigger if exists pc_test_pin_online on instances');
  await sqlClient.unsafe('create trigger pc_test_pin_online before update on instances for each row execute function pc_test_pin_online()');
  const fakes = await db.insert(schema.instances).values([
    { name: `pcfake-${tag}-on`, status: 'running' as const, adbState: 'device', image: PINNED },
    { name: `pcfake-${tag}-off`, status: 'stopped' as const, adbState: null, image: 'none' },
    { name: `pcfake-${tag}-on2`, status: 'running' as const, adbState: 'device', image: PINNED },
  ].map((d, i) => ({ ...d, adbPort: 5570 + i, spec: { width: 720, height: 1280, dpi: 320 } }))).returning();
  fakeIds.push(...fakes.map((f) => f.id));
  const [DON, DOFF, DON2] = fakes as [typeof fakes[0], typeof fakes[0], typeof fakes[0]];
  await http('PUT', `/api/users/${uA}/grants`, T, { instanceIds: [DON.id, DOFF.id, DON2.id] });

  const acc = async (token: string, body: Record<string, unknown>) => {
    const r = await http('POST', '/api/social/accounts', token, { handle: `pc_${tag}_${body.platform}_${randomBytes(2).toString('hex')}`, ...body });
    if (r.status !== 201) throw new Error(`account create failed ${r.status} ${r.text}`);
    // login/account status are written by the automatic account check (风控) since 2026-11-18, not by the API: set them like that check would
    if (body.loginStatus || body.accountStatus) await sqlClient`update social_accounts set login_status = coalesce(${(body.loginStatus as string) ?? null}, login_status), account_status = coalesce(${(body.accountStatus as string) ?? null}, account_status) where id = ${r.body.account.id}`;
    // device link: read only in the API since 2026-11-18 (set by 从云手机同步); written with the sync's rules (lib/social-link.ts)
    if (typeof body.instanceId === 'string') await linkAccount(r.body.account.id, body.instanceId);
    return r.body.account.id as string;
  };
  const ytA = await acc(A, { platform: 'youtube', instanceId: DON.id, loginStatus: 'logged_in' });
  const igA = await acc(A, { platform: 'instagram', instanceId: DON.id, loginStatus: 'logged_in' });
  const ttA = await acc(A, { platform: 'tiktok', instanceId: DOFF.id, loginStatus: 'logged_in' });
  const igSusp = await acc(A, { platform: 'instagram', instanceId: DOFF.id, loginStatus: 'logged_in', accountStatus: 'suspended' });
  const ytOut = await acc(A, { platform: 'youtube', instanceId: DON2.id, loginStatus: 'logged_out' });
  const igB = await acc(B, { platform: 'instagram', loginStatus: 'logged_in' });

  const png = (r: number) => sharp({ create: { width: 400, height: 300, channels: 3, background: { r, g: 90, b: 160 } } }).png().toBuffer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const mp4Path = path.join(tmp, 'clip.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1.5:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', mp4Path]);
  const mp4 = fs.readFileSync(mp4Path);
  fs.rmSync(tmp, { recursive: true, force: true });
  const [imgA1, imgA2, vidA, imgB, imgPub] = await Promise.all([
    upload(A, 'mine', 'pc-a1.png', await png(10), 'image/png'),
    upload(A, 'mine', 'pc-a2.png', await png(20), 'image/png'),
    upload(A, 'mine', 'pc-vid.mp4', mp4, 'video/mp4'),
    upload(B, 'mine', 'pc-b1.png', await png(30), 'image/png'),
    upload(T, 'public', `pc-pub-${tag}.png`, await png(40), 'image/png'),
  ]);
  publicMedia.push(imgPub);
  check('setup: 2 users, 3 placeholder devices, 6 accounts, 5 media ready', true);

  // ---------------------------------------------------------------- content CRUD + media permission
  let r = await http('POST', '/api/contents', A, { title: 'x', mediaIds: [imgB] });
  check("user cannot attach another user's private media (404 media.not_found)", r.status === 404 && r.body.code === 'media.not_found', r.text.slice(0, 120));
  r = await http('POST', '/api/contents', T, { title: 'x', ownerId: uA, mediaIds: [imgB] });
  check("admin cannot attach B's private media to A's content (400 content.media_not_usable)", r.status === 400 && r.body.code === 'content.media_not_usable', r.text.slice(0, 120));
  const catLaunch = (await http('POST', '/api/content-categories', A, { scope: 'mine', name: 'Launch' })).body.category;
  const catVideo = (await http('POST', '/api/content-categories', A, { scope: 'mine', name: 'Video' })).body.category;
  r = await http('POST', '/api/contents', A, {
    title: `pc-${tag} carousel`, body: 'Base caption', categoryId: catLaunch.id, tags: ['Promo', 'promo', '#Spring'], mediaIds: [imgA1, imgPub, imgA2, imgA1],
    platformHints: { instagram: { caption: 'IG caption' } },
  });
  const cImg = r.body.content;
  check('create content: 201, draft, tags deduped case-insensitively, media deduped in order',
    r.status === 201 && cImg.status === 'draft' && cImg.tags.join(',') === 'Promo,Spring' && cImg.media.map((m: any) => m.id).join() === [imgA1, imgPub, imgA2].join(), r.text.slice(0, 200));
  r = await http('PUT', `/api/contents/${cImg.id}`, A, { mediaIds: [imgA2, imgA1], tags: ['spring', 'New'], categoryId: catLaunch.id });
  check('update: media reordered, tags replaced (stored spelling kept)', r.status === 200 && r.body.content.media.map((m: any) => m.id).join() === [imgA2, imgA1].join()
    && r.body.content.tags.join(',') === 'New,Spring', r.text.slice(0, 200));
  r = await http('POST', '/api/contents', A, { title: `pc-${tag} video`, body: 'Video description', categoryId: catVideo.id, tags: ['clip'], mediaIds: [vidA], platformHints: { youtube: { title: 'YT title', privacy: 'unlisted' } } });
  const cVid = r.body.content;
  r = await http('GET', `/api/contents?categoryId=${catLaunch.id}&q=pc-${tag}`, A);
  check('list filter by category + search', r.status === 200 && r.body.total === 1 && r.body.items[0].id === cImg.id);
  r = await http('GET', '/api/contents?tag=SPRING', A);
  check('list filter by tag (case-insensitive)', r.body.items.length === 1 && r.body.items[0].id === cImg.id);
  r = await http('GET', '/api/contents/facets', A);
  check('facets: tags (categories come from /api/content-categories)', !('categories' in r.body) && r.body.tags.includes('clip') && r.body.tags.includes('Spring'), JSON.stringify(r.body));
  r = await http('GET', `/api/contents/${cImg.id}`, B);
  check("B cannot read A's content (404)", r.status === 404 && r.body.code === 'content.not_found');
  r = await http('GET', `/api/contents?ownerId=${uA}`, B);
  check("B cannot list A's contents by ownerId (403)", r.status === 403);
  r = await http('GET', '/api/contents', B);
  check("B's list does not contain A's contents", r.body.total === 0);
  r = await http('GET', `/api/contents?ownerId=${uA}`, T);
  check("admin lists A's contents with owner filter", r.body.total === 2 && r.body.items.every((i: any) => i.ownerName === `pca${tag}`));
  r = await http('PUT', `/api/contents/${cImg.id}`, B, { title: 'hijack' });
  check("B cannot edit A's content (404)", r.status === 404);

  // ---------------------------------------------------------------- platform validation
  r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: ytA }] });
  check('YouTube needs exactly one video (images refused: publish.media_count/kind)', r.status === 400 && ['publish.media_count', 'publish.media_kind'].includes(r.body.code), r.body.code);
  r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: ttA }] });
  check('TikTok refuses a 2-image post', r.status === 400 && r.body.code === 'publish.media_count', r.body.code);
  r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igA, caption: 'x'.repeat(2300) }] });
  check('Instagram caption > 2200 refused (publish.caption_too_long)', r.status === 400 && r.body.code === 'publish.caption_too_long', r.body.code);
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ytA, options: { privacy: 'friends' } }] });
  check('YouTube privacy must be public/unlisted/private', r.status === 400 && r.body.code === 'publish.bad_privacy', r.body.code);
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: igB }] });
  check("A cannot target B's account (404 social.not_found)", r.status === 404 && r.body.code === 'social.not_found', r.body.code);
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ytA }, { accountId: ytA }] });
  check('duplicate target in one request refused', r.status === 400 && r.body.code === 'publish.duplicate_target');
  const before = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, cVid.id));
  check('failed validations created no publish tasks (all or nothing)', before.length === 0);

  // ---------------------------------------------------------------- distribution: TikTok on an offline device (retry path, started early)
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ttA, caption: 'TT caption', hashtags: ['#fyp', 'fyp', 'demo'] }], maxAttempts: 2 });
  const ttTask = r.body.created?.[0];
  if (ttTask) ptIds.add(ttTask.id);
  check('distribute to TikTok (maxAttempts 2): hashtags normalised', r.status === 201 && ttTask.hashtags.join() === 'fyp,demo' && ttTask.maxAttempts === 2 && ttTask.text === 'TT caption\n\n#fyp #demo', r.text.slice(0, 200));

  // ---------------------------------------------------------------- distribution: YouTube scheduled + Instagram now
  const runAt = new Date(Date.now() + 6000);
  r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igA, hashtags: ['spring'] }] });
  const igTask = r.body.created?.[0];
  ptIds.add(igTask.id);
  check('distribute to Instagram now: 201, caption from platform hint', r.status === 201 && igTask.caption === 'IG caption' && igTask.mediaIds.join() === [imgA2, imgA1].join(), r.text.slice(0, 200));
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ytA, scheduledAt: runAt.toISOString() }] });
  const ytTask = r.body.created?.[0];
  ptIds.add(ytTask.id);
  check('distribute to YouTube scheduled: status scheduled, title + privacy from hints', r.status === 201 && ytTask.status === 'scheduled' && ytTask.title === 'YT title'
    && ytTask.options.privacy === 'unlisted' && ytTask.caption === 'Video description', r.text.slice(0, 200));
  const [ytRow0] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, ytTask.taskId));
  check('scheduler task: type publish, scheduled, runAt, idempotency key publish:<id>:1, ref publish',
    ytRow0?.type === 'publish' && ytRow0.status === 'scheduled' && Math.abs(ytRow0.runAt!.getTime() - runAt.getTime()) < 1000
    && ytRow0.idempotencyKey === `publish:${ytTask.id}:1` && ytRow0.refType === 'publish' && ytRow0.refId === ytTask.id && ytRow0.maxAttempts === 3 && !!ytRow0.timeoutMs,
    `${ytRow0?.status} ${ytRow0?.idempotencyKey} max=${ytRow0?.maxAttempts} timeout=${ytRow0?.timeoutMs}`);
  check('content status after distribution: scheduled (stage ready)', await contentStatus(A, cVid.id) === 'scheduled');

  // idempotency: same distribution again
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ytA, scheduledAt: runAt.toISOString() }, { accountId: ttA }] });
  check('double distribute: 200, nothing created, existing returned', r.status === 200 && r.body.created.length === 0 && r.body.existing.length === 2);
  const vidTasks = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, cVid.id));
  const vidRuns = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'publish'), inArray(schema.tasks.refId, vidTasks.map((x) => x.id))));
  check('still one publish task and one scheduler task per account', vidTasks.length === 2 && vidRuns.length === 2);
  const again = await createTask({ type: 'publish', userId: uA, refType: 'publish', refId: ytTask.id, payload: { publishTaskId: ytTask.id }, idempotencyKey: `publish:${ytTask.id}:1` });
  check('task centre: same idempotency key returns the existing task (created: false)', !again.created && again.task.id === ytTask.taskId);

  // Instagram (manual method) runs now
  let d = await waitStatus(A, igTask.id, ['awaiting_operator', 'failed']);
  check('Instagram run → awaiting_operator (manual method)', d.task.status === 'awaiting_operator' && d.task.method === 'manual', `${d.task.status} ${d.task.errorCode ?? ''}`);
  const msgs = d.logs.map((l: any) => l.message as string);
  check('publish logs record every check', ['check: account owner ok', 'check: account active', 'check: media ready and valid for the platform', 'check: not published before on this account',
    'check: device online', 'check: account logged in on the device', 'handed over to an operator: publish by hand on the bound device, then record the outcome', 'awaiting operator'].every((m) => msgs.includes(m))
    && !msgs.some((m: string) => /^(method api|publishing via|check: method|publish request sent)/.test(m)), msgs.join(' | '));
  check('scheduler task ended success with result awaiting_operator', d.runs.length === 1 && d.runs[0].status === 'success' && d.runs[0].result?.state === 'awaiting_operator');
  const tlogs = await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, d.runs[0].id));
  check('the same checks are in the task-centre log (ctx.log)', tlogs.some((l) => l.message === 'check: device online'));
  check('device link + online flag in the item', d.task.instance?.id === DON.id && d.task.instance.online === true && d.task.instance.accessible === true);

  // a stale task-centre task for the same publish task must not run it again
  const stale = await createTask({ type: 'publish', userId: uA, refType: 'publish', refId: igTask.id, payload: { publishTaskId: igTask.id }, idempotencyKey: `publish:${igTask.id}:stale-${tag}` });
  const staleDone = await waitFor('stale task', async () => { const [x] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, stale.task.id)); return x && ['success', 'failed'].includes(x.status) ? x : null; });
  const igAfter = await ptask(A, igTask.id);
  check('double execution: a second scheduler task is skipped, publish task unchanged',
    staleDone.status === 'success' && (staleDone.result as any)?.skipped === true && igAfter.task.status === 'awaiting_operator' && igAfter.task.taskId === igTask.taskId, JSON.stringify(staleDone.result));

  // scheduled YouTube fires at runAt
  d = await waitStatus(A, ytTask.id, ['awaiting_operator', 'failed'], 30_000);
  const [ytRow1] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, ytTask.taskId));
  check('scheduled YouTube fired at its time → awaiting_operator', d.task.status === 'awaiting_operator' && !!ytRow1?.startedAt && ytRow1.startedAt.getTime() >= runAt.getTime() - 50,
    `${d.task.status} started=${ytRow1?.startedAt?.toISOString()} runAt=${runAt.toISOString()}`);

  // ---------------------------------------------------------------- operator outcome (manual)
  r = await http('POST', `/api/publish/tasks/${igTask.id}/outcome`, A, { result: 'published' });
  check('outcome published needs a link or ID', r.status === 400 && r.body.code === 'publish.outcome_needs_link');
  r = await http('POST', `/api/publish/tasks/${igTask.id}/outcome`, B, { result: 'published', url: 'https://www.instagram.com/p/x/' });
  check("B cannot record an outcome on A's task (404)", r.status === 404 && r.body.code === 'publish.not_found');
  r = await http('POST', `/api/publish/tasks/${igTask.id}/outcome`, A, { result: 'published', url: 'https://www.instagram.com/p/pc-test/' });
  check('operator records published with URL', r.status === 200 && r.body.task.status === 'published' && r.body.task.url === 'https://www.instagram.com/p/pc-test/' && !!r.body.task.publishedAt);
  check('content with all tasks published → published', await contentStatus(A, cImg.id) === 'published');
  r = await http('POST', `/api/publish/tasks/${igTask.id}/outcome`, A, { result: 'published', url: 'https://www.instagram.com/p/again/' });
  check('outcome only once (409 publish.bad_status)', r.status === 409 && r.body.code === 'publish.bad_status');
  r = await http('POST', `/api/publish/tasks/${ytTask.id}/outcome`, A, { result: 'published', externalId: 'yt-video-123' });
  check('operator records published with external ID', r.body.task?.status === 'published' && r.body.task.externalId === 'yt-video-123');
  check('content with 1 published + 1 unfinished → partially_published', await contentStatus(A, cVid.id) === 'partially_published');

  // ---------------------------------------------------------------- duplicate protection + re-publish
  r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igA }] });
  check('publishing the same content to the same account again refused (409 publish.already_published)', r.status === 409 && r.body.code === 'publish.already_published');
  r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igA }], republish: true });
  const rep = r.body.created?.[0];
  if (rep) ptIds.add(rep.id);
  check('explicit re-publish creates a new task flagged republish', r.status === 201 && rep.republish === true);
  d = await waitStatus(A, rep.id, ['awaiting_operator', 'failed']);
  check('re-publish runs (duplicate check passes for republish)', d.task.status === 'awaiting_operator', d.task.errorCode ?? '');
  r = await http('POST', `/api/publish/tasks/${rep.id}/cancel`, A);
  check('cancel while awaiting operator → cancelled', r.status === 200 && r.body.task.status === 'cancelled');
  check('cancelled tasks do not count in the content status', await contentStatus(A, cImg.id) === 'published');

  // ---------------------------------------------------------------- cancel + reschedule
  r = await http('POST', '/api/contents', A, { title: `pc-${tag} later`, mediaIds: [imgA2] });
  const cLater = r.body.content;
  const in1h = new Date(Date.now() + 3600_000);
  r = await http('POST', `/api/contents/${cLater.id}/distribute`, A, { targets: [{ accountId: igA, scheduledAt: in1h.toISOString() }] });
  const later = r.body.created[0];
  ptIds.add(later.id);
  r = await http('DELETE', `/api/media/${imgA2}`, A);
  check('media used by an unfinished (scheduled) publish task cannot be deleted (409 media.in_use)', r.status === 409 && r.body.code === 'media.in_use', r.text.slice(0, 100));
  r = await http('DELETE', `/api/contents/${cLater.id}`, A);
  check('delete content with unfinished publish tasks refused (409 content.has_unfinished_publish)', r.status === 409 && r.body.code === 'content.has_unfinished_publish');
  r = await http('PUT', `/api/contents/${cLater.id}`, A, { stage: 'archived' });
  check('archive with unfinished publish tasks refused', r.status === 409 && r.body.code === 'content.archive_unfinished');
  const in2h = new Date(Date.now() + 7200_000);
  r = await http('POST', `/api/publish/tasks/${later.id}/reschedule`, A, { scheduledAt: in2h.toISOString() });
  const [oldRun] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, later.taskId));
  const [newRun] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, r.body.task?.taskId ?? later.taskId));
  check('reschedule: round 2, old scheduler task cancelled, new one scheduled at the new time with key publish:<id>:2',
    r.status === 200 && r.body.task.attemptNo === 2 && r.body.task.status === 'scheduled' && oldRun?.status === 'cancelled' && newRun?.id !== oldRun?.id
    && newRun?.status === 'scheduled' && Math.abs(newRun.runAt!.getTime() - in2h.getTime()) < 1000 && newRun.idempotencyKey === `publish:${later.id}:2`,
    `${r.status} ${oldRun?.status} ${newRun?.status} ${newRun?.idempotencyKey}`);
  check('the old round being cancelled did not cancel the publish task', (await ptask(A, later.id)).task.status === 'scheduled');
  r = await http('POST', `/api/publish/tasks/${later.id}/cancel`, B);
  check("B cannot cancel A's publish task (404)", r.status === 404);
  r = await http('POST', `/api/publish/tasks/${later.id}/cancel`, A);
  const [newRunAfter] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, newRun!.id));
  check('cancel scheduled: publish task + scheduler task cancelled', r.status === 200 && r.body.task.status === 'cancelled' && newRunAfter?.status === 'cancelled');
  r = await http('POST', `/api/publish/tasks/${later.id}/reschedule`, A, { scheduledAt: null });
  check('reschedule a cancelled task refused (409 publish.bad_status)', r.status === 409 && r.body.code === 'publish.bad_status');
  check('only cancelled tasks → content status back to its stage (ready)', await contentStatus(A, cLater.id) === 'ready');
  r = await http('DELETE', `/api/media/${imgA2}`, A);
  check('after cancel the media can be deleted; it drops out of the drafts', r.status === 204 && (await http('GET', `/api/contents/${cLater.id}`, A)).body.content.media.length === 0
    && (await http('GET', `/api/contents/${cImg.id}`, A)).body.content.media.map((m: any) => m.id).join() === imgA1);

  // retry the cancelled one → runs → operator marks failed
  r = await http('POST', `/api/publish/tasks/${later.id}/retry`, A, {});
  check('retry a cancelled task: 202, round 3, retry_of = previous scheduler task', r.status === 202 && r.body.task.attemptNo === 3, r.text.slice(0, 160));
  d = await waitStatus(A, later.id, ['awaiting_operator', 'failed']);
  const lastRun = d.runs[d.runs.length - 1];
  check('retried run: media snapshot gone → fails at once with publish.media_unavailable (no retry)', d.task.status === 'failed' && d.task.errorCode === 'publish.media_unavailable'
    && lastRun.attempts === 1 && lastRun.retryOf === newRun!.id && d.runs.length === 3, `${d.task.status} ${d.task.errorCode} attempts=${lastRun?.attempts}`);

  // operator failure
  r = await http('POST', '/api/contents', A, { title: `pc-${tag} opfail`, mediaIds: [imgA1] });
  const cOp = r.body.content;
  r = await http('POST', `/api/contents/${cOp.id}/distribute`, A, { targets: [{ accountId: igA }] });
  const op = r.body.created[0];
  ptIds.add(op.id);
  await waitStatus(A, op.id, ['awaiting_operator']);
  r = await http('POST', `/api/publish/tasks/${op.id}/outcome`, A, { result: 'failed' });
  check('outcome failed needs a reason', r.status === 400 && r.body.code === 'publish.outcome_needs_reason');
  r = await http('POST', `/api/publish/tasks/${op.id}/outcome`, A, { result: 'failed', reason: 'App crashed while uploading' });
  check('operator records failure with reason', r.body.task.status === 'failed' && r.body.task.errorCode === 'publish.operator_failed' && r.body.task.error === 'App crashed while uploading');
  check('content with only failed tasks → failed', await contentStatus(A, cOp.id) === 'failed');
  r = await http('GET', `/api/tasks/${op.taskId}`, A);
  check('task centre shows the publish task to its owner; generic retry is disabled (canRetry false)', r.status === 200 && r.body.task.type === 'publish' && r.body.task.canRetry === false);
  r = await http('POST', `/api/publish/tasks/${op.id}/retry`, A, {});
  d = await waitStatus(A, op.id, ['awaiting_operator', 'failed']);
  check('retry after operator failure → awaiting operator again, history keeps 2 rounds', d.task.status === 'awaiting_operator' && d.runs.length === 2 && d.task.attemptNo === 2);
  await http('POST', `/api/publish/tasks/${op.id}/cancel`, A);

  // ---------------------------------------------------------------- account checks
  r = await http('POST', `/api/contents/${cOp.id}/distribute`, A, { targets: [{ accountId: igSusp }] });
  const susp = r.body.created[0];
  ptIds.add(susp.id);
  d = await waitStatus(A, susp.id, ['failed', 'awaiting_operator']);
  check('suspended account → fails at once with publish.account_inactive (1 attempt)', d.task.status === 'failed' && d.task.errorCode === 'publish.account_inactive' && d.runs[0].attempts === 1 && d.runs[0].errorCode === 'publish.account_inactive',
    `${d.task.status} ${d.task.errorCode} attempts=${d.runs[0]?.attempts}`);
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ytOut }] });
  const out = r.body.created[0];
  ptIds.add(out.id);
  d = await waitStatus(A, out.id, ['failed', 'awaiting_operator']);
  check('logged-out account on an online device → publish.not_logged_in', d.task.status === 'failed' && d.task.errorCode === 'publish.not_logged_in', `${d.task.status} ${d.task.errorCode}`);
  // Platform turned off on the account's device after linking → the run fails at once (before device/login checks).
  r = await http('PUT', `/api/instances/${DON2.id}/platforms`, T, { platforms: ['instagram'] });
  check('admin turns youtube off on the linked device', r.status === 200, r.text);
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ytOut }] });
  const off = r.body.created?.[0];
  if (off) ptIds.add(off.id);
  d = await waitStatus(A, off.id, ['failed', 'awaiting_operator']);
  check('platform turned off on the device → publish.platform_disabled (1 attempt, logged)', d.task.status === 'failed' && d.task.errorCode === 'publish.platform_disabled' && d.runs[0].attempts === 1
    && !d.logs.some((l: any) => l.message === 'check: platform enabled on the device'), `${d.task.status} ${d.task.errorCode} attempts=${d.runs[0]?.attempts}`);
  await http('PUT', `/api/instances/${DON2.id}/platforms`, T, { platforms: null });

  // ---------------------------------------------------------------- manual only (official-API publishing removed 2026-11-18)
  // The former test-only Facebook API method is gone too: a caption that used to select it now goes to an operator.
  {
    const cFb = (await http('POST', '/api/contents', A, { title: `pc-${tag} fb`, body: 'fb text' })).body.content;
    const accountId = await acc(A, { platform: 'facebook', instanceId: DON.id, loginStatus: 'logged_in' });
    const res = await http('POST', `/api/contents/${cFb.id}/distribute`, A, { targets: [{ accountId, caption: '[test:ok] x' }], maxAttempts: 2 });
    ptIds.add(res.body.created?.[0]?.id);
    d = await waitStatus(A, res.body.created[0].id, ['failed', 'awaiting_operator', 'published']);
    const fm = d.logs.map((l: any) => l.message as string);
    check('Facebook run (former test API caption) → awaiting_operator via manual, no API method lines',
      d.task.status === 'awaiting_operator' && d.task.method === 'manual' && d.runs[0].attempts === 1 && !fm.some((m: string) => /publishing via|method api|publish request sent/.test(m)),
      `${d.task.status} ${d.task.method} ${fm.join(' | ')}`);
  }

  // TikTok on the offline device: retried once, then failed
  d = await waitStatus(A, ttTask.id, ['failed', 'awaiting_operator'], 120_000);
  check('offline device → retried (2/2 attempts) then failed with publish.device_offline', d.task.status === 'failed' && d.task.errorCode === 'publish.device_offline' && d.runs[0].attempts === 2,
    `${d.task.status} ${d.task.errorCode} attempts=${d.runs[0]?.attempts}`);
  check('retry logged in publish_logs', d.logs.some((l: any) => /will retry/.test(l.message)) && d.logs.some((l: any) => l.level === 'error'));
  await db.update(schema.instances).set({ status: 'running', adbState: 'device', image: PINNED }).where(eq(schema.instances.id, DOFF.id));
  r = await http('POST', `/api/publish/tasks/${ttTask.id}/retry`, A, {});
  d = await waitStatus(A, ttTask.id, ['awaiting_operator', 'failed']);
  check('device back online + manual retry → awaiting operator; new scheduler task retry_of the old one, key publish:<id>:2',
    d.task.status === 'awaiting_operator' && d.runs.length === 2 && d.runs[1].retryOf === d.runs[0].id && d.runs[1].idempotencyKey === `publish:${ttTask.id}:2`);
  await http('POST', `/api/publish/tasks/${ttTask.id}/outcome`, A, { result: 'published', url: 'https://www.tiktok.com/@x/video/1' });
  check('all video targets settled → content partially_published (1 failed account check, 2 published)', await contentStatus(A, cVid.id) === 'partially_published');

  // ---------------------------------------------------------------- admin distributes to a user's account
  r = await http('POST', '/api/contents', T, { title: `pc-${tag} admin`, mediaIds: [imgPub] });
  const cAdm = r.body.content;
  r = await http('POST', `/api/contents/${cAdm.id}/distribute`, T, { targets: [{ accountId: igA, scheduledAt: in1h.toISOString() }] });
  const adm = r.body.created?.[0];
  if (adm) ptIds.add(adm.id);
  check("admin may target any account; the task belongs to the account's owner", r.status === 201 && adm.userId === uA && adm.createdBy !== uA);
  r = await http('GET', `/api/publish/tasks?contentId=${cAdm.id}`, A);
  check('the account owner sees it in their scheduler', r.body.total === 1);
  r = await http('PATCH', `/api/publish/tasks/${adm.id}`, A, { caption: 'Edited caption', hashtags: ['edit'] });
  check('edit caption/hashtags while scheduled', r.status === 200 && r.body.task.text === 'Edited caption\n\n#edit');
  await http('POST', `/api/publish/tasks/${adm.id}/cancel`, A);
  await http('DELETE', `/api/contents/${cAdm.id}`, T);

  // ---------------------------------------------------------------- list / calendar / RBAC
  r = await http('GET', `/api/publish/tasks?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}&sort=scheduled_asc`, A);
  check('calendar range query + byStatus counts', r.status === 200 && r.body.total >= 6 && r.body.byStatus.published >= 3 && r.body.items.every((i: any) => i.userId === uA));
  r = await http('GET', '/api/publish/tasks?status=failed', A);
  check('history filter by status', r.body.items.length >= 2 && r.body.items.every((i: any) => i.status === 'failed'));
  r = await http('GET', '/api/publish/tasks', B);
  check("B sees none of A's publish tasks", r.body.total === 0);
  r = await http('GET', `/api/publish/tasks/${igTask.id}`, B);
  check("B: A's publish task detail → 404", r.status === 404);
  r = await http('GET', `/api/publish/tasks?ownerId=${uA}`, B);
  check('B: ownerId filter of another user → 403', r.status === 403);
  r = await http('GET', `/api/publish/tasks?ownerId=${uA}`, T);
  check("admin sees A's publish tasks with owner filter", r.body.total >= 6);
  r = await http('GET', `/api/tasks/${igTask.taskId}`, B);
  check("task centre: B cannot see A's publish scheduler task", r.status === 404);
  r = await http('GET', '/api/publish/platforms', A);
  check('platform capabilities (no methods field: publishing is manual only)', ['instagram', 'youtube', 'tiktok', 'facebook'].every((id) => r.body.platforms.some((p: any) => p.id === id)) && r.body.platforms.every((p: any) => !('methods' in p))
    && r.body.platforms.find((p: any) => p.id === 'youtube').capability.media.max === 1);

  // ---------------------------------------------------------------- delete content (finished only)
  r = await http('DELETE', `/api/contents/${cOp.id}`, A);
  check('delete content whose publish tasks are finished → 204 (history goes with it)', r.status === 204
    && (await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, cOp.id))).length === 0);

  // ---------------------------------------------------------------- audit
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), eq(schema.auditLogs.username, `pca${tag}`)));
  const acts = new Set(audit.map((a) => a.action));
  const want = ['content.create', 'content.update', 'content.distribute', 'content.delete', 'publish.outcome_published', 'publish.outcome_failed', 'publish.reschedule', 'publish.cancel', 'publish.retry', 'publish.update'];
  check('audit entries for content + publish actions', want.every((a) => acts.has(a)), want.filter((a) => !acts.has(a)).join(',') || 'all present');
  const dist = audit.find((a) => a.action === 'content.distribute' && a.status === 201);
  check('audit detail allowlisted (no captions)', !!dist && Array.isArray((dist.detail as any).accountIds) && !JSON.stringify(audit.map((a) => a.detail)).includes('Edited caption'));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  // Users first: their contents, accounts, publish tasks and private media go with them.
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, T);
  for (const id of publicMedia) await http('DELETE', `/api/media/${id}`, T);
  await db.delete(schema.contents).where(like(schema.contents.title, `pc-${tag}%`));
  if (ptIds.size) await db.delete(schema.tasks).where(and(eq(schema.tasks.refType, 'publish'), inArray(schema.tasks.refId, [...ptIds])));
  if (fakeIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, fakeIds));
  await sqlClient.unsafe('drop trigger if exists pc_test_pin_online on instances').catch(() => undefined);
  await sqlClient.unsafe('drop function if exists pc_test_pin_online()').catch(() => undefined);
  const leftC = await db.select().from(schema.contents).where(like(schema.contents.title, `pc-${tag}%`));
  const leftP = ptIds.size ? await db.select().from(schema.publishTasks).where(inArray(schema.publishTasks.id, [...ptIds])) : [];
  const leftD = await db.select().from(schema.instances).where(like(schema.instances.name, `pcfake-${tag}-%`));
  check('cleanup: contents, publish tasks, scheduler tasks, devices, users removed', leftC.length === 0 && leftP.length === 0 && leftD.length === 0);
  await closeTaskQueues();
  await sqlClient.end();
  const failed = results.filter((x) => !x[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
