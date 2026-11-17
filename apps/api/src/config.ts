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
  /**
   * External phones (device sources, e.g. BitBrowser cloud phones; configured in the UI): each one's
   * adbd is made reachable on EXTERNAL_ADB_BIND:<port from this range> by the API (SSH tunnel, TCP
   * forward), which STF's adb server must reach as ADB_DEVICE_HOST:<port>.
   */
  EXTERNAL_ADB_PORT_MIN: z.coerce.number().int().default(5700),
  EXTERNAL_ADB_PORT_MAX: z.coerce.number().int().default(5799),
  EXTERNAL_ADB_BIND: z.string().default('127.0.0.1'),
  /** ssh known_hosts for the BitBrowser ADB gateways (trust on first use). */
  BITBROWSER_KNOWN_HOSTS: z.string().default('var/bitbrowser_known_hosts'),
  SSH_PATH: z.string().default('ssh'),

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
  /**
   * scrcpy remote-control source: official scrcpy-server (infra/device-tools/scrcpy/fetch.sh). Its version
   * must equal SCRCPY_VERSION in adapters/scrcpy.ts. Video size (long edge), fps cap and H.264 bit rate.
   */
  SCRCPY_SERVER_PATH: z.string().default('../../infra/device-tools/scrcpy/out/scrcpy-server-v5.0.1'),
  SCRCPY_MAX_SIZE: z.coerce.number().int().min(0).default(1280),
  SCRCPY_MAX_FPS: z.coerce.number().int().min(1).max(120).default(30),
  SCRCPY_BIT_RATE: z.coerce.number().int().min(100_000).default(4_000_000),
  /**
   * For external phones behind a tunnel (BitBrowser). One adb stream there carries ~100 KB/s (~0.8 Mb/s:
   * adb has one write in flight per stream and the tunnel's round trip is ~0.3 s), and the video is one
   * stream: a higher bit rate backs up the encoder and the frame rate collapses on moving content.
   */
  SCRCPY_BIT_RATE_EXTERNAL: z.coerce.number().int().min(100_000).default(600_000),
  /** Periodic key frame interval for external phones, seconds (scrcpy default 10). */
  SCRCPY_KEY_INTERVAL_EXTERNAL_S: z.coerce.number().int().min(1).max(600).default(60),
  /**
   * Experimental relay for external phones: the device helper (infra/device-tools/relay) carries the
   * scrcpy sockets over a WebSocket to this public URL instead of adb (e.g. wss://<name>.ngrok-free.dev/scrcpy-relay
   * forwarded to SCRCPY_RELAY_PORT). Unset = off. Falls back to adb when the relay doesn't connect.
   */
  // URL-safe characters only: it is passed on the device's shell command line
  SCRCPY_RELAY_URL: z.string().regex(/^wss?:\/\/[\w.\-]+(:\d+)?(\/[\w.\-/]*)?$/).optional(),
  /** Local port of the relay listener (127.0.0.1 only; expose just this port, never the API). */
  SCRCPY_RELAY_PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  SCRCPY_RELAY_DEX_PATH: z.string().default('../../infra/device-tools/relay/out/cprelay.dex'),
  /** Bit rate over the relay (plain TCP carries several Mb/s where adb carried ~0.8). */
  SCRCPY_BIT_RATE_RELAY: z.coerce.number().int().min(100_000).default(2_000_000),
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
  /** Tracked accounts: YouTube Data API v3 base URL (override only for a compatible test endpoint). The key lives in settings. */
  YOUTUBE_API_BASE: z.string().url().default('https://www.googleapis.com/youtube/v3'),
  /**
   * Official platform integrations (modules/platforms). OAuth redirect URIs are
   * `${PUBLIC_BASE_URL}/api/platforms/<platform>/callback` (default: WEB_ORIGIN, whose /api is the API).
   * Meta and TikTok only accept https redirect URIs, Google also allows http://localhost.
   * The endpoints are overridable for a compatible test endpoint only.
   */
  PUBLIC_BASE_URL: z.string().url().optional(),
  GOOGLE_OAUTH_AUTH_URL: z.string().url().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_OAUTH_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  GOOGLE_OAUTH_REVOKE_URL: z.string().url().default('https://oauth2.googleapis.com/revoke'),
  YOUTUBE_UPLOAD_BASE: z.string().url().default('https://www.googleapis.com/upload/youtube/v3'),
  /** 账号分析: YouTube Analytics API v2 (per-day channel metrics). */
  YOUTUBE_ANALYTICS_BASE: z.string().url().default('https://youtubeanalytics.googleapis.com/v2'),
  INSTAGRAM_AUTH_URL: z.string().url().default('https://www.instagram.com/oauth/authorize'),
  INSTAGRAM_TOKEN_URL: z.string().url().default('https://api.instagram.com/oauth/access_token'),
  /** Unversioned = the app's default Graph API version; set e.g. https://graph.instagram.com/v24.0 to pin one. */
  INSTAGRAM_GRAPH_BASE: z.string().url().default('https://graph.instagram.com'),
  TIKTOK_AUTH_URL: z.string().url().default('https://www.tiktok.com/v2/auth/authorize/'),
  TIKTOK_API_BASE: z.string().url().default('https://open.tiktokapis.com'),
  /** Lifetime of presigned media URLs handed to platforms that fetch media by URL (Instagram). */
  PLATFORM_MEDIA_URL_TTL_SEC: z.coerce.number().int().min(300).max(7 * 86400).default(3600),
  /** Publish scheduler: default attempts per scheduled run (a distribution may lower/raise it, 1–10), attempt timeout and retry backoff base. */
  PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10 * 60_000),
  PUBLISH_RETRY_BACKOFF_MS: z.coerce.number().int().min(100).default(30_000),
  /** Registers the test-only task types used by scripts/tasks-check.ts. Never set in normal runs. */
  TASKS_TEST_HANDLERS: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export const config = Env.parse(process.env);
export type Config = typeof config;
