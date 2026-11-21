import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().default(3000),
  /** Listen address. Production containers use host networking and keep it on loopback behind the reverse proxy. */
  API_HOST: z.string().default('127.0.0.1'),
  /**
   * Background work (task workers, monitor + BitBrowser tunnels, schedulers): `always` = this process runs it
   * (dev, single process); `leader` = only the process holding the Redis leader lease runs it (blue-green
   * deploys, see lib/leader.ts and docs/10-deployment.md).
   */
  BACKGROUND_WORK: z.enum(['always', 'leader']).default('always'),
  /** Set by the deployment (deploy/): shown by /api/ready and in the leader lease. */
  APP_VERSION: z.string().optional(),
  DEPLOY_COLOR: z.string().optional(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  /**
   * Slider puzzle captcha on login (modules/auth/captcha.ts). `on` (default) everywhere, dev included;
   * `off` only for special deployments (e.g. behind an SSO gateway that already guards the login).
   * Challenges live LOGIN_CAPTCHA_TTL_SEC in Redis; GET /api/auth/captcha allows LOGIN_CAPTCHA_RATE
   * challenges per client IP and minute.
   */
  LOGIN_CAPTCHA: z.enum(['on', 'off']).default('on'),
  LOGIN_CAPTCHA_TTL_SEC: z.coerce.number().int().min(10).max(900).default(120),
  LOGIN_CAPTCHA_RATE: z.coerce.number().int().min(1).default(60),

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
  /**
   * Social platforms switched on (comma list of platform ids, or `all`). Every platform's code stays in the
   * registries; a disabled one is left out of option lists, refused for anything new (platform.disabled)
   * and skipped by the schedulers. Existing rows stay readable. Default instagram + youtube (owner 2026-11-21
   * 「可以再加入youtube支持」: the existing YouTube code, no cloud-phone automation for it).
   */
  ENABLED_PLATFORMS: z.string().default('instagram,youtube'),
  /** Tracked accounts: YouTube Data API v3 base URL (override only for a compatible test endpoint). The key lives in settings. */
  YOUTUBE_API_BASE: z.string().url().default('https://www.googleapis.com/youtube/v3'),
  /**
   * Tracked accounts read on their 采集手机 (Instagram app): pace per device. At least this many
   * seconds between two profile visits, at most this many visits per rolling hour; refreshes over the
   * limit are deferred (a new scheduled task), never dropped.
   */
  TRACKED_DEVICE_MIN_INTERVAL_SEC: z.coerce.number().int().min(1).max(3600).default(30),
  TRACKED_DEVICE_MAX_PER_HOUR: z.coerce.number().int().min(1).max(600).default(60),
  /** Someone is viewing/controlling the phone: the refresh is deferred by this many seconds. */
  TRACKED_DEVICE_BUSY_RETRY_SEC: z.coerce.number().int().min(5).max(86_400).default(300),
  /** Public URL of the web UI (reverse proxy), used for links in alert messages (default: WEB_ORIGIN). */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /**
   * Publish scheduler: default timeout of a round's single attempt (系统配置 → 发布任务 overrides it). No retries since
   * 2026-11-18: PUBLISH_MAX_ATTEMPTS / PUBLISH_RETRY_BACKOFF_MS are no longer read (left in an .env they are ignored).
   */
  PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10 * 60_000),
  /**
   * System management (modules/system). Database backups run `${PG_DUMP_CMD} --format=custom …` with the
   * password only in PGPASSWORD (never argv). PG_DUMP_CMD is split on spaces; its major version must be ≥ the
   * server's, e.g. `env -u DOCKER_HOST docker exec -i -e PGPASSWORD cloudphone-dev-postgres-1 pg_dump` (dev).
   */
  PG_DUMP_CMD: z.string().min(1).default('pg_dump'),
  /**
   * 导入 (restore a backup) runs `${PG_RESTORE_CMD} --clean --if-exists --no-owner --single-transaction` the same
   * way. Unset = PG_DUMP_CMD with its trailing `pg_dump` replaced by `pg_restore` (modules/system/restore.ts).
   */
  PG_RESTORE_CMD: z.string().min(1).optional(),
  /** API log files (one per UTC day, retention in settings) and the in-memory ring of recent lines. */
  LOG_DIR: z.string().default('var/logs'),
  LOG_RING_SIZE: z.coerce.number().int().min(100).max(100_000).default(5000),
  /** Alerts: Telegram Bot API base URL (override only for a compatible test endpoint). Token and chat id live in settings. */
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  /** Registers the test-only task types used by scripts/tasks-check.ts. Never set in normal runs. */
  TASKS_TEST_HANDLERS: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export const config = Env.parse(process.env);
export type Config = typeof config;
