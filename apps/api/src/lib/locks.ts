import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Transaction-scoped advisory lock on a text key (released at commit / rollback; shared by every API process). */
export const advisoryXactLock = (tx: Tx, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

/**
 * Runs `fn` while holding the advisory lock `key` (防并发: check-then-create across requests, processes and colours).
 * `fn` may write through other connections (e.g. createTask): its commits are visible to the next holder, which
 * only gets the lock once this transaction ends. Reads that decide must happen inside `fn`.
 */
export async function withAdvisoryLock<T>(key: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, key);
    return fn(tx);
  });
}

/**
 * Read-modify-write of one jsonb `settings` row without lost updates: two saves of different fields at the same
 * time both survive (防并发). Serialised per key by an advisory lock (no placeholder row is ever written); `next`
 * gets the stored value read inside the lock (undefined = no row) and returns the value to store (undefined = leave the
 * row as it is). Every writer that merges into a row must go through this; plain full replacements need not.
 */
export async function updateSetting<V>(key: string, next: (stored: unknown, tx: Tx) => V | undefined | Promise<V | undefined>): Promise<V | undefined> {
  return withAdvisoryLock(`settings:${key}`, async (tx) => {
    const [row] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
    const value = await next(row?.value, tx);
    if (value === undefined) return undefined;
    await tx.insert(schema.settings).values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
    return value;
  });
}
