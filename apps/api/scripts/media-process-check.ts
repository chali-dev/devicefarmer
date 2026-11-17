/**
 * Media library crop/compress at upload (multipart field `process`) through the real HTTP API,
 * real storage, real sharp/ffmpeg. No mocks. Requires: API running (base URL from API_PORT or
 * E2E_API), ffmpeg/ffprobe on PATH (FFMPEG_PATH/FFPROBE_PATH). Reads ADMIN_USERNAME / ADMIN_PASSWORD
 * (never printed). Uploads to the admin's private media and deletes everything it created.
 * Usage (from apps/api): npx tsx --env-file=../../.env scripts/media-process-check.ts
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema, sqlClient } from '../src/db/index.js';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
const ASSET_DIR = path.resolve(process.env.ASSET_DIR ?? 'var/assets');

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) passes++; else failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

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
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

const tag = randomBytes(3).toString('hex');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-process-check-'));
const created: string[] = [];

async function upload(token: string, name: string, data: Buffer, mime: string, proc?: unknown) {
  const fd = new FormData();
  fd.append('scope', 'mine');
  if (proc !== undefined) fd.append('process', typeof proc === 'string' ? proc : JSON.stringify(proc));
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
  const r = await http<{ item: any }>('POST', '/api/media/upload', token, fd);
  if (r.status === 201) created.push(r.body.item.id);
  return r;
}
async function waitDone(id: string, token: string, timeoutMs = 180_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await http<{ item: any }>('GET', `/api/media/${id}`, token);
    if (r.status !== 200) return { status: `http ${r.status}` };
    if (r.body.item.status !== 'processing' || Date.now() > until) return r.body.item;
    await new Promise((res) => setTimeout(res, 300));
  }
}
/** Uploads, waits, downloads: { item, file, row }. */
async function process1(token: string, name: string, data: Buffer, mime: string, proc?: unknown) {
  const up = await upload(token, name, data, mime, proc);
  if (up.status !== 201) return { up, item: null as any, file: Buffer.alloc(0), row: null as any };
  const item = await waitDone(up.body.item.id, token);
  const file = item.status === 'ready' ? (await raw(`/api/media/${item.id}/content`, token)).buf : Buffer.alloc(0);
  const [row] = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, item.id));
  return { up, item, file, row };
}
async function probe(buf: Buffer) {
  const f = path.join(tmpDir, `probe-${randomBytes(4).toString('hex')}`);
  fs.writeFileSync(f, buf);
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]);
  fs.rmSync(f);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video'), a = j.streams.find((s: any) => s.codec_type === 'audio');
  return { width: v?.width, height: v?.height, vcodec: v?.codec_name, pix: v?.pix_fmt, acodec: a?.codec_name ?? null, duration: Number(j.format.duration), format: j.format.format_name as string };
}
async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return [data[o]!, data[o + 1]!, data[o + 2]!];
}
const near = (p: [number, number, number], q: [number, number, number], tol = 40) => p.every((v, i) => Math.abs(v - q[i]!) <= tol);
const RED: [number, number, number] = [255, 0, 0], GREEN: [number, number, number] = [0, 255, 0], BLUE: [number, number, number] = [0, 0, 255], YELLOW: [number, number, number] = [255, 255, 0];
const ffgen = async (name: string, args: string[]) => { const f = path.join(tmpDir, name); await run(FFMPEG, ['-v', 'error', ...args, '-y', f]); return fs.readFileSync(f); };
const ownerFiles = (ownerId: string) => {
  const out: string[] = [];
  for (const d of ['images', 'videos', 'thumbnails']) {
    const dir = path.join(ASSET_DIR, 'users', ownerId, d);
    if (fs.existsSync(dir)) out.push(...fs.readdirSync(dir).map((f) => `users/${ownerId}/${d}/${f}`));
  }
  return out.sort();
};

