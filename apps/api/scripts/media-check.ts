/**
 * Media library (素材库) through the real HTTP API, real storage, real sharp/ffmpeg. No mocks.
 * Requires: API running (base URL from API_PORT, or E2E_API), ffmpeg on PATH (FFMPEG_PATH) to make a test clip.
 * Reads ADMIN_USERNAME / ADMIN_PASSWORD from the env (never printed). Creates two throwaway users and
 * test media, verifies storage on disk (ASSET_DIR) and rows in the DB, and deletes everything it created.
 * Optional S3 part (same env as assets-check used): S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY,
 * S3_TEST_SECRET_KEY [, S3_TEST_REGION]; it switches storage to S3 and back to local.
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

async function upload(token: string, scope: string | null, name: string, data: Buffer, mime: string, categoryId?: string) {
  const fd = new FormData();
  if (scope) fd.append('scope', scope);
  if (categoryId) fd.append('categoryId', categoryId);
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

const login = async (username: string, password: string) => (await http<{ token: string }>('POST', '/api/auth/login', undefined, { username, password })).body?.token;

const startedAt = new Date();
const tag = randomBytes(3).toString('hex');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-check-'));
const created: string[] = []; // media ids to clean up (admin deletes)
const createdCats: string[] = [];
const users: { id: string; name: string; token: string }[] = [];

const admin = await login(process.env.ADMIN_USERNAME ?? 'admin', process.env.ADMIN_PASSWORD ?? '');
check('admin login', Boolean(admin));
if (!admin) process.exit(1);

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

  const upA = await upload(A.token, 'mine', `私有A-${tag}.jpg`, jpg, 'image/jpeg');
  const upB = await upload(B.token, null, `privB-${tag}.png`, png, 'image/png'); // scope defaults to mine
  check('users upload private media', upA.status === 201 && upB.status === 201 && upB.body.item.ownerType === 'user' && upB.body.item.ownerId === B.id, `${upA.status} ${upB.status}`);
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

  // disable / enable
  const dis = await http('PUT', `/api/media/${pubVid.id}`, admin, { status: 'disabled' });
  check('admin disables public video', dis.status === 200 && dis.body.item.status === 'disabled', `${dis.status}`);
  const pubForA = await list(A.token, 'scope=public&pageSize=100');
  check('users do not see disabled public assets (list)', !ids(pubForA).includes(pubVid.id) && pubForA.body.items.every((i) => i.status === 'ready'));
  check('users get 404 on disabled asset + content', (await http('GET', `/api/media/${pubVid.id}`, A.token)).status === 404 && (await raw(`/api/media/${pubVid.id}/content`, A.token)).status === 404);
  check('admin still sees disabled asset', ids(await list(admin, 'scope=public&status=disabled')).includes(pubVid.id));
  check('status on private asset → 400', (await http('PUT', `/api/media/${aId}`, A.token, { status: 'disabled' })).status === 400);
  check('user cannot enable a disabled public asset (404, not visible)', (await http('PUT', `/api/media/${pubVid.id}`, A.token, { status: 'ready' })).status === 404);
  check('admin re-enables video', (await http('PUT', `/api/media/${pubVid.id}`, admin, { status: 'ready' })).body?.item?.status === 'ready');

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
  await http('PUT', `/api/media/${pubVid.id}`, admin, { status: 'disabled' });
  check('disabled favorite hidden from user\'s favorites', !ids(await list(A.token, 'scope=favorites')).includes(pubVid.id));
  await http('PUT', `/api/media/${pubVid.id}`, admin, { status: 'ready' });
  const unf = await http('DELETE', `/api/media/${pubImg.id}/favorite`, A.token);
  check('unfavorite: removed from favorites, asset intact', unf.status === 200 && !ids(await list(A.token, 'scope=favorites')).includes(pubImg.id) && (await http('GET', `/api/media/${pubImg.id}`, A.token)).status === 200);

  // ---------- categories
  const cPubByUser = await http('POST', '/api/media/categories', A.token, { scope: 'public', name: `公共分类-${tag}` });
  check('user creates public category → 403', cPubByUser.status === 403, `${cPubByUser.status}`);
  const cPub = await http('POST', '/api/media/categories', admin, { scope: 'public', name: `公共分类-${tag}` });
  const cPub2 = await http('POST', '/api/media/categories', admin, { scope: 'public', name: `公共分类-${tag}` });
  check('admin creates public category; duplicate → 409', cPub.status === 201 && cPub2.status === 409 && cPub2.body.code === 'media.category_exists', `${cPub.status} ${cPub2.status}`);
  const cA = await http('POST', '/api/media/categories', A.token, { scope: 'mine', name: `我的分类-${tag}` });
  const cB = await http('POST', '/api/media/categories', B.token, { scope: 'mine', name: `我的分类-${tag}` });
  check('users create own categories (same name per owner ok)', cA.status === 201 && cB.status === 201, `${cA.status} ${cB.status}`);
  createdCats.push(cPub.body.category.id, cA.body.category.id, cB.body.category.id);
  const pubCatId = cPub.body.category.id, aCatId = cA.body.category.id, bCatId = cB.body.category.id;
  check('user renames public category → 403', (await http('PUT', `/api/media/categories/${pubCatId}`, A.token, { name: 'x' })).status === 403);
  check('A renames B\'s category → 404', (await http('PUT', `/api/media/categories/${bCatId}`, A.token, { name: 'x' })).status === 404);
  check('A deletes B\'s category → 404', (await http('DELETE', `/api/media/categories/${bCatId}`, A.token)).status === 404);
  const ren = await http('PUT', `/api/media/categories/${aCatId}`, A.token, { name: `改名-${tag}`, sort: 5 });
  check('A renames + re-sorts own category', ren.status === 200 && ren.body.category.name === `改名-${tag}` && ren.body.category.sort === 5);
  const aCats = await http('GET', '/api/media/categories?scope=mine', A.token);
  check('A lists only own categories', aCats.body.categories.some((c: any) => c.id === aCatId) && !aCats.body.categories.some((c: any) => c.id === bCatId));
  check('user can list public categories', (await http('GET', '/api/media/categories?scope=public', A.token)).body.categories.some((c: any) => c.id === pubCatId));
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
  const delCat = await http('DELETE', `/api/media/categories/${aCatId}`, A.token);
  check('delete category → asset uncategorized', delCat.status === 204 && (await http('GET', `/api/media/${aId}`, A.token)).body.item.categoryId === null);
  createdCats.splice(createdCats.indexOf(aCatId), 1);

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
  const want = ['media.upload', 'media.update', 'media.disable', 'media.enable', 'media.delete', 'media.batch_delete', 'media.favorite', 'media.unfavorite', 'media.category_create', 'media.category_update', 'media.category_delete', 'media.push'];
  check('audit rows for media actions', want.every((w) => actions.has(w)), `missing: ${want.filter((w) => !actions.has(w)).join(', ') || 'none'}`);
  const [upAudit] = await db.select().from(schema.auditLogs).where(and(gte(schema.auditLogs.at, startedAt), eq(schema.auditLogs.action, 'media.upload'), eq(schema.auditLogs.status, 201))).limit(1);
  check('upload audit has filename + scope, no body', Boolean(upAudit?.target) && (upAudit?.detail as any)?.scope !== undefined, JSON.stringify(upAudit?.detail));
} catch (err) {
  failures++;
  console.log('✗ unexpected error', err);
} finally {
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
