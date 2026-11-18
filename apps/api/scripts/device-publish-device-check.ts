/**
 * 云手机发帖 on a real cloud phone (owner decision 2026-11-18): real API, DB, task centre, adb, STF and the real
 * Instagram app on the BitBrowser phone bit-ins-02 (no mocks). TEST MODE ONLY: the script sets 风控 → 云手机发帖 to
 * test mode and refuses to continue otherwise, so 分享 is never tapped: every run stops on the last screen before
 * sharing (caption pasted + read back, screenshot), clears the caption, discards the draft (重拍 / 放弃) and goes
 * back to the launcher. Navigation, the creation flow's own buttons, the caption field and the paste only: no
 * likes, follows, DMs, profile edits, no power on/off, no installs.
 *
 *   E2E_API=http://127.0.0.1:<port> API_PORT=<port> [MAIN_DEVICE_ID=<bit-ins-02 id in the main DB>] \
 *     npx tsx --env-file=../../.env scripts/device-publish-device-check.ts [--only feed1,feed2,reel,story]
 *
 * Device access like feed-device-check: an inert external device row in THIS API's DB on the adb port the main
 * API's tunnel keeps open (BIT_ADB_PORT, default 5700); its source config is invalid, so this API never powers the
 * phone or opens a second tunnel. The main API's Redis is only READ (MAIN_DEVICE_ID: before each run the script
 * waits while the main API's device lock `tracked:collector:lock:<id>` in db 0 is held; it never sets or deletes a
 * key there). A scrcpy viewer on the phone (someone watching) stops the script.
 *
 * Runs (one Instagram creation flow each; the account is checked via `dumpsys account`, no extra screen):
 *   feed1  帖子, 1 image   feed2  帖子, 2 images (carousel, item 2 picked in the app's gallery)
 *   reel   Reels, 1 video  story  快拍, 1 image
 * Each: media pushed (is_pending=0) → share target → … → caption pasted + read back (story: none) → screenshot →
 * draft discarded → status dry_run with PNG evidence; afterwards no cppub-* file / MediaStore row, no test text in
 * the clipboard, launcher, no dump file.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { parseClipParcel } from '../src/modules/publish/ig-publish.js';
import { activeStorage } from '../src/modules/settings/storage.js';
import { adb } from '../src/services.js';
import { withCaptcha } from './lib/login.js';
import { linkAccount } from './lib/social-link.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
if (/:3000\b/.test(API)) throw new Error('refusing to run against the main API (port 3000): set E2E_API and API_PORT to the test API');
const BIT_PORT = Number(process.env.BIT_ADB_PORT ?? 5700);
const OWN_HANDLE = process.env.OWN_HANDLE ?? 'conchadoroperto650';
const OWN_ID = process.env.OWN_EXTERNAL_ID ?? '78090361572';
const ALL = ['feed1', 'feed2', 'reel', 'story'] as const;
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? process.argv[onlyArg + 1]!.split(',') : [...ALL];
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function http<T = any>(method: string, p: string, token: string | null, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, body: json as T, text: buf.toString('utf8').slice(0, 400), buf, type: res.headers.get('content-type') ?? '' };
}
async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username, password })) });
  return (await r.json()).token;
}
async function waitFor<T>(label: string, fn: () => Promise<T | null | false | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(1000); }
}
async function upload(token: string, name: string, data: Buffer, mime: string) {
  const fd = new FormData();
  fd.append('scope', 'mine');
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
  const r = await http('POST', '/api/media/upload', token, fd);
  if (r.status !== 201) throw new Error(`upload failed ${r.status} ${r.text}`);
  const id: string = r.body.item.id;
  await waitFor(`media ${name} ready`, async () => (await http('GET', `/api/media/${id}`, token)).body.item.status === 'ready', 120_000);
  return id;
}
const T = schema.tasks;
const logsOf = async (taskIds: string[]) => (taskIds.length ? db.select().from(schema.taskLogs).where(inArray(schema.taskLogs.taskId, taskIds)) : []);

const admin = await login(process.env.ADMIN_USERNAME!, process.env.ADMIN_PASSWORD!);
const tag = randomBytes(3).toString('hex');
const pw = randomBytes(12).toString('base64url');
const settingKeys = ['risk.device', 'publish.device', 'risk.halts'];
const savedSettings = await db.select().from(schema.settings).where(inArray(schema.settings.key, settingKeys));
const t0 = new Date();
const userIds: string[] = [];
const extRows: { source: string; instance: string }[] = [];
const evidenceKeys: string[] = [];
const mainRedis = process.env.MAIN_DEVICE_ID ? new Redis(process.env.MAIN_REDIS_URL ?? process.env.REDIS_URL!.replace(/\/\d+$/, '').replace(/\/$/, '') + '/0', { maxRetriesPerRequest: 2 }) : null;
let flows = 0;

/** Read-only look at the main API's device lock (never written). */
async function waitMainIdle(): Promise<void> {
  if (!mainRedis) return;
  const key = `tracked:collector:lock:${process.env.MAIN_DEVICE_ID}`;
  for (let i = 0; ; i++) {
    if (!(await mainRedis.get(key))) return;
    if (i === 0) console.log('   the main API is working on the phone: waiting (read only)');
    if (i > 120) throw new Error('the main API keeps the phone busy for 10 min: stopping');
    await sleep(5000);
  }
}
const phone = async () => {
  const procs = await adb.shell(BIT_PORT, 'ps -A -o ARGS | grep -c "[s]crcpy"');
  if (Number(procs.trim()) > 0) throw new Error('a scrcpy viewer is on the phone (someone is watching it): stopping');
};

