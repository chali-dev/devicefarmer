import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, Task } from '../../db/schema.js';
import { events } from '../../lib/events.js';

/** Instance as exposed to clients: proxy password is never returned (write-only). */
export type PublicInstance = Omit<Instance, 'proxy'> & { proxy: (Omit<NonNullable<Instance['proxy']>, 'password'> & { hasPassword: boolean }) | null };
export function publicInstance(i: Instance): PublicInstance {
  if (!i.proxy) return { ...i, proxy: null };
  const { password, ...rest } = i.proxy;
  return { ...i, proxy: { ...rest, hasPassword: Boolean(password) } };
}

/** All instance/task writes go through here so every change is broadcast. */
export async function updateInstance(id: string, set: Partial<typeof schema.instances.$inferInsert>): Promise<Instance | undefined> {
  const [row] = await db.update(schema.instances).set(set).where(eq(schema.instances.id, id)).returning();
  if (row) events.publish({ type: 'instance.updated', instance: publicInstance(row) });
  return row;
}

export async function getInstance(id: string): Promise<Instance | undefined> {
  const [row] = await db.select().from(schema.instances).where(eq(schema.instances.id, id));
  return row;
}

export async function deleteInstanceRow(id: string): Promise<void> {
  await db.delete(schema.instances).where(eq(schema.instances.id, id));
  events.publish({ type: 'instance.deleted', instanceId: id });
}

export async function updateTask(id: string, set: Partial<typeof schema.tasks.$inferInsert>): Promise<Task | undefined> {
  const [row] = await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).returning();
  if (row) events.publish({ type: 'task.updated', task: row });
  return row;
}
