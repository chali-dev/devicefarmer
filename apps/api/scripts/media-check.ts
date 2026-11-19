/**
 * Media library (素材库) through the real HTTP API, real storage, real sharp/ffmpeg. No mocks.
 * Requires: API running (base URL from API_PORT, or E2E_API), ffmpeg on PATH (FFMPEG_PATH) to make a test clip.
 * Reads ADMIN_USERNAME / ADMIN_PASSWORD from the env (never printed). Creates two throwaway users and
 * test media, verifies storage on disk (ASSET_DIR) and rows in the DB, and deletes everything it created.
 * Upload into another user's personal media (multipart ownerId, admin only: the content editor's 上传 on someone else's
 * content): owner/visibility, 403 / 404 / bad scope / category of another owner, the content accepting it, audit.
 * Optional S3 part (same env as assets-check used): S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY,
 * S3_TEST_SECRET_KEY [, S3_TEST_REGION]; it switches storage to S3 and back to local.
 * 素材上传限制 (系统配置 → 素材上传, settings key `media.limits`): a stored row is set aside for the run (the env values
 * are then in effect) and put back at the end; the section checks GET/PUT RBAC, strict validation, normalisation, the
 * effective values in GET /api/media/limits, an upload over the lowered image limit (413 media.too_large) and a type
 * removed from allowedTypes (415 media.unsupported_type), the audit row, and the restore to the env defaults.
 * Usage (from apps/api): npx tsx --env-file=../../.env scripts/media-check.ts
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HeadObjectCommand, S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { and, eq, gte, inArray, like as dlike, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const ASSET_DIR = path.resolve(process.env.ASSET_DIR ?? 'var/assets');
const IMAGE_MAX_MB = Number(process.env.MEDIA_IMAGE_MAX_MB ?? 20);
const S3 = process.env.S3_TEST_ENDPOINT ? {
  endpoint: process.env.S3_TEST_ENDPOINT, region: process.env.S3_TEST_REGION ?? 'us-east-1', bucket: process.env.S3_TEST_BUCKET!,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY!, secretAccessKey: process.env.S3_TEST_SECRET_KEY!, forcePathStyle: true, prefix: 'cp-media-test/',
} : null;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NIL = '00000000-0000-4000-8000-000000000000';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function http<T = any>(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json as T, text };
}
async function raw(p: string, token: string) {
  const res = await fetch(API + p, { headers: { authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** `fields`: extra multipart text fields (name, tags, status, …), sent before the file like the web client. */
async function upload(token: string, scope: string | null, name: string, data: Buffer, mime: string, categoryId?: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  if (scope) fd.append('scope', scope);
  if (categoryId) fd.append('categoryId', categoryId);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
  return http<{ item: any }>('POST', '/api/media/upload', token, fd);
}

async function waitDone(id: string, token: string, timeoutMs = 90_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await http<{ item: any }>('GET', `/api/media/${id}`, token);
    if (r.status !== 200) return { status: `http ${r.status}` };
    if (r.body.item.status !== 'processing' || Date.now() > until) return r.body.item;
    await new Promise((res) => setTimeout(res, 300));
  }
}

async function row(id: string) {
  const [r] = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id));
  return r;
}
const onDisk = (key: string | null | undefined) => Boolean(key) && fs.existsSync(path.join(ASSET_DIR, key!));
const list = async (token: string, query: string) => (await http<{ items: any[]; total: number }>('GET', `/api/media?${query}`, token));
const ids = (r: { body: { items: any[] } }) => (r.body?.items ?? []).map((i) => i.id as string);

const login = async (username: string, password: string) => (await http<{ token: string }>('POST', '/api/auth/login', undefined, await withCaptcha(API, { username, password }))).body?.token;

// Audit/task timestamps come from Postgres (defaultNow), whose clock may differ from this host's
// (Docker Desktop VM drift): take the start time from the database.
const startedAt = new Date((await sqlClient`select now() as now`)[0]!.now as Date);
const tag = randomBytes(3).toString('hex');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-check-'));
const created: string[] = []; // media ids to clean up (admin deletes)
const createdCats: string[] = [];
const users: { id: string; name: string; token: string }[] = [];

const admin = await login(process.env.ADMIN_USERNAME ?? 'admin', process.env.ADMIN_PASSWORD ?? '');
check('admin login', Boolean(admin));
if (!admin) process.exit(1);
const adminId = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, process.env.ADMIN_USERNAME ?? 'admin')))[0]!.id;
// 素材上传限制: run on the env defaults; a stored row is put back in `finally`. The API caches the setting for 5 s,
// so wait that long after removing a row it may have cached.
const prevLimits = await db.select().from(schema.settings).where(eq(schema.settings.key, 'media.limits'));
if (prevLimits.length) {
  await db.delete(schema.settings).where(eq(schema.settings.key, 'media.limits'));
  await new Promise((r) => setTimeout(r, 5500));
}

