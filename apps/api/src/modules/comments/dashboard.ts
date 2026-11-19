import { count, eq, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { registerDashboardWidget, type DashboardCtx } from '../dashboard/registry.js';
import { registerTaskKeepRule } from '../tasks/retention.js';

/** Reply states that still need the scheduling task (and its history) around. */
const REPLY_UNFINISHED = ['draft', 'scheduled', 'sending', 'awaiting_operator'] as const;

// Task retention must not delete the task of a reply that is still in progress.
registerTaskKeepRule('comment-reply', (id) => sql`exists (select 1 from ${schema.commentTasks} c where c.task_id = ${id}
  and c.status in (${sql.join(REPLY_UNFINISHED.map((s) => sql`${s}`), sql`, `)}))`);

const own = (ctx: DashboardCtx, col: typeof schema.comments.userId | typeof schema.commentTasks.userId): SQL | undefined =>
  (ctx.admin ? undefined : eq(col, ctx.scope.id));

/** Comments & engagement (评论互动): comments by status, replies by state, last-7-day sent/failed. */
registerDashboardWidget('comments', async (ctx) => {
  const C = schema.comments; const R = schema.commentTasks;
  const since = new Date(ctx.now.getTime() - 7 * 86400_000).toISOString();
  const [comments, replies] = await Promise.all([
    db.select({ k: C.status, n: count() }).from(C).where(own(ctx, C.userId)).groupBy(C.status),
    db.select({
      k: R.status, n: count(),
      recent: sql<number>`count(*) filter (where ${R.updatedAt} >= ${since}::timestamptz)::int`,
    }).from(R).where(own(ctx, R.userId)).groupBy(R.status),
  ]);
  const c = Object.fromEntries(comments.map((r) => [r.k, Number(r.n)])) as Record<string, number>;
  const r = Object.fromEntries(replies.map((x) => [x.k, Number(x.n)])) as Record<string, number>;
  const recent = Object.fromEntries(replies.map((x) => [x.k, Number(x.recent)])) as Record<string, number>;
  return {
    total: comments.reduce((s, x) => s + Number(x.n), 0),
    unread: c.new ?? 0,
    /** Replies written but not submitted. */
    drafts: r.draft ?? 0,
    awaitingOperator: r.awaiting_operator ?? 0,
    queued: (r.scheduled ?? 0) + (r.sending ?? 0),
    sent7d: recent.sent ?? 0,
    failed7d: recent.failed ?? 0,
  };
}, { order: 65 });
