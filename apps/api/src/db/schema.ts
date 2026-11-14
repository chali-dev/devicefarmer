import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'operator', 'viewer']);

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
  role: roleEnum('role').notNull().default('viewer'),
  disabled: boolean('disabled').notNull().default(false),
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
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] }).notNull().default('queued'),
  error: text('error'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

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
 * Asset library (素材库): images/videos/files pushed to devices' shared storage.
 * `storage` is the backend the object was written to, so switching the active backend
 * later keeps old assets readable (s3 assets are read with the current s3 config).
 */
export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  storage: text('storage', { enum: ['local', 's3'] }).notNull(),
  key: text('key').notNull(),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('assets_created_at_idx').on(t.createdAt)]);

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
export type Asset = typeof assets.$inferSelect;
export type Role = User['role'];
