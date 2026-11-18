import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { LibraryApp } from '../../db/schema.js';
import { adb } from '../../services.js';
import type { AuthUser } from '../auth/rbac.js';
import { visibleTasks } from '../tasks/routes.js';
import { LIBRARY_TASK_REF, libraryDir } from './library.js';

const I = schema.instances;
const T = schema.tasks;
const BUSY = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];
const UNFINISHED = ['pending', 'scheduled', 'running'] as const;
/** Live read of the installed version: short timeout, bounded fan-out (read-only `dumpsys package`). */
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CONCURRENCY = 6;

/**
 * installable – not installed; update – an older version is installed; installed – same or newer version
 * (the UI hides these); installing – an install of this library entry is already queued/running;
 * offline – not running, adb not attached or the version read failed; busy – lifecycle op in progress.
 * Only installable/update can be picked.
 */
export type TargetState = 'installable' | 'update' | 'installed' | 'installing' | 'offline' | 'busy';
export interface InstallTarget {
  id: string; name: string; status: string; engine: string; external: boolean;
  /** Usernames granted this device. */
  users: string[];
  installed: { versionCode: string; versionName: string | null } | null;
  state: TargetState;
  /** Why it can't be picked: instance status, `adb` (not attached), `probe` (version read failed/timed out). */
  reason?: string;
}

/** Compares numeric versionCodes (bigint-safe); non-numeric fall back to string order. */
export function compareVersionCode(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  return a.localeCompare(b);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

/** Every device `app` may be installed on (the library is admin only), with granted usernames, installed version and state. */
export async function installTargets(app: LibraryApp): Promise<{ devices: InstallTarget[] }> {
  const [rows, grants, pending] = await Promise.all([
    db.select({ id: I.id, name: I.name, status: I.status, engine: I.engine, adbPort: I.adbPort, adbState: I.adbState, sourceId: I.sourceId })
      .from(I).orderBy(I.name),
    // Granted usernames per device: one grouped query.
    db.select({ instanceId: schema.instanceGrants.instanceId, names: sql<string[]>`array_agg(${schema.users.username} order by ${schema.users.username})` })
      .from(schema.instanceGrants).innerJoin(schema.users, eq(schema.users.id, schema.instanceGrants.userId))
      .groupBy(schema.instanceGrants.instanceId),
    db.select({ instanceId: T.instanceId }).from(T)
      .where(and(eq(T.type, 'install-apk'), eq(T.refType, LIBRARY_TASK_REF), eq(T.refId, app.id), inArray(T.status, [...UNFINISHED]))),
  ]);
  const usersOf = new Map(grants.map((g) => [g.instanceId, g.names]));
  const installing = new Set(pending.map((p) => p.instanceId));
  const devices = await mapLimit(rows, PROBE_CONCURRENCY, async (r): Promise<InstallTarget> => {
    const base = { id: r.id, name: r.name, status: r.status, engine: r.engine, external: !!r.sourceId, users: usersOf.get(r.id) ?? [] };
    if (BUSY.includes(r.status)) return { ...base, installed: null, state: 'busy', reason: r.status };
    if (r.status !== 'running') return { ...base, installed: null, state: 'offline', reason: r.status };
    if (r.adbState !== 'device') return { ...base, installed: null, state: 'offline', reason: 'adb' };
    let installed: InstallTarget['installed'];
    try { installed = await adb.packageVersion(r.adbPort, app.package, PROBE_TIMEOUT_MS); }
    catch { return { ...base, installed: null, state: 'offline', reason: 'probe' }; }
    if (installing.has(r.id)) return { ...base, installed, state: 'installing' };
    if (!installed) return { ...base, installed, state: 'installable' };
    return { ...base, installed, state: compareVersionCode(installed.versionCode, app.versionCode) >= 0 ? 'installed' : 'update' };
  });
  return { devices };
}

export interface InstallLogItem {
  taskId: string; status: string; errorCode: string | null; error: string | null;
  createdAt: Date; finishedAt: Date | null;
  instanceId: string | null; instanceName: string;
  /** false once the device was deleted (the name then comes from the task label). */
  deviceExists: boolean;
  operator: string | null;
  versionCode: string | null; versionName: string | null;
  preinstall: boolean;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Install log of a package (every version): install-apk tasks created from the library. New tasks carry
 * refType library_app + payload.library; older ones (before the ref was recorded) are matched by their
 * APK path inside the library directory of the package. Visibility = task centre rule (visibleTasks).
 */
export async function installLog(user: AuthUser, pkg: string, limit: number, offset: number): Promise<{ items: InstallLogItem[]; total: number }> {
  const legacyPrefix = `${libraryDir({ package: pkg, versionCode: '' })}`.replace(/\/?$/, '/');
  const where = and(
    eq(T.type, 'install-apk'),
    or(
      and(eq(T.refType, LIBRARY_TASK_REF), sql`${T.payload}->'library'->>'package' = ${pkg}`),
      and(isNull(T.refType), sql`${T.payload}->'apkPaths'->>0 like ${`${likeEscape(legacyPrefix)}%`}`),
    ),
    visibleTasks(user),
  );
  const [rows, [tot], versions] = await Promise.all([
    db.select({
      id: T.id, status: T.status, errorCode: T.errorCode, error: T.error, createdAt: T.createdAt, finishedAt: T.finishedAt,
      instanceId: T.instanceId, label: T.instanceName, current: I.name, operator: schema.users.username, payload: T.payload,
    }).from(T).leftJoin(I, eq(I.id, T.instanceId)).leftJoin(schema.users, eq(schema.users.id, T.createdBy))
      .where(where).orderBy(desc(T.createdAt)).limit(limit).offset(offset),
    db.select({ n: count() }).from(T).where(where),
    db.select({ versionCode: schema.libraryApps.versionCode, versionName: schema.libraryApps.versionName }).from(schema.libraryApps).where(eq(schema.libraryApps.package, pkg)),
  ]);
  const nameOf = new Map(versions.map((v) => [v.versionCode, v.versionName]));
  const items = rows.map((r): InstallLogItem => {
    const p = (r.payload ?? {}) as { library?: { versionCode: string; versionName: string | null; preinstall: boolean }; apkPaths?: string[] };
    const legacyCode = p.library ? null : p.apkPaths?.[0]?.slice(legacyPrefix.length).split('/')[0] ?? null;
    const versionCode = p.library?.versionCode ?? legacyCode;
    return {
      taskId: r.id, status: r.status, errorCode: r.errorCode, error: r.error, createdAt: r.createdAt, finishedAt: r.finishedAt,
      instanceId: r.instanceId, instanceName: r.current ?? (r.label ?? '').split(' · ')[0]!, deviceExists: r.current != null,
      operator: r.operator ?? null,
      versionCode, versionName: p.library ? p.library.versionName : (versionCode ? nameOf.get(versionCode) ?? null : null),
      preinstall: p.library ? p.library.preinstall : / · 预装 /.test(r.label ?? ''),
    };
  });
  return { items, total: tot?.n ?? 0 };
}
