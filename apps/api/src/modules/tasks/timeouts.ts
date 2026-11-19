import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

/**
 * 任务超时 (系统配置 → 任务超时, admin; owner 2026-11-19 「把代码写死的超时都移到配置；一个配置一行」): the timeout of one
 * attempt per user-facing task type, stored in settings key `tasks.timeouts` = { [type]: ms }. A type without a stored
 * value uses its handler's `timeoutMs` (registerTaskHandler; publish: env PUBLISH_TIMEOUT_MS), so nothing changes until
 * edited. `createTask` (tasks/core.ts) stores the effective value on every new task (tasks.timeout_ms) unless the caller
 * passes one; a running task keeps its own. Device operations derive their phone lock from it (collector.ts `lockFor`).
 *
 * Not listed (hard-coded on purpose): schedulers / cleanups / alert sends (collection-schedule, tasks-cleanup,
 * notifications-cleanup, notify-*), the legacy AI task types, and the device lifecycle ops (create / start / stop /
 * restart / delete / apply-settings / set-proxy / uninstall-app) which have no timeout: a timeout there would fail the
 * task (and mark the device error) while the container work is still running.
 */
export const TASK_TIMEOUTS_KEY = 'tasks.timeouts';

/** Configurable types in UI order, bounds in minutes. */
export const TIMEOUT_TYPES: Record<string, { min: number; max: number }> = {
  publish: { min: 1, max: 60 },
  'comment-reply': { min: 1, max: 60 },
  'account-device-sync': { min: 1, max: 60 },
  'account-device-check': { min: 1, max: 60 },
  'feed-collect': { min: 2, max: 120 },
  'account-following': { min: 2, max: 120 },
  'tracked-refresh': { min: 1, max: 60 },
  'trending-refresh': { min: 1, max: 30 },
  'media-process': { min: 1, max: 120 },
  'install-apk': { min: 1, max: 120 },
  'import-app': { min: 1, max: 120 },
  'push-asset': { min: 1, max: 120 },
  'db-backup': { min: 5, max: 720 },
  'db-restore': { min: 10, max: 1440 },
};
export const isTimeoutType = (type: string) => Object.hasOwn(TIMEOUT_TYPES, type);

let cache: { at: number; value: Record<string, number>; updatedAt: string | null } | null = null;
const CACHE_MS = 5000;

/** Stored overrides (ms) of the listed types; anything malformed or out of range is ignored. */
export async function storedTimeouts(fresh = false): Promise<{ value: Record<string, number>; updatedAt: string | null }> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, TASK_TIMEOUTS_KEY));
  const value: Record<string, number> = {};
  const raw = (row?.value ?? {}) as Record<string, unknown>;
  for (const [type, b] of Object.entries(TIMEOUT_TYPES)) {
    const ms = raw[type];
    if (typeof ms === 'number' && Number.isInteger(ms) && ms >= b.min * 60_000 && ms <= b.max * 60_000) value[type] = ms;
  }
  cache = { at: Date.now(), value, updatedAt: row ? row.updatedAt.toISOString() : null };
  return cache;
}

/** The configured timeout of `type` (ms), or undefined (= the handler's default). */
export async function configuredTimeout(type: string): Promise<number | undefined> {
  if (!isTimeoutType(type)) return undefined;
  return (await storedTimeouts()).value[type];
}

/** Sets (minutes) or clears (null = default) one type's timeout. Range checked by the caller. */
export async function saveTaskTimeout(type: string, minutes: number | null): Promise<void> {
  const { value } = await storedTimeouts(true);
  const next = { ...value };
  if (minutes === null) delete next[type];
  else next[type] = minutes * 60_000;
  await db.insert(schema.settings).values({ key: TASK_TIMEOUTS_KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  cache = null;
}
