import { lt, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance } from '../../db/schema.js';

/**
 * Device status history (连线监控): `updateInstance` (modules/instances/repo.ts) calls this inside its
 * transaction whenever a write touches `status` or `adb_state`; only real changes become rows.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type StatusSnapshot = Pick<Instance, 'status' | 'adbState'>;

export async function recordTransitions(tx: Tx, id: string, before: StatusSnapshot, after: StatusSnapshot): Promise<void> {
  const rows: (typeof schema.instanceStatusEvents.$inferInsert)[] = [];
  if (before.status !== after.status) rows.push({ instanceId: id, field: 'status', from: before.status, to: after.status, status: after.status });
  if ((before.adbState ?? null) !== (after.adbState ?? null)) rows.push({ instanceId: id, field: 'adb', from: before.adbState, to: after.adbState, status: after.status });
  if (rows.length) await tx.insert(schema.instanceStatusEvents).values(rows);
}

/** Statuses in which a lost adb connection is expected (the platform itself is stopping/starting the device). */
export const TRANSITIONAL = ['creating', 'starting', 'stopping', 'restarting', 'deleting'];

/** SQL condition for an "offline event": adb lost outside a deliberate transition, or the device went to error. */
export function offlineEventCond() {
  const E = schema.instanceStatusEvents;
  return sql`((${E.field} = 'adb' and ${E.from} = 'device' and ${E.status} not in (${sql.join(TRANSITIONAL.map((s) => sql`${s}`), sql`, `)}))
    or (${E.field} = 'status' and ${E.to} = 'error'))`;
}

/** Hourly: drops rows older than `days`, then everything beyond the newest MAX_ROWS (flapping devices). */
const MAX_ROWS = 100_000;
export async function purgeStatusEvents(days: number, now = Date.now()): Promise<number> {
  const E = schema.instanceStatusEvents;
  const old = await db.delete(E).where(lt(E.at, new Date(now - days * 86_400_000))).returning({ id: E.id });
  const over = await db.execute(sql`delete from ${E} where ${E.id} <= (select ${E.id} from ${E} order by ${E.id} desc offset ${MAX_ROWS} limit 1)`);
  return old.length + (over.count ?? 0);
}
