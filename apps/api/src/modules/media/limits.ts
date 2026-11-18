import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { FORMATS } from './formats.js';

/**
 * 素材上传限制 (系统配置 → 素材上传, admin; settings key `media.limits`): size limit per kind and the allowed formats.
 * The env values MEDIA_IMAGE_MAX_MB / MEDIA_VIDEO_MAX_MB / MEDIA_ALLOWED_TYPES are the defaults; a saved field wins
 * (an invalid stored field falls back to its default). Read at every upload and by GET /api/media/limits with a
 * short in-process cache (a save is effective at once in the saving process, within CACHE_MS elsewhere).
 * The multipart size limit of the upload route follows these values (formats.ts maxBytes); MAX_*_MB are hard ceilings.
 */
export const MEDIA_LIMITS_KEY = 'media.limits';
const CACHE_MS = 5_000;
export const MAX_IMAGE_MB = 100;
export const MAX_VIDEO_MB = 4096;
/** Every format the validator knows (extension + MIME + magic bytes): allowedTypes is a subset of these. */
export const MEDIA_TYPE_IDS = FORMATS.map((f) => f.id) as [string, ...string[]];

/** Sorted in FORMATS order, de-duplicated. */
const normTypes = (ids: string[]) => MEDIA_TYPE_IDS.filter((id) => ids.includes(id));

export const MediaLimitsInput = z.object({
  imageMaxMb: z.number().int().min(1).max(MAX_IMAGE_MB),
  videoMaxMb: z.number().int().min(1).max(MAX_VIDEO_MB),
  allowedTypes: z.array(z.enum(MEDIA_TYPE_IDS)).min(1).max(20).transform(normTypes),
}).strict();
export type MediaLimitSettings = { imageMaxMb: number; videoMaxMb: number; allowedTypes: string[] };

export const mediaLimitDefaults = (): MediaLimitSettings => ({
  imageMaxMb: config.MEDIA_IMAGE_MAX_MB,
  videoMaxMb: config.MEDIA_VIDEO_MAX_MB,
  allowedTypes: normTypes(config.MEDIA_ALLOWED_TYPES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
});

let cache: { at: number; value: MediaLimitSettings & { updatedAt: string | null } } | null = null;

export async function getMediaLimitSettings(fresh = false): Promise<MediaLimitSettings & { updatedAt: string | null }> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, MEDIA_LIMITS_KEY));
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  const d = mediaLimitDefaults();
  const pick = <K extends keyof MediaLimitSettings>(k: K): MediaLimitSettings[K] => {
    if (!(k in stored)) return d[k];
    const r = MediaLimitsInput.shape[k].safeParse(stored[k]);
    return r.success ? (r.data as MediaLimitSettings[K]) : d[k];
  };
  const value = { imageMaxMb: pick('imageMaxMb'), videoMaxMb: pick('videoMaxMb'), allowedTypes: pick('allowedTypes'), updatedAt: row ? row.updatedAt.toISOString() : null };
  cache = { at: Date.now(), value };
  return value;
}

export async function saveMediaLimitSettings(input: z.infer<typeof MediaLimitsInput>) {
  await db.insert(schema.settings).values({ key: MEDIA_LIMITS_KEY, value: input })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: input, updatedAt: new Date() } });
  cache = null;
  return getMediaLimitSettings(true);
}
