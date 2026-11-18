import type { Sql } from 'postgres';

export const APPROVAL_REMOVED_LOG = 'approval removed';
const REPLY_TYPE = 'comment-reply';
const REPLY_TIMEOUT_MS = 2 * 60_000;

/**
 * Data step for the removal of the comment-reply approval (owner decision 2026-11-18), run by
 * src/db/migrate.ts after the schema migrations. Every reply still waiting in the old flow moves on as the
 * new flow would have moved it, with a comment_logs row (action `approval_removed`):
 * - `approved` whose send task is still unfinished: only the status becomes `scheduled` (same task).
 * - `pending_review`, and `approved` without a live task: a `comment-reply` task row is created for the
 *   reply (round kept for pending_review, +1 for an approved one so its key is new; runAt = scheduled_at if
 *   in the future) and the reply becomes `scheduled` pointing at it. The task row has no BullMQ job yet:
 *   the API's startup reconciliation (reconcileTasks, run when a process becomes the background leader)
 *   enqueues pending/scheduled tasks without a job; at its time the run hands the reply to an operator.
 * Statuses stay in the enum (expand/contract): old code after a rollback still reads `scheduled` rows.
 * Idempotent: a second run finds no pending_review / approved rows. `ids` (tests only) restricts the rows.
 */
export async function migrateCommentApproval(sql: Sql, log: (msg: string) => void = console.log, opts: { ids?: string[] } = {}): Promise<{ scheduled: number; kept: number }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; status: string; round: number; task_id: string | null; scheduled_at: Date | string | null; max_attempts: number;
      user_id: string; account_id: string; comment_id: string; platform: string; text: string; handle: string | null; task_status: string | null }[]>`
      select r.id, r.status, r.round, r.task_id, r.scheduled_at, r.max_attempts, r.user_id, r.account_id, r.comment_id, r.platform, r.text,
        s.handle, t.status as task_status
      from comment_tasks r
      left join social_accounts s on s.id = r.account_id
      left join tasks t on t.id = r.task_id and t.type = ${REPLY_TYPE}
      where r.status in ('pending_review', 'approved') ${opts.ids ? tx`and r.id = any(${opts.ids}::uuid[])` : tx``}
      order by r.created_at
      for update of r`;
    let scheduled = 0; let kept = 0;
    for (const r of rows) {
      let taskId = r.task_id;
      let round = r.round;
      const live = r.status === 'approved' && r.task_id && ['pending', 'scheduled', 'running'].includes(r.task_status ?? '');
      if (live) {
        kept++;
      } else {
        if (r.status === 'approved' && r.task_id) round = r.round + 1;
        // drizzle's postgres-js setup hands timestamps over as strings and passes json/dates through unserialised
        const at = r.scheduled_at ? new Date(r.scheduled_at) : null;
        const runAt = at && at.getTime() > Date.now() ? at : null;
        const key = `comment-reply:${r.id}:${round}`;
        const label = `${r.platform} @${r.handle ?? '?'} · ${r.text}`.slice(0, 200);
        const [t] = await tx<{ id: string }[]>`
          insert into tasks (type, instance_name, ref_type, ref_id, status, payload, max_attempts, timeout_ms, idempotency_key, run_at, created_by)
          values (${REPLY_TYPE}, ${label}, 'comment_reply', ${r.id}, ${runAt ? 'scheduled' : 'pending'}, ${JSON.stringify({ commentTaskId: r.id, round })}::jsonb,
            ${r.max_attempts}, ${REPLY_TIMEOUT_MS}, ${key}, ${runAt ? runAt.toISOString() : null}::timestamptz, ${r.user_id})
          on conflict do nothing returning id`;
        if (t) {
          taskId = t.id;
          await tx`insert into task_logs (task_id, level, message, data) values (${t.id}, 'info', ${runAt ? 'scheduled' : 'created'}, ${JSON.stringify({ reason: APPROVAL_REMOVED_LOG })}::jsonb)`;
        } else {
          const [ex] = await tx<{ id: string }[]>`select id from tasks where type = ${REPLY_TYPE} and idempotency_key = ${key}`;
          taskId = ex?.id ?? null;
        }
        scheduled++;
      }
      await tx`update comment_tasks set status = 'scheduled', task_id = ${taskId}, round = ${round}, submitted_at = coalesce(submitted_at, now()), updated_at = now() where id = ${r.id}`;
      await tx`insert into comment_logs (account_id, comment_id, comment_task_id, level, action, message, data, task_id)
        values (${r.account_id}, ${r.comment_id}, ${r.id}, 'info', 'approval_removed', ${APPROVAL_REMOVED_LOG}, ${JSON.stringify({ from: r.status, taskId, round })}::jsonb, ${taskId})`;
    }
    if (rows.length) log(`comment replies: approval removed, ${scheduled} queued for sending, ${kept} already queued`);
    return { scheduled, kept };
  });
}
