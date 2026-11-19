/**
 * Content management (内容管理) + publish scheduler (排程发布) through the real HTTP API, the real task centre
 * (BullMQ worker in the API), real media processing (sharp / ffmpeg). No mocks.
 * - Devices are placeholder `instances` rows (no Android container): "online" = status running + adb state device,
 *   held by a test-only trigger against the monitor (created and dropped by this script).
 *   Pushing media to a real phone is not covered here. Instagram runs try the `device` method (云手机发帖) first: adb
 *   doesn't see the placeholder phone, so they are handed to an operator (reason publish.device_offline), as before.
 * - 系统配置 → 任务超时 (`tasks.timeouts`, 2026-11-19): the publish.timeout data migration (twice), GET defaults per type,
 *   strict PUTs, unknown type 404, null = default, a new task takes the value (createTask), audit, old path 404; the
 *   发帖 row is set to 2 min for the run.
 * - No automatic publish retries (2026-11-18): every round is one attempt; distribute's maxAttempts
 *   is stripped (1 attempt); the POST …/retry endpoint is gone (404); the TikTok round on the offline phone fails once with publish.device_offline (1 attempt, no "will
 *   retry", no new round queued); 编辑后重新发布 = the content edited + distributed again to that account → a NEW
 *   publish task with the edited text (the failed one stays; a failed / cancelled pair is not published), the content status follows the
 *   newest task per account; a new round takes a changed timeout (5 min). The previous timeout rows are restored.
 * - 发布后不能再发 (2026-11-19): a content may be distributed to several accounts in one request, but once any account
 *   published it, distribute refuses it for every account (published or not, caption override, an older page's
 *   `republish: true`, admins too) with 409 publish.content_published {count}, nothing created; a legacy row flagged
 *   republish fails its run as publish.duplicate; a cancelled / failed pair of a content published nowhere can be
 *   published again. (The per-pair publish.already_published is a backstop distribute no longer reaches.)
 * - group=content (发文日志 / 排程发布, 2026-11-18): one row per content + account = its newest task with the older
 *   ones in `previous`; filters / total / paging / byStatus on the newest only; detail `history`; no param = every task.
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
import { cancelTask, closeTaskQueues, createTask } from '../src/modules/tasks/core.js';
import { refreshContentStatus } from '../src/modules/content/content.js';
import '../src/modules/publish/publish.js'; // registers the 'publish' task type (for the idempotency checks below)
import '../src/modules/media/media.js'; // registers media-process (任务超时 check)
import { migrateTaskTimeouts } from '../src/db/task-timeouts-migration.js';

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
// 发布任务 (timeout) for this run (restored in finally).
const TIMEOUT_KEYS = ['tasks.timeouts', 'publish.timeout', 'publish.retry'];
const prevRetryRows = await db.select().from(schema.settings).where(inArray(schema.settings.key, TIMEOUT_KEYS));

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
  // ---------------------------------------------------------------- 任务超时 setting (admin, strict, one row per type)
  {
    // data migration of the former 发布任务 setting: publish.timeout {timeoutSec} → tasks.timeouts.publish, rows deleted
    await db.delete(schema.settings).where(inArray(schema.settings.key, TIMEOUT_KEYS));
    await db.insert(schema.settings).values([{ key: 'publish.timeout', value: { timeoutSec: 240 } }, { key: 'publish.retry', value: { maxAttempts: 3, backoffSec: 60 } }]);
    const m1 = await migrateTaskTimeouts(sqlClient);
    const m2 = await migrateTaskTimeouts(sqlClient);
    const rows = await db.select().from(schema.settings).where(inArray(schema.settings.key, TIMEOUT_KEYS));
    check('data migration: publish.timeout 240 s → tasks.timeouts.publish 4 min, publish.timeout + publish.retry deleted, second run = no-op',
      m1 && !m2 && rows.length === 1 && rows[0]!.key === 'tasks.timeouts' && JSON.stringify(rows[0]!.value) === JSON.stringify({ publish: 240_000 }), JSON.stringify(rows));
    await db.delete(schema.settings).where(inArray(schema.settings.key, TIMEOUT_KEYS));

    const g = await http('GET', '/api/settings/task-timeouts', T);
    const by = Object.fromEntries((g.body?.items ?? []).map((i: any) => [i.type, i]));
    const want: Record<string, number | null> = {
      publish: Number(process.env.PUBLISH_TIMEOUT_MS ?? 600_000) / 60_000, 'comment-reply': 6, 'account-device-sync': 3, 'account-device-check': 3,
      'feed-collect': 15, 'account-following': 20, 'tracked-refresh': 5, 'trending-refresh': 2, 'media-process': 15,
      'install-apk': null, 'import-app': null, 'push-asset': null, 'db-backup': 60, 'db-restore': 180,
    };
    check('GET task timeouts: one row per type in order, defaults = the handlers\' values (install-apk etc. no limit), none custom',
      g.status === 200 && Object.keys(by).join() === Object.keys(want).join() && Object.entries(want).every(([k, v]) => by[k].timeoutMin === v && by[k].defaultMin === v && by[k].custom === false)
      && by['db-restore'].max === 1440 && by.publish.min === 1, g.text.slice(0, 400));
    const bad = await Promise.all([{ timeoutMin: 0 }, { timeoutMin: 61 }, { timeoutMin: 1.5 }, { timeoutMin: '2' }, { timeoutMin: 2, extra: 1 }, {}]
      .map((b) => http('PUT', '/api/settings/task-timeouts/publish', T, b)));
    check('PUT strict: 0 / 61 (range 1–60) / fraction / string / unknown field / missing → 400', bad.every((x) => x.status === 400) && bad[0]!.body.code === 'settings.task_timeout_range'
      && bad[1]!.body.params?.max === 60, bad.map((x) => `${x.status}:${x.body?.code}`).join(','));
    const unk = await http('PUT', '/api/settings/task-timeouts/collection-schedule', T, { timeoutMin: 5 });
    check('a type not in the list (scheduler) → 404 settings.task_timeout_unknown', unk.status === 404 && unk.body.code === 'settings.task_timeout_unknown', unk.text.slice(0, 160));
    const fc = await http('PUT', '/api/settings/task-timeouts/feed-collect', T, { timeoutMin: 30 });
    const fcBack = await http('PUT', '/api/settings/task-timeouts/feed-collect', T, { timeoutMin: null });
    const fcRow = (x: any) => x.body.items.find((i: any) => i.type === 'feed-collect');
    check('PUT feed-collect 30 → custom 30 (default 15); null → back to the default', fcRow(fc).timeoutMin === 30 && fcRow(fc).custom && fcRow(fc).defaultMin === 15
      && fcRow(fcBack).timeoutMin === 15 && !fcRow(fcBack).custom, `${JSON.stringify(fcRow(fc))} ${JSON.stringify(fcRow(fcBack))}`);
    const ia = await http('PUT', '/api/settings/task-timeouts/install-apk', T, { timeoutMin: 45 });
    const iaRow = ia.body.items.find((i: any) => i.type === 'install-apk');
    await http('PUT', '/api/settings/task-timeouts/install-apk', T, { timeoutMin: null });
    check('install-apk (default no limit) can get a timeout: 45 min', iaRow.timeoutMin === 45 && iaRow.defaultMin === null && iaRow.custom, JSON.stringify(iaRow));
    const ok = await http('PUT', '/api/settings/task-timeouts/publish', T, { timeoutMin: 2 });
    const [stored] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'tasks.timeouts'));
    check('PUT publish 2 min → stored as tasks.timeouts { publish: 120000 } only', ok.status === 200 && JSON.stringify(stored?.value) === JSON.stringify({ publish: 120_000 }), JSON.stringify(stored?.value));
    // a newly created task of the type carries it (createTask in this process reads the same settings row)
    const { task: mp } = await createTask({ type: 'media-process', label: `pc-timeout-${tag}`, payload: { assetId: '00000000-0000-0000-0000-000000000000' }, runAt: new Date(Date.now() + 3600_000), idempotencyKey: `pc-timeout-${tag}` });
    await http('PUT', '/api/settings/task-timeouts/media-process', T, { timeoutMin: 7 });
    await new Promise((res) => setTimeout(res, 5200)); // this process's 5 s cache of the row
    const { task: mp2 } = await createTask({ type: 'media-process', label: `pc-timeout-${tag}`, payload: { assetId: '00000000-0000-0000-0000-000000000000' }, runAt: new Date(Date.now() + 3600_000), idempotencyKey: `pc-timeout2-${tag}` });
    await http('PUT', '/api/settings/task-timeouts/media-process', T, { timeoutMin: null });
    for (const x of [mp, mp2]) await cancelTask(x, null);
    await sqlClient`delete from tasks where id in (${mp.id}, ${mp2.id})`;
    check('createTask: a new media-process task takes the default 15 min, after PUT 7 min a new one takes 420000 ms', mp.timeoutMs === 900_000 && mp2.timeoutMs === 420_000, `${mp.timeoutMs} ${mp2.timeoutMs}`);
    await new Promise((res) => setTimeout(res, 1500));
    const aus = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'settings.task_timeout'), gte(schema.auditLogs.at, t0), eq(schema.auditLogs.status, 200)))
      .orderBy(schema.auditLogs.at);
    check('audit settings.task_timeout per PUT with type + minutes (target = type)', aus.some((a) => (a.detail as any)?.type === 'publish' && (a.detail as any)?.timeoutMin === 2 && a.target === 'publish')
      && aus.some((a) => (a.detail as any)?.type === 'feed-collect' && (a.detail as any)?.timeoutMin === null), JSON.stringify(aus.map((a) => [a.target, a.detail])));
    const gone = await http('GET', '/api/settings/publish-retry', T);
    check('the former /api/settings/publish-retry is gone (404)', gone.status === 404, String(gone.status));
  }
  // ---------------------------------------------------------------- setup: users, placeholder devices, accounts, media
  const pw = randomBytes(12).toString('base64url');
  for (const n of ['a', 'b']) {
    const r = await http('POST', '/api/users', T, { username: `pc${n}${tag}`, password: pw, role: 'user' });
    userIds.push(r.body.user?.id ?? r.body.id);
  }
  const [uA, uB] = userIds as [string, string];
  const A = await login(`pca${tag}`, pw);
  {
    const g = await http('GET', '/api/settings/task-timeouts', A);
    const p = await http('PUT', '/api/settings/task-timeouts/publish', A, { timeoutMin: 30 });
    check('task timeouts: a user gets 403 on GET and PUT', g.status === 403 && p.status === 403, `${g.status} ${p.status}`);
  }
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

  // 内容编辑器「上传」: the editor uploads as the content owner's own media (scope mine) and attaches the asset at once,
  // while it is still processing; publishing waits until it is ready. An admin's own upload can't go on a user's content
  // (the editor disables 上传 there).
  {
    const fd = new FormData();
    fd.append('scope', 'mine');
    fd.append('name', `pc-editor-upload-${tag}`);
    fd.append('process', JSON.stringify({ maxSize: 720, quality: 'low' }));
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
    fd.append('file', new Blob([new Uint8Array(big)], { type: 'image/png' }), 'pc-editor.png');
    const up = await http('POST', '/api/media/upload', A, fd);
    const upId: string = up.body?.item?.id;
    check('editor upload: 201 processing, own private media', up.status === 201 && up.body.item.status === 'processing' && up.body.item.ownerType === 'user', up.text.slice(0, 160));
    const cr = await http('POST', '/api/contents', A, { title: `pc-${tag} editor upload`, mediaIds: [imgA1, upId] });
    const cUp = cr.body.content;
    check('content accepts its own processing media, appended in order', cr.status === 201 && cUp.media.map((m: any) => m.id).join() === [imgA1, upId].join(), cr.text.slice(0, 200));
    const stillProcessing = cUp?.media?.[1]?.status === 'processing';
    const d1 = await http('POST', `/api/contents/${cUp.id}/distribute`, A, { targets: [{ accountId: igA, scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString() }] });
    if (stillProcessing) check('distribute while the uploaded asset processes → 409 publish.media_not_ready', d1.status === 409 && d1.body.code === 'publish.media_not_ready', d1.text.slice(0, 160));
    else {
      console.log(`  (asset was already ready when the content was created: media_not_ready not exercised, distribute ${d1.status})`);
      for (const tk of d1.body?.created ?? []) await http('POST', `/api/publish/tasks/${tk.id}/cancel`, A);
    }
    const ready = await waitFor('editor upload ready', async () => { const g = await http('GET', `/api/media/${upId}`, A); return g.body.item.status === 'ready' ? g.body.item : null; }, 90_000);
    check('GET /api/media/:id (the editor polls it) → ready with a thumbnail, 720p', Boolean(ready.thumbnailUrl) && Math.min(ready.width, ready.height) === 720, `${ready.width}×${ready.height}`);
    const cg = await http('GET', `/api/contents/${cUp.id}`, A);
    check('content media shows the asset ready afterwards', cg.body.content.media[1]?.status === 'ready');
    if (stillProcessing) {
      const d2 = await http('POST', `/api/contents/${cUp.id}/distribute`, A, { targets: [{ accountId: igA, scheduledAt: new Date(Date.now() + 3 * 86400_000).toISOString() }] });
      check('distribute once ready → 201', d2.status === 201, d2.text.slice(0, 160));
      for (const tk of d2.body?.created ?? []) await http('POST', `/api/publish/tasks/${tk.id}/cancel`, A);
    }
    const del = await http('DELETE', `/api/contents/${cUp.id}`, A);
    check('content with the uploaded asset deleted (publish task cancelled)', del.status === 200 || del.status === 204, del.text.slice(0, 120));
    const adminUp = new FormData();
    adminUp.append('scope', 'mine');
    adminUp.append('file', new Blob([new Uint8Array(await png(77))], { type: 'image/png' }), 'pc-admin.png');
    const au = await http('POST', '/api/media/upload', T, adminUp);
    const ac = await http('POST', '/api/contents', T, { title: 'x', ownerId: uA, mediaIds: [au.body.item.id] });
    check("admin's own upload on A's content → 400 content.media_not_usable (editor disables 上传)", ac.status === 400 && ac.body.code === 'content.media_not_usable', ac.text.slice(0, 120));
    await waitFor('admin upload settled', async () => ['ready', 'failed'].includes((await http('GET', `/api/media/${au.body.item.id}`, T)).body.item.status), 90_000);
    await http('DELETE', `/api/media/${au.body.item.id}`, T);
  }
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
  check('distribute to TikTok (a maxAttempts 2 in the body is stripped → 1): hashtags normalised', r.status === 201 && ttTask.hashtags.join() === 'fyp,demo' && ttTask.maxAttempts === 1 && ttTask.text === 'TT caption\n\n#fyp #demo', r.text.slice(0, 200));

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
  check('scheduler task: type publish, scheduled, runAt, idempotency key publish:<id>:1, ref publish, 1 attempt, no backoff, timeout 120 s',
    ytRow0?.type === 'publish' && ytRow0.status === 'scheduled' && Math.abs(ytRow0.runAt!.getTime() - runAt.getTime()) < 1000
    && ytRow0.idempotencyKey === `publish:${ytTask.id}:1` && ytRow0.refType === 'publish' && ytRow0.refId === ytTask.id && ytRow0.maxAttempts === 1 && ytTask.maxAttempts === 1 && !('backoffMs' in ytRow0) && ytRow0.timeoutMs === 120_000,
    `${ytRow0?.status} ${ytRow0?.idempotencyKey} max=${ytRow0?.maxAttempts} timeout=${ytRow0?.timeoutMs}`);
  check('content status after distribution: scheduled (stage ready)', await contentStatus(A, cVid.id) === 'scheduled');

  // idempotency: same distribution again
  // (only the scheduled YouTube target: the TikTok round on the offline phone may already have failed, and a failed
  // pair is distributed anew, see 编辑后重新发布 below)
  r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ytA, scheduledAt: runAt.toISOString() }] });
  check('double distribute: 200, nothing created, existing returned', r.status === 200 && r.body.created.length === 0 && r.body.existing.length === 1 && r.body.existing[0].id === ytTask.id);
  const vidTasks = await db.select().from(schema.publishTasks).where(and(eq(schema.publishTasks.contentId, cVid.id), eq(schema.publishTasks.accountId, ytA)));
  const vidRuns = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, 'publish'), inArray(schema.tasks.refId, vidTasks.map((x) => x.id))));
  check('still one publish task and one scheduler task for the account', vidTasks.length === 1 && vidRuns.length === 1);
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

  // a translation while nothing is published yet (the lock below must keep it)
  r = await http('PUT', `/api/contents/${cImg.id}/translations/en`, A, { title: 'EN carousel', body: 'EN caption' });
  check('before anything is published: translation saved (201), content not locked', r.status === 201 && (await http('GET', `/api/contents/${cImg.id}`, A)).body.content.locked === false, r.text.slice(0, 160));

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

  // ---------------------------------------------------------------- 已发布的内容不能编辑 (owner 2026-11-19)
  {
    const locked409 = (x: any) => x.status === 409 && x.body.code === 'content.published_locked';
    const det = (await http('GET', `/api/contents/${cImg.id}`, A)).body;
    const curMedia = det.content.media.map((m: any) => m.id) as string[];
    const curTargets = det.content.targets.map((x: any) => x.id) as string[];
    const listItem = (await http('GET', `/api/contents?q=${encodeURIComponent(`pc-${tag} carousel`)}`, A)).body.items.find((x: any) => x.id === cImg.id);
    check('published content: locked in the detail and the list; the publish task item says so too',
      det.content.locked === true && listItem?.locked === true && (await ptask(A, igTask.id)).task.content?.locked === true);
    const refused: [string, unknown][] = [
      ['title', { title: `pc-${tag} carousel changed` }], ['body', { body: 'changed body' }],
      ['platform texts', { platformHints: { instagram: { caption: 'IG changed' } } }], ['media', { mediaIds: [...curMedia].reverse() }],
      ['targets', { targetIds: [...curTargets, igSusp] }], ['source language', { lang: 'en' }],
    ];
    for (const [what, body] of refused) {
      r = await http('PUT', `/api/contents/${cImg.id}`, A, body);
      check(`locked: PUT ${what} → 409 content.published_locked`, locked409(r), r.text.slice(0, 160));
    }
    r = await http('PUT', `/api/contents/${cImg.id}`, T, { title: `pc-${tag} admin edit` });
    check('locked: an admin is refused too (409)', locked409(r), r.text.slice(0, 160));
    r = await http('PUT', `/api/contents/${cImg.id}`, A, { title: det.content.title, body: det.content.body, platformHints: det.content.platformHints, mediaIds: curMedia, targetIds: curTargets });
    check('locked: a PUT that resends the same texts / media / targets passes (200)', r.status === 200, r.text.slice(0, 160));
    r = await http('PUT', `/api/contents/${cImg.id}`, A, { categoryId: catVideo.id, tags: ['locked-ok'] });
    check('locked: category + tags can still be changed', r.status === 200 && r.body.content.category?.id === catVideo.id && r.body.content.tags.includes('locked-ok'), r.text.slice(0, 160));
    r = await http('PUT', `/api/contents/${cImg.id}`, A, { stage: 'archived' });
    const arch = r.status === 200 && r.body.content.stage === 'archived';
    r = await http('PUT', `/api/contents/${cImg.id}`, A, { stage: 'ready' });
    check('locked: 归档 / 取消归档 still allowed', arch && r.status === 200 && r.body.content.stage === 'ready' && r.body.content.status === 'published', r.text.slice(0, 160));
    r = await http('POST', '/api/contents/batch', A, { ids: [cImg.id], action: 'set-category', categoryId: catLaunch.id });
    check('locked: batch set-category still allowed', r.status === 200 && r.body.ok.length === 1 && r.body.changed === 1, r.text.slice(0, 160));
    r = await http('PUT', `/api/contents/${cImg.id}/translations/en`, A, { title: 'EN changed', body: 'x' });
    check('locked: translation PUT → 409', locked409(r), r.text.slice(0, 160));
    r = await http('PUT', `/api/contents/${cImg.id}/translations/de`, A, { title: 'DE new' });
    check('locked: a NEW translation → 409', locked409(r), r.text.slice(0, 160));
    r = await http('DELETE', `/api/contents/${cImg.id}/translations/en`, A);
    const trs = (await http('GET', `/api/contents/${cImg.id}/translations`, A)).body.translations;
    check('locked: translation DELETE → 409, the translation is kept unchanged', locked409(r) && trs.length === 1 && trs[0].lang === 'en' && trs[0].title === 'EN carousel', r.text.slice(0, 160));
    const after = (await http('GET', `/api/contents/${cImg.id}`, A)).body.content;
    check('locked: nothing of the refused changes was stored', after.title === det.content.title && after.body === det.content.body
      && after.media.map((m: any) => m.id).join() === curMedia.join() && after.targets.map((x: any) => x.id).join() === curTargets.join());
  }

  // ---------------------------------------------------------------- 发布后不能再发 (owner 2026-11-19): several accounts at once, never again
  {
    const pub409 = (x: any) => x.status === 409 && x.body.code === 'publish.content_published' && x.body.params?.count === 1;
    const countOf = async (id: string) => (await db.select({ id: schema.publishTasks.id }).from(schema.publishTasks).where(eq(schema.publishTasks.contentId, id))).length;
    const later3 = new Date(Date.now() + 2 * 86400_000).toISOString();
    const nImg = await countOf(cImg.id);
    r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igSusp, scheduledAt: later3 }] });
    check('published content: distribute to a not yet published account → 409 publish.content_published {count: 1}', pub409(r), r.text.slice(0, 160));
    r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igSusp, scheduledAt: later3, caption: 'per-account text' }] });
    check('published content: with a per-account caption override → 409 publish.content_published', pub409(r), r.text.slice(0, 160));
    r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igA }] });
    check('published content: to the account it is published on → 409 publish.content_published (before the per-pair check)', pub409(r), r.text.slice(0, 160));
    r = await http('POST', `/api/contents/${cImg.id}/distribute`, A, { targets: [{ accountId: igA }], republish: true });
    check('an older page\'s `republish: true` is ignored: still 409 publish.content_published', pub409(r), r.text.slice(0, 160));
    r = await http('POST', `/api/contents/${cImg.id}/distribute`, T, { targets: [{ accountId: igSusp, scheduledAt: later3 }], republish: true });
    check('an admin is refused too (409 publish.content_published)', pub409(r), r.text.slice(0, 160));
    check('no publish task was created for the published content', await countOf(cImg.id) === nImg);
    // 发布时可多选: one request to two accounts; once one of them published, the other's unfinished task keeps its text
    r = await http('POST', '/api/contents', A, { title: `pc-${tag} multi`, mediaIds: [imgA1], platformHints: { instagram: { caption: 'multi' } } });
    const cMulti = r.body.content;
    r = await http('POST', `/api/contents/${cMulti.id}/distribute`, A, { targets: [{ accountId: igA }, { accountId: igSusp, scheduledAt: later3 }] });
    const [mA, mS] = [r.body.created?.find((x: any) => x.accountId === igA), r.body.created?.find((x: any) => x.accountId === igSusp)];
    for (const x of [mA, mS]) if (x) ptIds.add(x.id);
    check('distribute one content to 2 accounts in one request → 201, 2 tasks', r.status === 201 && !!mA && !!mS && mS.status === 'scheduled', r.text.slice(0, 200));
    await waitStatus(A, mA.id, ['awaiting_operator', 'failed']);
    r = await http('POST', `/api/publish/tasks/${mA.id}/outcome`, A, { result: 'published', url: 'https://www.instagram.com/p/pc-multi/' });
    check('one of the two published → content locked', r.body.task?.status === 'published' && (await http('GET', `/api/contents/${cMulti.id}`, A)).body.content.locked === true);
    r = await http('PATCH', `/api/publish/tasks/${mS.id}`, A, { caption: 'edited later' });
    check('locked: editing the text of the other (scheduled) task → 409 content.published_locked', r.status === 409 && r.body.code === 'content.published_locked', r.text.slice(0, 160));
    const nMulti = await countOf(cMulti.id);
    r = await http('POST', `/api/contents/${cMulti.id}/distribute`, A, { targets: [{ accountId: igSusp, scheduledAt: later3 }] });
    check('distributing it again (even to the still scheduled account) → 409 publish.content_published, nothing created', pub409(r) && await countOf(cMulti.id) === nMulti, r.text.slice(0, 160));
    await http('POST', `/api/publish/tasks/${mS.id}/cancel`, A);
  }

  // ---------------------------------------------------------------- 1 个内容只发布一次: a legacy republish row
  // a LEGACY row flagged republish (written by an older release) fails its run as a duplicate instead of publishing again
  {
    const [legacy] = await db.insert(schema.publishTasks).values({
      userId: uA, contentId: cImg.id, accountId: igA, platform: 'instagram', title: null, caption: 'IG caption', hashtags: [], options: {},
      mediaIds: [imgA2, imgA1], postType: 'feed', scheduledAt: new Date(), status: 'pending', maxAttempts: 1, republish: true, createdBy: uA,
    }).returning();
    ptIds.add(legacy!.id);
    const { task } = await createTask({ type: 'publish', userId: uA, refType: 'publish', refId: legacy!.id, payload: { publishTaskId: legacy!.id, attemptNo: 1 },
      idempotencyKey: `publish:${legacy!.id}:1`, maxAttempts: 1 });
    await db.update(schema.publishTasks).set({ taskId: task.id }).where(eq(schema.publishTasks.id, legacy!.id));
    d = await waitStatus(A, legacy!.id, ['failed', 'awaiting_operator', 'published']);
    check('legacy republish row: the run refuses it (failed publish.duplicate), never handed to an operator', d.task.status === 'failed' && d.task.errorCode === 'publish.duplicate', `${d.task.status} ${d.task.errorCode}`);
    // only an older release writes such rows: the fixture is removed again (the content status counts the newest task per pair)
    await db.delete(schema.publishTasks).where(eq(schema.publishTasks.id, legacy!.id));
    await refreshContentStatus(cImg.id);
    check('legacy row removed again: the content is published', await contentStatus(A, cImg.id) === 'published');
  }
  // a cancelled pair is not published: it can be published again
  {
    r = await http('POST', '/api/contents', A, { title: `pc-${tag} once`, mediaIds: [imgA2], platformHints: { instagram: { caption: 'once' } } });
    const cOnce = r.body.content;
    r = await http('POST', `/api/contents/${cOnce.id}/distribute`, A, { targets: [{ accountId: igA }] });
    const first = r.body.created?.[0];
    if (first) ptIds.add(first.id);
    d = await waitStatus(A, first.id, ['awaiting_operator', 'failed']);
    check('a new content on the same account runs (handed to the operator)', d.task.status === 'awaiting_operator', d.task.errorCode ?? '');
    r = await http('POST', `/api/publish/tasks/${first.id}/cancel`, A);
    check('cancel while awaiting operator → cancelled', r.status === 200 && r.body.task.status === 'cancelled');
    r = await http('POST', `/api/contents/${cOnce.id}/distribute`, A, { targets: [{ accountId: igA }] });
    const again = r.body.created?.[0];
    if (again) ptIds.add(again.id);
    check('a cancelled pair can be published again (201, a new task)', r.status === 201 && !!again && again.id !== first.id, r.text.slice(0, 160));
    if (again) {
      await waitStatus(A, again.id, ['awaiting_operator', 'failed']);
      await http('POST', `/api/publish/tasks/${again.id}/cancel`, A);
    }
    await http('DELETE', `/api/contents/${cOnce.id}`, A);
  }

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

  // the former retry endpoint (same snapshot again) is gone: the UI offers 编辑后重新发布 (a new publish task)
  r = await http('POST', `/api/publish/tasks/${later.id}/retry`, A, {});
  check('POST …/retry of a cancelled task → 404 (endpoint removed)', r.status === 404, r.text.slice(0, 160));

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
  r = await http('PUT', `/api/contents/${cOp.id}`, A, { title: `pc-${tag} opfail edited`, body: 'edited after a failure' });
  const rTr = await http('PUT', `/api/contents/${cOp.id}/translations/en`, A, { title: 'EN opfail' });
  check('only failed tasks: not locked, texts + translations editable', r.status === 200 && r.body.content.locked === false && rTr.status === 201, `${r.status} ${rTr.status}`);
  r = await http('PUT', `/api/contents/${cLater.id}`, A, { title: `pc-${tag} later edited` });
  check('only cancelled tasks: not locked, editable', r.status === 200 && r.body.content.locked === false, r.text.slice(0, 160));
  r = await http('GET', `/api/tasks/${op.taskId}`, A);
  check('task centre shows the publish task to its owner; generic retry is disabled (canRetry false)', r.status === 200 && r.body.task.type === 'publish' && r.body.task.canRetry === false);
  r = await http('POST', `/api/publish/tasks/${op.id}/retry`, A, {});
  check('no retry after an operator failure (POST …/retry → 404)', r.status === 404, r.text.slice(0, 160));

  // ---------------------------------------------------------------- account checks
  r = await http('POST', `/api/contents/${cOp.id}/distribute`, A, { targets: [{ accountId: igSusp }] });
  const susp = r.body.created[0];
  ptIds.add(susp.id);
  d = await waitStatus(A, susp.id, ['failed', 'awaiting_operator']);
  check('suspended account → fails at once with publish.account_inactive (1 attempt)', d.task.status === 'failed' && d.task.errorCode === 'publish.account_inactive' && d.runs[0].attempts === 1 && d.runs[0].errorCode === 'publish.account_inactive',
    `${d.task.status} ${d.task.errorCode} attempts=${d.runs[0]?.attempts}`);
  // cVid is published on YouTube (发布后不能再发): the account checks use a fresh video content
  const cVid2 = (await http('POST', '/api/contents', A, { title: `pc-${tag} video2`, body: 'Video 2', mediaIds: [vidA] })).body.content;
  r = await http('POST', `/api/contents/${cVid2.id}/distribute`, A, { targets: [{ accountId: ytOut }] });
  const out = r.body.created[0];
  ptIds.add(out.id);
  d = await waitStatus(A, out.id, ['failed', 'awaiting_operator']);
  check('logged-out account on an online device → publish.not_logged_in', d.task.status === 'failed' && d.task.errorCode === 'publish.not_logged_in', `${d.task.status} ${d.task.errorCode}`);
  // Platform turned off on the account's device after linking → the run fails at once (before device/login checks).
  r = await http('PUT', `/api/instances/${DON2.id}/platforms`, T, { platforms: ['instagram'] });
  check('admin turns youtube off on the linked device', r.status === 200, r.text);
  r = await http('POST', `/api/contents/${cVid2.id}/distribute`, A, { targets: [{ accountId: ytOut }] });
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

  // TikTok on the offline device: ONE attempt, failed, nothing re-queued
  d = await waitStatus(A, ttTask.id, ['failed', 'awaiting_operator'], 120_000);
  check('offline device → failed at once with publish.device_offline (1 attempt)', d.task.status === 'failed' && d.task.errorCode === 'publish.device_offline' && d.runs.length === 1 && d.runs[0].attempts === 1 && d.runs[0].maxAttempts === 1,
    `${d.task.status} ${d.task.errorCode} runs=${d.runs.length} attempts=${d.runs[0]?.attempts}/${d.runs[0]?.maxAttempts}`);
  check('no retry logged (publish_logs: an error, no "will retry")', !d.logs.some((l: any) => /will retry/.test(l.message)) && d.logs.some((l: any) => l.level === 'error'));
  {
    const [ttRun] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, d.task.taskId));
    const lines = ttRun ? await db.select().from(schema.taskLogs).where(eq(schema.taskLogs.taskId, ttRun.id)) : [];
    check('scheduler task: failed, timeout_ms 120000, no "failed, retrying" line', ttRun?.status === 'failed' && ttRun.timeoutMs === 120_000
      && !lines.some((l) => /retrying/.test(l.message)), `${ttRun?.status} ${ttRun?.timeoutMs}`);
    await sleep(4000);
    const later2 = await ptask(A, ttTask.id);
    const open = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.refId, ttTask.id), inArray(schema.tasks.status, ['pending', 'scheduled', 'running'])));
    check('4 s later: still failed, still one round, no task queued for it', later2.task.status === 'failed' && later2.runs.length === 1 && open.length === 0, `${later2.task.status} runs=${later2.runs.length} open=${open.length}`);
  }
  check('content with a failed round shows it (not published everywhere)', ['partially_published', 'failed', 'scheduled'].includes(await contentStatus(A, cVid.id)));
  // cVid is already published on YouTube, so it is LOCKED: neither its texts can be edited nor its failed TikTok pair
  // published again (发布后不能再发, 2026-11-19).
  await http('PUT', '/api/settings/task-timeouts/publish', T, { timeoutMin: 5 });
  {
    const cur = (await http('GET', `/api/contents/${cVid.id}`, A)).body.content;
    const hints = { ...(cur.platformHints ?? {}), tiktok: { ...(cur.platformHints?.tiktok ?? {}), caption: `TT edited ${tag}` } };
    r = await http('PUT', `/api/contents/${cVid.id}`, A, { platformHints: hints });
    check('the platform texts of a content published elsewhere (YouTube) cannot be edited (409 content.published_locked)', r.status === 409 && r.body.code === 'content.published_locked', r.text.slice(0, 160));
    r = await http('POST', `/api/contents/${cVid.id}/distribute`, A, { targets: [{ accountId: ttA }] });
    check('its failed TikTok pair cannot be published again either (409 publish.content_published)', r.status === 409 && r.body.code === 'publish.content_published', r.text.slice(0, 160));
  }
  check('video content stays partially_published (YouTube published, TikTok failed)', await contentStatus(A, cVid.id) === 'partially_published');
  // 编辑后重新发布 on a content published nowhere: cOp (only failed tasks, edited above) distributed again to the failed
  // account → a NEW publish task with the edited text; the failed one stays as history.
  {
    r = await http('POST', `/api/contents/${cOp.id}/distribute`, A, { targets: [{ accountId: igA }] });
    const nt = r.body.created?.[0];
    if (nt) ptIds.add(nt.id);
    check('distribute again to the failed pair: 201, a NEW publish task with the edited text, 1 attempt', r.status === 201 && !!nt && nt.id !== op.id
      && nt.caption === 'edited after a failure' && nt.maxAttempts === 1 && nt.attemptNo === 1, r.text.slice(0, 200));
    const oldRow = (await ptask(A, op.id)).task;
    check('the failed task stays as history (failed, its old text)', oldRow.status === 'failed' && oldRow.caption !== 'edited after a failure', `${oldRow.status} ${oldRow.caption}`);
    d = await waitStatus(A, nt.id, ['awaiting_operator', 'failed']);
    const [newRun] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, d.task.taskId));
    check('the new round takes the changed timeout (300 s), 1 attempt → awaiting operator', d.task.status === 'awaiting_operator' && newRun?.timeoutMs === 300_000 && newRun?.maxAttempts === 1,
      `${d.task.status} ${newRun?.timeoutMs} ${newRun?.maxAttempts}`);
    await http('POST', `/api/publish/tasks/${nt.id}/outcome`, A, { result: 'published', url: 'https://www.instagram.com/p/pc-op/' });
    const list = (await http('GET', `/api/contents?q=${encodeURIComponent(`pc-${tag}`)}&pageSize=100`, A)).body.items.find((x: any) => x.id === cOp.id);
    check('publishCounts count the newest task per account (igA: published, its superseded failure not counted; igSusp failed)', list?.publishCounts?.published === 1 && list?.publishCounts?.failed === 1, JSON.stringify(list?.publishCounts));
    check('content status → partially_published (1 published, 1 failed; the superseded failure not counted)', await contentStatus(A, cOp.id) === 'partially_published');
  }

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

  // ---------------------------------------------------------------- group=content: newest task per content + account, older ones folded
  {
    const later = () => new Date(Date.now() + 5 * 86400_000).toISOString();
    const mk = async (title: string) => (await http('POST', '/api/contents', A, { title: `pc-${tag} ${title}`, body: 'grp', mediaIds: [imgA1] })).body.content.id as string;
    const g1 = await mk('grp1');
    const g2 = await mk('grp2');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { // 3 attempts on g1 → igA (each cancelled, then 编辑后重新发布 = a new task)
      const d = await http('POST', `/api/contents/${g1}/distribute`, A, { targets: [{ accountId: igA, scheduledAt: later() }] });
      ids.push(d.body.created[0].id);
      if (i < 2) await http('POST', `/api/publish/tasks/${d.body.created[0].id}/cancel`, A);
      await sleep(20);
    }
    const g2t = (await http('POST', `/api/contents/${g2}/distribute`, A, { targets: [{ accountId: igA, scheduledAt: later() }] })).body.created[0].id as string;
    const q = `q=${encodeURIComponent(`pc-${tag} grp`)}`;
    r = await http('GET', `/api/publish/tasks?${q}&sort=updated_desc`, A);
    check('without group: every task listed (old behaviour, no previous field)', r.status === 200 && r.body.total === 4 && r.body.items.every((i: any) => !('previous' in i)), `${r.body.total}`);
    const plainCancelled = r.body.byStatus.cancelled;
    r = await http('GET', `/api/publish/tasks?${q}&group=content&sort=updated_desc`, A);
    const row1 = r.body.items?.find((i: any) => i.contentId === g1);
    check('group=content: one row per content + account (2), total 2, the newest task of g1 with its 2 older attempts in previous (newest first, cancelled)',
      r.status === 200 && r.body.total === 2 && r.body.items.length === 2 && row1?.id === ids[2] && row1.previous.map((x: any) => x.id).join() === [ids[1], ids[0]].join()
      && row1.previous.every((x: any) => x.status === 'cancelled' && 'errorCode' in x && 'updatedAt' in x) && r.body.items.find((i: any) => i.contentId === g2)?.previous.length === 0,
    JSON.stringify(r.body.items?.map((i: any) => [i.id, i.previous?.map((x: any) => x.id)])));
    check('group=content: byStatus counts the newest tasks only (no cancelled; without group 2)', r.body.byStatus.cancelled === 0 && r.body.byStatus.scheduled === 2 && plainCancelled === 2, JSON.stringify(r.body.byStatus));
    const [pg1, pg2] = await Promise.all([1, 2].map((n) => http('GET', `/api/publish/tasks?${q}&group=content&sort=updated_desc&limit=1&offset=${n - 1}`, A)));
    check('group=content paging: limit 1 → total 2 on both pages, two different rows', pg1.body.total === 2 && pg2.body.total === 2 && pg1.body.items.length === 1 && pg2.body.items.length === 1 && pg1.body.items[0].id !== pg2.body.items[0].id);
    r = await http('GET', `/api/publish/tasks?${q}&group=content&status=cancelled`, A);
    const r2 = await http('GET', `/api/publish/tasks?${q}&status=cancelled`, A);
    check('status filter matches the newest task: group=content&status=cancelled → 0 (newest are scheduled); without group → the 2 cancelled', r.body.total === 0 && r2.body.total === 2, `${r.body.total} ${r2.body.total}`);
    r = await http('GET', `/api/publish/tasks?contentId=${g1}&group=content`, B);
    check("B: group=content shows none of A's tasks", r.status === 200 && r.body.total === 0);
    r = await http('GET', `/api/publish/tasks/${ids[0]}`, A);
    check('detail: history = every task of this content on this account, newest first (3)', r.status === 200 && r.body.history?.map((x: any) => x.id).join() === [ids[2], ids[1], ids[0]].join(), JSON.stringify(r.body.history?.map((x: any) => x.id)));
    r = await http('GET', `/api/publish/tasks/${g2t}`, A);
    check('detail of a single task: history of 1', r.body.history?.length === 1 && r.body.history[0].id === g2t);
    for (const id of [ids[2], g2t]) await http('POST', `/api/publish/tasks/${id}/cancel`, A);
  }

  // ---------------------------------------------------------------- delete content (finished only)
  r = await http('DELETE', `/api/contents/${cOp.id}`, A);
  check('delete content whose publish tasks are finished → 204 (history goes with it)', r.status === 204
    && (await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.contentId, cOp.id))).length === 0);

  // ---------------------------------------------------------------- audit
  const audit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, t0), eq(schema.auditLogs.username, `pca${tag}`)));
  const acts = new Set(audit.map((a) => a.action));
  const want = ['content.create', 'content.update', 'content.distribute', 'content.delete', 'publish.outcome_published', 'publish.outcome_failed', 'publish.reschedule', 'publish.cancel', 'publish.update'];
  check('audit entries for content + publish actions', want.every((a) => acts.has(a)), want.filter((a) => !acts.has(a)).join(',') || 'all present');
  const dist = audit.find((a) => a.action === 'content.distribute' && a.status === 201);
  check('audit detail allowlisted (no captions)', !!dist && Array.isArray((dist.detail as any).accountIds) && !JSON.stringify(audit.map((a) => a.detail)).includes('Edited caption'));
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  await db.delete(schema.settings).where(inArray(schema.settings.key, TIMEOUT_KEYS));
  if (prevRetryRows.length) await db.insert(schema.settings).values(prevRetryRows);
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
