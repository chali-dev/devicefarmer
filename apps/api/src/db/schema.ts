import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'user']);

/**
 * Phone lifecycle (power through its source) and device state (adb/STF) are tracked separately:
 * `status` is what the platform is doing/observed at power level,
 * `adbState` / `bootCompleted` / `stfReady` are device-level observations.
 */
export const instanceStatusEnum = pgEnum('instance_status', [
  'creating', 'starting', 'running', 'stopping', 'stopped', 'restarting', 'deleting', 'error',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull().default('user'),
  disabled: boolean('disabled').notNull().default(false),
  /** The seeded ADMIN_USERNAME account: cannot be deleted, disabled or demoted. */
  builtin: boolean('builtin').notNull().default(false),
  displayName: text('display_name'),
  email: text('email'),
  /**
   * 自定义角色 (权限管理, owner decision 2026-11-18): only meaningful when role = 'user'; null = 普通用户 (menus from the
   * `rbac.userMenus` setting). A custom role only changes which grantable menus the user sees, never the data scope.
   * RESTRICT: a role in use cannot be deleted (the API answers 409 role.in_use first).
   */
  roleId: uuid('role_id').references((): AnyPgColumn => roles.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('users_role_id_idx').on(t.roleId)]);

/** 自定义角色 (modules/auth/roles.ts): a variant of the `user` role with its own set of grantable menus. */
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  menus: text('menus').array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('roles_name_lower').on(sql`lower(${t.name})`)]);

export const instances = pgTable('instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Device source type (= the source's `type`); every device is an external phone since redroid was removed (2026-11-20). */
  engine: text('engine', { enum: ['bitbrowser'] }).notNull(),
  /**
   * The phone's device source (e.g. a BitBrowser client) and its id there. `adb_port` is the local end of the
   * connection the API keeps to the phone's adbd.
   */
  sourceId: uuid('source_id').notNull().references((): AnyPgColumn => deviceSources.id, { onDelete: 'restrict' }),
  externalId: text('external_id').notNull(),
  adbPort: integer('adb_port').notNull().unique(),
  /** Egress as the phone sees it (measured on the phone over adb: monitor / per-device check). */
  proxyStatus: jsonb('proxy_status').$type<ProxyStatus>(),
  status: instanceStatusEnum('status').notNull().default('creating'),
  adbState: text('adb_state'),
  bootCompleted: boolean('boot_completed').notNull().default(false),
  stfReady: boolean('stf_ready').notNull().default(false),
  lastError: text('last_error'),
  spec: jsonb('spec').$type<InstanceSpec>().notNull(),
  /**
   * Social platforms allowed on this device (ids from social/platforms.ts); null = all. Checked when an
   * account is linked and before each publish run. Accounts already linked stay linked when a platform
   * is turned off (their publish runs then fail with publish.platform_disabled).
   */
  allowedPlatforms: text('allowed_platforms').array(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [unique('instances_source_external_unique').on(t.sourceId, t.externalId)]);

/**
 * Device sources (设备来源, admin-managed): where external phones come from, e.g. one BitBrowser
 * client (config `{ apiUrl }`). The driver per `type` lives in modules/sources. A source with
 * devices can't be deleted (restrict).
 */
export const deviceSources = pgTable('device_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type', { enum: ['bitbrowser'] }).notNull(),
  name: text('name').notNull().unique(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
});
export type DeviceSource = typeof deviceSources.$inferSelect;

