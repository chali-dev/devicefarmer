import { sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { registerTaskKeepRule } from '../tasks/retention.js';

/** Reply states that still need the scheduling task (and its history) around. */
const REPLY_UNFINISHED = ['draft', 'pending_review', 'approved', 'scheduled', 'sending', 'awaiting_operator'] as const;

// Task retention must not delete the task of a reply that is still in progress.
// (The former comments dashboard widget was removed with the dashboard simplification of 2026-11-19.)
registerTaskKeepRule('comment-reply', (id) => sql`exists (select 1 from ${schema.commentTasks} c where c.task_id = ${id}
  and c.status in (${sql.join(REPLY_UNFINISHED.map((s) => sql`${s}`), sql`, `)}))`);
