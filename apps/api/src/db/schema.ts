import { sql } from 'drizzle-orm';
import { bigint, boolean, check, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'user']);

/**
 * Instance lifecycle (Docker) and device state (adb/STF) are tracked separately:
 * `status` is what the platform is doing/observed at container level,
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const instances = pgTable('instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  engine: text('engine', { enum: ['redroid', 'emulator'] }).notNull().default('redroid'),
  /** Image profile id (see profiles.ts), e.g. redroid-13-gapps */
  profile: text('profile').notNull().default('redroid-12'),
  image: text('image').notNull(),
  adbPort: integer('adb_port').notNull().unique(),
  containerId: text('container_id'),
  /** Network sidecar (sing-box) owning the instance's network namespace; null = legacy direct networking */
  netContainerId: text('net_container_id'),
  /**
   * Bound proxy from the pool (至多绑定一台设备: unique). The sidecar config is built from the pool entry,
   * password decrypted only at apply time. Deleting a bound proxy is refused (restrict).
   */
  proxyId: uuid('proxy_id').unique('instances_proxy_id_unique').references((): AnyPgColumn => proxies.id, { onDelete: 'restrict' }),
  /** Egress as seen from inside the device's netns (monitor / per-device check). */
  proxyStatus: jsonb('proxy_status').$type<ProxyStatus>(),
  status: instanceStatusEnum('status').notNull().default('creating'),
  adbState: text('adb_state'),
  bootCompleted: boolean('boot_completed').notNull().default(false),
  stfReady: boolean('stf_ready').notNull().default(false),
  lastError: text('last_error'),
  /** Latest Google services health snapshot (no account identifiers stored). */
  google: jsonb('google').$type<GoogleHealth>(),
  spec: jsonb('spec').$type<InstanceSpec>().notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
});

/**
 * Static residential proxy pool (代理管理, admin-managed). The password is AES-256-GCM encrypted
 * (lib/secret-box.ts) and write-only. `lastCheck` is the check from the API host through the proxy.
 */
export const proxies = pgTable('proxies', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label'),
  type: text('type', { enum: ['socks5', 'http'] }).notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  username: text('username'),
  passwordEnc: text('password_enc'),
  country: text('country'),
  region: text('region'),
  city: text('city'),
  provider: text('provider'),
  notes: text('notes'),
  status: text('status', { enum: ['unchecked', 'ok', 'failed'] }).notNull().default('unchecked'),
  lastCheck: jsonb('last_check').$type<ProxyCheck>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('proxies_endpoint_unique').on(t.type, sql`lower(${t.host})`, t.port, sql`coalesce(${t.username}, '')`),
  index('proxies_status_idx').on(t.status),
]);

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
 * (e.g. from Google Play), reinstalled on other instances without Play.
 */
export const libraryApps = pgTable('library_apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  package: text('package').notNull(),
  versionName: text('version_name'),
  versionCode: text('version_code').notNull(),
  files: jsonb('files').$type<{ name: string; size: number; sha256: string }[]>().notNull(),
  /** Install automatically on newly created instances */
  preinstall: boolean('preinstall').notNull().default(false),
  sourceInstance: text('source_instance'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('library_pkg_version').on(t.package, t.versionCode)]);

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
 * 'disabled' (public only) hides a ready asset from non-admins.
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
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  unique('media_categories_owner_name').on(t.ownerType, t.ownerId, t.name).nullsNotDistinct(),
  ownerCheck('media_categories_owner_chk'),
]);

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
  status: text('status', { enum: ['processing', 'ready', 'failed', 'disabled'] }).notNull().default('processing'),
  error: text('error'),
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
 * Data comes from official APIs (YouTube Data API) or manual entry only, never scraping.
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
  category: text('category'),
  /** Lowercase, deduplicated. */
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  /** The account is private to its owner, so a favorite is just a flag (no per-user table needed). */
  favorite: boolean('favorite').notNull().default(false),
  status: text('status', { enum: ['active', 'paused', 'error'] }).notNull().default('active'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorCode: text('last_error_code'),
  lastSource: text('last_source', { enum: ['api', 'manual'] }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  unique('tracked_accounts_user_platform_handle').on(t.userId, t.platform, t.handle),
  index('tracked_accounts_user_status_idx').on(t.userId, t.status),
  index('tracked_accounts_user_category_idx').on(t.userId, t.category),
  index('tracked_accounts_user_favorite_idx').on(t.userId, t.favorite),
  index('tracked_accounts_tags_idx').using('gin', t.tags),
]);

