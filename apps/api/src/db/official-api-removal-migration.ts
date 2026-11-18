import type { Sql } from 'postgres';

/** Task types whose handlers were removed with the official platform APIs (owner decision 2026-11-18). */
export const REMOVED_TASK_TYPES = ['account-stats', 'comment-sync', 'social-account-check'] as const;
export const REMOVED_TASK_LOG = 'cancelled: official platform APIs removed';
export const REMOVED_PUBLISH_LOG = 'official platform APIs removed: this round will be handed to an operator';
const REMOVED_KIND = 'connection.expired';

export interface OfficialApiRemovalResult {
  connections: number;
  tasks: number;
  publishTasks: number;
  notifications: number;
  alertStates: number;
  channels: number;
  channelsDisabled: number;
  rules: number;
}

/**
 * Data step for the removal of the official platform APIs (OAuth, API publishing, comment sync, account
 * analytics, account checks), run by src/db/migrate.ts after the schema migrations. Idempotent: a second
 * run changes nothing. Tables and columns stay (expand/contract); only data the new code can't use goes:
 * - platform_connections: every row is DELETED, so no sealed OAuth access/refresh token stays at rest
 *   (the table is dropped in the next release; a rollback to the old code finds no connections and the
 *   accounts have to be re-authorised there).
 * - unfinished tasks of the removed types (pending / scheduled / running) are cancelled with a task log
 *   line, so no worker ever fails them as task.unknown_type (a leftover BullMQ job finds a final row and
 *   changes nothing).
 * - publish rounds still waiting (pending / scheduled) whose method says 'api' (a rescheduled round keeps
 *   the last method) get method null and a publish log line: they run as manual (handed to an operator).
 * - alert kind connection.expired: its notifications and de-dup states are deleted, it is removed from
 *   alert channels' kind lists (a channel left with no kind at all would mean "every kind", so it is
 *   disabled instead) and from the stored alert rules (with the removed rule accountCheckHours).
 * `taskIds` (tests only) restricts the task/publish steps to these rows.
 */
export async function migrateOfficialApiRemoval(
  sql: Sql, log: (msg: string) => void = console.log, opts: { taskIds?: string[]; publishTaskIds?: string[] } = {},
): Promise<OfficialApiRemovalResult> {
  return sql.begin(async (tx) => {
    const r: OfficialApiRemovalResult = { connections: 0, tasks: 0, publishTasks: 0, notifications: 0, alertStates: 0, channels: 0, channelsDisabled: 0, rules: 0 };
    r.connections = (await tx`delete from platform_connections`).count;

    const tasks = await tx<{ id: string }[]>`
      update tasks set status = 'cancelled', finished_at = now(), error = ${REMOVED_TASK_LOG}, error_code = null
      where type in ${tx([...REMOVED_TASK_TYPES])} and status in ('pending', 'scheduled', 'running')
        ${opts.taskIds ? tx`and id = any(${opts.taskIds}::uuid[])` : tx``}
      returning id`;
    for (const t of tasks) await tx`insert into task_logs (task_id, level, message) values (${t.id}, 'warn', ${REMOVED_TASK_LOG})`;
    r.tasks = tasks.length;

    const pubs = await tx<{ id: string; attempt_no: number; task_id: string | null }[]>`
      update publish_tasks set method = null
      where method = 'api' and status in ('pending', 'scheduled')
        ${opts.publishTaskIds ? tx`and id = any(${opts.publishTaskIds}::uuid[])` : tx``}
      returning id, attempt_no, task_id`;
    for (const p of pubs) {
      await tx`insert into publish_logs (publish_task_id, level, message, attempt_no, task_id) values (${p.id}, 'warn', ${REMOVED_PUBLISH_LOG}, ${p.attempt_no}, ${p.task_id})`;
    }
    r.publishTasks = pubs.length;

    r.notifications = (await tx`delete from notifications where kind = ${REMOVED_KIND}`).count;
    r.alertStates = (await tx`delete from alert_states where kind = ${REMOVED_KIND}`).count;
    const disabled = await tx`update alert_channels set kinds = '{}', enabled = false where kinds = array[${REMOVED_KIND}]::text[] returning id`;
    r.channelsDisabled = disabled.count;
    r.channels = (await tx`update alert_channels set kinds = array_remove(kinds, ${REMOVED_KIND}) where ${REMOVED_KIND} = any(kinds)`).count + disabled.count;
    r.rules = (await tx`
      update settings set value = (value - 'accountCheckHours') #- ${['kinds', REMOVED_KIND]}::text[], updated_at = now()
      where key = 'alerts.rules' and (value ? 'accountCheckHours' or (value -> 'kinds') ? ${REMOVED_KIND})`).count;

    const parts = Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
    if (parts.length) log(`official platform APIs removed: ${parts.join(', ')}`);
    return r;
  });
}
