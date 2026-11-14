import { sql } from 'drizzle-orm';
import { bigint, boolean, check, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
  /** Per-instance upstream proxy. Password never leaves the API (see publicInstance). */
  proxy: jsonb('proxy').$type<ProxyConfig>(),
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

export const instanceGrants = pgTable('instance_grants', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  instanceId: uuid('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.userId, t.instanceId] })]);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  instanceId: uuid('instance_id'),
  instanceName: text('instance_name'),
  /** What the task works on besides a device, e.g. ref_type 'media' + the media asset id (push-asset, media-process). */
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] }).notNull().default('queued'),
  error: text('error'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [index('tasks_ref_idx').on(t.refType, t.refId)]);

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
export type LibraryApp = typeof libraryApps.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type MediaCategory = typeof mediaCategories.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type Role = User['role'];