const login = await http<{ token: string; user: { id: string } }>('POST', '/api/auth/login', undefined, { username: process.env.ADMIN_USERNAME ?? 'admin', password: process.env.ADMIN_PASSWORD ?? '' });
const admin = login.body?.token;
check('admin login', Boolean(admin));
if (!admin) process.exit(1);
const me = await http<{ user: { id: string } }>('GET', '/api/auth/me', admin);
const adminId: string = me.body?.user?.id ?? login.body.user?.id;

try {
  await http('PUT', '/api/settings/storage', admin, { type: 'local' });

  // ---------- test media
  /** 1600×1000, quadrants: top-left red, top-right green, bottom-left blue, bottom-right yellow. */
  const quad = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#000' } }).composite([
    { input: { create: { width: w / 2, height: h / 2, channels: 3, background: '#ff0000' } }, left: 0, top: 0 },
    { input: { create: { width: w / 2, height: h / 2, channels: 3, background: '#00ff00' } }, left: w / 2, top: 0 },
    { input: { create: { width: w / 2, height: h / 2, channels: 3, background: '#0000ff' } }, left: 0, top: h / 2 },
    { input: { create: { width: w / 2, height: h / 2, channels: 3, background: '#ffff00' } }, left: w / 2, top: h / 2 },
  ]);
  const quadPng = await quad(1600, 1000).png().toBuffer();
  const quadPortraitPng = await quad(1000, 1600).png().toBuffer();
  // Photo-like: gradient + noise (compressible, but quality matters).
  const noise = await sharp(randomBytes(500 * 375 * 3), { raw: { width: 500, height: 375, channels: 3 } }).resize(2000, 1500, { kernel: 'cubic' }).png().toBuffer();
  const photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#3a6ea5' } })
    .composite([{ input: noise, blend: 'overlay' }]).jpeg({ quality: 95 }).toBuffer();
  const big45 = await sharp({ create: { width: 2000, height: 2500, channels: 3, background: '#808080' } }).jpeg({ quality: 90 }).toBuffer();
  const small = await sharp({ create: { width: 300, height: 500, channels: 3, background: '#c83c3c' } }).jpeg({ quality: 75 }).toBuffer();
  const webp = await sharp(photo).resize(1200, 900).webp({ quality: 95 }).toBuffer();
  // EXIF orientation 6 (rotate 90° cw to display): stored 1000×600, displayed 600×1000.
  const rotated = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#336699' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const gif = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ff00ff' } }).gif().toBuffer();
  const vid1080 = await ffgen('src1080.mp4', ['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  // Video with coloured halves (left red, right blue) for the crop position.
  const vidHalves = await ffgen('halves.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=2:r=25', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=2:r=25',
    '-filter_complex', '[0][1]hstack', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const webm = await ffgen('src.webm', ['-f', 'lavfi', '-i', 'testsrc2=duration=2:size=854x480:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2',
    '-c:v', 'libvpx-vp9', '-b:v', '1M', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest']);
  check('generated test media', [quadPng, photo, big45, small, webp, rotated, gif, vid1080, vidHalves, webm].every((b) => b.length > 0),
    `photo ${kb(photo.length)}, 1080p video ${kb(vid1080.length)}, webm ${kb(webm.length)}`);

  const lim = await http('GET', '/api/media/limits', admin);
  check('limits report processable formats', lim.body.image.formats.find((f: any) => f.id === 'jpeg')?.processable === true && lim.body.image.formats.find((f: any) => f.id === 'gif')?.processable === false);

  // ---------- validation
  for (const [label, proc] of [
    ['not JSON', '{nope'], ['unknown aspect 3:2', { crop: { aspect: '3:2' } }], ['maxSize 500', { maxSize: 500 }],
    ['quality ultra', { quality: 'ultra' }], ['crop x > 1', { crop: { aspect: '1:1', x: 2 } }], ['unknown key', { rotate: 90 }],
    ['rect x + w > 1', { crop: { x: 0.6, y: 0, w: 0.5, h: 0.5 } }], ['rect y + h > 1', { crop: { x: 0, y: 0.7, w: 0.2, h: 0.4 } }],
    ['rect w = 0', { crop: { x: 0, y: 0, w: 0, h: 0.5 } }], ['rect h < 0', { crop: { x: 0, y: 0, w: 0.5, h: -0.2 } }],
    ['rect too small (w 0.005)', { crop: { x: 0.1, y: 0.1, w: 0.005, h: 0.5 } }], ['rect negative x', { crop: { x: -0.1, y: 0, w: 0.5, h: 0.5 } }],
    ['rect missing h', { crop: { x: 0, y: 0, w: 0.5 } }], ['rect with unknown aspect', { crop: { x: 0, y: 0, w: 0.5, h: 0.5, aspect: '3:2' } }],
    ['rect with extra key', { crop: { x: 0, y: 0, w: 0.5, h: 0.5, r: 1 } }],
  ] as const) {
    const r = await upload(admin, `bad-${tag}.jpg`, small, 'image/jpeg', proc);
    check(`invalid options (${label}) → 400 media.bad_process_options`, r.status === 400 && r.body?.code === 'media.bad_process_options', `${r.status} ${r.body?.code}`);
  }
  const rg = await upload(admin, `anim-${tag}.gif`, gif, 'image/gif', { quality: 'low' });
  check('GIF with options → 400 media.process_unsupported', rg.status === 400 && rg.body?.code === 'media.process_unsupported', `${rg.status} ${rg.body?.code}`);
  const rgPlain = await upload(admin, `plain-${tag}.gif`, gif, 'image/gif');
  check('GIF without options still accepted', rgPlain.status === 201);

  // ---------- default: unchanged byte-for-byte; all-"original" options = no processing
  for (const [label, proc] of [['no field', undefined], ['empty object', {}], ['aspect original', { crop: { aspect: 'original' } }]] as const) {
    const d = await process1(admin, `plain-${label}-${tag}.png`, quadPng, 'image/png', proc);
    check(`default (${label}): byte-identical, processing null`, d.item?.status === 'ready' && sha(d.file) === sha(quadPng) && d.item.checksum === sha(quadPng) && d.item.processing === null,
      `${d.item?.status} processing=${JSON.stringify(d.item?.processing)}`);
  }

  // ---------- image crop position (lossless PNG keeps exact colours)
  const left = await process1(admin, `crop-left-${tag}.png`, quadPng, 'image/png', { crop: { aspect: '4:5', x: 0, y: 0.5 } });
  const lm = left.file.length ? await sharp(left.file).metadata() : null;
  check('PNG 4:5 crop at x=0 → 800×1000 PNG', left.item?.status === 'ready' && lm?.width === 800 && lm?.height === 1000 && lm.format === 'png' && left.item.width === 800 && left.item.height === 1000,
    `${left.item?.status} ${lm?.width}×${lm?.height} ${lm?.format} ${left.item?.error ?? ''}`);
  if (lm) {
    check('crop x=0 keeps the left half (red top, blue bottom, no green/yellow)', near(await pixel(left.file, 5, 5), RED) && near(await pixel(left.file, 795, 5), RED) && near(await pixel(left.file, 795, 995), BLUE) && near(await pixel(left.file, 5, 995), BLUE));
  }
  const right = await process1(admin, `crop-right-${tag}.png`, quadPng, 'image/png', { crop: { aspect: '4:5', x: 1, y: 0.5 } });
  if (right.file.length) check('crop x=1 keeps the right half (green top, yellow bottom)', near(await pixel(right.file, 5, 5), GREEN) && near(await pixel(right.file, 795, 995), YELLOW));
  else check('crop x=1 processed', false, right.item?.error);
  const top = await process1(admin, `crop-top-${tag}.png`, quadPortraitPng, 'image/png', { crop: { aspect: '16:9', x: 0.5, y: 0 } });
  const tm = top.file.length ? await sharp(top.file).metadata() : null;
  check('portrait 16:9 crop at y=0 → 1000×563, top half only', tm?.width === 1000 && tm?.height === 563 && near(await pixel(top.file, 5, 560), RED) && near(await pixel(top.file, 995, 560), GREEN), `${tm?.width}×${tm?.height}`);
  const bottom = await process1(admin, `crop-bottom-${tag}.png`, quadPortraitPng, 'image/png', { crop: { aspect: '16:9', x: 0.5, y: 1 } });
  check('portrait 16:9 crop at y=1 → bottom half only', bottom.file.length > 0 && near(await pixel(bottom.file, 5, 2), BLUE) && near(await pixel(bottom.file, 995, 2), YELLOW));
  const centre = await process1(admin, `crop-centre-${tag}.png`, quadPng, 'image/png', { crop: { aspect: '1:1' } });
  check('1:1 default centre → 1000×1000, centred (x 300..1300 of source)', centre.item?.width === 1000 && centre.item?.height === 1000 && near(await pixel(centre.file, 495, 5), RED) && near(await pixel(centre.file, 505, 5), GREEN));

  // ---------- explicit rectangles { x, y, w, h [, aspect] } (the editor's form)
  const corners = async (buf: Buffer) => {
    const m = await sharp(buf).metadata();
    return { w: m.width!, h: m.height!, tl: await pixel(buf, 3, 3), tr: await pixel(buf, m.width! - 4, 3), bl: await pixel(buf, 3, m.height! - 4), br: await pixel(buf, m.width! - 4, m.height! - 4) };
  };
  const all = (c: Awaited<ReturnType<typeof corners>>, col: [number, number, number], tol?: number) => [c.tl, c.tr, c.bl, c.br].every((p) => near(p, col, tol));
  const rq = await process1(admin, `rect-q2-${tag}.png`, quadPng, 'image/png', { crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } });
  const rqc = rq.file.length ? await corners(rq.file) : null;
  check('free rect = top-right quadrant → 800×500, green only', rq.item?.status === 'ready' && rqc?.w === 800 && rqc.h === 500 && all(rqc, GREEN) && rq.item.width === 800 && rq.item.height === 500,
    `${rq.item?.status} ${rqc?.w}×${rqc?.h} ${rq.item?.error ?? ''}`);
  const rc = await process1(admin, `rect-mid-${tag}.png`, quadPng, 'image/png', { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const rcc = rc.file.length ? await corners(rc.file) : null;
  check('free rect around the centre → 800×500 with all four quadrants in place', rcc?.w === 800 && rcc.h === 500 && near(rcc.tl, RED) && near(rcc.tr, GREEN) && near(rcc.bl, BLUE) && near(rcc.br, YELLOW), `${rcc?.w}×${rcc?.h}`);
  const rb = await process1(admin, `rect-odd-${tag}.png`, quadPng, 'image/png', { crop: { x: 0.1, y: 0.6, w: 0.3, h: 0.3 } });
  const rbc = rb.file.length ? await corners(rb.file) : null;
  check('free rect 0.1/0.6/0.3/0.3 → exactly 480×300, blue only', rbc?.w === 480 && rbc.h === 300 && all(rbc, BLUE), `${rbc?.w}×${rbc?.h}`);
  const ra = await process1(admin, `rect-45-${tag}.png`, quadPng, 'image/png', { crop: { x: 0.5, y: 0, w: 0.25, h: 0.5, aspect: '4:5' } });
  const rac = ra.file.length ? await corners(ra.file) : null;
  check('4:5 rect (400×500 at the top right) → 400×500, green only', rac?.w === 400 && rac.h === 500 && all(rac, GREEN), `${rac?.w}×${rac?.h}`);
  const rs = await process1(admin, `rect-11-${tag}.png`, quadPng, 'image/png', { crop: { x: 0, y: 0, w: 0.5, h: 0.8, aspect: '1:1' }, maxSize: 720 });
  const rsc = rs.file.length ? await corners(rs.file) : null;
  check('1:1 rect 800×800 at the left + 720 → 720×720, red on top, blue at the bottom', rsc?.w === 720 && rsc.h === 720 && near(rsc.tl, RED) && near(rsc.tr, RED) && near(rsc.bl, BLUE) && near(rsc.br, BLUE), `${rsc?.w}×${rsc?.h}`);
  const rm = await process1(admin, `rect-mismatch-${tag}.png`, quadPng, 'image/png', { crop: { x: 0, y: 0, w: 0.5, h: 0.5, aspect: '1:1' } });
  check('rect that does not match its aspect (800×500 as 1:1) → failed with a reason', rm.item?.status === 'failed' && /does not match aspect/.test(rm.item.error ?? ''), `${rm.item?.status} ${rm.item?.error?.slice(0, 80)}`);
  const rf = await process1(admin, `rect-full-${tag}.png`, quadPng, 'image/png', { crop: { x: 0, y: 0, w: 1, h: 1 } });
  check('full-source rect = no-op: byte-identical, processing null', rf.item?.status === 'ready' && sha(rf.file) === sha(quadPng) && rf.item.processing === null, `${rf.item?.status} ${JSON.stringify(rf.item?.processing)}`);
  const rr = await process1(admin, `rect-rot-${tag}.jpg`, rotated, 'image/jpeg', { crop: { x: 0, y: 0.5, w: 1, h: 0.5 } });
  check('rect on an EXIF-rotated JPEG uses displayed coordinates → 600×500', rr.item?.width === 600 && rr.item?.height === 500, `${rr.item?.width}×${rr.item?.height}`);
  check('rect options recorded on the asset', ['x', 'y', 'w', 'h', 'aspect'].every((k) => rs.item?.processing?.options?.crop?.[k] === ({ x: 0, y: 0, w: 0.5, h: 0.8, aspect: '1:1' } as any)[k]), JSON.stringify(rs.item?.processing?.options));

  // ---------- size presets, aspect exactness, no upscaling
  const ig45 = await process1(admin, `ig45-${tag}.jpg`, big45, 'image/jpeg', { crop: { aspect: '4:5' }, maxSize: 1080 });
  check('2000×2500 JPEG 4:5 + 1080 → 1080×1350 JPEG', ig45.item?.width === 1080 && ig45.item?.height === 1350 && (await sharp(ig45.file).metadata()).format === 'jpeg' && ig45.item.mimeType === 'image/jpeg', `${ig45.item?.width}×${ig45.item?.height}`);
  const ig11 = await process1(admin, `ig11-${tag}.jpg`, photo, 'image/jpeg', { crop: { aspect: '1:1' }, maxSize: 1080 });
  check('2000×1500 1:1 + 1080 → 1080×1080', ig11.item?.width === 1080 && ig11.item?.height === 1080, `${ig11.item?.width}×${ig11.item?.height}`);
  const s720 = await process1(admin, `s720-${tag}.jpg`, photo, 'image/jpeg', { maxSize: 720 });
  check('2000×1500 + 720 (no crop) → 960×720', s720.item?.width === 960 && s720.item?.height === 720, `${s720.item?.width}×${s720.item?.height}`);
  const r191 = await process1(admin, `r191-${tag}.jpg`, photo, 'image/jpeg', { crop: { aspect: '1.91:1' }, maxSize: 1080 });
  check('2000×1500 1.91:1 + 1080 → 2000×1047 crop, capped at 2160 long side (no upscale) → 2000×1047', r191.item?.width === 2000 && r191.item?.height === 1047, `${r191.item?.width}×${r191.item?.height}`);
  const noUp = await process1(admin, `noup-${tag}.jpg`, small, 'image/jpeg', { maxSize: 1080 });
  check('300×500 + 1080 → stays 300×500 (no upscaling)', noUp.item?.status === 'ready' && noUp.item.width === 300 && noUp.item.height === 500 && noUp.item.processing?.result?.after?.width === 300,
    `${noUp.item?.width}×${noUp.item?.height} kept=${noUp.item?.processing?.result?.kept ?? false}`);
  const rot = await process1(admin, `rot-${tag}.jpg`, rotated, 'image/jpeg', { crop: { aspect: '1:1', x: 0.5, y: 0 } });
  check('EXIF-rotated 1000×600 (displayed 600×1000) 1:1 → 600×600, before = displayed size', rot.item?.width === 600 && rot.item?.height === 600 && rot.item.processing?.result?.before?.width === 600 && rot.item.processing.result.before.height === 1000 && ((await sharp(rot.file).metadata()).orientation ?? 1) === 1,
    `${rot.item?.width}×${rot.item?.height} before ${rot.item?.processing?.result?.before?.width}×${rot.item?.processing?.result?.before?.height}`);

  // ---------- quality: lower quality → smaller, metadata recomputed
  const sizes: Record<string, number> = {};
  for (const q of ['high', 'medium', 'low'] as const) {
    const filesBefore = ownerFiles(adminId);
    const r = await process1(admin, `q-${q}-${tag}.jpg`, photo, 'image/jpeg', { quality: q });
    const added = ownerFiles(adminId).filter((k) => !filesBefore.includes(k));
    sizes[q] = r.item?.fileSize ?? 0;
    if (q === 'medium') {
      const p = r.item?.processing?.result;
      check('JPEG quality medium: processing record before → after', p?.before?.size === photo.length && p?.after?.size === r.file.length && p?.before?.width === 2000 && p?.after?.width === 2000 && !p?.kept, JSON.stringify(p));
      check('sha256/size/mime of the stored file match the row', r.file.length === r.item.fileSize && sha(r.file) === r.item.checksum && r.row.checksum === r.item.checksum && r.item.mimeType === 'image/jpeg');
      check('storage holds only the new file + thumbnail (original upload removed), key users/<id>/images/<uuid>.jpg',
        added.length === 2 && added.includes(r.row.fileKey) && added.includes(r.row.thumbnailKey) && new RegExp(`^users/${adminId}/images/[0-9a-f-]{36}\\.jpg$`).test(r.row.fileKey), added.join(', '));
      const th = await raw(`/api/media/${r.item.id}/thumbnail`, admin);
      check('thumbnail present (JPEG ≤ 480 px)', th.status === 200 && (await sharp(th.buf).metadata()).width === 480);
    }
  }
  check('JPEG sizes: original > high > medium > low', photo.length > sizes.high! && sizes.high! > sizes.medium! && sizes.medium! > sizes.low!,
    `original ${kb(photo.length)} → high ${kb(sizes.high!)}, medium ${kb(sizes.medium!)}, low ${kb(sizes.low!)}`);
  const pngLow = await process1(admin, `pnglow-${tag}.png`, await sharp(photo).resize(1000, 750).png().toBuffer(), 'image/png', { quality: 'low' });
  check('PNG low (palette) → smaller PNG, same size', pngLow.item?.status === 'ready' && pngLow.item.mimeType === 'image/png' && pngLow.item.processing?.result?.after?.size < pngLow.item.processing?.result?.before?.size && pngLow.item.width === 1000,
    `${kb(pngLow.item?.processing?.result?.before?.size ?? 0)} → ${kb(pngLow.item?.processing?.result?.after?.size ?? 0)}`);
  const webpLow = await process1(admin, `webplow-${tag}.webp`, webp, 'image/webp', { quality: 'low', crop: { aspect: '9:16' } });
  const wm = webpLow.file.length ? await sharp(webpLow.file).metadata() : null;
  check('WebP 9:16 low → WebP 506×900, smaller', wm?.format === 'webp' && wm.width === 506 && wm.height === 900 && webpLow.file.length < webp.length, `${wm?.format} ${wm?.width}×${wm?.height} ${kb(webp.length)} → ${kb(webpLow.file.length)}`);
  // Quality-only re-encode that isn't smaller: the upload is kept untouched.
  const lowJpeg = await sharp(photo).resize(800, 600).jpeg({ quality: 40, mozjpeg: true }).toBuffer();
  const keep = await process1(admin, `keep-${tag}.jpg`, lowJpeg, 'image/jpeg', { quality: 'high' });
  check('quality-only result not smaller → upload kept byte-for-byte (kept: true)', keep.item?.status === 'ready' && sha(keep.file) === sha(lowJpeg) && keep.item.processing?.result?.kept === true,
    `${keep.item?.status} kept=${keep.item?.processing?.result?.kept}`);

  // ---------- video
  const v916 = await process1(admin, `v916-${tag}.mp4`, vid1080, 'video/mp4', { crop: { aspect: '9:16' }, maxSize: 1080 });
  const p916 = v916.file.length ? await probe(v916.file) : null;
  check('1920×1080 video 9:16 + 1080 → 608×1080 H.264/AAC MP4 (no upscale)', v916.item?.status === 'ready' && p916?.width === 608 && p916?.height === 1080 && p916.vcodec === 'h264' && p916.acodec === 'aac' && p916.pix === 'yuv420p' && v916.item.width === 608 && v916.item.height === 1080,
    `${v916.item?.status} ${p916?.width}×${p916?.height} ${p916?.vcodec}/${p916?.acodec} ${v916.item?.error ?? ''}`);
  check('video duration kept (≈3 s), recorded before/after', Math.abs((v916.item?.duration ?? 0) - 3) < 0.15 && Math.abs(v916.item?.processing?.result?.before?.duration - 3) < 0.15 && v916.item?.processing?.result?.after?.duration === v916.item?.duration, `${v916.item?.duration}`);
  const moov = v916.file.indexOf('moov'), mdat = v916.file.indexOf('mdat');
  check('+faststart: moov before mdat', moov > 0 && mdat > 0 && moov < mdat, `moov@${moov} mdat@${mdat}`);
  check('video sha256/size match', sha(v916.file) === v916.item?.checksum && v916.file.length === v916.item?.fileSize);
  const v720 = await process1(admin, `v720-${tag}.mp4`, vid1080, 'video/mp4', { maxSize: 720, quality: 'high' });
  check('1920×1080 + 720 → 1280×720', v720.item?.width === 1280 && v720.item?.height === 720, `${v720.item?.width}×${v720.item?.height}`);
  const v11 = await process1(admin, `v11-${tag}.mp4`, vid1080, 'video/mp4', { crop: { aspect: '1:1' }, maxSize: 720 });
  check('1920×1080 1:1 + 720 → 720×720', v11.item?.width === 720 && v11.item?.height === 720, `${v11.item?.width}×${v11.item?.height}`);
  const v45 = await process1(admin, `v45-${tag}.mp4`, vid1080, 'video/mp4', { crop: { aspect: '4:5' } });
  check('1920×1080 4:5 → 864×1080 (even dims)', v45.item?.width === 864 && v45.item?.height === 1080, `${v45.item?.width}×${v45.item?.height}`);
  const vsize: Record<string, number> = {};
  for (const q of ['high', 'low'] as const) {
    const r = await process1(admin, `vq-${q}-${tag}.mp4`, vid1080, 'video/mp4', { maxSize: 720, quality: q });
    vsize[q] = r.item?.fileSize ?? 0;
  }
  check('video 720p: low quality smaller than high', vsize.high! > vsize.low! && vsize.low! > 0, `original ${kb(vid1080.length)} → high ${kb(vsize.high!)}, low ${kb(vsize.low!)}`);
  // Crop position on video: halves red | blue; 9:16 at x=0 → red only, x=1 → blue only (thumbnail = cover frame).
  for (const [x, want, label] of [[0, RED, 'red'], [1, BLUE, 'blue']] as const) {
    const r = await process1(admin, `vhalf-${x}-${tag}.mp4`, vidHalves, 'video/mp4', { crop: { aspect: '9:16', x } });
    const th = r.item?.status === 'ready' ? (await raw(`/api/media/${r.item.id}/thumbnail`, admin)).buf : null;
    const m = th ? await sharp(th).metadata() : null;
    const ok = th && m ? near(await pixel(th, 2, 2), want, 60) && near(await pixel(th, m.width! - 3, m.height! - 3), want, 60) : false;
    check(`video 9:16 crop at x=${x} → ${label} only (202×360)`, Boolean(ok) && r.item.width === 202 && r.item.height === 360, `${r.item?.width}×${r.item?.height}`);
  }
  // Rectangles on video (1280×360: red | blue halves), even pixel rounding; checked on the cover frame.
  for (const [label, crop, want, w, h] of [
    ['free rect on the blue half', { x: 0.5, y: 0.25, w: 0.3, h: 0.5 }, BLUE, 384, 180],
    ['free rect with odd pixel sizes → rounded down to even', { x: 0.1, y: 0.1, w: 0.165, h: 0.33 }, RED, 210, 118],
    ['9:16 rect on the blue half', { x: 0.6, y: 0, w: 202 / 1280, h: 1, aspect: '9:16' }, BLUE, 202, 360],
  ] as const) {
    const r = await process1(admin, `vrect-${w}-${tag}.mp4`, vidHalves, 'video/mp4', { crop });
    const th = r.item?.status === 'ready' ? (await raw(`/api/media/${r.item.id}/thumbnail`, admin)).buf : null;
    const p = r.file.length ? await probe(r.file) : null;
    const ok = th ? all(await corners(th), want, 60) : false;
    check(`video ${label} → ${w}×${h}`, ok && p?.width === w && p?.height === h && r.item.width === w && r.item.height === h, `${r.item?.status} ${p?.width}×${p?.height} ${r.item?.error ?? ''}`);
  }
  const vw = await process1(admin, `webm-${tag}.webm`, webm, 'video/webm', { quality: 'medium', crop: { aspect: '1:1' } });
  const pw = vw.file.length ? await probe(vw.file) : null;
  check('WebM (VP9/Opus) 1:1 → 480×480 MP4 H.264/AAC, mime video/mp4, key .mp4', vw.item?.status === 'ready' && vw.item.mimeType === 'video/mp4' && pw?.vcodec === 'h264' && pw.acodec === 'aac' && /mp4/.test(pw.format) && vw.row.fileKey.endsWith('.mp4') && pw.width === 480 && pw.height === 480,
    `${vw.item?.status} ${vw.item?.mimeType} ${pw?.vcodec}/${pw?.acodec} ${vw.row?.fileKey?.split('/').pop()} ${vw.item?.error ?? ''}`);
  const dl = await raw(`/api/media/${vw.item?.id}/content?download=1`, admin);
  check('download name uses the new extension', /\.mp4"/.test(dl.headers.get('content-disposition') ?? ''), dl.headers.get('content-disposition') ?? '');

  // ---------- failure: corrupt image passes magic bytes but can't be decoded
  const before = ownerFiles(adminId);
  const corrupt = Buffer.concat([small.subarray(0, 200), randomBytes(2000)]);
  const bad = await process1(admin, `corrupt-${tag}.jpg`, corrupt, 'image/jpeg', { crop: { aspect: '1:1' } });
  const [task] = bad.item ? await db.select().from(schema.tasks).where(eq(schema.tasks.refId, bad.item.id)) : [];
  check('undecodable image with options → failed with a reason', bad.item?.status === 'failed' && Boolean(bad.item.error), `${bad.item?.status} ${bad.item?.error?.slice(0, 80)}`);
  check('failed task carries an error code', task?.status === 'failed' && Boolean(task.errorCode), `${task?.status} ${task?.errorCode}`);
  const after = ownerFiles(adminId);
  check('failure leaves only the original upload (no half-written file, no thumbnail)', after.length === before.length + 1 && after.includes(bad.row.fileKey) && bad.row.thumbnailKey === null && bad.row.processing?.result === undefined,
    `${before.length} → ${after.length}`);
} finally {
  for (const id of created) {
    const d = await http('DELETE', `/api/media/${id}`, admin);
    if (d.status !== 204 && d.status !== 404) check(`cleanup: delete media ${id}`, false, `${d.status}`);
  }
  const left = ownerFiles(adminId);
  check('cleanup: no test files left in the admin\'s private media', left.length === 0, `${left.length}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await sqlClient.end();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
