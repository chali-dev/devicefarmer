import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, Task } from '../../db/schema.js';
import { events } from '../../lib/events.js';

/** All instance/task writes go through here so every change is broadcast. */
export async function updateInstance(id: string, set: Partial<typeof schema.instances.$inferInsert>): Promise<Instance | undefined> {
  const [row] = await db.update(schema.instances).set(set).where(eq(schema.instances.id, id)).returning();
  if (row) events.publish({ type: 'instance.updated', instance: row });
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