try {
  await http('PUT', '/api/settings/storage', admin, { type: 'local' });

  // ---------- test files (real media)
  const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .composite([{ input: Buffer.from('<svg width="640" height="400"><circle cx="320" cy="200" r="150" fill="orange"/></svg>') }]).png().toBuffer();
  const jpg = await sharp({ create: { width: 300, height: 500, channels: 3, background: { r: 200, g: 60, b: 60 } } }).jpeg().toBuffer();
  const mp4Path = path.join(tmpDir, 'clip.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2.5:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', mp4Path]);
  const mp4 = fs.readFileSync(mp4Path);
  check('generated test media (png, jpeg, 2.5 s mp4)', png.length > 0 && jpg.length > 0 && mp4.length > 0, `${png.length} / ${jpg.length} / ${mp4.length} bytes`);

  const limits = await http('GET', '/api/media/limits', admin);
  check('GET /api/media/limits', limits.status === 200 && limits.body.image.maxMb === IMAGE_MAX_MB && limits.body.video.formats.some((f: any) => f.id === 'mp4'), JSON.stringify({ image: limits.body?.image?.maxMb, video: limits.body?.video?.maxMb }));

  // ---------- admin uploads public image + video → processing → ready
  const upImg = await upload(admin, 'public', `公共图片-${tag}.png`, png, 'image/png');
  check('admin upload public image → 201 processing', upImg.status === 201 && ['processing', 'ready'].includes(upImg.body.item.status) && upImg.body.item.ownerType === 'public', `${upImg.status} ${upImg.body?.item?.status ?? upImg.text}`);
  const upVid = await upload(admin, 'public', `公共视频-${tag}.mp4`, mp4, 'video/mp4');
  check('admin upload public video → 201', upVid.status === 201 && upVid.body.item.fileType === 'video', `${upVid.status} ${upVid.text.slice(0, 120)}`);
  const pubImg = upImg.body.item, pubVid = upVid.body.item;
  created.push(pubImg.id, pubVid.id);
  check('upload response hides storage keys', !('fileKey' in pubImg) && !('thumbnailKey' in pubImg));

  const img = await waitDone(pubImg.id, admin);
  check('image processed → ready, width/height, thumbnailUrl', img.status === 'ready' && img.width === 640 && img.height === 400 && img.thumbnailUrl === `/api/media/${pubImg.id}/thumbnail`, `${img.status} ${img.width}x${img.height} ${img.error ?? ''}`);
  check('image checksum = sha256 of upload, size exact', img.checksum === sha(png) && img.fileSize === png.length && img.mimeType === 'image/png');
  const vid = await waitDone(pubVid.id, admin);
  check('video processed → ready, 320x240, duration ≈ 2.5 s', vid.status === 'ready' && vid.width === 320 && vid.height === 240 && Math.abs(vid.duration - 2.5) < 0.2, `${vid.status} ${vid.width}x${vid.height} ${vid.duration}s ${vid.error ?? ''}`);

  const th = await raw(`/api/media/${pubImg.id}/thumbnail`, admin);
  const thMeta = th.status === 200 ? await sharp(th.buf).metadata() : null;
  check('image thumbnail endpoint returns a JPEG ≤ 480 px', th.status === 200 && th.headers.get('content-type') === 'image/jpeg' && thMeta?.format === 'jpeg' && thMeta.width === 480 && thMeta.height === 300, `${th.status} ${thMeta?.format} ${thMeta?.width}x${thMeta?.height}`);
  const vth = await raw(`/api/media/${pubVid.id}/thumbnail`, admin);
  const vthMeta = vth.status === 200 ? await sharp(vth.buf).metadata() : null;
  check('video cover endpoint returns a JPEG frame', vth.status === 200 && vthMeta?.format === 'jpeg' && vthMeta.width === 320 && vthMeta.height === 240, `${vth.status} ${vthMeta?.format} ${vthMeta?.width}x${vthMeta?.height}`);
  const content = await raw(`/api/media/${pubImg.id}/content`, admin);
  check('content: bytes match, nosniff + CSP sandbox', content.status === 200 && sha(content.buf) === sha(png) && content.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(content.headers.get('content-security-policy') ?? ''), `${content.status}`);

  const rImg = await row(pubImg.id), rVid = await row(pubVid.id);
  check('storage keys: public/images/<uuid>.png + public/thumbnails/<uuid>.jpg', new RegExp(`^public/images/${UUID}\\.png$`).test(rImg!.fileKey) && new RegExp(`^public/thumbnails/${UUID}\\.jpg$`).test(rImg!.thumbnailKey ?? ''), `${rImg!.fileKey} ${rImg!.thumbnailKey}`);
  check('storage keys: public/videos/<uuid>.mp4, original name not used', new RegExp(`^public/videos/${UUID}\\.mp4$`).test(rVid!.fileKey) && !rVid!.fileKey.includes(tag) && rVid!.fileName === `公共视频-${tag}.mp4`, rVid!.fileKey);
  check('files exist on local disk', onDisk(rImg!.fileKey) && onDisk(rImg!.thumbnailKey) && onDisk(rVid!.fileKey) && onDisk(rVid!.thumbnailKey));

  // JPEG portrait + the media-process task row
  const upJpg = await upload(admin, 'public', `portrait-${tag}.jpg`, jpg, 'image/jpeg');
  created.push(upJpg.body.item.id);
  const j = await waitDone(upJpg.body.item.id, admin);
  check('jpeg processed (300x500)', j.status === 'ready' && j.width === 300 && j.height === 500, `${j.status} ${j.width}x${j.height}`);
  const tasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.refType, 'media'), eq(schema.tasks.refId, pubImg.id)));
  check('media-process task row (no device) succeeded', tasks.some((t) => t.type === 'media-process' && t.status === 'success' && t.instanceId === null), JSON.stringify(tasks.map((t) => [t.type, t.status])));

  // ---------- validation
  const exe = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), randomBytes(2000)]);
  const fake = await upload(admin, 'public', `evil-${tag}.png`, exe, 'image/png');
  check('renamed executable with .png → 415 content_mismatch', fake.status === 415 && fake.body.code === 'media.content_mismatch', `${fake.status} ${fake.body?.code}`);
  const txt = await upload(admin, 'mine', `notes-${tag}.jpg`, Buffer.from('just some text, not a jpeg\n'.repeat(20)), 'image/jpeg');
  check('text file with .jpg → 415 content_mismatch', txt.status === 415 && txt.body.code === 'media.content_mismatch', `${txt.status} ${txt.body?.code}`);
  const exe2 = await upload(admin, 'mine', `tool-${tag}.exe`, exe, 'application/x-msdownload');
  check('.exe → 415 unsupported_type', exe2.status === 415 && exe2.body.code === 'media.unsupported_type', `${exe2.status} ${exe2.body?.code}`);
  const mime = await upload(admin, 'mine', `page-${tag}.png`, png, 'text/html');
  check('MIME text/html with .png → 415 mime_mismatch', mime.status === 415 && mime.body.code === 'media.mime_mismatch', `${mime.status} ${mime.body?.code}`);
  const vidAsImg = await upload(admin, 'mine', `clip-${tag}.png`, mp4, 'image/png');
  check('mp4 renamed to .png → 415', vidAsImg.status === 415, `${vidAsImg.status} ${vidAsImg.body?.code}`);
  const big = Buffer.concat([png.subarray(0, 64), Buffer.alloc(Math.ceil((IMAGE_MAX_MB + 1) * 1024 * 1024))]);
  const over = await upload(admin, 'mine', `big-${tag}.png`, big, 'image/png');
  check(`oversize image (> ${IMAGE_MAX_MB} MB) → 413 too_large`, over.status === 413 && over.body.code === 'media.too_large', `${over.status} ${over.body?.code}`);
  const empty = await upload(admin, 'mine', `empty-${tag}.png`, Buffer.alloc(0), 'image/png');
  check('empty file → 400', empty.status === 400, `${empty.status}`);
  const rejectedRows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.mediaAssets).where(dlike(schema.mediaAssets.fileName, `%-${tag}.%`));
  check('rejected uploads left no rows (only the 3 accepted so far)', rejectedRows[0]!.n === 3, `${rejectedRows[0]!.n} rows`);

  // ---------- throwaway users
  for (const n of ['a', 'b']) {
    const name = `media_${n}_${tag}`;
    const pass = randomBytes(12).toString('base64url');
    const u = await http<{ user: { id: string } }>('POST', '/api/users', admin, { username: name, password: pass, role: 'user' });
    users.push({ id: u.body.user.id, name, token: (await login(name, pass))! });
  }
  const [A, B] = users as [typeof users[0], typeof users[0]];
  check('two throwaway users created + logged in', Boolean(A.token && B.token));

  // ---------- 素材上传限制 (系统配置 → 素材上传, admin; key media.limits; env values = defaults)
  {
    const g = await http('GET', '/api/settings/media-limits', admin);
    const d = g.body?.defaults;
    check('GET media-limits: defaults = env, nothing stored, ceilings 100 / 4096 MB, every validator type listed',
      g.status === 200 && d.imageMaxMb === IMAGE_MAX_MB && g.body.limits.imageMaxMb === IMAGE_MAX_MB && g.body.updatedAt === null
      && g.body.max.imageMaxMb === 100 && g.body.max.videoMaxMb === 4096
      && ['jpeg', 'png', 'webp', 'gif', 'heic', 'mp4', 'mov', 'webm'].every((id) => g.body.types.some((x: any) => x.id === id)), g.text.slice(0, 300));
    const rbac = await Promise.all([http('GET', '/api/settings/media-limits', A.token), http('PUT', '/api/settings/media-limits', A.token, { imageMaxMb: 1, videoMaxMb: 1, allowedTypes: ['png'] })]);
    check('media-limits: user GET/PUT → 403', rbac.every((x) => x.status === 403), rbac.map((x) => x.status).join(','));
    const ok = { imageMaxMb: 1, videoMaxMb: 50, allowedTypes: ['png', 'jpeg', 'mp4', 'png'] };
    const bads = [{ ...ok, imageMaxMb: 0 }, { ...ok, imageMaxMb: 101 }, { ...ok, imageMaxMb: 1.5 }, { ...ok, videoMaxMb: 4097 }, { ...ok, allowedTypes: [] },
      { ...ok, allowedTypes: ['bmp'] }, { ...ok, allowedTypes: 'png' }, { ...ok, extra: 1 }, { imageMaxMb: 1, videoMaxMb: 50 }];
    const bad = await Promise.all(bads.map((b) => http('PUT', '/api/settings/media-limits', admin, b)));
    check('media-limits: out-of-range / fractional / empty or unknown types / unknown or missing fields → 400', bad.every((x) => x.status === 400), bad.map((x) => x.status).join(','));
    const put = await http('PUT', '/api/settings/media-limits', admin, ok);
    check('media-limits saved: image 1 MB, video 50 MB, types normalised (validator order, de-duplicated)', put.status === 200 && put.body.limits.imageMaxMb === 1 && put.body.limits.videoMaxMb === 50
      && JSON.stringify(put.body.limits.allowedTypes) === '["jpeg","png","mp4"]' && typeof put.body.updatedAt === 'string', put.text.slice(0, 300));
    const lim = await http('GET', '/api/media/limits', A.token);
    check('GET /api/media/limits (user) follows the setting at once', lim.status === 200 && lim.body.image.maxMb === 1 && lim.body.video.maxMb === 50
      && JSON.stringify(lim.body.image.formats.map((f: any) => f.id)) === '["jpeg","png"]' && JSON.stringify(lim.body.video.formats.map((f: any) => f.id)) === '["mp4"]', JSON.stringify(lim.body));
    const big15 = Buffer.concat([png, Buffer.alloc(Math.ceil(1.5 * 1024 * 1024))]);
    const over1 = await upload(A.token, 'mine', `over1mb-${tag}.png`, big15, 'image/png');
    check('upload of a 1.5 MB png over the lowered 1 MB limit → 413 media.too_large (max 1)', over1.status === 413 && over1.body.code === 'media.too_large' && over1.body.params?.max === 1, `${over1.status} ${over1.body?.code} ${JSON.stringify(over1.body?.params)}`);
    const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp().toBuffer();
    const noWebp = await upload(A.token, 'mine', `removed-${tag}.webp`, webp, 'image/webp');
    check('upload of a webp (removed from allowedTypes) → 415 media.unsupported_type, webp not offered', noWebp.status === 415 && noWebp.body.code === 'media.unsupported_type' && !String(noWebp.body.params?.exts).includes('webp'),
      `${noWebp.status} ${noWebp.body?.code} ${noWebp.body?.params?.exts}`);
    const small = await upload(A.token, 'mine', `under1mb-${tag}.jpg`, jpg, 'image/jpeg');
    check('a small jpeg (allowed, under 1 MB) still uploads', small.status === 201, `${small.status} ${small.text.slice(0, 120)}`);
    if (small.body?.item?.id) { await waitDone(small.body.item.id, A.token); created.push(small.body.item.id); }
    const n = await db.select({ n: sql<number>`count(*)::int` }).from(schema.mediaAssets).where(inArray(schema.mediaAssets.fileName, [`over1mb-${tag}.png`, `removed-${tag}.webp`]));
    check('refused uploads left no rows', n[0]!.n === 0, `${n[0]!.n}`);
    await new Promise((r) => setTimeout(r, 1000));
    const au = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), eq(schema.auditLogs.action, 'settings.media_limits')));
    const au200 = au.find((a) => a.status === 200);
    check('audit settings.media_limits: the save (normalised values) + the user 403', JSON.stringify((au200?.detail as any)?.allowedTypes) === '["jpeg","png","mp4"]' && (au200?.detail as any)?.imageMaxMb === 1
      && au.some((a) => a.status === 403), JSON.stringify(au.map((a) => [a.status, a.detail])));
    // Restore: save the env defaults through the API (clears its cache), then drop the row (the defaults stay in effect).
    const back = await http('PUT', '/api/settings/media-limits', admin, { imageMaxMb: d.imageMaxMb, videoMaxMb: d.videoMaxMb, allowedTypes: d.allowedTypes });
    await db.delete(schema.settings).where(eq(schema.settings.key, 'media.limits'));
    const after = await http('GET', '/api/media/limits', A.token);
    check('media-limits restored to the env defaults', back.status === 200 && after.body.image.maxMb === IMAGE_MAX_MB && after.body.image.formats.some((f: any) => f.id === 'webp'), `${back.status} ${after.body?.image?.maxMb}`);
  }

  const upA = await upload(A.token, 'mine', `私有A-${tag}.jpg`, jpg, 'image/jpeg');
  const upB = await upload(B.token, null, `privB-${tag}.png`, png, 'image/png'); // scope defaults to mine
  check('users upload private media', upA.status === 201 && upB.status === 201 && upB.body.item.ownerType === 'user' && upB.body.item.ownerId === B.id, `${upA.status} ${upB.status}`);
  check('upload without metadata fields: name = file name without extension, no category, no tags', upB.body.item.name === `privB-${tag}` && upB.body.item.categoryId === null && upB.body.item.tags.length === 0,
    JSON.stringify([upB.body?.item?.name, upB.body?.item?.categoryId, upB.body?.item?.tags]));
  const aId = upA.body.item.id, bId = upB.body.item.id;
  await waitDone(aId, A.token); await waitDone(bId, B.token);
  const rA = await row(aId);
  check('private keys: users/<owner id>/images/<uuid>.jpg + users/<id>/thumbnails/', rA!.fileKey.startsWith(`users/${A.id}/images/`) && new RegExp(`^users/${A.id}/images/${UUID}\\.jpg$`).test(rA!.fileKey) && new RegExp(`^users/${A.id}/thumbnails/${UUID}\\.jpg$`).test(rA!.thumbnailKey ?? ''), `${rA!.fileKey} ${rA!.thumbnailKey}`);

  const userPublic = await upload(A.token, 'public', `x-${tag}.png`, png, 'image/png');
  check('user upload scope=public → 403', userPublic.status === 403 && userPublic.body.code === 'media.public_admin_only', `${userPublic.status}`);

  // isolation
  check('A cannot GET B\'s private asset (404)', (await http('GET', `/api/media/${bId}`, A.token)).status === 404);
  check('A cannot read B\'s content / thumbnail (404)', (await raw(`/api/media/${bId}/content`, A.token)).status === 404 && (await raw(`/api/media/${bId}/thumbnail`, A.token)).status === 404);
  check('A cannot edit B\'s asset (404)', (await http('PUT', `/api/media/${bId}`, A.token, { name: 'hacked' })).status === 404);
  check('A cannot delete B\'s asset (404)', (await http('DELETE', `/api/media/${bId}`, A.token)).status === 404);
  check('A cannot favorite B\'s asset (404)', (await http('POST', `/api/media/${bId}/favorite`, A.token)).status === 404);
  const aMine = await list(A.token, 'scope=mine');
  check('A\'s "mine" lists only A\'s asset', aMine.status === 200 && ids(aMine).includes(aId) && !ids(aMine).includes(bId) && aMine.body.items.every((i) => i.ownerId === A.id));
  check('user cannot use scope=all-users (403)', (await list(A.token, 'scope=all-users')).status === 403);
  const all = await list(admin, `scope=all-users&ownerId=${B.id}`);
  check('admin all-users scope filtered by owner sees B\'s asset only', all.status === 200 && ids(all).includes(bId) && !ids(all).includes(aId), `${all.status} ${all.body?.total}`);
  check('admin can view B\'s private content', (await raw(`/api/media/${bId}/content`, admin)).status === 200);
  check('user cannot modify public asset (403)', (await http('PUT', `/api/media/${pubImg.id}`, A.token, { name: 'x' })).status === 403);
  check('user cannot delete public asset (403)', (await http('DELETE', `/api/media/${pubImg.id}`, A.token)).status === 403);
  check('user sees ready public assets', ids(await list(A.token, 'scope=public&pageSize=100')).includes(pubImg.id));

  // ---------- 对用户可见 removed (2026-11-18): public media is always visible to every user
  const pubForA = await list(A.token, 'scope=public&pageSize=100');
  check('users see every processed public asset', ids(pubForA).includes(pubVid.id) && ids(pubForA).includes(pubImg.id) && pubForA.body.items.every((i) => i.status === 'ready'));
  // a failed public asset stays hidden from users (only ready public media is visible)
  const failPub = (id: string, on: boolean) => db.update(schema.mediaAssets).set({ status: on ? 'failed' : 'ready' }).where(eq(schema.mediaAssets.id, id));
  await failPub(pubVid.id, true);
  check('failed public row: users 404 / not listed, admin still sees it', (await http('GET', `/api/media/${pubVid.id}`, A.token)).status === 404
    && !ids(await list(A.token, 'scope=public&pageSize=100')).includes(pubVid.id) && (await http('GET', `/api/media/${pubVid.id}`, admin)).status === 200);
  await failPub(pubVid.id, false);

  // ---------- favorites
  const f1 = await http('POST', `/api/media/${pubImg.id}/favorite`, A.token);
  const f2 = await http('POST', `/api/media/${pubImg.id}/favorite`, A.token);
  const favRows = await db.select().from(schema.mediaFavorites).where(and(eq(schema.mediaFavorites.userId, A.id), eq(schema.mediaFavorites.assetId, pubImg.id)));
  check('favorite twice → one row (unique)', f1.status === 200 && f2.status === 200 && favRows.length === 1, `${f1.status} ${f2.status} rows=${favRows.length}`);
  const fp = await http('POST', `/api/media/${aId}/favorite`, A.token);
  check('favorite own private asset → 400 favorite_public_only', fp.status === 400 && fp.body.code === 'media.favorite_public_only', `${fp.status}`);
  await http('POST', `/api/media/${pubVid.id}/favorite`, A.token);
  const favList = await list(A.token, 'scope=favorites');
  check('favorites tab lists favorited public assets', ids(favList).includes(pubImg.id) && ids(favList).includes(pubVid.id) && favList.body.items.every((i) => i.isFavorite), `${favList.body?.total}`);
  check('isFavorite only for the user who favorited', (await list(B.token, 'scope=public&pageSize=100')).body.items.find((i) => i.id === pubImg.id)?.isFavorite === false
    && (await list(A.token, 'scope=public&pageSize=100')).body.items.find((i) => i.id === pubImg.id)?.isFavorite === true);
  await failPub(pubVid.id, true);
  check('failed public favorite hidden from user\'s favorites', !ids(await list(A.token, 'scope=favorites')).includes(pubVid.id));
  await failPub(pubVid.id, false);
  const unf = await http('DELETE', `/api/media/${pubImg.id}/favorite`, A.token);
  check('unfavorite: removed from favorites, asset intact', unf.status === 200 && !ids(await list(A.token, 'scope=favorites')).includes(pubImg.id) && (await http('GET', `/api/media/${pubImg.id}`, A.token)).status === 200);

  // ---------- categories (shared scoped-list model: lib/scoped-list.ts)
  const cPubByUser = await http('POST', '/api/media/categories', A.token, { scope: 'public', name: `公共分类-${tag}` });
  check('user creates public category → 403 media_category.admin_only', cPubByUser.status === 403 && cPubByUser.body.code === 'media_category.admin_only', `${cPubByUser.status}`);
  const cPub = await http('POST', '/api/media/categories', admin, { scope: 'public', name: `Cat-${tag}`, description: `desc ${tag}` });
  const cPub2 = await http('POST', '/api/media/categories', admin, { scope: 'public', name: `CAT-${tag}` });
  check('admin creates public category with description; case variant → 409 media_category.exists',
    cPub.status === 201 && cPub.body.category.description === `desc ${tag}` && cPub2.status === 409 && cPub2.body.code === 'media_category.exists', `${cPub.status} ${cPub2.status} ${cPub2.body?.code}`);
  const cA = await http('POST', '/api/media/categories', A.token, { scope: 'mine', name: `我的分类-${tag}` });
  const cB = await http('POST', '/api/media/categories', B.token, { scope: 'mine', name: `我的分类-${tag}` });
  const cPubSame = await http('POST', '/api/media/categories', A.token, { scope: 'mine', name: `cat-${tag}` });
  check('users create own categories (same name per owner ok, also next to a public one)', cA.status === 201 && cB.status === 201 && cPubSame.status === 201, `${cA.status} ${cB.status} ${cPubSame.status}`);
  createdCats.push(cPub.body.category.id, cA.body.category.id, cB.body.category.id, cPubSame.body.category.id);
  const pubCatId = cPub.body.category.id, aCatId = cA.body.category.id, bCatId = cB.body.category.id;
  check('user renames public category → 403', (await http('PATCH', `/api/media/categories/${pubCatId}`, A.token, { name: 'x' })).status === 403);
  check('A renames B\'s category → 404', (await http('PATCH', `/api/media/categories/${bCatId}`, A.token, { name: 'x' })).status === 404);
  check('A deletes B\'s category → 404', (await http('DELETE', `/api/media/categories/${bCatId}`, A.token)).status === 404);
  check('PATCH without fields → 400', (await http('PATCH', `/api/media/categories/${aCatId}`, A.token, {})).status === 400);
  const ren = await http('PATCH', `/api/media/categories/${aCatId}`, A.token, { name: `改名-${tag}`, sort: 5, description: `mine ${tag}` });
  check('A renames + re-sorts + describes own category', ren.status === 200 && ren.body.category.name === `改名-${tag}` && ren.body.category.sort === 5 && ren.body.category.description === `mine ${tag}`);
  const renDup = await http('PATCH', `/api/media/categories/${cPubSame.body.category.id}`, A.token, { name: `CAT-${tag}` });
  check('case-only rename of an own category is fine', renDup.status === 200, `${renDup.status}`);
  const renClash = await http('PATCH', `/api/media/categories/${cPubSame.body.category.id}`, A.token, { name: `改名-${tag}` });
  check('rename onto another own name → 409 media_category.exists', renClash.status === 409 && renClash.body.code === 'media_category.exists', `${renClash.status}`);
  const aCats = await http('GET', '/api/media/categories?scope=mine', A.token);
  check('A lists only own categories (writable, ownerName)', aCats.body.categories.some((c: any) => c.id === aCatId && c.writable === true && c.ownerName === A.name) && !aCats.body.categories.some((c: any) => c.id === bCatId));
  const pubCatForA = (await http('GET', '/api/media/categories?scope=public', A.token)).body.categories.find((c: any) => c.id === pubCatId);
  check('user lists public categories (read-only, with description)', pubCatForA?.writable === false && pubCatForA.description === `desc ${tag}`);
  check('user: scope=all-users → 403, scope=mine&ownerId=<B> → 403', (await http('GET', '/api/media/categories?scope=all-users', A.token)).status === 403
    && (await http('GET', `/api/media/categories?scope=mine&ownerId=${B.id}`, A.token)).status === 403);
  const allB = await http('GET', `/api/media/categories?scope=all-users&ownerId=${B.id}`, admin);
  const mineB = await http('GET', `/api/media/categories?scope=mine&ownerId=${B.id}`, admin);
  check('admin: all-users with ownerId and the older scope=mine&ownerId list B\'s categories', allB.body.categories.length === 1 && allB.body.categories[0].id === bCatId
    && mineB.body.categories.length === 1 && mineB.body.categories[0].id === bCatId);
  check('assign B\'s category to A\'s asset → 400', (await http('PUT', `/api/media/${aId}`, A.token, { categoryId: bCatId })).status === 400);
  check('assign public category to private asset → 400', (await http('PUT', `/api/media/${aId}`, A.token, { categoryId: pubCatId })).status === 400);
  const setCat = await http('PUT', `/api/media/${aId}`, A.token, { categoryId: aCatId, name: `A-renamed-${tag}` });
  check('assign own category + rename asset', setCat.status === 200 && setCat.body.item.categoryId === aCatId && setCat.body.item.categoryName === `改名-${tag}`);
  check('filter by category', ids(await list(A.token, `scope=mine&categoryId=${aCatId}`)).join() === aId);
  const upCat = await upload(admin, 'public', `in-cat-${tag}.png`, png, 'image/png', pubCatId);
  created.push(upCat.body.item.id);
  check('upload with categoryId field', upCat.status === 201 && upCat.body.item.categoryId === pubCatId, `${upCat.status}`);
  const upWrongCat = await upload(A.token, 'mine', `wrong-cat-${tag}.png`, png, 'image/png', bCatId);
  check('upload into someone else\'s category → 400', upWrongCat.status === 400, `${upWrongCat.status}`);
  // counts = assets the viewer can see (users: ready public ones; a failed public row counts for admins only)
  await waitDone(upCat.body.item.id, admin);
  await http('PUT', `/api/media/${pubImg.id}`, admin, { categoryId: pubCatId });
  const cnt = async (token: string, q: string, id: string) => ((await http('GET', `/api/media/categories?${q}`, token)).body.categories as any[]).find((c) => c.id === id)?.count;
  const counts0 = [await cnt(admin, 'scope=public', pubCatId), await cnt(A.token, 'scope=public', pubCatId), await cnt(A.token, 'scope=mine', aCatId)];
  check('counts per viewer (public category: admin 2, user 2; A\'s own 1)', counts0.join() === '2,2,1', JSON.stringify(counts0));
  await failPub(pubImg.id, true);
  const counts = [await cnt(admin, 'scope=public', pubCatId), await cnt(A.token, 'scope=public', pubCatId)];
  check('counts with a failed public row: admin 2, user 1', counts.join() === '2,1', JSON.stringify(counts));
  await failPub(pubImg.id, false);

  // ---------- metadata at upload (name / category / tags): same schema + rules as PUT /api/media/:id
  {
    const metaCat = (await http('POST', '/api/media/categories', admin, { scope: 'public', name: `UpMeta-${tag}` })).body.category.id as string;
    createdCats.push(metaCat);
    const metaRows = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.mediaAssets).where(dlike(schema.mediaAssets.fileName, `%upmeta-${tag}%`)))[0]!.n;
    const mine: string[] = [];
    const hid = await upload(admin, 'public', `upmeta-${tag}-named.png`, png, 'image/png', metaCat,
      { name: `  命名素材 ${tag} `, tags: JSON.stringify([` Promo${tag} `, `promo${tag}`, `Summer${tag}`]) });
    if (hid.status === 201) mine.push(hid.body.item.id);
    const hidRow = hid.status === 201 ? await row(hid.body.item.id) : undefined;
    check('admin public upload with name/category/tags (no status field) → 201, stored while processing (name trimmed, tags case-insensitively deduped)',
      hid.status === 201 && hid.body.item.status === 'processing' && hid.body.item.name === `命名素材 ${tag}` && hid.body.item.categoryId === metaCat
        && hid.body.item.tags.join() === `Promo${tag},Summer${tag}` && hidRow?.categoryId === metaCat,
      `${hid.status} ${JSON.stringify([hid.body?.item?.status, hid.body?.item?.name, hid.body?.item?.tags])} ${hid.status !== 201 ? hid.text.slice(0, 200) : ''}`);
    const vis = await upload(admin, 'public', `upmeta-${tag}-visible.png`, png, 'image/png', metaCat, { name: `可见素材 ${tag}` });
    if (vis.status === 201) mine.push(vis.body.item.id);
    check('second public upload → 201', vis.status === 201, `${vis.status} ${vis.body?.code}`);
    const hidDone = await waitDone(hid.body.item.id, admin);
    const visDone = await waitDone(vis.body.item.id, admin);
    check('after processing: both ready; metadata kept', hidDone.status === 'ready' && visDone.status === 'ready'
      && hidDone.name === `命名素材 ${tag}` && hidDone.tags.length === 2 && hidDone.categoryId === metaCat, `${hidDone.status} ${visDone.status}`);
    const forA = ids(await list(A.token, `scope=public&categoryId=${metaCat}`));
    check('user sees both public uploads', forA.length === 2 && forA.includes(vis.body.item.id) && forA.includes(hid.body.item.id), JSON.stringify(forA));
    check('category count includes uploads with categoryId', (await cnt(admin, 'scope=public', metaCat)) === 2);

    const fileCount = () => (fs.existsSync(ASSET_DIR) ? fs.readdirSync(ASSET_DIR, { recursive: true }).filter((f) => fs.statSync(path.join(ASSET_DIR, String(f))).isFile()).length : 0);
    const before = await metaRows();
    const filesBefore = fileCount();
    const pubPersonal = await upload(admin, 'public', `upmeta-${tag}-x1.png`, png, 'image/png', aCatId);
    check('admin public upload with a personal category → 400 media.category_mismatch', pubPersonal.status === 400 && pubPersonal.body.code === 'media.category_mismatch', `${pubPersonal.status} ${pubPersonal.body?.code}`);
    const adminMinePub = await upload(admin, 'mine', `upmeta-${tag}-x2.png`, png, 'image/png', metaCat);
    check('admin personal upload with a public category → 400 media.category_mismatch', adminMinePub.status === 400 && adminMinePub.body.code === 'media.category_mismatch', `${adminMinePub.status}`);
    const aWithB = await upload(A.token, 'mine', `upmeta-${tag}-x3.png`, png, 'image/png', bCatId);
    const aWithPub = await upload(A.token, 'mine', `upmeta-${tag}-x4.png`, png, 'image/png', metaCat);
    check('user upload with another user\'s / a public category → 400 media.category_mismatch', aWithB.body?.code === 'media.category_mismatch' && aWithPub.body?.code === 'media.category_mismatch'
      && aWithB.status === 400 && aWithPub.status === 400, `${aWithB.status} ${aWithPub.status}`);
    const manyTags = await upload(A.token, 'mine', `upmeta-${tag}-x6.png`, png, 'image/png', undefined, { tags: JSON.stringify(Array.from({ length: 21 }, (_, i) => `t${i}`)) });
    const longTag = await upload(A.token, 'mine', `upmeta-${tag}-x7.png`, png, 'image/png', undefined, { tags: JSON.stringify(['x'.repeat(33)]) });
    const notArray = await upload(A.token, 'mine', `upmeta-${tag}-x8.png`, png, 'image/png', undefined, { tags: 'just text' });
    const longName = await upload(A.token, 'mine', `upmeta-${tag}-x9.png`, png, 'image/png', undefined, { name: 'n'.repeat(201) });
    check('21 tags / 33-char tag / tags not a JSON array / 201-char name → 400 media.bad_fields',
      [manyTags, longTag, notArray, longName].every((r) => r.status === 400 && r.body.code === 'media.bad_fields'),
      JSON.stringify([manyTags, longTag, notArray, longName].map((r) => [r.status, r.body?.code])));
    const edit21 = await http('PUT', `/api/media/${vis.body.item.id}`, admin, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) });
    const edit20 = await http('PUT', `/api/media/${vis.body.item.id}`, admin, { tags: Array.from({ length: 20 }, (_, i) => `t${i}${tag}`) });
    check('edit has the same tag limits (21 → 400, 20 → 200)', edit21.status === 400 && edit20.status === 200 && edit20.body.item.tags.length === 20, `${edit21.status} ${edit20.status}`);
    check('refused uploads created no rows and no files in storage', (await metaRows()) === before && fileCount() === filesBefore, `rows ${await metaRows()} vs ${before}, files ${fileCount()} vs ${filesBefore}`);
    const aOwn = await upload(A.token, 'mine', `upmeta-${tag}-own.jpg`, jpg, 'image/jpeg', aCatId, { name: `我的上传 ${tag}`, tags: JSON.stringify([`Mine${tag}`]) });
    if (aOwn.status === 201) mine.push(aOwn.body.item.id);
    check('user upload into own category with name + tags', aOwn.status === 201 && aOwn.body.item.categoryId === aCatId && aOwn.body.item.name === `我的上传 ${tag}` && aOwn.body.item.tags.join() === `Mine${tag}`,
      `${aOwn.status} ${aOwn.text.slice(0, 160)}`);
    const aOwnDone = await waitDone(aOwn.body.item.id, A.token);
    check('private upload ends ready', aOwnDone.status === 'ready');
    await new Promise((r) => setTimeout(r, 500));
    const [metaAudit] = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), eq(schema.auditLogs.action, 'media.upload'), eq(schema.auditLogs.target, `upmeta-${tag}-named.png`)));
    check('upload audit records categoryId (no tag/name texts needed)', (metaAudit?.detail as any)?.categoryId === metaCat, JSON.stringify(metaAudit?.detail));
    // keep the later counts/search checks unchanged: remove these assets now
    for (const id of mine) await http('DELETE', `/api/media/${id}`, admin);
    check('cleanup of metadata uploads', (await metaRows()) === 0);
    await db.delete(schema.mediaTags).where(inArray(sql`lower(${schema.mediaTags.name})`, [`promo${tag}`, `summer${tag}`, `mine${tag}`, ...Array.from({ length: 20 }, (_, i) => `t${i}${tag}`)]));
  }

  // ---------- upload into another user's personal media (ownerId, admin only; content editor 上传 on A's content)
  {
    const own = await upload(admin, 'mine', `upown-${tag}.png`, png, 'image/png', aCatId, { ownerId: A.id, name: `给A ${tag}`, tags: JSON.stringify([`Own${tag}`]) });
    if (own.status === 201) created.push(own.body.item.id);
    const ownRow = own.status === 201 ? await row(own.body.item.id) : undefined;
    check('admin upload with ownerId=A (+ A\'s category) → 201, A\'s private asset, created by the admin, key under users/<A>/',
      own.status === 201 && own.body.item.ownerType === 'user' && own.body.item.ownerId === A.id && own.body.item.categoryId === aCatId
        && ownRow?.createdBy === adminId && ownRow!.fileKey.startsWith(`users/${A.id}/images/`),
      `${own.status} ${own.text.slice(0, 200)} ${ownRow?.createdBy} ${ownRow?.fileKey}`);
    const noScope = await upload(admin, null, `upown-${tag}-noscope.png`, png, 'image/png', undefined, { ownerId: A.id });
    if (noScope.status === 201) created.push(noScope.body.item.id);
    check('ownerId without scope (= mine) → A\'s asset', noScope.status === 201 && noScope.body.item.ownerId === A.id, `${noScope.status}`);
    const ownDone = await waitDone(own.body.item.id, admin);
    check('it is processed (ready)', ownDone.status === 'ready', ownDone.status);
    check('A sees it (GET + scope=mine), B does not (404, not listed)', (await http('GET', `/api/media/${own.body.item.id}`, A.token)).status === 200
      && ids(await list(A.token, 'scope=mine')).includes(own.body.item.id)
      && (await http('GET', `/api/media/${own.body.item.id}`, B.token)).status === 404 && !ids(await list(B.token, 'scope=mine')).includes(own.body.item.id)
      && !ids(await list(B.token, 'scope=public')).includes(own.body.item.id));
    check('A\'s tags facet lists the new tag (owner scope)', ((await http('GET', `/api/media/tags?scope=all-users&ownerId=${A.id}`, admin)).body.tags as string[]).includes(`Own${tag}`));
    const userOwner = await upload(A.token, 'mine', `upown-${tag}-x1.png`, png, 'image/png', undefined, { ownerId: B.id });
    const userSelf = await upload(A.token, 'mine', `upown-${tag}-x2.png`, png, 'image/png', undefined, { ownerId: A.id });
    check('user sending ownerId (another user or even itself) → 403 media.owner_admin_only', userOwner.status === 403 && userOwner.body.code === 'media.owner_admin_only'
      && userSelf.status === 403 && userSelf.body.code === 'media.owner_admin_only', `${userOwner.status} ${userOwner.body?.code} ${userSelf.status}`);
    const unknown = await upload(admin, 'mine', `upown-${tag}-x3.png`, png, 'image/png', undefined, { ownerId: NIL });
    const notUuid = await upload(admin, 'mine', `upown-${tag}-x4.png`, png, 'image/png', undefined, { ownerId: 'nope' });
    check('unknown / malformed ownerId → 404 users.not_found', unknown.status === 404 && unknown.body.code === 'users.not_found' && notUuid.status === 404 && notUuid.body.code === 'users.not_found',
      `${unknown.status} ${unknown.body?.code} ${notUuid.status}`);
    const pubOwner = await upload(admin, 'public', `upown-${tag}-x5.png`, png, 'image/png', undefined, { ownerId: A.id });
    check('ownerId with scope=public → 400 media.bad_scope', pubOwner.status === 400 && pubOwner.body.code === 'media.bad_scope', `${pubOwner.status} ${pubOwner.body?.code}`);
    const wrongB = await upload(admin, 'mine', `upown-${tag}-x6.png`, png, 'image/png', bCatId, { ownerId: A.id });
    const wrongPub = await upload(admin, 'mine', `upown-${tag}-x7.png`, png, 'image/png', pubCatId, { ownerId: A.id });
    check('ownerId=A with B\'s / a public category → 400 media.category_mismatch', wrongB.status === 400 && wrongB.body.code === 'media.category_mismatch'
      && wrongPub.status === 400 && wrongPub.body.code === 'media.category_mismatch', `${wrongB.status} ${wrongB.body?.code} ${wrongPub.status}`);
    const leftovers = await db.select({ id: schema.mediaAssets.id }).from(schema.mediaAssets).where(dlike(schema.mediaAssets.fileName, `upown-${tag}-x%`));
    check('refused ownerId uploads left no rows', leftovers.length === 0, `${leftovers.length}`);
    // the content editor: admin on A's content attaches it; A's own content too; B's content refuses it
    const cAdmin = await http('POST', '/api/contents', admin, { title: `upown ${tag}`, ownerId: A.id, mediaIds: [own.body.item.id] });
    const cOwn = await http('POST', '/api/contents', A.token, { title: `upown A ${tag}`, mediaIds: [own.body.item.id] });
    const cB = await http('POST', '/api/contents', B.token, { title: `upown B ${tag}`, mediaIds: [own.body.item.id] });
    const cAdminForB = await http('POST', '/api/contents', admin, { title: `upown B2 ${tag}`, ownerId: B.id, mediaIds: [own.body.item.id] });
    check('A\'s content (by the admin or A) accepts the asset; B\'s refuses it (B 404 media.not_found, admin for B 400 content.media_not_usable)',
      cAdmin.status === 201 && cAdmin.body.content.media?.[0]?.id === own.body.item.id && cOwn.status === 201
        && cB.status === 404 && cB.body.code === 'media.not_found' && cAdminForB.status === 400 && cAdminForB.body.code === 'content.media_not_usable',
      `${cAdmin.status} ${cAdmin.text.slice(0, 160)} ${cOwn.status} ${cB.status} ${cB.body?.code} ${cAdminForB.status} ${cAdminForB.body?.code}`);
    for (const c of [cAdmin, cOwn, cB, cAdminForB]) if (c.status === 201) await http('DELETE', `/api/contents/${c.body.content.id}`, admin);
    await new Promise((r) => setTimeout(r, 500));
    const [ownAudit] = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), eq(schema.auditLogs.action, 'media.upload'), eq(schema.auditLogs.target, `upown-${tag}.png`)));
    check('upload audit records ownerId + categoryId', (ownAudit?.detail as any)?.ownerId === A.id && (ownAudit?.detail as any)?.categoryId === aCatId && ownAudit?.userId === adminId, JSON.stringify(ownAudit?.detail));
    for (const id of [own.body.item.id, noScope.body.item?.id].filter(Boolean)) { await http('DELETE', `/api/media/${id}`, admin); created.splice(created.indexOf(id), 1); }
    await db.delete(schema.mediaTags).where(eq(sql`lower(${schema.mediaTags.name})`, `own${tag}`));
  }

  // merge: within one owner only (a category holds assets of its own owner)
  const aCat2 = (await http('POST', '/api/media/categories', A.token, { scope: 'mine', name: `合并源-${tag}` })).body.category.id as string;
  createdCats.push(aCat2);
  await http('PUT', `/api/media/${aId}`, A.token, { categoryId: aCat2 });
  check('merge into itself → 400 media_category.merge_same', (await http('POST', `/api/media/categories/${aCat2}/merge`, A.token, { into: aCat2 })).body?.code === 'media_category.merge_same');
  const mPub = await http('POST', `/api/media/categories/${aCat2}/merge`, A.token, { into: pubCatId });
  check('merge personal → public → 400 media_category.merge_scope (assets would change scope)', mPub.status === 400 && mPub.body.code === 'media_category.merge_scope', `${mPub.status} ${mPub.body?.code}`);
  check('merge into B\'s category → 404', (await http('POST', `/api/media/categories/${aCat2}/merge`, A.token, { into: bCatId })).status === 404);
  const mAdmin = await http('POST', `/api/media/categories/${aCat2}/merge`, admin, { into: bCatId });
  check('admin: merge A\'s into B\'s → 400 merge_scope', mAdmin.status === 400 && mAdmin.body.code === 'media_category.merge_scope');
  check('user merges a public category → 403', (await http('POST', `/api/media/categories/${pubCatId}/merge`, A.token, { into: pubCatId })).status === 403);
  const mOk = await http('POST', `/api/media/categories/${aCat2}/merge`, A.token, { into: aCatId });
  check('merge personal → same owner\'s: asset moved, source deleted', mOk.status === 200 && mOk.body.moved === 1
    && (await http('GET', `/api/media/${aId}`, A.token)).body.item.categoryId === aCatId && (await http('PATCH', `/api/media/categories/${aCat2}`, A.token, { sort: 1 })).status === 404);
  createdCats.splice(createdCats.indexOf(aCat2), 1);
  const pub2 = (await http('POST', '/api/media/categories', admin, { scope: 'public', name: `Pub2-${tag}` })).body.category.id as string;
  await http('PUT', `/api/media/${pubVid.id}`, admin, { categoryId: pub2 });
  const mPubPub = await http('POST', `/api/media/categories/${pub2}/merge`, admin, { into: pubCatId });
  check('admin merges public → public', mPubPub.status === 200 && mPubPub.body.moved === 1 && (await http('GET', `/api/media/${pubVid.id}`, admin)).body.item.categoryId === pubCatId);
  check('public → personal → 400 merge_scope', (await http('POST', `/api/media/categories/${pubCatId}/merge`, admin, { into: aCatId })).body?.code === 'media_category.merge_scope');
  const delCat = await http('DELETE', `/api/media/categories/${aCatId}`, A.token);
  check('delete category → asset uncategorized', delCat.status === 204 && (await http('GET', `/api/media/${aId}`, A.token)).body.item.categoryId === null);
  createdCats.splice(createdCats.indexOf(aCatId), 1);
  for (const m of [pubImg.id, pubVid.id]) await http('PUT', `/api/media/${m}`, admin, { categoryId: null });

  // ---------- tags + search
  const t1 = await http('PUT', `/api/media/${pubImg.id}`, admin, { tags: [`Sunset${tag}`, `beach${tag}`, `sunset${tag}`] });
  check('set tags (case-insensitive dedupe)', t1.status === 200 && t1.body.item.tags.length === 2, JSON.stringify(t1.body?.item?.tags));
  await http('PUT', `/api/media/${pubVid.id}`, admin, { tags: [`SUNSET${tag}`] });
  const tagRows = await db.select().from(schema.mediaTags).where(sql`lower(${schema.mediaTags.name}) = ${`sunset${tag}`}`);
  check('one media_tags row per lower(name)', tagRows.length === 1 && tagRows[0]!.name === `Sunset${tag}`, JSON.stringify(tagRows.map((t) => t.name)));
  const byTag = await list(A.token, `scope=public&tags=${encodeURIComponent(`sunset${tag}`)}`);
  check('tag filter (case-insensitive) → image + video', byTag.body.total === 2 && ids(byTag).includes(pubImg.id) && ids(byTag).includes(pubVid.id), `${byTag.body?.total}`);
  const byTags = await list(A.token, `scope=public&tags=${encodeURIComponent(`sunset${tag},BEACH${tag}`)}`);
  check('multiple tags = all of them → image only', byTags.body.total === 1 && ids(byTags)[0] === pubImg.id, `${byTags.body?.total}`);
  check('keyword search matches tag', ids(await list(A.token, `scope=public&q=${encodeURIComponent(`beach${tag}`)}`)).join() === pubImg.id);
  check('keyword search matches name', ids(await list(A.token, `scope=public&q=${encodeURIComponent(`公共视频-${tag}`)}`)).join() === pubVid.id);
  const typeV = await list(admin, `scope=public&type=video&q=${tag}`);
  check('type filter', typeV.body.items.length === 1 && typeV.body.items[0].fileType === 'video');
  const page = await list(admin, `scope=public&q=${tag}&pageSize=2&page=2`);
  check('pagination: total + page size', page.body.total === 4 && page.body.items.length === 2, `${page.body?.total} ${page.body?.items?.length}`);
  check('GET /api/media/tags lists used tags', (await http('GET', '/api/media/tags?scope=public', A.token)).body.tags.includes(`Sunset${tag}`));

  // ---------- push validation (no devices are created)
  const p1 = await http('POST', '/api/media/push', admin, { assetIds: [pubImg.id], instanceIds: [NIL] });
  check('push to unknown device → 202, skipped "not found"', p1.status === 202 && p1.body.accepted.length === 0 && p1.body.skipped[0]?.reason === 'not found', JSON.stringify(p1.body));
  const p2 = await http('POST', '/api/media/push', A.token, { assetIds: [aId], instanceIds: [NIL] });
  check('user push to a device without grant → 403', p2.status === 403, `${p2.status}`);
  const p3 = await http('POST', '/api/media/push', admin, { assetIds: [NIL], instanceIds: [NIL] });
  check('push unknown asset → 404', p3.status === 404, `${p3.status}`);
  const p4 = await http('POST', '/api/media/push', admin, { assetIds: [], instanceIds: [NIL] });
  check('push with empty assetIds → 400', p4.status === 400, `${p4.status}`);

  // ---------- in-use guard: a real unfinished push-asset task row referencing the asset
  const [busy] = await db.insert(schema.tasks).values({ type: 'push-asset', status: 'pending', instanceName: `media-check-${tag}`, refType: 'media', refId: aId }).returning();
  const inUse = await http('DELETE', `/api/media/${aId}`, A.token);
  check('delete while an unfinished push task references it → 409 in_use', inUse.status === 409 && inUse.body.code === 'media.in_use', `${inUse.status} ${inUse.body?.code}`);
  await db.delete(schema.tasks).where(eq(schema.tasks.id, busy!.id));

  // ---------- batch delete honours permissions
  const up2 = await upload(A.token, 'mine', `batch-${tag}.png`, png, 'image/png');
  await waitDone(up2.body.item.id, A.token);
  const r2 = await row(up2.body.item.id);
  const bd = await http<{ results: any[] }>('POST', '/api/media/batch-delete', A.token, { ids: [up2.body.item.id, bId, pubImg.id, NIL] });
  const res = (id: string) => bd.body.results.find((r: any) => r.id === id);
  check('batch delete: own → ok, B\'s → 404, public → 403, unknown → 404',
    bd.status === 200 && res(up2.body.item.id)?.ok === true && res(bId)?.status === 404 && res(pubImg.id)?.status === 403 && res(NIL)?.status === 404,
    JSON.stringify(bd.body.results.map((r: any) => [r.ok, r.status, r.code])));
  check('batch delete removed own files + row; others untouched', !onDisk(r2!.fileKey) && !onDisk(r2!.thumbnailKey) && !(await row(up2.body.item.id)) && Boolean(await row(bId)) && Boolean(await row(pubImg.id)));

  // ---------- delete removes files, rows and favorites
  await http('POST', `/api/media/${pubImg.id}/favorite`, A.token);
  await http('POST', `/api/media/${pubImg.id}/favorite`, B.token);
  const before = await row(pubImg.id);
  const del = await http('DELETE', `/api/media/${pubImg.id}`, admin);
  const favAfter = await db.select().from(schema.mediaFavorites).where(eq(schema.mediaFavorites.assetId, pubImg.id));
  check('admin deletes public image → 204, file + thumbnail gone from disk, row gone', del.status === 204 && !onDisk(before!.fileKey) && !onDisk(before!.thumbnailKey) && !(await row(pubImg.id)), `${del.status}`);
  check('deleting a public asset removes it from everyone\'s favorites', favAfter.length === 0 && !ids(await list(A.token, 'scope=favorites')).includes(pubImg.id));
  check('asset tag links cascade-deleted', (await db.select().from(schema.mediaAssetTags).where(eq(schema.mediaAssetTags.assetId, pubImg.id))).length === 0);
  created.splice(created.indexOf(pubImg.id), 1);
  const delA = await http('DELETE', `/api/media/${aId}`, A.token);
  check('user deletes own private asset → 204, files gone', delA.status === 204 && !onDisk(rA!.fileKey) && !onDisk(rA!.thumbnailKey));

  // ---------- optional S3
  if (!S3) {
    console.log('S3_TEST_* not set: skipping S3 checks');
  } else {
    const sdk = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey } });
    await sdk.send(new CreateBucketCommand({ Bucket: S3.bucket })).catch((e: any) => { if (!/BucketAlready/.test(e.name)) throw e; });
    const head = (key: string) => sdk.send(new HeadObjectCommand({ Bucket: S3.bucket, Key: S3.prefix + key })).then(() => 200, (e: any) => e.$metadata?.httpStatusCode ?? 0);
    const put = await http('PUT', '/api/settings/storage', admin, { type: 's3', s3: S3 });
    check('switch storage to S3', put.status === 200 && put.body.storage.type === 's3', `${put.status}`);
    const s3up = await upload(A.token, 'mine', `s3-${tag}.png`, png, 'image/png');
    const s3item = await waitDone(s3up.body.item.id, A.token);
    const s3row = await row(s3up.body.item.id);
    check('S3 upload processed, same key layout', s3item.status === 'ready' && s3row!.storage === 's3' && s3row!.fileKey.startsWith(`users/${A.id}/images/`), `${s3item.status} ${s3row?.fileKey}`);
    check('S3 objects exist (file + thumbnail), not on local disk', (await head(s3row!.fileKey)) === 200 && (await head(s3row!.thumbnailKey!)) === 200 && !onDisk(s3row!.fileKey));
    const s3del = await http('DELETE', `/api/media/${s3row!.id}`, A.token);
    check('S3 delete removes both objects', s3del.status === 204 && (await head(s3row!.fileKey)) === 404 && (await head(s3row!.thumbnailKey!)) === 404);
    sdk.destroy();
    await http('PUT', '/api/settings/storage', admin, { type: 'local' });
  }

  // ---------- deleting a user purges their private media files
  const bRow = await row(bId);
  const delB = await http('DELETE', `/api/users/${B.id}`, admin);
  check('deleting user B purges B\'s media files + rows + categories', delB.status === 204 && !onDisk(bRow!.fileKey) && !onDisk(bRow!.thumbnailKey) && !(await row(bId))
    && (await db.select().from(schema.mediaCategories).where(eq(schema.mediaCategories.id, bCatId))).length === 0, `${delB.status}`);
  check('B\'s storage directory is empty', !fs.existsSync(path.join(ASSET_DIR, 'users', B.id)) || fs.readdirSync(path.join(ASSET_DIR, 'users', B.id), { recursive: true }).every((f) => fs.statSync(path.join(ASSET_DIR, 'users', B.id, String(f))).isDirectory()));
  users.splice(users.indexOf(B), 1);

  // ---------- audit
  await new Promise((r) => setTimeout(r, 1000));
  const audit = await db.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), dlike(schema.auditLogs.action, 'media.%')));
  const actions = new Set(audit.map((a) => a.action));
  const want = ['media.upload', 'media.update', 'media.delete', 'media.batch_delete', 'media.favorite', 'media.unfavorite', 'media.category_create', 'media.category_update', 'media.category_delete', 'media.category_merge', 'media.push'];
  check('audit rows for media actions', want.every((w) => actions.has(w)), `missing: ${want.filter((w) => !actions.has(w)).join(', ') || 'none'}`);
  check('no media.disable / media.enable audit actions', !actions.has('media.disable') && !actions.has('media.enable'), [...actions].join(','));
  const catAudit = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), dlike(schema.auditLogs.action, 'media.category_%')));
  check('category audit: names only (merge source + into), no description text', catAudit.some((a) => a.action === 'media.category_merge' && a.target === `合并源-${tag}` && (a.detail as any)?.into === `改名-${tag}`)
    && catAudit.some((a) => a.action === 'media.category_delete' && a.target === `改名-${tag}`) && !JSON.stringify(catAudit).includes(`desc ${tag}`), JSON.stringify(catAudit.map((a) => [a.action, a.target])));
  const [upAudit] = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), eq(schema.auditLogs.action, 'media.upload'), eq(schema.auditLogs.status, 201))).limit(1);
  check('upload audit has filename + scope, no body', Boolean(upAudit?.target) && (upAudit?.detail as any)?.scope !== undefined, JSON.stringify(upAudit?.detail));
} catch (err) {
  failures++;
  console.log('✗ unexpected error', err);
} finally {
  if (prevLimits.length) {
    await db.delete(schema.settings).where(eq(schema.settings.key, 'media.limits'));
    await db.insert(schema.settings).values(prevLimits);
  }
  for (const id of created) {
    const d = await http('DELETE', `/api/media/${id}`, admin);
    if (d.status !== 204 && d.status !== 404) check(`cleanup: delete media ${id}`, false, `${d.status}`);
  }
  for (const id of createdCats) await http('DELETE', `/api/media/categories/${id}`, admin);
  for (const u of users) {
    const d = await http('DELETE', `/api/users/${u.id}`, admin);
    check(`cleanup: delete user ${u.name}`, d.status === 204, `${d.status}`);
  }
  const left = await db.select({ id: schema.mediaAssets.id }).from(schema.mediaAssets).where(dlike(schema.mediaAssets.fileName, `%${tag}%`));
  check('cleanup: no test media rows left', left.length === 0, `${left.length}`);
  await db.delete(schema.mediaTags).where(inArray(sql`lower(${schema.mediaTags.name})`, [`sunset${tag}`, `beach${tag}`]));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await sqlClient.end();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