try {
  // ---------------------------------------------------------------- preconditions (read only)
  const serial = adb.serialFor(BIT_PORT);
  if ((await adb.states()).get(serial) !== 'device') throw new Error(`${serial} is not attached: bit-ins-02 is off or the main API's tunnel is down — stopping before anything touches it`);
  await phone();
  let r = await http('PUT', '/api/publish/device-settings', admin, { enabled: true, testMode: true, postsPerDay: 10, minGapMin: 0 });
  if (r.status !== 200 || r.body.rules?.testMode !== true) throw new Error(`could not switch 云手机发帖 to test mode: ${r.text}`);
  check('云手机发帖 test mode ON (nothing will be shared), limits relaxed for the run', true);
  r = await http('PUT', '/api/risk/settings', admin, { minIntervalSec: 10, maxPerHour: 60, accountCheckHours: null, feedCollectHours: null });
  check('pace 10 s, account checks + feed collection off for the run (no other screens from this API)', r.status === 200, r.text);

  // ---------------------------------------------------------------- setup: user, inert device row, account, media
  const u = await http('POST', '/api/users', admin, { username: `dpd${tag}`, password: pw, role: 'user' });
  userIds.push(u.body.user?.id ?? u.body.id);
  const U = await login(`dpd${tag}`, pw);
  const [src] = await db.insert(schema.deviceSources).values({ type: 'bitbrowser', name: `dpchk-src-${tag}`, config: { apiUrl: 'not a url' } }).returning();
  const [dev] = await db.insert(schema.instances).values({
    name: `dpchk-bit-${tag}`, engine: 'bitbrowser', sourceId: src!.id, externalId: `dpchk-${tag}`, profile: 'bitbrowser', image: '',
    adbPort: BIT_PORT, status: 'running', adbState: 'device', bootCompleted: true, spec: { width: 1080, height: 2374, dpi: 480 },
  }).returning();
  extRows.push({ source: src!.id, instance: dev!.id });
  await db.insert(schema.instanceGrants).values({ userId: userIds[0]!, instanceId: dev!.id }).onConflictDoNothing();
  const sa = await http('POST', '/api/social/accounts', admin, { platform: 'instagram', handle: OWN_HANDLE, externalId: OWN_ID, ownerId: userIds[0] });
  // device link: read only in the API since 2026-11-18 (set by 从云手机同步); written with the sync's rules (lib/social-link.ts)
  if (sa.body?.account?.id) await linkAccount(sa.body.account.id, dev!.id);
  if (sa.status !== 201) throw new Error(`social create: ${sa.text}`);
  const own = sa.body.account;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpd-'));
  const jpg = (rgb: [number, number, number]) => sharp({ create: { width: 1080, height: 1080, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg({ quality: 85 }).toBuffer();
  const vidPath = path.join(tmp, 'v.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=5', '-f', 'lavfi', '-i', 'sine=f=440:d=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-y', vidPath]);
  const img1 = await upload(U, `dpd-${tag}-teal.jpg`, await jpg([42, 157, 143]), 'image/jpeg');
  const img2 = await upload(U, `dpd-${tag}-orange.jpg`, await jpg([231, 111, 81]), 'image/jpeg');
  const vid = await upload(U, `dpd-${tag}-5s.mp4`, fs.readFileSync(vidPath), 'video/mp4');
  check('test media uploaded to the temporary media library (2 solid-colour JPEGs, a 5 s test video)', true);

  const RUNS: Record<typeof ALL[number], { postType: 'feed' | 'reel' | 'story'; media: string[]; body: string }> = {
    feed1: { postType: 'feed', media: [img1], body: `云手机发帖测试 feed ✅ ${tag} #cptest` },
    feed2: { postType: 'feed', media: [img1, img2], body: `多图帖子测试 🎨 ${tag}\n第二行 #cptest` },
    reel: { postType: 'reel', media: [vid], body: `Reels 测试 🎬 ${tag} #cptest` },
    story: { postType: 'story', media: [img2], body: `story ${tag}` },
  };
  for (const key of ONLY as (typeof ALL[number])[]) {
    const run = RUNS[key];
    if (!run) throw new Error(`unknown run ${key}`);
    await waitMainIdle();
    await phone();
    const c = await http('POST', '/api/contents', U, { title: `dpd ${key} ${tag}`, body: run.body, mediaIds: run.media, targetIds: [own.id] });
    if (c.status !== 201) throw new Error(`content: ${c.text}`);
    const since = new Date(Date.now() - 1000);
    // One attempt only: a retry would be one more Instagram flow on the billed phone.
    const d = await http('POST', `/api/contents/${c.body.content.id}/distribute`, U, { targets: [{ accountId: own.id, postType: run.postType }], maxAttempts: 1 });
    if (d.status !== 201) throw new Error(`distribute: ${d.text}`);
    const pid: string = d.body.created[0].id;
    const done = await waitFor(`${key} finished`, async () => {
      const x = (await http('GET', `/api/publish/tasks/${pid}`, U)).body;
      return ['dry_run', 'failed', 'awaiting_operator', 'published', 'cancelled'].includes(x?.task?.status) && x.runs.every((t: any) => ['success', 'failed', 'cancelled'].includes(t.status)) ? x : null;
    }, 10 * 60_000);
    const task = done.task;
    const runIds = (await db.select({ id: T.id }).from(T).where(eq(T.refId, pid))).map((x) => x.id);
    const tl = await logsOf(runIds);
    flows += tl.filter((l) => l.message === 'publish: share screen opened').length;
    for (const l of tl.filter((x) => /^publish:|^method |^cloud phone|^test mode|device screen|failed|^collector/.test(x.message))) console.log(`     · ${l.level} ${l.message}${l.data ? ` ${JSON.stringify(l.data).slice(0, 160)}` : ''}`);
    const [row] = await db.select().from(schema.publishTasks).where(eq(schema.publishTasks.id, pid));
    if (row?.evidence?.key) evidenceKeys.push(row.evidence.key);
    console.log(`   ${key}: ${task.status} ${task.method} ${task.errorCode ?? ''} ${task.error ?? ''} input="${row?.evidence?.inputText ?? ''}"`);
    check(`${key}: dry_run via method device (test mode, nothing shared)`, task.status === 'dry_run' && task.method === 'device' && !task.publishedAt && !task.externalId, `${task.status} ${task.method} ${task.errorCode} ${task.error}`);
    const want = run.postType === 'story' ? '' : run.body;
    check(`${key}: caption read back from the field = the text (zh/emoji/newline intact)${run.postType === 'story' ? ' (story: none)' : ''}`,
      (row?.evidence?.inputText ?? '').replace(/\s+/g, ' ').trim() === want.replace(/\s+/g, ' ').trim(), JSON.stringify(row?.evidence?.inputText));
    check(`${key}: logged media pushed → share screen → last screen before sharing → not shared, draft discarded`,
      ['publish: media pushed to the phone gallery', 'publish: share screen opened', 'publish: last screen before sharing reached', 'publish: test mode, not shared; draft discarded'].every((m) => tl.some((l) => l.message === m))
      && (run.media.length < 2 || tl.some((l) => l.message === 'publish: carousel items added in order')));
    const ev = await http('GET', `/api/publish/tasks/${pid}/evidence`, U);
    check(`${key}: screenshot evidence (PNG) served to the owner`, ev.status === 200 && ev.type.startsWith('image/png') && ev.buf.subarray(1, 4).toString() === 'PNG', `${ev.status} ${ev.buf.length} bytes`);
    if (ev.status === 200) fs.writeFileSync(path.join(process.env.EVIDENCE_DIR ?? tmp, `dpd-${key}.png`), ev.buf);
    // the phone afterwards
    const after = await adb.shell(BIT_PORT, `dumpsys activity activities | grep " ResumedActivity"; ls /sdcard/Pictures /sdcard/Movies; content query --uri content://media/external/file --projection _id --where "_display_name LIKE 'cppub-%'"; ls /data/local/tmp`);
    check(`${key}: launcher, pushed files + MediaStore rows removed, no dump left`, /Launcher/.test(after) && !/cppub-/.test(after) && /No result found/.test(after) && !/cp-ig-.*\.xml/.test(after), after.replace(/\s+/g, ' ').slice(0, 200));
    const clipOut = await adb.shell(BIT_PORT, 'service call clipboard 4 s16 com.android.shell i32 -1 i32 0 i32 0');
    const clipText = parseClipParcel(clipOut);
    check(`${key}: no test text left in the clipboard`, !clipText || !clipText.includes(tag), JSON.stringify(clipText));
    if (task.status !== 'dry_run') throw new Error(`${key} did not end dry_run: stopping before more flows`);
    await sleep(12_000);
  }
  check(`Instagram creation flows run by this script: ${flows} (one per run, no retries)`, flows === ONLY.length);
  const halt = (await http('GET', '/api/risk/devices', admin)).body.devices?.find((x: any) => x.id === dev!.id);
  check('phone not halted', !halt?.halted, JSON.stringify(halt?.halted ?? null));
} catch (err) {
  check(`stopped: ${(err as Error).message}`, false);
} finally {
  console.log(`   flows on the phone: ${flows}`);
  await db.update(T).set({ status: 'cancelled', finishedAt: new Date() }).where(and(inArray(T.status, ['pending', 'scheduled']), sql`${T.createdAt} >= ${t0.toISOString()}::timestamptz`));
  for (const k of evidenceKeys) await (await activeStorage()).delete(k).catch(() => undefined);
  for (const id of userIds) await http('DELETE', `/api/users/${id}`, admin);
  for (const e of extRows) {
    await db.delete(schema.riskEvents).where(eq(schema.riskEvents.instanceId, e.instance));
    await db.delete(schema.instances).where(eq(schema.instances.id, e.instance));
    await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, e.source));
  }
  await db.delete(schema.settings).where(inArray(schema.settings.key, settingKeys));
  if (savedSettings.length) await db.insert(schema.settings).values(savedSettings);
  mainRedis?.disconnect();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await sqlClient.end();
  process.exit(failed ? 1 : 0);
}
