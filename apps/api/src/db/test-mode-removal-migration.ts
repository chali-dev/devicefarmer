import type { Sql } from 'postgres';

export const TEST_MODE_REMOVED_REPLY_LOG = 'test mode removed: rehearsal turned back into a draft';
export const TEST_MODE_REMOVED_REPLY_CANCELLED_LOG = 'test mode removed: rehearsal cancelled (the comment already has another reply)';
export const TEST_MODE_REMOVED_PUBLISH_LOG = 'test mode removed: rehearsal kept as cancelled, schedule it again with retry';

/**
 * Data step for the removal of the cloud-phone test mode (owner decision 2026-11-18: 云手机发帖 / 云手机发评论 have no
 * test mode any more; everything is saved as a draft first and a person schedules it). Run by src/db/migrate.ts
 * after the schema migrations. `dry_run` stays in both status enums (expand/contract) but is no longer produced.
 *
 * - Replies (`comment_tasks`) in `dry_run` become `draft` again (editable, then 排程): round + 1 so the next send
 *   task gets a new idempotency key, task / method / hand-over / error cleared, the screenshot of the rehearsal kept.
 *   A draft blocks another reply to the same comment (partial unique indexes), so only the newest rehearsal of a
 *   comment / tracked comment without another active reply becomes a draft; the others become `cancelled`
 *   (`comment.test_mode_removed`). Post comments (no comment id) always become drafts. Comment log action
 *   `test_mode_removed`.
 * - Publish tasks in `dry_run` become `cancelled` (`publish.test_mode_removed`): finished like before (the content
 *   status ignores both), and a person schedules it again with 重试 (retry accepts cancelled, picks a time).
 *   Scheduled / pending would publish on their own, which is exactly what the owner does not want. publish_logs row.
 * Idempotent: a second run finds no dry_run rows. `ids` (tests only) restricts the rows of both tables.
 */
export async function migrateTestModeRemoval(sql: Sql, log: (msg: string) => void = console.log, opts: { ids?: string[] } = {}):
  Promise<{ drafts: number; cancelledReplies: number; publish: number }> {
  return sql.begin(async (tx) => {
    const only = opts.ids ? tx`and id = any(${opts.ids}::uuid[])` : tx``;
    const rows = await tx<{ id: string; account_id: string; comment_id: string | null; tracked_comment_id: string | null; task_id: string | null; round: number }[]>`
      select id, account_id, comment_id, tracked_comment_id, task_id, round from comment_tasks
      where status = 'dry_run' ${only}
      order by created_at desc
      for update`;
    let drafts = 0; let cancelledReplies = 0;
    const taken = new Set<string>();
    for (const r of rows) {
      const target = r.comment_id ? `c:${r.comment_id}` : r.tracked_comment_id ? `t:${r.tracked_comment_id}` : null;
      let blocked = !!target && taken.has(target);
      if (target && !blocked) {
        const [other] = r.comment_id
          ? await tx`select 1 from comment_tasks where comment_id = ${r.comment_id} and id <> ${r.id} and status not in ('failed', 'rejected', 'cancelled', 'dry_run') limit 1`
          : await tx`select 1 from comment_tasks where tracked_comment_id = ${r.tracked_comment_id} and id <> ${r.id} and status not in ('failed', 'rejected', 'cancelled', 'dry_run') limit 1`;
        blocked = !!other;
      }
      if (target) taken.add(target);
      if (blocked) {
        await tx`update comment_tasks set status = 'cancelled', error_code = 'comment.test_mode_removed', error = null, updated_at = now() where id = ${r.id}`;
        cancelledReplies++;
      } else {
        await tx`update comment_tasks set status = 'draft', round = ${r.round + 1}, task_id = null, method = null, handed_at = null, submitted_at = null,
          error = null, error_code = null, updated_at = now() where id = ${r.id}`;
        drafts++;
      }
      await tx`insert into comment_logs (account_id, comment_id, comment_task_id, level, action, message, data, task_id)
        values (${r.account_id}, ${r.comment_id}, ${r.id}, ${blocked ? 'warn' : 'info'}, 'test_mode_removed',
          ${blocked ? TEST_MODE_REMOVED_REPLY_CANCELLED_LOG : TEST_MODE_REMOVED_REPLY_LOG},
          ${JSON.stringify({ from: 'dry_run', to: blocked ? 'cancelled' : 'draft', round: blocked ? r.round : r.round + 1 })}::jsonb, ${r.task_id})`;
    }
    const pubs = await tx<{ id: string; attempt_no: number; task_id: string | null }[]>`
      update publish_tasks set status = 'cancelled', error_code = 'publish.test_mode_removed', error = null, updated_at = now()
      where status = 'dry_run' ${only}
      returning id, attempt_no, task_id`;
    for (const p of pubs) {
      await tx`insert into publish_logs (publish_task_id, level, message, data, attempt_no, task_id)
        values (${p.id}, 'info', ${TEST_MODE_REMOVED_PUBLISH_LOG}, ${JSON.stringify({ from: 'dry_run', to: 'cancelled' })}::jsonb, ${p.attempt_no}, ${p.task_id})`;
    }
    if (rows.length || pubs.length) log(`test mode removed: ${drafts} replies back to draft, ${cancelledReplies} cancelled, ${pubs.length} publish tasks cancelled (retry to schedule)`);
    return { drafts, cancelledReplies, publish: pubs.length };
  });
}
