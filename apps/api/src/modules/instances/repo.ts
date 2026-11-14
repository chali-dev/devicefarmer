import { and, eq, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { db, schema } from '../../db/index.js';
import type { Instance, Task } from '../../db/schema.js';
import { events, type PublicTask } from '../../lib/events.js';
import { proxyViews, type InstanceProxyView } from '../proxies/pool.js';
import { unlinkInstanceAccounts } from '../social/social.js';

/**
 * Instance as exposed to clients: the bound pool proxy's non-secret fields only
 * (no username/password; those stay in the admin-only pool API, where the password is write-only).
 */
export type PublicInstance = Instance & { proxy: InstanceProxyView | null };

export async function publicInstances(rows: Instance[]): Promise<PublicInstance[]> {
  const views = await proxyViews(rows.map((r) => r.proxyId).filter((x): x is string => !!x));
  return rows.map((r) => ({ ...r, proxy: r.proxyId ? views.get(r.proxyId) ?? null : null }));
}

export async function publicInstance(row: Instance): Promise<PublicInstance> {
  return (await publicInstances([row]))[0]!;
}

/** Broadcasts the current state of an instance (e.g. after a transactional write). */
export async function publishInstance(row: Instance): Promise<void> {
  events.publish({ type: 'instance.updated', instance: await publicInstance(row) });
}

/** All instance/task writes go through here so every change is broadcast. */
export async function updateInstance(id: string, set: Partial<typeof schema.instances.$inferInsert>): Promise<Instance | undefined> {
  const [row] = await db.update(schema.instances).set(set).where(eq(schema.instances.id, id)).returning();
  if (row) await publishInstance(row);
  return row;
}

export async function getInstance(id: string): Promise<Instance | undefined> {
  const [row] = await db.select().from(schema.instances).where(eq(schema.instances.id, id));
  return row;
}

export async function deleteInstanceRow(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ name: schema.instances.name }).from(schema.instances).where(eq(schema.instances.id, id)).for('update');
    if (row) await unlinkInstanceAccounts(tx, id, row.name);
    await tx.delete(schema.instances).where(eq(schema.instances.id, id));
  });
  events.publish({ type: 'instance.deleted', instanceId: id });
}

export function publicTask(row: Task): PublicTask {
  const { payload: _p, result: _r, ...rest } = row;
  return rest;
}

/** Task writes (modules/tasks/core.ts); `onlyIf` guards status transitions. Undefined = no row matched. */
export async function updateTask(id: string, set: PgUpdateSetSource<typeof schema.tasks>, onlyIf?: SQL): Promise<Task | undefined> {
  const [row] = await db.update(schema.tasks).set(set).where(onlyIf ? and(eq(schema.tasks.id, id), onlyIf) : eq(schema.tasks.id, id)).returning();
  if (row) events.publish({ type: 'task.updated', task: publicTask(row) });
  return row;
}
