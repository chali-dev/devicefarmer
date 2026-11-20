import { and, eq, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { db, schema } from '../../db/index.js';
import type { Instance, Task } from '../../db/schema.js';
import { events, type PublicTask } from '../../lib/events.js';
import { unlinkInstanceAccounts } from '../social/social.js';
import { recordTransitions } from '../system/history.js';

/** Instance as exposed to clients (every column is safe to show; kept as one place to shape it). */
export type PublicInstance = Instance;

export async function publicInstances(rows: Instance[]): Promise<PublicInstance[]> {
  return rows;
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
  const I = schema.instances;
  // Status / adb changes are also written to the connection history (modules/system/history.ts).
  const [row] = set.status === undefined && set.adbState === undefined
    ? await db.update(I).set(set).where(eq(I.id, id)).returning()
    : await db.transaction(async (tx) => {
      const [before] = await tx.select({ status: I.status, adbState: I.adbState }).from(I).where(eq(I.id, id)).for('update');
      const rows = await tx.update(I).set(set).where(eq(I.id, id)).returning();
      if (before && rows[0]) await recordTransitions(tx, id, before, rows[0]);
      return rows;
    });
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
