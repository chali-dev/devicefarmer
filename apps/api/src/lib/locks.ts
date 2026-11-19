import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { HttpError } from './errors.js';

/**
 * 防并发 helpers. Two kinds of lock, chosen by what the critical section does:
 * - `updateSetting` / `advisoryXactLock`: Postgres advisory locks inside a transaction whose work uses only that
 *   transaction (waiters hold a pooled connection while they wait, so the holder must not need a second one).
 * - `withMutex`: a Redis mutex for check-then-create sections that call createTask / other connections (e.g. "no
 *   unfinished task of this kind for this account, then create one"): nothing is held in the DB pool while waiting.
 * Both are shared by every API process (blue-green colours included).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Transaction-scoped advisory lock on a text key (released at commit / rollback). */
export const advisoryXactLock = (tx: Tx, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

/**
 * Read-modify-write of one jsonb `settings` row without lost updates: two saves of different fields at the same
 * time both survive. Serialised per key by an advisory lock (no placeholder row is ever written); `next` gets the
 * stored value read inside the lock (undefined = no row) and returns the value to store (undefined = leave the row as
 * it is); it must read through `tx` only. Every writer that merges into a row must go through this; plain full
 * replacements need not.
 */
export async function updateSetting<V>(key: string, next: (stored: unknown, tx: Tx) => V | undefined | Promise<V | undefined>): Promise<V | undefined> {
  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, `settings:${key}`);
    const [row] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
    const value = await next(row?.value, tx);
    if (value === undefined) return undefined;
    await tx.insert(schema.settings).values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
    return value;
  });
}

let redis: Redis | null = null;
const client = () => (redis ??= new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 }));
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Runs `fn` alone for `key` (Redis `SET NX PX`, retried every 25 ms for up to `waitMs`, released by token). `ttlMs`
 * bounds a crashed holder. A waiter that gives up gets a 409 `common.busy`; in practice it gets the lock and then
 * sees what the holder did (e.g. `…in_progress`).
 */
export async function withMutex<T>(key: string, fn: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const r = client();
  const k = `mutex:${key}`;
  const token = randomBytes(8).toString('hex');
  const until = Date.now() + (opts.waitMs ?? 15_000);
  while ((await r.set(k, token, 'PX', opts.ttlMs ?? 30_000, 'NX')) !== 'OK') {
    if (Date.now() > until) throw new HttpError(409, '操作正在进行中，请稍后再试', 'common.busy');
    await new Promise((res) => setTimeout(res, 25));
  }
  try {
    return await fn();
  } finally {
    await r.eval(RELEASE, 1, k, token).catch(() => undefined);
  }
}