export const instanceGrants = pgTable('instance_grants', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  instanceId: uuid('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.userId, t.instanceId] })]);

/**
 * Task centre (任务中心): the single scheduling table for every background job (device ops, media
 * processing, and later publish/comment/account-check/tracking jobs). Business tables keep business
 * data; this table keeps scheduling state. Rows are written only through modules/tasks/core.ts.
 * Lifecycle: pending | scheduled (run_at in the future) → running → success | failed | cancelled.
 * A failed attempt with attempts left goes back to pending (BullMQ backoff). `error` / `error_code`
 * hold the last error. `created_by` is the owner (null = system).
 */
export const TASK_STATUSES = ['pending', 'scheduled', 'running', 'success', 'failed', 'cancelled'] as const;
export const TASK_FINAL: readonly TaskStatus[] = ['success', 'failed', 'cancelled'];
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  instanceId: uuid('instance_id'),
  /** Display label (device name · detail, or e.g. the media name for device-less tasks). */
  instanceName: text('instance_name'),
  /** What the task works on besides a device, e.g. ref_type 'media' + the media asset id (push-asset, media-process). */
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  status: text('status', { enum: TASK_STATUSES }).notNull().default('pending'),
  /** Handler input. Never put secrets here (it is shown in the task centre); pass ids and resolve secrets in the handler. */
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  result: jsonb('result').$type<unknown>(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(1),
  timeoutMs: integer('timeout_ms'),
  priority: integer('priority').notNull().default(0),
  /** Unique per type (see tasks_idem_idx): creating again with the same key returns the existing task. */
  idempotencyKey: text('idempotency_key'),
  /** Manual retry of a failed/cancelled task creates a new task pointing at the original. */
  retryOf: uuid('retry_of'),
  runAt: timestamp('run_at', { withTimezone: true }),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  /** Last error (message) and its stable code (e.g. task.timeout, task.interrupted). */
  error: text('error'),
  errorCode: text('error_code'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  index('tasks_ref_idx').on(t.refType, t.refId),
  index('tasks_status_idx').on(t.status, t.createdAt),
  index('tasks_type_idx').on(t.type, t.createdAt),
  index('tasks_created_by_idx').on(t.createdBy, t.createdAt),
  index('tasks_instance_idx').on(t.instanceId, t.createdAt),
  index('tasks_created_at_idx').on(t.createdAt),
  index('tasks_run_at_idx').on(t.runAt),
  uniqueIndex('tasks_idem_idx').on(t.type, t.idempotencyKey).where(sql`idempotency_key is not null`),
]);

/** Execution log of a task: every status transition and attempt, plus handler messages (ctx.log). */
export const taskLogs = pgTable('task_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull(),
  message: text('message').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
}, (t) => [index('task_logs_task_idx').on(t.taskId, t.ts)]);

/**
 * App library: official packages imported from a device where they were installed
 * (e.g. from Google Play) or uploaded, installed on other devices by hand.
 */
export const libraryApps = pgTable('library_apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  package: text('package').notNull(),
  versionName: text('version_name'),
  versionCode: text('version_code').notNull(),
  files: jsonb('files').$type<{ name: string; size: number; sha256: string }[]>().notNull(),
  sourceInstance: text('source_instance'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('library_pkg_version').on(t.package, t.versionCode)]);

/**
 * 必装应用 (modules/library/required.ts, owner 2026-11-20): apps every phone of a device source type must have, per
 * `source_type` (= device_sources.type; only 'bitbrowser' today, another vendor = its own rows). When a phone is
 * added or powered on, adb checks `package`; a missing one is installed from that source's app store by
 * `store_app_id` (BitBrowser: the app's id in its app store). Unique per source type + package.
 */
export const requiredApps = pgTable('required_apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceType: text('source_type', { enum: ['bitbrowser'] }).notNull(),
  package: text('package').notNull(),
  name: text('name').notNull(),
  storeAppId: text('store_app_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [unique('required_apps_source_package_unique').on(t.sourceType, t.package)]);
export type RequiredApp = typeof requiredApps.$inferSelect;

/** Platform settings (admin). Secrets inside values are encrypted (lib/secret-box.ts). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
});

/**
 * Media library (素材库). Two owners: `public` (managed by admins, used by everyone) and
 * `user` (private to owner_id; admins can see/manage all). Files live on the storage backend
 * recorded in `storage` under public/{images,videos,thumbnails}/ or users/{owner_id}/...,
 * always with random names. Upload stores the file with status 'processing'; the media-process
 * queue job computes metadata + thumbnail and sets 'ready' or 'failed' (`error`).
 * `deleted_at` marks a row whose files are being purged: it is hidden immediately, the files are
 * deleted, then the row (and its tags/favorites, by cascade) is removed. A row that stays with
 * deleted_at set means a storage delete failed; purgeDeletedMedia() retries it.
 */
const ownerCheck = (name: string) => check(name, sql`(owner_type = 'public' and owner_id is null) or (owner_type = 'user' and owner_id is not null)`);

export const mediaCategories = pgTable('media_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerType: text('owner_type', { enum: ['public', 'user'] }).notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  // Same rule as personas / content categories (lib/scoped-list.ts): unique per owner, case-insensitive.
  uniqueIndex('media_categories_owner_name_lower').on(sql`coalesce(${t.ownerId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`),
  ownerCheck('media_categories_owner_chk'),
]);

export type MediaCropAspect = 'original' | '1:1' | '4:5' | '9:16' | '16:9' | '1.91:1';
/** Crop rectangle in 0..1 of the (orientation-corrected) source; `aspect` = preset it is locked to. */
export interface MediaCropRect { x: number; y: number; w: number; h: number; aspect?: MediaCropAspect }
export interface MediaProcessOptions {
  /** A rectangle, or the legacy form: aspect preset with x/y = centre of the largest box of that aspect. */
  crop?: MediaCropRect | { aspect: MediaCropAspect; x: number; y: number };
  /** Shorter side ≤ maxSize (longer side ≤ 2 × maxSize); never upscales. */
  maxSize?: 1080 | 720;
  quality?: 'high' | 'medium' | 'low';
}
export interface MediaFileFacts { size: number; width: number | null; height: number | null; mime: string; duration?: number | null }
export interface MediaProcessing {
  options: MediaProcessOptions;
  /** Set when processing ran. `kept`: the re-encode wasn't smaller and nothing else changed, so the upload was kept. */
  result?: { before: MediaFileFacts; after: MediaFileFacts; kept?: boolean };
}

export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerType: text('owner_type', { enum: ['public', 'user'] }).notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').references(() => mediaCategories.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  /** Original upload name, display only (never used as a storage key or device path as-is). */
  fileName: text('file_name').notNull(),
  storage: text('storage', { enum: ['local', 's3'] }).notNull(),
  fileKey: text('file_key').notNull(),
  thumbnailKey: text('thumbnail_key'),
  fileType: text('file_type', { enum: ['image', 'video'] }).notNull(),
  mimeType: text('mime_type').notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),
  width: integer('width'),
  height: integer('height'),
  /** Seconds (videos). */
  duration: doublePrecision('duration'),
  /** sha256 hex of the file. */
  checksum: text('checksum').notNull(),
  status: text('status', { enum: ['processing', 'ready', 'failed'] }).notNull().default('processing'),
  error: text('error'),
  /** Crop/compress requested at upload (null = stored as uploaded) and, once done, what it did. */
  processing: jsonb('processing').$type<MediaProcessing>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  index('media_assets_owner_idx').on(t.ownerType, t.ownerId),
  index('media_assets_category_idx').on(t.categoryId),
  index('media_assets_status_idx').on(t.status),
  index('media_assets_created_at_idx').on(t.createdAt),
  index('media_assets_checksum_idx').on(t.checksum),
  ownerCheck('media_assets_owner_chk'),
]);

