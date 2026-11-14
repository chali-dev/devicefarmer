import type { Sql } from 'postgres';

/**
 * Task centre data step (after the schema migrations; idempotent): the old task statuses
 * queued/succeeded become pending/success. Pre-task-centre rows keep payload NULL, which tells
 * startup reconciliation that their input only lived in the BullMQ job (see modules/tasks/core.ts).
 */
export async function migrateTaskStatuses(sql: Sql): Promise<number> {
  const a = await sql`update tasks set status = 'pending' where status = 'queued'`;
  const b = await sql`update tasks set status = 'success' where status = 'succeeded'`;
  return a.count + b.count;
}
