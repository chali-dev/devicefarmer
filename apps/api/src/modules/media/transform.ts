import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../../config.js';
import type { MediaCropAspect, MediaFileFacts, MediaProcessOptions } from '../../db/schema.js';
import { PROCESSABLE, type MediaFormat } from './formats.js';
import { probeVideo, SHARP_INPUT, stderrOf } from './process.js';

const run = promisify(execFile);

/**
 * Optional crop/compress at upload (multipart field `process`, JSON). Runs server-side in the
 * media-process job with the tools already used for thumbnails: sharp for images (format kept),
 * ffmpeg for videos (always MP4/H.264 + AAC, +faststart). Absent/empty = stored as uploaded.
 */
export const ASPECTS: Record<MediaCropAspect, number | null> = { original: null, '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9, '1.91:1': 1.91 };

export const ProcessOptionsSchema = z.object({
  crop: z.object({
    aspect: z.enum(Object.keys(ASPECTS) as [MediaCropAspect, ...MediaCropAspect[]]),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.5),
  }).strict().optional(),
  maxSize: z.union([z.literal(1080), z.literal(720)]).optional(),
  quality: z.enum(['high', 'medium', 'low']).optional(),
}).strict();

/** Drops no-op parts; null when nothing is left to do. */
export function normalizeOptions(o: z.infer<typeof ProcessOptionsSchema>): MediaProcessOptions | null {
  const out: MediaProcessOptions = {};
  if (o.crop && o.crop.aspect !== 'original') out.crop = { aspect: o.crop.aspect, x: o.crop.x, y: o.crop.y };
  if (o.maxSize) out.maxSize = o.maxSize;
  if (o.quality) out.quality = o.quality;
  return Object.keys(out).length ? out : null;
}

export interface Box { x: number; y: number; w: number; h: number }

/** Largest box of the preset's aspect inside w×h, centred on (cx, cy) and clamped to the source. */
export function cropBox(w: number, h: number, crop: MediaProcessOptions['crop'], even = false): Box {
  const r = crop ? ASPECTS[crop.aspect] : null;
  let bw = w, bh = h;
  if (r) {
    if (w / h > r) bw = Math.round(h * r); else bh = Math.round(w / r);
  }
  if (even) { bw -= bw % 2; bh -= bh % 2; }
  bw = Math.max(even ? 2 : 1, Math.min(bw, w)); bh = Math.max(even ? 2 : 1, Math.min(bh, h));
  const cx = crop?.x ?? 0.5, cy = crop?.y ?? 0.5;
  const x = Math.min(Math.max(Math.round(cx * w - bw / 2), 0), w - bw);
  const y = Math.min(Math.max(Math.round(cy * h - bh / 2), 0), h - bh);
  return { x, y, w: bw, h: bh };
}

/** Shorter side ≤ maxSize and longer side ≤ 2 × maxSize, never upscaled. */
export function targetSize(w: number, h: number, maxSize: number | undefined, even = false): { w: number; h: number } {
  const s = maxSize ? Math.min(1, maxSize / Math.min(w, h), (2 * maxSize) / Math.max(w, h)) : 1;
  let tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  if (even) { tw = Math.max(2, 2 * Math.round(tw / 2)); th = Math.max(2, 2 * Math.round(th / 2)); }
  return { w: tw, h: th };
}

export interface TransformResult {
  before: MediaFileFacts;
  /** false: the result wasn't smaller and nothing visible changed, so keep the upload. */
  replaced: boolean;
  mime: string;
  ext: string;
}

const IMAGE_Q = { high: 90, medium: 80, low: 65 } as const;
const VIDEO_CRF = { high: 20, medium: 24, low: 28 } as const;
/** Keeps a runaway ffmpeg below the task timeout (15 min). */
const FFMPEG_TIMEOUT_MS = 14 * 60_000;

export async function transformMedia(format: MediaFormat, file: string, out: string, o: MediaProcessOptions, signal?: AbortSignal): Promise<TransformResult> {
  if (!PROCESSABLE.has(format.id)) throw new Error(`processing not supported for ${format.id}`);
  const r = format.kind === 'image' ? await transformImage(format, file, out, o) : await transformVideo(format, file, out, o, signal);
  const size = (await fs.promises.stat(out)).size;
  if (size === 0) throw new Error('processing produced an empty file');
  if (!r.changed && size >= r.before.size) return { before: r.before, replaced: false, mime: format.mime, ext: format.exts[0]! };
  return { before: r.before, replaced: true, mime: r.mime, ext: r.ext };
}

async function transformImage(format: MediaFormat, file: string, out: string, o: MediaProcessOptions) {
  const meta = await sharp(file, SHARP_INPUT).metadata();
  if (!meta.width || !meta.height) throw new Error('image has no dimensions');
  if ((meta.pages ?? 1) > 1) throw new Error('animated images cannot be processed');
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? meta.height : meta.width, H = swap ? meta.width : meta.height;
  const box = cropBox(W, H, o.crop);
  const t = targetSize(box.w, box.h, o.maxSize);
  let img = sharp(file, SHARP_INPUT).rotate();
  const cropped = box.w !== W || box.h !== H;
  if (cropped) img = img.extract({ left: box.x, top: box.y, width: box.w, height: box.h });
  const resized = t.w !== box.w || t.h !== box.h;
  if (resized) img = img.resize(t.w, t.h, { fit: 'fill' });
  const q = o.quality ?? 'high';
  if (format.id === 'jpeg') img = img.jpeg({ quality: IMAGE_Q[q], mozjpeg: true });
  else if (format.id === 'webp') img = img.webp({ quality: IMAGE_Q[q], effort: 4 });
  else img = q === 'high' ? img.png({ compressionLevel: 9, effort: 7 }) : img.png({ palette: true, quality: q === 'medium' ? 90 : 65, effort: 7 });
  await img.toFile(out);
  const before: MediaFileFacts = { size: (await fs.promises.stat(file)).size, width: W, height: H, mime: format.mime };
  return { before, changed: cropped || resized, mime: format.mime, ext: format.exts[0]! };
}

async function transformVideo(format: MediaFormat, file: string, out: string, o: MediaProcessOptions, signal?: AbortSignal) {
  const p = await probeVideo(file);
  const W = p.width, H = p.height;
  const box = cropBox(W, H, o.crop, true);
  const t = targetSize(box.w, box.h, o.maxSize, true);
  const cropped = box.w !== W || box.h !== H;
  const resized = t.w !== box.w || t.h !== box.h;
  // ffmpeg auto-rotates before filtering, so the filters work on displayed dimensions.
  const vf = [
    ...(cropped ? [`crop=${box.w}:${box.h}:${box.x}:${box.y}`] : []),
    ...(resized ? [`scale=${t.w}:${t.h}:flags=lanczos`] : []),
    'setsar=1', 'format=yuv420p',
  ].join(',');
  const q = o.quality ?? 'high';
  const audio = p.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'];
  try {
    await run(config.FFMPEG_PATH, [
      '-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-vf', vf, '-c:v', 'libx264', '-crf', String(VIDEO_CRF[q]), '-preset', 'medium', '-profile:v', 'high',
      ...audio, '-movflags', '+faststart', '-f', 'mp4', '-y', out,
    ], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal });
  } catch (err) {
    throw new Error(`ffmpeg transcode failed: ${stderrOf(err)}`);
  }
  const before: MediaFileFacts = { size: (await fs.promises.stat(file)).size, width: W, height: H, mime: format.mime, duration: p.duration };
  return { before, changed: cropped || resized, mime: 'video/mp4', ext: 'mp4' };
}