/** Tag names are unique case-insensitively (lower(name) index); the first spelling wins. */
export const mediaTags = pgTable('media_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('media_tags_name_lower_idx').on(sql`lower(${t.name})`)]);

export const mediaAssetTags = pgTable('media_asset_tags', {
  assetId: uuid('asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull().references(() => mediaTags.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.assetId, t.tagId] }), index('media_asset_tags_tag_idx').on(t.tagId)]);

/** Per-user bookmarks of PUBLIC assets (no file copy). */
export const mediaFavorites = pgTable('media_favorites', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('media_favorites_user_asset').on(t.userId, t.assetId), index('media_favorites_asset_idx').on(t.assetId)]);

/**
 * Tracked accounts (追踪账号): external public profiles a user observes. Private per user (admins see all);
 * entirely separate from the user's own managed social accounts. `platform` is a code registry id
 * (modules/tracked/platforms.ts), `handle` its normalised identity (lowercase handle, or a YouTube channel id).
 * Data comes from official APIs (YouTube Data API) or, for Instagram, from reading the profile header in the
 * Instagram app on the account's own 采集手机 `instance_id` (owner decision 2026-11-19: one of the owner's cloud
 * phones, modules/tracked/phone.ts; the former global collector setting was removed).
 * Manual entry was removed; old `manual` rows stay readable.
 */
export const trackedAccounts = pgTable('tracked_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  handle: text('handle').notNull(),
  profileUrl: text('profile_url').notNull(),
  externalId: text('external_id'),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  /** 采集手机: the owner's cloud phone the account is read on (Instagram); null = not set. */
  instanceId: uuid('instance_id').references(() => instances.id, { onDelete: 'set null' }),
  /** Verified badge as last read on the 采集手机 (Instagram); null = unknown. */
  verified: boolean('verified'),
  /** Lowercase, deduplicated. */
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  /** The account is private to its owner, so a favorite is just a flag (no per-user table needed). */
  favorite: boolean('favorite').notNull().default(false),
  status: text('status', { enum: ['active', 'paused', 'error'] }).notNull().default('active'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorCode: text('last_error_code'),
  /** `manual`: legacy rows only (manual entry was removed). `device`: read on the 采集手机. */
  lastSource: text('last_source', { enum: ['api', 'manual', 'device'] }),
  notes: text('notes'),
  /** 定时采集: refresh every N hours (null = off). The hourly collection tick enqueues `tracked-refresh` for due rows. */
  refreshIntervalHours: integer('refresh_interval_hours'),
  /** Next scheduled slot (set when the interval is set, advanced by the tick). */
  nextRefreshAt: timestamp('next_refresh_at', { withTimezone: true }),
  /** Why the last due slot was skipped (error code, e.g. tracked.paused); null when it was queued. */
  scheduleSkipCode: text('schedule_skip_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  unique('tracked_accounts_user_platform_handle').on(t.userId, t.platform, t.handle),
  index('tracked_accounts_next_refresh_idx').on(t.nextRefreshAt).where(sql`refresh_interval_hours is not null`),
  index('tracked_accounts_user_status_idx').on(t.userId, t.status),
  index('tracked_accounts_user_favorite_idx').on(t.userId, t.favorite),
  index('tracked_accounts_tags_idx').using('gin', t.tags),
  index('tracked_accounts_instance_idx').on(t.instanceId),
]);

/** Public counters over time. NULL = not available on that platform / not entered. */
export const trackedAccountSnapshots = pgTable('tracked_account_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackedAccountId: uuid('tracked_account_id').notNull().references(() => trackedAccounts.id, { onDelete: 'cascade' }),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source', { enum: ['api', 'manual', 'device'] }).notNull(),
  followers: bigint('followers', { mode: 'number' }),
  following: bigint('following', { mode: 'number' }),
  posts: bigint('posts', { mode: 'number' }),
  views: bigint('views', { mode: 'number' }),
  /** Metrics that are approximate (the app abbreviated them, e.g. "3.2万" / "12.5K"); null/empty = all exact. */
  approx: text('approx').array(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [index('tracked_snapshots_account_at_idx').on(t.trackedAccountId, t.capturedAt)]);

/** Public posts/videos seen on a tracked account (content update history). */
export const trackedPosts = pgTable('tracked_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackedAccountId: uuid('tracked_account_id').notNull().references(() => trackedAccounts.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  url: text('url'),
  title: text('title'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  views: bigint('views', { mode: 'number' }),
  likes: bigint('likes', { mode: 'number' }),
  comments: bigint('comments', { mode: 'number' }),
  /** `device`: read in the Instagram app on the 采集手机 (modules/feed; externalId = media pk, title = caption). */
  source: text('source', { enum: ['api', 'manual', 'device'] }).notNull(),
  /** Device source: photo | video | carousel as the app labels the post. */
  mediaType: text('media_type'),
  /** Metrics the app abbreviated (likes / comments), like snapshots. */
  approx: text('approx').array(),
  /** Last time its comments were read (device source). */
  commentsFetchedAt: timestamp('comments_fetched_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tracked_posts_account_external').on(t.trackedAccountId, t.externalId),
  index('tracked_posts_account_published_idx').on(t.trackedAccountId, t.publishedAt),
]);

/**
 * Comments under a tracked account's posts as read on the 采集手机 (modules/feed, read only; never
 * replied to). Unique per post + stable id: Instagram shows no comment id, so `external_id` is a hash of
 * post pk + author + normalised text (feed/ig-ui.ts commentKey). `published_at` is approximate (the app shows
 * "11小时前"), set on first sight and kept.
 */
export const trackedPostComments = pgTable('tracked_post_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackedPostId: uuid('tracked_post_id').notNull().references(() => trackedPosts.id, { onDelete: 'cascade' }),
  trackedAccountId: uuid('tracked_account_id').notNull().references(() => trackedAccounts.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  authorHandle: text('author_handle'),
  text: text('text').notNull(),
  likes: integer('likes'),
  replyCount: integer('reply_count'),
  /** Position in the list as the app showed it on the last read (0 = first). */
  position: integer('position'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tracked_post_comments_post_external').on(t.trackedPostId, t.externalId),
  index('tracked_post_comments_account_idx').on(t.trackedAccountId, t.firstSeenAt),
]);

/**
 * Platform audit log (操作日志). `username` is denormalized so entries survive user deletion;
 * `detail` holds an allowlisted, redacted summary (never raw request bodies). See modules/audit.
 */
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id'),
  username: text('username'),
  action: text('action').notNull(),
  target: text('target'),
  targetId: text('target_id'),
  method: text('method').notNull(),
  path: text('path').notNull(),
  status: integer('status').notNull(),
  ok: boolean('ok').notNull(),
  ip: text('ip'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
}, (t) => [index('audit_logs_at_idx').on(t.at), index('audit_logs_action_idx').on(t.action)]);

/**
 * Social accounts (社交账号, P1): the operator's own platform accounts, modelled apart from devices.
 * `platform` is a registry id (modules/social/platforms.ts), not a DB enum, so adding a platform needs no migration.
 * Handles are unique per platform case-insensitively across all owners: one real account is managed only once.
 * The account's egress proxy is its device's proxy (instances.proxy_id); it is never stored here.
 * No platform passwords are stored. Rows cascade with their owner; deleting a device unlinks (logged).
 */
export const socialAccounts = pgTable('social_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  profileUrl: text('profile_url'),
  externalId: text('external_id'),
  instanceId: uuid('instance_id').references(() => instances.id, { onDelete: 'set null' }),
  /** 账号人设: a public persona or one of the account owner's personal personas (assertPersonaFor). */
  personaId: uuid('persona_id').references((): AnyPgColumn => personas.id, { onDelete: 'set null' }),
  /**
   * 账号语言 (BCP-47, canonical, null = not set): the language this account posts in. Publishing uses the content's
   * translation in this language (else the Chinese source); the set of these = the 配置语系 offered in the editor.
   */
  lang: text('lang'),
  loginStatus: text('login_status', { enum: ['unknown', 'logged_in', 'logged_out', 'needs_verification'] }).notNull().default('unknown'),
  accountStatus: text('account_status', { enum: ['active', 'limited', 'suspended', 'disabled'] }).notNull().default('active'),
  notes: text('notes'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  /**
   * Result of the last automatic check on the account's cloud phone (modules/social/check.ts, task
   * account-device-check): ok | logged_out | wrong_account | challenge | offline | timeout | app_missing.
   * `last_check_detail` = what was seen (e.g. the other username), short, never a screen dump.
   */
  lastCheckCode: text('last_check_code'),
  lastCheckDetail: text('last_check_detail'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('social_accounts_platform_handle').on(t.platform, sql`lower(${t.handle})`),
  index('social_accounts_user_idx').on(t.userId, t.createdAt),
  index('social_accounts_instance_platform_idx').on(t.instanceId, t.platform),
  index('social_accounts_status_idx').on(t.loginStatus, t.accountStatus),
  index('social_accounts_created_at_idx').on(t.createdAt),
  index('social_accounts_persona_idx').on(t.personaId),
  index('social_accounts_lang_idx').on(t.lang),
]);

/** Tag names are unique case-insensitively; the first spelling wins (same rule as media tags). */
export const socialTags = pgTable('social_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('social_tags_name_lower_idx').on(sql`lower(${t.name})`)]);

export const socialAccountTags = pgTable('social_account_tags', {
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull().references(() => socialTags.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.accountId, t.tagId] }), index('social_account_tags_tag_idx').on(t.tagId)]);

/** Per-account timeline: every field/status change and every device link/unlink (who, what, from → to). */
export const socialAccountLogs = pgTable('social_account_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  /** null = system (e.g. device deleted). `actorName` is denormalized so entries survive user deletion. */
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actorName: text('actor_name'),
  action: text('action', { enum: ['create', 'update', 'status', 'checked', 'link', 'unlink', 'connect', 'disconnect'] }).notNull(),
  field: text('field'),
  fromValue: text('from_value'),
  toValue: text('to_value'),
  message: text('message'),
}, (t) => [index('social_account_logs_account_at_idx').on(t.accountId, t.at)]);

/**
 * Account analytics (账号分析): one row per own social account and UTC day. Two kinds of values:
 * - counters, read at `captured_at` (the latest reading of the day wins): followers, following, posts,
 *   and lifetime totals where the platform only reports those (`total_views` YouTube, `total_likes` TikTok);
 * - day activity as the platform reports it for that day: views, likes, shares, comments.
 * Per-day gains are differences between readings (lib/counter-deltas.ts, shared with tracked accounts);
 * views/likes per day fall back to the difference of the lifetime totals. `missing` lists metrics the
 * API could not provide because the connection lacks a scope. source api|manual like tracked snapshots.
 * Since 2026-11-18 the only writer is the automatic account check on the account's cloud phone (source
 * `device`: followers/following/posts as the Instagram app shows them, `approx` = abbreviated); api/manual rows are history.
 */
export const socialAccountStats = pgTable('social_account_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  socialAccountId: uuid('social_account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  /** api | manual (historical) | device (the account's own profile read by the automatic check on its cloud phone). */
  source: text('source', { enum: ['api', 'manual', 'device'] }).notNull(),
  followers: bigint('followers', { mode: 'number' }),
  following: bigint('following', { mode: 'number' }),
  posts: bigint('posts', { mode: 'number' }),
  /** Metrics the app abbreviated (device source; same rule as tracked snapshots). */
  approx: text('approx').array(),
  totalViews: bigint('total_views', { mode: 'number' }),
  totalLikes: bigint('total_likes', { mode: 'number' }),
  views: bigint('views', { mode: 'number' }),
  likes: bigint('likes', { mode: 'number' }),
  shares: bigint('shares', { mode: 'number' }),
  comments: bigint('comments', { mode: 'number' }),
  missing: text('missing').array().notNull().default(sql`'{}'::text[]`),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [unique('social_account_stats_account_day').on(t.socialAccountId, t.day)]);

/**
 * Content management (内容管理, P3). A content is private to its owner (`user_id`; admins see all). Media are
 * references to media_assets (never copies), ordered by `position`. `stage` is what the editor sets
 * (draft / ready / archived); `status` is derived from the stage and the content's publish tasks
 * (modules/publish/content.ts refreshContentStatus) and stored for filtering.
 */
export const CONTENT_STATUSES = ['draft', 'ready', 'scheduled', 'partially_published', 'published', 'failed', 'archived'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/**
 * 内容分类 (content categories), scoped like personas: public (owner_id null, admin-managed, usable by everyone) or
 * personal (owner_id, private to that user; admins see all). Name unique per owner, case-insensitive.
 */
export const contentCategories = pgTable('content_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerType: text('owner_type', { enum: ['public', 'user'] }).notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  sort: integer('sort').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('content_categories_owner_name').on(sql`coalesce(${t.ownerId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`),
  ownerCheck('content_categories_owner_chk'),
]);
export type ContentCategory = typeof contentCategories.$inferSelect;

export const contents = pgTable('contents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** Base caption / description; publish tasks copy it unless they override it. */
  body: text('body').notNull().default(''),
  /** 内容分类: a public category or one of the owner's personal categories (assertCategoryFor). */
  categoryId: uuid('category_id').references(() => contentCategories.id, { onDelete: 'set null' }),
  /** Source (original) language, BCP-47 (e.g. zh-CN). Null = not set (rows from before 多语言内容). */
  lang: text('lang'),
  stage: text('stage', { enum: ['draft', 'ready', 'archived'] }).notNull().default('draft'),
  status: text('status', { enum: CONTENT_STATUSES }).notNull().default('draft'),
  /** Per-platform defaults, e.g. { youtube: { title, description, privacy }, instagram: { caption }, tiktok: { caption } }. */
  platformHints: jsonb('platform_hints').$type<ContentPlatformHints>().notNull().default({}),
  /** Set when the content was written as an AI draft (人设每日草稿); null for everything a person wrote. */
  aiGenerated: jsonb('ai_generated').$type<ContentAiInfo>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  index('contents_user_created_idx').on(t.userId, t.createdAt),
  index('contents_user_status_idx').on(t.userId, t.status),
  index('contents_category_id_idx').on(t.categoryId),
  index('contents_created_at_idx').on(t.createdAt),
]);

export const contentMedia = pgTable('content_media', {
  contentId: uuid('content_id').notNull().references(() => contents.id, { onDelete: 'cascade' }),
  /** Deleting an asset drops it from drafts; assets used by unfinished publish tasks can't be deleted (assertMediaNotInUse). */
  assetId: uuid('asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
}, (t) => [primaryKey({ columns: [t.contentId, t.assetId] }), index('content_media_asset_idx').on(t.assetId)]);

/**
 * 发布目标: a content's default target accounts (ordered). Concrete account ids only (a group/persona pick is expanded
 * when chosen). Deleting the content or the account drops the row. Distributing still takes its own target list.
 */
export const contentTargets = pgTable('content_targets', {
  contentId: uuid('content_id').notNull().references(() => contents.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
}, (t) => [primaryKey({ columns: [t.contentId, t.accountId] }), index('content_targets_account_idx').on(t.accountId)]);

/**
 * 多语言内容: human-written versions of a content in another language (the content itself is the source,
 * `contents.lang`). Text fields only; hints hold the per-platform caption texts (no options such as privacy).
 */
export const contentTranslations = pgTable('content_translations', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentId: uuid('content_id').notNull().references(() => contents.id, { onDelete: 'cascade' }),
  lang: text('lang').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  platformHints: jsonb('platform_hints').$type<ContentPlatformHints>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [unique('content_translations_content_lang_unique').on(t.contentId, t.lang), index('content_translations_lang_idx').on(t.lang)]);

/** Tag names are unique case-insensitively; the first spelling wins (same rule as media/social tags). */
export const contentTags = pgTable('content_tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('content_tags_name_lower_idx').on(sql`lower(${t.name})`)]);

export const contentTagLinks = pgTable('content_tag_links', {
  contentId: uuid('content_id').notNull().references(() => contents.id, { onDelete: 'cascade' }),
  tagId: uuid('tag_id').notNull().references(() => contentTags.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.contentId, t.tagId] }), index('content_tag_links_tag_idx').on(t.tagId)]);

/**
 * Publish scheduler (排程发布, P4): one row per (content, target social account) distribution.
 * Business state lives here; scheduling state lives in `tasks` (type 'publish', ref_type 'publish',
 * ref_id = this id, idempotency key publish:<id>:<attempt_no>). `task_id` is the current scheduler task;
 * every reschedule/retry bumps `attempt_no` and creates a new tasks row (older ones stay as history).
 * Status: pending | scheduled → running → published | awaiting_operator (manual method: handed to an
 * operator, who records the outcome) | failed | cancelled. `user_id` = the account's owner.
 * Media and texts are snapshots taken at distribution (what was scheduled is what gets published).
 * At most one unfinished row per (content, account) (partial unique index); an already published pair is
 * never published again (1 个内容只发布一次; `republish` is LEGACY, always false now).
 */
export const PUBLISH_STATUSES = ['pending', 'scheduled', 'running', 'awaiting_operator', 'published', 'failed', 'cancelled'] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];
export const PUBLISH_UNFINISHED: readonly PublishStatus[] = ['pending', 'scheduled', 'running', 'awaiting_operator'];
/** Post type (帖子 / Reels / 限动). Which types a platform accepts: modules/publish/platforms.ts. */
export const POST_TYPES = ['feed', 'reel', 'story'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const publishTasks = pgTable('publish_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentId: uuid('content_id').notNull().references(() => contents.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  title: text('title'),
  caption: text('caption').notNull().default(''),
  /** Platform options, e.g. { privacy: 'public' | 'unlisted' | 'private' }. */
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  /** Snapshot of the content's ordered media at distribution. */
  mediaIds: uuid('media_ids').array().notNull().default(sql`'{}'::uuid[]`),
  /** feed (帖子, carousel when > 1 medium) | reel | story (限动). */
  postType: text('post_type', { enum: POST_TYPES }).notNull().default('feed'),
  /**
   * Language of the snapshot texts (title/caption): the account's language when the content has a translation in it
   * (or is written in it), else the content's source language; null = unknown (rows from before, legacy contents
   * without a source language).
   */
  lang: text('lang'),
  /** When it is (or was) due; distributions "now" get the creation time. */
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status', { enum: PUBLISH_STATUSES }).notNull().default('pending'),
  /** Method of the last run: 'manual' (old rows may say 'api': official-API publishing was removed on 2026-11-18). */
  method: text('method'),
  attemptNo: integer('attempt_no').notNull().default(1),
  maxAttempts: integer('max_attempts').notNull().default(3),
  taskId: uuid('task_id'),
  republish: boolean('republish').notNull().default(false),
  externalId: text('external_id'),
  url: text('url'),
  error: text('error'),
  errorCode: text('error_code'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  /** 云手机发帖 (method device): when the phone last started a run; daily cap + min gap per account. */
  deviceRunAt: timestamp('device_run_at', { withTimezone: true }),
  /** 云手机发帖: screenshot of the last screen before 分享 (storage key server-side only) + the caption read back. */
  evidence: jsonb('evidence').$type<ReplyEvidence>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('publish_tasks_one_unfinished_idx').on(t.contentId, t.accountId)
    .where(sql`status in ('pending', 'scheduled', 'running', 'awaiting_operator')`),
  index('publish_tasks_user_scheduled_idx').on(t.userId, t.scheduledAt),
  index('publish_tasks_status_scheduled_idx').on(t.status, t.scheduledAt),
  index('publish_tasks_scheduled_idx').on(t.scheduledAt),
  // content + account (+ owner) newest first: the "newest task per pair" anti-join (group=content, dashboard, content
  // status) and every per-content lookup (prefix; replaced publish_tasks_content_idx)
  index('publish_tasks_pair_idx').on(t.contentId, t.accountId, t.userId, t.createdAt, t.id),
  // 发文日志 (sort=updated_desc) and the dashboard's published/failed per day
  index('publish_tasks_updated_idx').on(t.updatedAt, t.id),
  index('publish_tasks_account_idx').on(t.accountId, t.scheduledAt),
  index('publish_tasks_media_idx').using('gin', t.mediaIds),
  index('publish_tasks_account_device_idx').on(t.accountId, t.deviceRunAt),
]);

/**
 * Read only since 2026-11-18 (official APIs removed; nothing writes this table any more).
 * Posts of the operator's OWN social accounts as the official API listed them (账号分析 → 帖子): per-post
 * likes/comments counters, formerly refreshed by the removed account-stats task (Instagram
 * /me/media today). Unique per account + platform post id; an upsert keeps first_seen_at and updates the
 * mutable fields. Linked to publish_tasks at read time (account + external_id), no FK.
 */
export const socialAccountPosts = pgTable('social_account_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  socialAccountId: uuid('social_account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  /** Platform media type (Instagram IMAGE / VIDEO / CAROUSEL_ALBUM). */
  mediaType: text('media_type'),
  /** Platform surface (Instagram FEED / REELS / STORY). */
  productType: text('product_type'),
  caption: text('caption'),
  permalink: text('permalink'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  likes: bigint('likes', { mode: 'number' }),
  comments: bigint('comments', { mode: 'number' }),
  /** api (history) | device: read in the Instagram app on the account's cloud phone (modules/feed, externalId = media pk). */
  source: text('source', { enum: ['api', 'device'] }).notNull().default('api'),
  /** Metrics the app abbreviated (likes / comments). */
  approx: text('approx').array(),
  /** Last time its comments were read (device source). */
  commentsFetchedAt: timestamp('comments_fetched_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('social_account_posts_account_external').on(t.socialAccountId, t.externalId),
  index('social_account_posts_account_published_idx').on(t.socialAccountId, t.publishedAt),
]);

/**
 * 关注 (following list) and 粉丝 (followers list) of an own social account, read in the Instagram app on its cloud
 * phone (modules/social/following.ts, task `account-following`). One row per account and list (`kind`
 * following|followers, handle lowercased). A run upserts what it saw (last_seen_at, position = order in the app,
 * gone_at cleared); only a COMPLETE read of that list (reached its end) marks rows of that kind it did not see as
 * `gone_at` (取消关注 history); a capped read never does. Followers: at most the newest 20 per run (FOLLOWERS_MAX).
 */
export const socialAccountFollowing = pgTable('social_account_following', {
  id: uuid('id').primaryKey().defaultRandom(),
  socialAccountId: uuid('social_account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  /** following = accounts this account follows (关注); followers = accounts following it (粉丝). */
  kind: text('kind', { enum: ['following', 'followers'] }).notNull().default('following'),
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  /** null = not readable on that screen (the app draws the badge inside the username text). */
  verified: boolean('verified'),
  /** Position in the list as the app showed it on the last run that saw it (0 = first). */
  position: integer('position'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Not in the list any more (seen missing by a complete read); cleared when it shows up again. */
  goneAt: timestamp('gone_at', { withTimezone: true }),
  /**
   * The listed account's own profile (owner 2026-11-19): read by opening its public profile on the account's phone
   * (account-following, ≤ PROFILE_VISITS_PER_RUN per run, again after 7 days). null = not shown / never read.
   */
  followers: integer('followers'),
  following: integer('following'),
  posts: integer('posts'),
  /** Counters the app abbreviated (≈). */
  approx: text('approx').array(),
  /** 不公开: the profile says the account is private (its counts still show). */
  isPrivate: boolean('is_private'),
  /** Last profile visit that read the profile or found it missing; null = never (or only failed visits). */
  profileCheckedAt: timestamp('profile_checked_at', { withTimezone: true }),
  /** null = read; not_found / timeout / parse_failed / bad_handle = the last visit's problem. */
  profileCode: text('profile_code'),
}, (t) => [
  unique('social_account_following_account_kind_handle').on(t.socialAccountId, t.kind, t.handle),
  index('social_account_following_account_idx').on(t.socialAccountId, t.kind, t.goneAt, t.position),
]);

/** Business log of a publish task: distribution, every pre-run check, method hand-over, operator actions. */
export const publishLogs = pgTable('publish_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  publishTaskId: uuid('publish_task_id').notNull().references(() => publishTasks.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull(),
  message: text('message').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>(),
  attemptNo: integer('attempt_no'),
  taskId: uuid('task_id'),
  /** null = scheduler. Name denormalized so entries survive user deletion. */
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actorName: text('actor_name'),
}, (t) => [index('publish_logs_task_at_idx').on(t.publishTaskId, t.at)]);

/**
 * Comments & engagement (评论互动, P5). `comments` is the local copy of comments received on a social
 * account, entered by an operator who saw it on the phone (`source` manual; `api` = synced through the
 * official API before that was removed on 2026-11-18). Unique per (account, external id). `user_id` = the account owner.
 * `publish_task_id` links a comment to the post published by the scheduler (same external post id).
 */
export const COMMENT_STATUSES = ['new', 'read', 'replied', 'hidden', 'ignored'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  /** manual | api (history) | device (read in the app on the account's cloud phone by modules/feed; external_id = feed/ig-ui.ts commentKey). */
  source: text('source', { enum: ['api', 'manual', 'device'] }).notNull(),
  externalId: text('external_id').notNull(),
  /** Thread: external id of the top-level comment this one replies to (null = top level). */
  parentExternalId: text('parent_external_id'),
  externalPostId: text('external_post_id'),
  postUrl: text('post_url'),
  publishTaskId: uuid('publish_task_id').references(() => publishTasks.id, { onDelete: 'set null' }),
  /** Public author name / handle as shown on the platform. */
  authorName: text('author_name'),
  authorHandle: text('author_handle'),
  text: text('text').notNull(),
  likeCount: integer('like_count'),
  replyCount: integer('reply_count'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  /** `hidden` only hides it in this platform (never on the social platform). `replied` is set when a reply is sent. */
  status: text('status', { enum: COMMENT_STATUSES }).notNull().default('new'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('comments_account_external_idx').on(t.accountId, t.externalId),
  index('comments_user_published_idx').on(t.userId, t.publishedAt),
  // 评论互动 list order (newest thread first)
  index('comments_when_idx').on(sql`coalesce(${t.publishedAt}, ${t.createdAt})`, t.id),
  index('comments_account_status_idx').on(t.accountId, t.status, t.publishedAt),
  index('comments_account_post_idx').on(t.accountId, t.externalPostId),
  index('comments_account_parent_idx').on(t.accountId, t.parentExternalId),
  index('comments_status_idx').on(t.status, t.publishedAt),
  index('comments_publish_task_idx').on(t.publishTaskId),
]);

/**
 * Reply tasks (评论回复任务). The text is always written by a person (optionally starting from a template).
 * draft → scheduled → sending → sent | awaiting_operator → sent | failed; cancelled.
 * At most one reply per comment that is not failed / cancelled.
 * `round` is bumped when a rate-limited send is deferred (idempotency key comment-reply:<id>:<round>).
 */
export const COMMENT_REPLY_STATUSES = ['draft', 'scheduled', 'sending', 'awaiting_operator', 'sent', 'failed', 'cancelled'] as const;
export type CommentReplyStatus = (typeof COMMENT_REPLY_STATUSES)[number];

/** What a device send left as proof (screenshot before 发布 / 分享, or of the failing screen) + a short screen excerpt. */
export interface ReplyEvidence { at: string; storage?: string | null; key?: string | null; inputText?: string | null; excerpt?: string | null }

export const commentTasks = pgTable('comment_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  /** The comment replied to; null = a comment written directly under a post (`post_id`). Nullable since 0035 (expand). */
  commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  /** Direct comment under one of the account's own posts (social_account_posts), sent from the cloud phone. */
  postId: uuid('post_id').references(() => socialAccountPosts.id, { onDelete: 'cascade' }),
  /**
   * 评论追踪账号的帖子 (owner decision 2026-11-18): a comment under a tracked account's post (tracked_posts), sent by
   * the chosen own account's cloud phone. Set null when the tracked post is deleted (the record stays). Expand (0036).
   */
  trackedPostId: uuid('tracked_post_id').references(() => trackedPosts.id, { onDelete: 'set null' }),
  /**
   * Reply to a comment under a tracked post (tracked_post_comments). Deliberately no FK: a reply whose comment is gone
   * keeps the id and fails `comment.comment_gone` instead of turning into a comment directly under the post.
   */
  trackedCommentId: uuid('tracked_comment_id'),
  /** Device send: screenshot + what the input field showed. */
  evidence: jsonb('evidence').$type<ReplyEvidence>(),
  platform: text('platform').notNull(),
  text: text('text').notNull(),
  /** sha256 of the normalized text (lower case, collapsed whitespace): duplicate-text rule. */
  textHash: text('text_hash').notNull(),
  templateId: uuid('template_id'),
  status: text('status', { enum: COMMENT_REPLY_STATUSES }).notNull().default('draft'),
  /** 'manual' (old rows may say 'api': API replies were removed on 2026-11-18). */
  method: text('method'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  round: integer('round').notNull().default(1),
  maxAttempts: integer('max_attempts').notNull().default(3),
  taskId: uuid('task_id'),
  externalReplyId: text('external_reply_id'),
  error: text('error'),
  errorCode: text('error_code'),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  /** Who sent it: null = the API job; the operator for a manual reply. */
  senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
  senderName: text('sender_name'),
  handedAt: timestamp('handed_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  // A draft blocks too.
  uniqueIndex('comment_tasks_one_active_idx').on(t.commentId).where(sql`status not in ('failed', 'cancelled')`),
  index('comment_tasks_post_idx').on(t.postId, t.createdAt),
  index('comment_tasks_tracked_post_idx').on(t.trackedPostId, t.createdAt),
  // one active reply per tracked comment, like comment_tasks_one_active_idx
  uniqueIndex('comment_tasks_tracked_one_active_idx').on(t.trackedCommentId).where(sql`tracked_comment_id is not null and status not in ('failed', 'cancelled')`),
  index('comment_tasks_user_status_idx').on(t.userId, t.status, t.updatedAt),
  index('comment_tasks_account_status_idx').on(t.accountId, t.status, t.updatedAt),
  index('comment_tasks_account_hash_idx').on(t.accountId, t.textHash, t.submittedAt),
  index('comment_tasks_account_sent_idx').on(t.accountId, t.sentAt),
  index('comment_tasks_status_idx').on(t.status, t.updatedAt),
  // 回复记录 list order (last change first)
  index('comment_tasks_updated_idx').on(t.updatedAt, t.id),
  index('comment_tasks_comment_idx').on(t.commentId, t.createdAt),
]);

/** Business log: every state change of a comment or reply, every rule block (with its reason code) and sync result. */
export const commentLogs = pgTable('comment_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  commentTaskId: uuid('comment_task_id').references(() => commentTasks.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull(),
  action: text('action').notNull(),
  /** Reason code of a block / failure (e.g. comment.duplicate_text). */
  code: text('code'),
  message: text('message'),
  data: jsonb('data').$type<Record<string, unknown>>(),
  taskId: uuid('task_id'),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actorName: text('actor_name'),
}, (t) => [
  index('comment_logs_task_at_idx').on(t.commentTaskId, t.at),
  index('comment_logs_comment_at_idx').on(t.commentId, t.at),
  index('comment_logs_account_at_idx').on(t.accountId, t.at),
  index('comment_logs_code_idx').on(t.code, t.at),
]);

/**
 * 人设 (personas) of the script library, scoped like media categories: public (owner_id null, admin-managed, usable by
 * everyone) or personal (owner_id, private to that user; admins see all). Name unique per owner, case-insensitive.
 */
export const personas = pgTable('personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerType: text('owner_type', { enum: ['public', 'user'] }).notNull(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** 一句话定位 (one-line positioning). */
  description: text('description'),
  sort: integer('sort').notNull().default(0),
  /**
   * 风格 (`PersonaStyle`, one style for posts and comments), stored in the column `brief` (the former 内容设定);
   * defaults are applied on read (`styleOf`).
   */
  style: jsonb('brief').$type<PersonaStyle>().notNull().default({}),
  /**
   * 自定义提示词 (owner 2026-11-19): the WHOLE prompt a person wrote for AI测试 / 「AI生成草稿」 instead of the generated
   * one (placeholders `{{topic}}` … filled per request, modules/ai/prompt.ts); null = generated from the persona.
   */
  customPrompt: jsonb('custom_prompt').$type<{ system: string; user: string }>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('personas_owner_name').on(sql`coalesce(${t.ownerId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`),
  ownerCheck('personas_owner_chk'),
]);
export type Persona = typeof personas.$inferSelect;

export const PERSONA_TONES = ['casual', 'pro', 'funny', 'cool', 'warm'] as const;
export type PersonaTone = (typeof PERSONA_TONES)[number];
export const PERSONA_LEVELS = ['low', 'medium', 'high'] as const;
export type PersonaLevel = (typeof PERSONA_LEVELS)[number];
/**
 * 人设风格 (personas.brief; ONE style again since 2026-11-19, owner: 「发文风格和评论风格；建议整成一个吧」): tone preset
 * (亲切日常/专业干货/幽默俏皮/高冷简洁/温暖治愈) with an editable note, emoji/length low|medium|high (one level: the post
 * range `PERSONA_LENGTHS.post` and the comment range `PERSONA_LENGTHS.comment` both follow it), hashtags (posts),
 * audience, notes, topics and banned words (checked on posts AND comments). 固定开头/结尾 were removed (owner 2026-11-19).
 * No language: the language belongs to the social account (账号语言).
 */
export interface PersonaStyle {
  topics?: string[];
  bannedWords?: string[];
  tone?: PersonaTone;
  toneNote?: string;
  emoji?: PersonaLevel;
  length?: PersonaLevel;
  hashtags?: string[];
  audience?: string;
  notes?: string;
}

/**
 * Saved templates = the 范例 of personas (one list for posts and comments), with a
 * persona (人设, `persona_id`) and lowercase tags. Private (user_id) or shared (user_id null, admin-managed). A person picks and edits one.
 * A shared template may only use a public persona; a private one a public persona or one of its owner's.
 */
export const commentTemplates = pgTable('comment_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  personaId: uuid('persona_id').references(() => personas.id, { onDelete: 'set null' }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  name: text('name').notNull(),
  text: text('text').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [index('comment_templates_user_idx').on(t.userId, t.name), index('comment_templates_persona_idx').on(t.personaId)]);

/**
 * 趋势热点: one stored chart per (source, region, category, slot). Slots are `intervalHours` wide (UTC); the
 * scheduled task is idempotent per slot and a manual refresh replaces the slot's snapshot. Old ones are purged by retention.
 */
export const trendingSnapshots = pgTable('trending_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull().default('youtube'),
  region: text('region').notNull(),
  /** '' = all categories. */
  categoryId: text('category_id').notNull().default(''),
  slotAt: timestamp('slot_at', { withTimezone: true }).notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  itemCount: integer('item_count').notNull().default(0),
  taskId: uuid('task_id'),
}, (t) => [
  unique('trending_snapshots_slot').on(t.source, t.region, t.categoryId, t.slotAt),
  index('trending_snapshots_captured_idx').on(t.capturedAt),
]);

/** Public chart entries (metadata and links only; no media is downloaded). */
export const trendingItems = pgTable('trending_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  snapshotId: uuid('snapshot_id').notNull().references(() => trendingSnapshots.id, { onDelete: 'cascade' }),
  rank: integer('rank').notNull(),
  videoId: text('video_id').notNull(),
  title: text('title'),
  channelId: text('channel_id'),
  channelTitle: text('channel_title'),
  categoryId: text('category_id'),
  views: bigint('views', { mode: 'number' }),
  likes: bigint('likes', { mode: 'number' }),
  comments: bigint('comments', { mode: 'number' }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
}, (t) => [unique('trending_items_snapshot_rank').on(t.snapshotId, t.rank)]);

/**
 * Origin of an AI draft: the model that served it, the persona, the task and when; `mediaTags` = the model's media keywords.
 * `via`: `account` = 「AI生成草稿」 of one social account (`accountId`; older rows: an `account-drafts` run, daily or 立即生成), `preview` = LEGACY
 * (an AI测试 preview saved by a person; saving was removed on 2026-11-18, older rows keep it).
 */
export interface ContentAiInfo {
  via?: 'account' | 'preview';
  accountId?: string;
  /** 立即生成 with a 主题: the topic the person asked for. */
  topic?: string;
  /** 「AI生成草稿」 saved from the account preview: whether the person changed the generated title/text before saving. */
  edited?: boolean;
  model: string;
  requestedModel: string;
  personaId: string;
  personaName: string;
  taskId: string | null;
  generatedAt: string;
  mediaTags: string[];
  /** Languages of the target accounts other than the Chinese source: the draft needs a human translation (no MT). */
  needsTranslation?: string[];
}

export interface ContentPlatformHints {
  youtube?: { title?: string; description?: string; privacy?: 'public' | 'unlisted' | 'private' };
  instagram?: { caption?: string };
  tiktok?: { caption?: string };
  facebook?: { caption?: string };
  [platform: string]: Record<string, unknown> | undefined;
}

/** The phone's screen as read over adb when it is attached (for the player). */
export interface InstanceSpec {
  width: number;
  height: number;
  dpi: number;
}

export interface ProxyStatus {
  checkedAt: string;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  dnsOk: boolean;
  error: string | null;
  /** Geo of the egress IP (ipinfo.io, looked up through the same path); absent on older checks or when the lookup failed. */
  country?: string | null;
  region?: string | null;
  city?: string | null;
}

/**
 * Database backups (数据库备份, modules/system/backup.ts): one row per pg_dump run (custom format), the file
 * lives in the storage backend that was active then (`storage`) under `key` (backups/…). Restore is manual.
 */
export const dbBackups = pgTable('db_backups', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: text('status', { enum: ['running', 'ok', 'failed'] }).notNull().default('running'),
  trigger: text('trigger', { enum: ['manual', 'scheduled', 'pre-restore'] }).notNull(),
  storage: text('storage', { enum: ['local', 's3'] }).notNull(),
  key: text('key').notNull(),
  size: bigint('size', { mode: 'number' }),
  error: text('error'),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [index('db_backups_created_idx').on(t.createdAt)]);
export type DbBackup = typeof dbBackups.$inferSelect;

/**
 * Device connection history (连线监控): one row per change of a device's `status` or `adb_state`, written by
 * modules/instances/repo.ts (updateInstance). `status` is the device status after the change. Bounded by
 * a retention period and a row cap (modules/system/connections.ts, hourly).
 */
export const instanceStatusEvents = pgTable('instance_status_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  instanceId: uuid('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
  field: text('field', { enum: ['status', 'adb'] }).notNull(),
  from: text('from'),
  to: text('to'),
  status: text('status').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('instance_status_events_instance_at_idx').on(t.instanceId, t.at), index('instance_status_events_at_idx').on(t.at)]);
export type InstanceStatusEvent = typeof instanceStatusEvents.$inferSelect;

/**
 * 风控记录 (modules/risk): what the automatic device work ran into (collector visits, account checks):
 * challenge / logged out / wrong account / unreadable screens. Short coded rows (detail ≤ 300 chars, never a
 * screen dump), purged after 90 days by the hourly system maintenance.
 */
export const riskEvents = pgTable('risk_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  instanceId: uuid('instance_id').references(() => instances.id, { onDelete: 'set null' }),
  /** Denormalised so the row stays readable after the device is deleted. */
  instanceName: text('instance_name'),
  socialAccountId: uuid('social_account_id').references(() => socialAccounts.id, { onDelete: 'set null' }),
  trackedAccountId: uuid('tracked_account_id').references(() => trackedAccounts.id, { onDelete: 'set null' }),
  /** collector | account_check | … */
  source: text('source').notNull(),
  code: text('code').notNull(),
  detail: text('detail'),
  /** Who started it (task creator), null = scheduler. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [
  index('risk_events_at_idx').on(t.at),
  index('risk_events_instance_at_idx').on(t.instanceId, t.at),
  index('risk_events_code_at_idx').on(t.code, t.at),
]);
export type RiskEvent = typeof riskEvents.$inferSelect;

/**
 * Alerts (告警通知, modules/notify). One in-app notification row per recipient. `kind` + `params` are
 * rendered by the UI (i18n `alerts.kinds.<kind>`); params are short identifiers/codes only (names, handles,
 * status and error codes), never free-form texts from external systems or secrets. `recovered` = the
 * "back to normal" notice of a recoverable kind. Rows cascade with the user; old ones are purged hourly.
 */
export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'error'] as const;
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  severity: text('severity', { enum: NOTIFICATION_SEVERITIES }).notNull(),
  recovered: boolean('recovered').notNull().default(false),
  params: jsonb('params').$type<Record<string, string | number>>().notNull().default({}),
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('notifications_user_idx').on(t.userId, t.createdAt),
  index('notifications_unread_idx').on(t.userId).where(sql`read_at is null`),
  index('notifications_created_at_idx').on(t.createdAt),
]);

/**
 * De-duplication state per alert (kind + key; key = the referenced object's id or a finer key): an alert is
 * delivered when its state is not active or its last delivery is older than the cooldown; a recovery
 * deactivates it (and may send a "recovered" notice). No FKs: rows of deleted objects age out (hourly cleanup).
 */
export const alertStates = pgTable('alert_states', {
  kind: text('kind').notNull(),
  key: text('key').notNull(),
  active: boolean('active').notNull().default(true),
  lastAlertAt: timestamp('last_alert_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [primaryKey({ columns: [t.kind, t.key] }), index('alert_states_updated_idx').on(t.updatedAt)]);

/**
 * External alert channels (告警通道, modules/notify/channels.ts; admin only). `type` names a driver in the
 * code registry (telegram today), so a new type needs no migration. `config` holds the driver's non-secret
 * fields plus each secret sealed as `<field>Enc` (Telegram: chatId, threadId?, language, botTokenEnc); never
 * returned. `kinds`: alert kinds this channel receives (empty = all channel kinds); `minSeverity`: optional
 * floor on the kind's severity. `lastResult`: outcome of the last delivery or test (no message text).
 */
export const ALERT_CHANNEL_MIN_SEVERITIES = ['warning', 'error'] as const;
export const alertChannels = pgTable('alert_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  type: text('type').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  kinds: text('kinds').array().notNull().default(sql`'{}'::text[]`),
  minSeverity: text('min_severity', { enum: ALERT_CHANNEL_MIN_SEVERITIES }),
  lastResult: jsonb('last_result').$type<{ ok: boolean; at: string; test?: boolean; code?: string | null }>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
});
export type AlertChannel = typeof alertChannels.$inferSelect;

export type User = typeof users.$inferSelect;
export type Instance = typeof instances.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskLog = typeof taskLogs.$inferSelect;
export type LibraryApp = typeof libraryApps.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type MediaCategory = typeof mediaCategories.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type SocialAccount = typeof socialAccounts.$inferSelect;
export type SocialAccountLog = typeof socialAccountLogs.$inferSelect;
export type TrackedAccount = typeof trackedAccounts.$inferSelect;
export type TrackedSnapshot = typeof trackedAccountSnapshots.$inferSelect;
export type SocialAccountStats = typeof socialAccountStats.$inferSelect;
export type TrackedPost = typeof trackedPosts.$inferSelect;
export type TrackedPostComment = typeof trackedPostComments.$inferSelect;
export type SocialAccountPost = typeof socialAccountPosts.$inferSelect;
export type SocialAccountFollowing = typeof socialAccountFollowing.$inferSelect;
export type Content = typeof contents.$inferSelect;
export type ContentTranslation = typeof contentTranslations.$inferSelect;
export type PublishTask = typeof publishTasks.$inferSelect;
export type PublishLog = typeof publishLogs.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type CommentTask = typeof commentTasks.$inferSelect;
export type CommentTemplate = typeof commentTemplates.$inferSelect;
export type TrendingSnapshot = typeof trendingSnapshots.$inferSelect;
export type TrendingItem = typeof trendingItems.$inferSelect;
export type Role = User['role'];
export type Notification = typeof notifications.$inferSelect;
