import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config } from '../../config.js';
import type { MediaKind } from './formats.js';

const run = promisify(execFile);

/** Longest side of generated thumbnails / video covers. */
export const THUMB_SIZE = 480;

export interface MediaInfo { width: number | null; height: number | null; duration: number | null }

/**
 * Reads metadata and writes a JPEG thumbnail (image: scaled copy; video: a frame as cover).
 * Throws with a readable reason when the file can't be decoded (the asset becomes 'failed').
 */
export async function analyzeMedia(kind: MediaKind, file: string, thumbOut: string): Promise<MediaInfo> {
  return kind === 'image' ? analyzeImage(file, thumbOut) : analyzeVideo(file, thumbOut);
}

async function analyzeImage(file: string, thumbOut: string): Promise<MediaInfo> {
  // Large decode limit is fine: the upload size is capped (MEDIA_IMAGE_MAX_MB).
  const img = sharp(file, { failOn: 'error', limitInputPixels: 268_402_689 });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('image has no dimensions');
  // EXIF orientations 5..8 are rotated by 90°: report the displayed size.
  const swap = (meta.orientation ?? 1) >= 5;
  await sharp(file, { failOn: 'error', limitInputPixels: 268_402_689 })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(thumbOut);
  return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height, duration: null };
}

interface Probe {
  streams?: { codec_type?: string; width?: number; height?: number; duration?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
  format?: { duration?: string };
}

async function analyzeVideo(file: string, thumbOut: string): Promise<MediaInfo> {
  let probe: Probe;
  try {
    const { stdout } = await run(config.FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    probe = JSON.parse(stdout) as Probe;
  } catch (err) {
    throw new Error(`ffprobe failed: ${stderrOf(err)}`);
  }
  const v = probe.streams?.find((s) => s.codec_type === 'video');
  if (!v || !v.width || !v.height) throw new Error('no video stream found');
  const rotation = Math.abs(Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
  const durRaw = Number(probe.format?.duration ?? v.duration);
  const duration = Number.isFinite(durRaw) && durRaw > 0 ? Math.round(durRaw * 1000) / 1000 : null;
  // Cover frame: 1 s in (or 10 % of short clips), falling back to the first frame.
  const at = duration ? Math.min(1, duration * 0.1) : 0;
  for (const seek of at > 0 ? [at, 0] : [0]) {
    await fs.promises.rm(thumbOut, { force: true });
    try {
      await run(config.FFMPEG_PATH, [
        '-v', 'error', '-nostdin', '-ss', String(seek), '-i', file, '-frames:v', '1', '-an',
        '-vf', `scale=w='min(${THUMB_SIZE},iw)':h='min(${THUMB_SIZE},ih)':force_original_aspect_ratio=decrease`,
        '-q:v', '4', '-f', 'image2', '-y', thumbOut,
      ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      if (seek === 0) throw new Error(`ffmpeg cover failed: ${stderrOf(err)}`);
      continue;
    }
    const st = await fs.promises.stat(thumbOut).catch(() => null);
    if (st && st.size > 0) break;
    if (seek === 0) throw new Error('ffmpeg produced no cover frame');
  }
  return { width: rotation === 90 ? v.height : v.width, height: rotation === 90 ? v.width : v.height, duration };
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: string; message?: string; code?: string };
  if (e.code === 'ENOENT') return `${e.message} (set FFMPEG_PATH / FFPROBE_PATH)`;
  return (e.stderr || e.message || String(err)).trim().split('\n').slice(-3).join(' ').slice(0, 300);
}
