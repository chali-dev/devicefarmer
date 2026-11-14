import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  DOCKER_HOST: z.string().default('unix:///var/run/docker.sock'),
  REDROID_IMAGE: z.string().default('redroid/redroid:12.0.0_64only-latest'),
  /** Redroid 13 + official MindTheGapps, built locally (see infra/redroid-gapps). */
  REDROID_GAPPS_IMAGE: z.string().default('cloudphone/redroid:13-mtg-20231025'),
  /** Android 16 + official MindTheGapps 16 (infra/redroid-gapps/build.sh ANDROID=16) */
  REDROID16_GAPPS_IMAGE: z.string().default('cloudphone/redroid:16-mtg-20261023'),
  /** Image produced by google/android-emulator-container-scripts (google_apis_playstore). Unset = profile unavailable. */
  EMULATOR_IMAGE: z.string().optional(),
  /** Network sidecar image (per-instance proxy, kill switch). Pinned. */
  SINGBOX_IMAGE: z.string().default('ghcr.io/sagernet/sing-box:v1.14.4'),
  /** Where the emulator image keeps its AVD (persisted per instance). */
  EMULATOR_DATA_PATH: z.string().default('/android-home'),
  /** Private key of the STF adb server, handed to Play Store emulator images (ADBKEY). */
  EMULATOR_ADBKEY_PATH: z.string().optional(),
  INSTANCE_DATA_ROOT: z.string().default('/srv/cloudphone/instances'),
  ADB_PORT_MIN: z.coerce.number().int().default(5555),
  ADB_PORT_MAX: z.coerce.number().int().default(5604),
  ADB_DEVICE_HOST: z.string().default('host.docker.internal'),

  STF_URL: z.string().url(),
  STF_WS_URL: z.string().url(),
  STF_ADB_HOST: z.string().default('127.0.0.1'),
  STF_ADB_PORT: z.coerce.number().int().default(5037),
  STF_SERVICE_EMAIL: z.string().email(),
  STF_SERVICE_NAME: z.string().default('cloudphone-svc'),
  /** Rewrites the host of STF screen URLs when the API can't reach STF's public host (e.g. inside compose). */
  STF_SCREEN_HOST: z.string().optional(),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  MAX_APK_MB: z.coerce.number().int().default(500),
  UPLOAD_DIR: z.string().default('var/uploads'),
  /** Secure-window capture helper (infra/device-tools/capture/build.sh) */
  CAPTURE_DEX_PATH: z.string().default('../../infra/device-tools/capture/out/cpcapture.dex'),
  /** App library storage (imported official APKs). Not cleaned up automatically. */
  LIBRARY_DIR: z.string().default('var/library'),
  /** Asset library (素材库): local storage backend directory. The active backend is chosen in settings. */
  ASSET_DIR: z.string().default('var/assets'),
  /** Media library (素材) limits, enforced by the API (GET /api/media/limits tells the UI). */
  MEDIA_IMAGE_MAX_MB: z.coerce.number().positive().default(20),
  MEDIA_VIDEO_MAX_MB: z.coerce.number().positive().default(500),
  /** Comma-separated subset of: jpeg,png,webp,gif,heic,mp4,mov,webm (heic needs a libvips build with HEVC). */
  MEDIA_ALLOWED_TYPES: z.string().default('jpeg,png,webp,gif,mp4,mov,webm'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  /** Audit log (操作日志) entries older than this are deleted at startup and daily. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
});

export const config = Env.parse(process.env);
export type Config = typeof config;