/** Public counters over time. NULL = not available on that platform / not entered. */
export const trackedAccountSnapshots = pgTable('tracked_account_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackedAccountId: uuid('tracked_account_id').notNull().references(() => trackedAccounts.id, { onDelete: 'cascade' }),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source', { enum: ['api', 'manual'] }).notNull(),
  followers: bigint('followers', { mode: 'number' }),
  following: bigint('following', { mode: 'number' }),
  posts: bigint('posts', { mode: 'number' }),
  views: bigint('views', { mode: 'number' }),
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
  source: text('source', { enum: ['api', 'manual'] }).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tracked_posts_account_external').on(t.trackedAccountId, t.externalId),
  index('tracked_posts_account_published_idx').on(t.trackedAccountId, t.publishedAt),
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
export const socialAccountGroups = pgTable('social_account_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [uniqueIndex('social_account_groups_user_name').on(t.userId, sql`lower(${t.name})`)]);

export const socialAccounts = pgTable('social_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  profileUrl: text('profile_url'),
  externalId: text('external_id'),
  groupId: uuid('group_id').references(() => socialAccountGroups.id, { onDelete: 'set null' }),
  instanceId: uuid('instance_id').references(() => instances.id, { onDelete: 'set null' }),
  loginStatus: text('login_status', { enum: ['unknown', 'logged_in', 'logged_out', 'needs_verification'] }).notNull().default('unknown'),
  accountStatus: text('account_status', { enum: ['active', 'limited', 'suspended', 'disabled'] }).notNull().default('active'),
  notes: text('notes'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('social_accounts_platform_handle').on(t.platform, sql`lower(${t.handle})`),
  index('social_accounts_user_idx').on(t.userId, t.createdAt),
  index('social_accounts_group_idx').on(t.groupId),
  index('social_accounts_instance_platform_idx').on(t.instanceId, t.platform),
  index('social_accounts_status_idx').on(t.loginStatus, t.accountStatus),
  index('social_accounts_created_at_idx').on(t.createdAt),
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
  action: text('action', { enum: ['create', 'update', 'status', 'checked', 'link', 'unlink'] }).notNull(),
  field: text('field'),
  fromValue: text('from_value'),
  toValue: text('to_value'),
  message: text('message'),
}, (t) => [index('social_account_logs_account_at_idx').on(t.accountId, t.at)]);

/**
 * Content management (内容管理, P3). A content is private to its owner (`user_id`; admins see all). Media are
 * references to media_assets (never copies), ordered by `position`. `stage` is what the editor sets
 * (draft / ready / archived); `status` is derived from the stage and the content's publish tasks
 * (modules/publish/content.ts refreshContentStatus) and stored for filtering.
 */
export const CONTENT_STATUSES = ['draft', 'ready', 'scheduled', 'partially_published', 'published', 'failed', 'archived'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const contents = pgTable('contents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** Base caption / description; publish tasks copy it unless they override it. */
  body: text('body').notNull().default(''),
  category: text('category'),
  stage: text('stage', { enum: ['draft', 'ready', 'archived'] }).notNull().default('draft'),
  status: text('status', { enum: CONTENT_STATUSES }).notNull().default('draft'),
  /** Per-platform defaults, e.g. { youtube: { title, description, privacy }, instagram: { caption }, tiktok: { caption } }. */
  platformHints: jsonb('platform_hints').$type<ContentPlatformHints>().notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  index('contents_user_created_idx').on(t.userId, t.createdAt),
  index('contents_user_status_idx').on(t.userId, t.status),
  index('contents_user_category_idx').on(t.userId, t.category),
  index('contents_created_at_idx').on(t.createdAt),
]);

export const contentMedia = pgTable('content_media', {
  contentId: uuid('content_id').notNull().references(() => contents.id, { onDelete: 'cascade' }),
  /** Deleting an asset drops it from drafts; assets used by unfinished publish tasks can't be deleted (assertMediaNotInUse). */
  assetId: uuid('asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
}, (t) => [primaryKey({ columns: [t.contentId, t.assetId] }), index('content_media_asset_idx').on(t.assetId)]);

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
 * Publish scheduler (定时发布, P4): one row per (content, target social account) distribution.
 * Business state lives here; scheduling state lives in `tasks` (type 'publish', ref_type 'publish',
 * ref_id = this id, idempotency key publish:<id>:<attempt_no>). `task_id` is the current scheduler task;
 * every reschedule/retry bumps `attempt_no` and creates a new tasks row (older ones stay as history).
 * Status: pending | scheduled → running → published | awaiting_operator (manual method: handed to an
 * operator, who records the outcome) | failed | cancelled. `user_id` = the account's owner.
 * Media and texts are snapshots taken at distribution (what was scheduled is what gets published).
 * At most one unfinished row per (content, account) (partial unique index); a second publish of an
 * already published pair needs `republish`.
 */
export const PUBLISH_STATUSES = ['pending', 'scheduled', 'running', 'awaiting_operator', 'published', 'failed', 'cancelled'] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];
export const PUBLISH_UNFINISHED: readonly PublishStatus[] = ['pending', 'scheduled', 'running', 'awaiting_operator'];

export const publishTasks = pgTable('publish_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contentId: uuid('content_id').notNull().references(() => contents.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => socialAccounts.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  title: text('title'),
  caption: text('caption').notNull().default(''),
  hashtags: text('hashtags').array().notNull().default(sql`'{}'::text[]`),
  /** Platform options, e.g. { privacy: 'public' | 'unlisted' | 'private' }. */
  options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
  /** Snapshot of the content's ordered media at distribution. */
  mediaIds: uuid('media_ids').array().notNull().default(sql`'{}'::uuid[]`),
  /** When it is (or was) due; distributions "now" get the creation time. */
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status', { enum: PUBLISH_STATUSES }).notNull().default('pending'),
  /** Method chosen by the last run ('api' | 'manual'). */
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
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
}, (t) => [
  uniqueIndex('publish_tasks_one_unfinished_idx').on(t.contentId, t.accountId)
    .where(sql`status in ('pending', 'scheduled', 'running', 'awaiting_operator')`),
  index('publish_tasks_user_scheduled_idx').on(t.userId, t.scheduledAt),
  index('publish_tasks_status_scheduled_idx').on(t.status, t.scheduledAt),
  index('publish_tasks_scheduled_idx').on(t.scheduledAt),
  index('publish_tasks_content_idx').on(t.contentId),
  index('publish_tasks_account_idx').on(t.accountId, t.scheduledAt),
  index('publish_tasks_media_idx').using('gin', t.mediaIds),
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

export interface ContentPlatformHints {
  youtube?: { title?: string; description?: string; privacy?: 'public' | 'unlisted' | 'private' };
  instagram?: { caption?: string };
  tiktok?: { caption?: string };
  [platform: string]: Record<string, unknown> | undefined;
}

export interface InstanceSpec {
  width: number;
  height: number;
  dpi: number;
  /** MiB, applied as a container memory limit when set */
  memoryMb?: number;
  /** Android system settings (see device-settings.ts); persisted in /data */
  locale?: string;
  timezone?: string;
  deviceName?: string;
}

/** Resolved upstream proxy handed to the sidecar (runtime only, never stored in this form). */
export interface ProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyStatus {
  checkedAt: string;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  dnsOk: boolean;
  error: string | null;
}

/** Result of checking a pool proxy from the API host (egress IP + geo through the proxy). */
export interface ProxyCheck {
  at: string;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  country: string | null;
  city: string | null;
  error: string | null;
}

export interface GoogleHealth {
  checkedAt: string;
  gms: { installed: boolean; version: string | null; running: boolean };
  gsf: { installed: boolean; gsfId: string | null };
  playStore: { installed: boolean; version: string | null };
  youtube: { installed: boolean; version: string | null; playing: boolean };
  /** Number of Google accounts on the device; emails are never read or stored. */
  googleAccounts: number;
}

export type User = typeof users.$inferSelect;
export type Instance = typeof instances.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskLog = typeof taskLogs.$inferSelect;
export type LibraryApp = typeof libraryApps.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type MediaCategory = typeof mediaCategories.$inferSelect;
export type PoolProxy = typeof proxies.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type SocialAccount = typeof socialAccounts.$inferSelect;
export type SocialAccountGroup = typeof socialAccountGroups.$inferSelect;
export type SocialAccountLog = typeof socialAccountLogs.$inferSelect;
export type TrackedAccount = typeof trackedAccounts.$inferSelect;
export type TrackedSnapshot = typeof trackedAccountSnapshots.$inferSelect;
export type TrackedPost = typeof trackedPosts.$inferSelect;
export type Content = typeof contents.$inferSelect;
export type PublishTask = typeof publishTasks.$inferSelect;
export type PublishLog = typeof publishLogs.$inferSelect;
export type Role = User['role'];
