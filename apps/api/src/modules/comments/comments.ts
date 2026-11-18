import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { and, eq, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Comment, CommentReplyStatus, CommentTask, SocialAccount, Task } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { visibleAccount, type Tx } from '../social/social.js';
import { cancelTask, createTask, isFinal, registerTaskHandler, type TaskContext } from '../tasks/core.js';

/**
 * Comments & engagement (评论互动, P5).
 *
 * - Received comments are entered by hand (the operator copies them from the phone). The official-API
 *   comment sync (task `comment-sync`, comment_sync_states) was removed on 2026-11-18 by owner decision;
 *   rows it stored earlier (source `api`) stay readable.
 * - Replies (comment_tasks) are always written by a person, optionally from a saved template. No
 *   generated text, no automatic replies, no "reply to all": one reply task per comment request.
 * - No approval step (owner decision 2026-11-18): a submitted reply goes straight to its send task
 *   (draft → scheduled → sending → awaiting_operator). pending_review / approved / rejected stay in the
 *   status list for old rows only; src/db/comment-approval-migration.ts moved waiting rows on.
 * - Anti-abuse (owner's hard constraint), each block written to comment_logs with a reason code:
 *   one reply per comment (unless the previous one failed / was rejected / cancelled; also a DB
 *   partial unique index), the same text at most `duplicateMax` times per account per
 *   `duplicateWindowHours`, at most `sendsPerHour` sends per account (a send over the limit is
 *   deferred to the next free slot, never dropped or pushed through).
 * - Sending (task `comment-reply`, idempotency key comment-reply:<id>:<round>): applies the send rate
 *   limit, then hands the reply to an operator (awaiting_operator), who replies on the phone and records
 *   the outcome. There is no API sending (removed on 2026-11-18).
 */

const C = schema.comments;
const R = schema.commentTasks;
export const REPLY_REF = 'comment_reply';
export const REPLY_TYPE = 'comment-reply';
const REPLY_MAX_ATTEMPTS = 3;
/** Reply states that block another reply to the same comment. */
export const REPLY_ACTIVE: CommentReplyStatus[] = ['draft', 'pending_review', 'approved', 'scheduled', 'sending', 'awaiting_operator', 'sent'];
/** Reply states counted by the duplicate-text rule (submitted and not dropped). */
const DUP_COUNTED: CommentReplyStatus[] = ['pending_review', 'approved', 'scheduled', 'sending', 'awaiting_operator', 'sent'];

type Exec = typeof db | Tx;
type Level = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------- settings

export interface CommentRules {
  /** Same reply text at most this many times per account within the window. */
  duplicateMax: number;
  duplicateWindowHours: number;
  /** Hand-overs to an operator (sends) per account per rolling hour. */
  sendsPerHour: number;
}
const RULES_KEY = 'comments.rules';
export const DEFAULT_RULES: CommentRules = { duplicateMax: 3, duplicateWindowHours: 24, sendsPerHour: 20 };

export async function getRules(exec: Exec = db): Promise<CommentRules> {
  const [row] = await exec.select().from(schema.settings).where(eq(schema.settings.key, RULES_KEY));
  const v = (row?.value ?? {}) as Partial<CommentRules>;
  const int = (x: unknown, d: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 ? x : d);
  return {
    duplicateMax: int(v.duplicateMax, DEFAULT_RULES.duplicateMax),
    duplicateWindowHours: int(v.duplicateWindowHours, DEFAULT_RULES.duplicateWindowHours),
    sendsPerHour: int(v.sendsPerHour, DEFAULT_RULES.sendsPerHour),
  };
}

/** Stored without the removed `requireApproval` (an old row's flag is dropped on the next save). */
export async function saveRules(input: Partial<CommentRules>): Promise<CommentRules> {
  const next = { ...(await getRules()), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  await db.insert(schema.settings).values({ key: RULES_KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return getRules();
}

// ---------------------------------------------------------------- logs

export interface LogInput {
  accountId: string;
  commentId?: string | null;
  commentTaskId?: string | null;
  level?: Level;
  action: string;
  code?: string | null;
  message?: string | null;
  data?: Record<string, unknown>;
  taskId?: string | null;
  actor?: AuthUser | null;
}

export async function commentLog(e: LogInput, exec: Exec = db): Promise<void> {
  await exec.insert(schema.commentLogs).values({
    accountId: e.accountId, commentId: e.commentId ?? null, commentTaskId: e.commentTaskId ?? null, level: e.level ?? 'info',
    action: e.action, code: e.code ?? null, message: e.message?.slice(0, 2000) ?? null, data: e.data ?? null, taskId: e.taskId ?? null,
    actorId: e.actor?.id ?? null, actorName: e.actor?.username ?? null,
  });
}

const replyLog = (r: Pick<CommentTask, 'id' | 'accountId' | 'commentId' | 'taskId'>, e: Omit<LogInput, 'accountId' | 'commentId' | 'commentTaskId'>, exec: Exec = db) =>
  commentLog({ ...e, accountId: r.accountId, commentId: r.commentId, commentTaskId: r.id, taskId: e.taskId ?? r.taskId }, exec);

/** Logs a rule block (reason code) and returns the error to throw. */
async function blocked(r: { accountId: string; commentId?: string | null; commentTaskId?: string | null }, actor: AuthUser | null, err: ReturnType<typeof conflict>, data?: Record<string, unknown>) {
  await commentLog({ ...r, level: 'warn', action: 'blocked', code: err.code, message: err.message, data, actor });
  return err;
}

// ---------------------------------------------------------------- visibility

export async function visibleComment(user: AuthUser, id: string, exec: Exec = db): Promise<Comment> {
  const [row] = await exec.select().from(C).where(eq(C.id, id));
  if (!row || (!isAdmin(user) && row.userId !== user.id)) throw notFound('评论不存在', 'comment.not_found');
  return row;
}

export async function visibleReply(user: AuthUser, id: string, exec: Exec = db): Promise<CommentTask> {
  const [row] = await exec.select().from(R).where(eq(R.id, id));
  if (!row || (!isAdmin(user) && row.userId !== user.id)) throw notFound('回复任务不存在', 'comment.reply_not_found');
  return row;
}

// ---------------------------------------------------------------- comments

export const normalizeText = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const textHash = (s: string) => createHash('sha256').update(normalizeText(s)).digest('hex');

/** Links comments to the scheduler's published post with the same external id (same account). */
async function linkPublishTasks(accountId: string, exec: Exec = db): Promise<void> {
  await exec.execute(sql`
    update comments c set publish_task_id = p.id
    from publish_tasks p
    where c.account_id = ${accountId} and c.publish_task_id is null and c.external_post_id is not null
      and p.account_id = c.account_id and p.external_id = c.external_post_id and p.status = 'published'`);
}

export interface ManualCommentInput {
  accountId: string;
  text: string;
  authorName: string;
  authorHandle?: string | null;
  externalId?: string | null;
  /** Local id of the top-level comment this one replies to (thread). */
  parentId?: string | null;
  externalPostId?: string | null;
  postUrl?: string | null;
  publishedAt?: Date | null;
}

/** Operator enters a comment seen on the phone (source manual). */
export async function createManualComment(user: AuthUser, b: ManualCommentInput): Promise<Comment> {
  const acc = await visibleAccount(user, b.accountId);
  let parentExternalId: string | null = null;
  let externalPostId = b.externalPostId?.trim() || null;
  let postUrl = b.postUrl?.trim() || null;
  if (b.parentId) {
    const parent = await visibleComment(user, b.parentId).catch(() => null);
    if (!parent || parent.accountId !== acc.id) throw badRequest('上级评论不存在或不属于该账号', 'comment.parent_not_found');
    parentExternalId = parent.parentExternalId ?? parent.externalId;
    externalPostId ??= parent.externalPostId;
    postUrl ??= parent.postUrl;
  }
  const externalId = b.externalId?.trim() ? b.externalId.trim() : `manual:${crypto.randomUUID()}`;
  const [row] = await db.insert(C).values({
    userId: acc.userId, accountId: acc.id, platform: acc.platform, source: 'manual', externalId, parentExternalId,
    externalPostId, postUrl, authorName: b.authorName.trim(), authorHandle: b.authorHandle?.trim() || null, text: b.text,
    publishedAt: b.publishedAt ?? null, createdBy: user.id,
  }).onConflictDoNothing().returning();
  if (!row) throw conflict('该账号下已存在相同平台 ID 的评论', 'comment.duplicate_external_id');
  await linkPublishTasks(acc.id);
  await commentLog({ accountId: acc.id, commentId: row.id, action: 'entered', message: 'comment entered manually', data: { externalId, parentExternalId }, actor: user });
  const [cur] = await db.select().from(C).where(eq(C.id, row.id));
  return cur!;
}

/** Local status (never changes anything on the platform). `replied` is set by the reply workflow only. */
export async function setCommentStatus(user: AuthUser, c: Comment, status: 'new' | 'read' | 'hidden' | 'ignored'): Promise<Comment> {
  if (c.status === status) return c;
  const [row] = await db.update(C).set({ status }).where(eq(C.id, c.id)).returning();
  await commentLog({ accountId: c.accountId, commentId: c.id, action: 'status', message: `${c.status} → ${status}`, data: { from: c.status, to: status }, actor: user });
  return row!;
}

/** Deletes a manually entered comment (and its reply history). API comments are kept (hide them instead). */
export async function deleteManualComment(user: AuthUser, c: Comment): Promise<void> {
  if (c.source !== 'manual') throw conflict('只能删除人工录入的评论，接口同步的评论可以隐藏', 'comment.not_manual');
  const [busy] = await db.select({ id: R.id }).from(R).where(and(eq(R.commentId, c.id), inArray(R.status, ['approved', 'scheduled', 'sending', 'awaiting_operator'])));
  if (busy) throw conflict('该评论有正在发送的回复，请先取消', 'comment.reply_in_progress');
  await db.delete(C).where(eq(C.id, c.id));
}

// ---------------------------------------------------------------- replies: compose / review

const lockKey = (tx: Tx, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
const isUnique = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
};

/** Duplicate-text rule: throws (and logs) when the same text was already used `duplicateMax` times in the window. */
async function assertNotDuplicate(tx: Tx, actor: AuthUser | null, r: Pick<CommentTask, 'id' | 'accountId' | 'commentId' | 'textHash'> & { id: string | null }, rules: CommentRules): Promise<void> {
  await lockKey(tx, `comment-dup:${r.accountId}`);
  const since = new Date(Date.now() - rules.duplicateWindowHours * 3600_000);
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(R).where(and(
    eq(R.accountId, r.accountId), eq(R.textHash, r.textHash), inArray(R.status, DUP_COUNTED), isNotNull(R.submittedAt), gte(R.submittedAt, since),
    r.id ? ne(R.id, r.id) : undefined,
  ));
  if (n >= rules.duplicateMax) {
    throw await blocked({ accountId: r.accountId, commentId: r.commentId, commentTaskId: r.id }, actor,
      conflict(`相同的回复内容在 ${rules.duplicateWindowHours} 小时内已使用 ${n} 次（上限 ${rules.duplicateMax}），请针对这条评论单独撰写`, 'comment.duplicate_text',
        { max: rules.duplicateMax, hours: rules.duplicateWindowHours, count: n }), { count: n });
  }
}

export interface ReplyInput { text: string; templateId?: string | null; submit?: boolean; scheduledAt?: Date | null }

/** Writes a reply to one comment (draft, or submitted at once). One active reply per comment. */
export async function createReply(user: AuthUser, comment: Comment, b: ReplyInput): Promise<CommentTask> {
  const text = b.text.trim();
  if (!text) throw badRequest('回复内容不能为空', 'comment.text_empty');
  if (b.templateId) await visibleTemplate(user, b.templateId);
  let row: CommentTask;
  try {
    row = await db.transaction(async (tx) => {
      await lockKey(tx, `comment-reply:${comment.id}`);
      const [prior] = await tx.select({ id: R.id, status: R.status }).from(R).where(and(eq(R.commentId, comment.id), inArray(R.status, REPLY_ACTIVE)));
      if (prior) {
        throw await blocked({ accountId: comment.accountId, commentId: comment.id }, user,
          conflict('这条评论已有回复（每条评论只能回复一次，除非之前的回复失败或被取消）', 'comment.already_replied', { status: prior.status }), { existing: prior.id, status: prior.status });
      }
      const [r] = await tx.insert(R).values({
        userId: comment.userId, accountId: comment.accountId, commentId: comment.id, platform: comment.platform, text, textHash: textHash(text),
        templateId: b.templateId ?? null, status: 'draft', scheduledAt: b.scheduledAt ?? null, maxAttempts: REPLY_MAX_ATTEMPTS,
        authorId: user.id, authorName: user.username,
      }).returning();
      await replyLog(r!, { action: 'created', message: 'draft written', data: { templateId: b.templateId ?? null }, actor: user }, tx);
      return r!;
    });
  } catch (err) {
    if (isUnique(err)) {
      throw await blocked({ accountId: comment.accountId, commentId: comment.id }, user, conflict('这条评论已有回复', 'comment.already_replied', { status: 'unknown' }));
    }
    throw err;
  }
  if (comment.status === 'new') await db.update(C).set({ status: 'read' }).where(and(eq(C.id, comment.id), eq(C.status, 'new')));
  return b.submit ? submitReply(user, row, b.scheduledAt) : row;
}

export async function editReply(user: AuthUser, r: CommentTask, b: { text?: string; scheduledAt?: Date | null; templateId?: string | null }): Promise<CommentTask> {
  if (r.status !== 'draft') throw conflict(`当前状态（${r.status}）不能修改`, 'comment.bad_status', { status: r.status });
  const text = b.text !== undefined ? b.text.trim() : r.text;
  if (!text) throw badRequest('回复内容不能为空', 'comment.text_empty');
  if (b.templateId) await visibleTemplate(user, b.templateId);
  return db.transaction(async (tx) => {
    const set = { text, textHash: textHash(text), ...(b.scheduledAt !== undefined ? { scheduledAt: b.scheduledAt } : {}), ...(b.templateId !== undefined ? { templateId: b.templateId } : {}) };
    const [done] = await tx.update(R).set(set).where(and(eq(R.id, r.id), eq(R.status, 'draft'))).returning();
    if (!done) throw conflict('回复状态已变化', 'comment.bad_status', { status: 'changed' });
    await replyLog(done, { action: 'edited', data: { textChanged: text !== r.text, scheduledAt: done.scheduledAt?.toISOString() ?? null }, actor: user }, tx);
    return done;
  });
}

/** draft → scheduled: the send task of round 1 is created at once (runAt = scheduledAt). No approval step. */
export async function submitReply(user: AuthUser, r: CommentTask, scheduledAt?: Date | null): Promise<CommentTask> {
  if (r.status !== 'draft') throw conflict(`当前状态（${r.status}）不能提交`, 'comment.bad_status', { status: r.status });
  const rules = await getRules();
  const row = await db.transaction(async (tx) => {
    await assertNotDuplicate(tx, user, r, rules);
    const [done] = await tx.update(R).set({ status: 'scheduled', submittedAt: new Date(), ...(scheduledAt !== undefined ? { scheduledAt } : {}) })
      .where(and(eq(R.id, r.id), eq(R.status, 'draft'))).returning();
    if (!done) throw conflict('回复状态已变化', 'comment.bad_status', { status: 'changed' });
    await replyLog(done, { action: 'submitted', message: 'submitted', actor: user }, tx);
    return done;
  });
  return scheduleSend(row, user);
}

// ---------------------------------------------------------------- replies: sending

/**
 * Creates the task-centre task of the reply's current round (runAt = scheduledAt). The reply is `scheduled`
 * until its task runs (also for "now"; `approved` is only on old rows).
 */
async function scheduleSend(r: CommentTask, actor: AuthUser | null): Promise<CommentTask> {
  const now = new Date();
  const when = r.scheduledAt && r.scheduledAt > now ? r.scheduledAt : null;
  const [acc] = await db.select({ handle: schema.socialAccounts.handle }).from(schema.socialAccounts).where(eq(schema.socialAccounts.id, r.accountId));
  try {
    const { task } = await createTask({
      type: REPLY_TYPE, userId: r.userId, label: `${r.platform} @${acc?.handle ?? '?'} · ${r.text}`.slice(0, 200),
      refType: REPLY_REF, refId: r.id, payload: { commentTaskId: r.id, round: r.round },
      runAt: when, idempotencyKey: `comment-reply:${r.id}:${r.round}`, maxAttempts: r.maxAttempts,
    });
    const [done] = await db.update(R).set({ taskId: task.id, status: 'scheduled' })
      .where(and(eq(R.id, r.id), eq(R.round, r.round), inArray(R.status, ['approved', 'scheduled']))).returning();
    await replyLog(done ?? r, { action: when ? 'scheduled' : 'queued', data: { runAt: when?.toISOString() ?? null, round: r.round }, taskId: task.id, actor });
    return done ?? r;
  } catch (err) {
    const [failed] = await db.update(R).set({ status: 'failed', error: (err as Error).message.slice(0, 500), errorCode: 'comment.enqueue_failed' })
      .where(and(eq(R.id, r.id), inArray(R.status, ['approved', 'scheduled']))).returning();
    if (failed) await replyLog(failed, { level: 'error', action: 'failed', code: 'comment.enqueue_failed', message: (err as Error).message });
    throw err;
  }
}

async function currentTask(r: CommentTask): Promise<Task | undefined> {
  if (!r.taskId) return undefined;
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, r.taskId));
  return t;
}

/** Cancel before it is sent (draft, review, queued/scheduled, or handed to an operator). */
export async function cancelReply(user: AuthUser, r: CommentTask): Promise<CommentTask> {
  const from: CommentReplyStatus[] = ['draft', 'pending_review', 'approved', 'scheduled', 'awaiting_operator'];
  if (!from.includes(r.status)) throw conflict(`当前状态（${r.status}）不能取消`, 'comment.bad_status', { status: r.status });
  if (r.status === 'approved' || r.status === 'scheduled') {
    const t = await currentTask(r);
    if (t && !isFinal(t.status)) {
      if (t.status === 'running') throw conflict('回复正在发送，无法取消', 'comment.bad_status', { status: 'sending' });
      await cancelTask(t, user.username); // onFailure marks the reply cancelled
    }
  }
  const [done] = await db.update(R).set({ status: 'cancelled', errorCode: 'comment.cancelled', error: null })
    .where(and(eq(R.id, r.id), inArray(R.status, from))).returning();
  if (done) await replyLog(done, { level: 'warn', action: 'cancelled', data: { from: r.status }, actor: user });
  const [cur] = await db.select().from(R).where(eq(R.id, r.id));
  if (cur?.status !== 'cancelled') throw conflict(`当前状态（${cur?.status}）不能取消`, 'comment.bad_status', { status: cur?.status ?? 'unknown' });
  return cur;
}

async function markReplied(commentId: string): Promise<void> {
  await db.update(C).set({ status: 'replied' }).where(eq(C.id, commentId));
}

/** Operator records the outcome of a manual reply. */
export async function recordReplyOutcome(user: AuthUser, r: CommentTask, o: { result: 'sent' | 'failed'; reason?: string | null; externalReplyId?: string | null }): Promise<CommentTask> {
  if (o.result === 'failed' && !o.reason?.trim()) throw badRequest('请填写失败原因', 'comment.outcome_needs_reason');
  const set = o.result === 'sent'
    ? { status: 'sent' as const, sentAt: new Date(), senderId: user.id, senderName: user.username, externalReplyId: o.externalReplyId?.trim() || null, error: null, errorCode: null }
    : { status: 'failed' as const, senderId: user.id, senderName: user.username, error: o.reason!.trim().slice(0, 1000), errorCode: 'comment.operator_failed' };
  const [done] = await db.update(R).set(set).where(and(eq(R.id, r.id), eq(R.status, 'awaiting_operator'))).returning();
  if (!done) throw conflict('只有等待人工处理的回复可以记录结果', 'comment.bad_status', { status: r.status });
  if (o.result === 'sent') await markReplied(done.commentId);
  await replyLog(done, o.result === 'sent'
    ? { action: 'sent', message: 'operator recorded: sent', data: { method: 'manual', externalReplyId: set.externalReplyId ?? null }, actor: user }
    : { level: 'error', action: 'failed', code: 'comment.operator_failed', message: set.error ?? null, actor: user });
  return done;
}

/** Non-retryable, coded failure of a run (keeps the code in tasks.error_code). */
class ReplyCheckError extends UnrecoverableError {
  constructor(readonly code: string, message: string) { super(message); }
}
type ReplyPayload = { commentTaskId: string; round?: number };

async function runReply(ctx: TaskContext<ReplyPayload>): Promise<unknown> {
  const id = ctx.payload.commentTaskId ?? ctx.task.refId!;
  const rules = await getRules();
  // Claim + rate limit under a per-account lock: concurrent sends of one account serialize.
  const claim = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(R).where(eq(R.id, id)).for('update');
    if (!r) return { kind: 'gone' as const };
    // `sending` of this same task = an earlier attempt was cut off before the hand-over (nothing is ever sent automatically).
    // `approved` = an old row queued before the approval step was removed.
    if (r.taskId !== ctx.task.id || !['approved', 'scheduled', 'sending'].includes(r.status)) return { kind: 'skip' as const, r };
    await lockKey(tx, `comment-send:${r.accountId}`);
    const hourAgo = new Date(Date.now() - 3600_000);
    const recent = await tx.select({ at: sql<Date>`coalesce(${R.sentAt}, ${R.handedAt}, ${R.updatedAt})` }).from(R).where(and(
      eq(R.accountId, r.accountId), ne(R.id, r.id),
      or(and(eq(R.status, 'sent'), gte(R.sentAt, hourAgo)), eq(R.status, 'sending'), and(eq(R.status, 'awaiting_operator'), gte(R.handedAt, hourAgo))),
    ));
    if (recent.length >= rules.sendsPerHour) {
      const oldest = Math.min(...recent.map((x) => new Date(x.at).getTime()));
      const retryAt = new Date(Math.max(oldest + 3600_000, Date.now()) + 5_000);
      const [n] = await tx.update(R).set({ status: 'scheduled', scheduledAt: retryAt, round: r.round + 1, taskId: null }).where(eq(R.id, r.id)).returning();
      await replyLog(r, { level: 'warn', action: 'blocked', code: 'comment.rate_limited',
        message: `send rate limit reached (${recent.length}/${rules.sendsPerHour} per hour), deferred`, data: { retryAt: retryAt.toISOString(), limit: rules.sendsPerHour }, taskId: ctx.task.id }, tx);
      return { kind: 'deferred' as const, r: n!, retryAt };
    }
    const [n] = await tx.update(R).set({ status: 'sending', error: null, errorCode: null }).where(eq(R.id, r.id)).returning();
    return { kind: 'claimed' as const, r: n! };
  });
  if (claim.kind === 'gone') throw new ReplyCheckError('comment.reply_gone', 'the reply task no longer exists');
  if (claim.kind === 'skip') {
    await ctx.log('warn', 'not executed: the reply is no longer driven by this task', { status: claim.r.status, currentTaskId: claim.r.taskId });
    return { skipped: true, status: claim.r.status };
  }
  if (claim.kind === 'deferred') {
    await ctx.log('warn', 'rate limit reached: deferred to a new round', { retryAt: claim.retryAt.toISOString() });
    const next = await scheduleSend(claim.r, null);
    return { deferred: true, retryAt: claim.retryAt.toISOString(), nextTaskId: next.taskId };
  }
  const r = claim.r;
  const log = async (level: Level, action: string, message: string, data?: Record<string, unknown>, code?: string) => {
    await replyLog(r, { level, action, message, data, code, taskId: ctx.task.id });
    await ctx.log(level, message, { ...data, ...(code ? { code } : {}) });
  };
  await log('info', 'run', `send started (attempt ${ctx.attempt}/${ctx.task.maxAttempts})`);
  try {
    const [comment] = await db.select().from(C).where(eq(C.id, r.commentId));
    if (!comment) throw new ReplyCheckError('comment.comment_gone', 'the comment no longer exists');
    const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, r.accountId));
    if (!acc) throw new ReplyCheckError('comment.account_gone', 'the social account no longer exists');
    if (acc.userId !== r.userId) throw new ReplyCheckError('comment.account_owner_changed', 'the account now belongs to another user');
    if (acc.accountStatus !== 'active') throw new ReplyCheckError('comment.account_inactive', `account status is ${acc.accountStatus}`);
    const [sent] = await db.select({ id: R.id }).from(R).where(and(eq(R.commentId, r.commentId), eq(R.status, 'sent'), ne(R.id, r.id)));
    if (sent) {
      await replyLog(r, { level: 'warn', action: 'blocked', code: 'comment.already_replied', message: 'the comment was already replied to', data: { existing: sent.id }, taskId: ctx.task.id });
      throw new ReplyCheckError('comment.already_replied', 'the comment was already replied to');
    }
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const [done] = await db.update(R).set({ status: 'awaiting_operator', method: 'manual', handedAt: new Date() })
      .where(and(eq(R.id, r.id), eq(R.taskId, ctx.task.id), eq(R.status, 'sending'))).returning();
    await log('info', 'handed_over', 'handed over to an operator: reply by hand on the phone, then record the outcome', { recorded: !!done });
    return { state: 'awaiting_operator', method: 'manual' };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const code = typeof e.code === 'string' ? e.code : 'comment.failed';
    if (!ctx.signal.aborted) {
      // Check failures are final; anything else (e.g. a database error) is retried while attempts remain.
      const final = err instanceof UnrecoverableError || ctx.attempt >= ctx.task.maxAttempts;
      await db.update(R).set({ status: final ? 'failed' : 'scheduled', error: (e.message ?? String(err)).slice(0, 1000), errorCode: code })
        .where(and(eq(R.id, r.id), eq(R.taskId, ctx.task.id), eq(R.status, 'sending')));
      await log(final ? 'error' : 'warn', final ? 'failed' : 'retry', final ? `failed: ${e.message}` : `attempt failed, will retry: ${e.message}`, undefined, code);
    }
    throw err;
  }
}

registerTaskHandler<ReplyPayload>(REPLY_TYPE, {
  queue: 'task-ops',
  timeoutMs: 2 * 60_000,
  maxAttempts: REPLY_MAX_ATTEMPTS,
  backoffMs: 15_000,
  // A new attempt goes through the comments workflow (write a new reply); retry in the task centre would bypass the rules.
  retryable: false,
  run: runReply,
  async onFailure(task) {
    const id = (task.payload as ReplyPayload | null)?.commentTaskId ?? task.refId;
    if (!id) return;
    const status = task.status === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    const [row] = await db.update(R).set({ status, error: task.error, errorCode: task.errorCode ?? (status === 'cancelled' ? 'comment.cancelled' : 'comment.failed') })
      .where(and(eq(R.id, id), eq(R.taskId, task.id), inArray(R.status, ['approved', 'scheduled', 'sending']))).returning();
    if (row) await replyLog(row, { level: status === 'cancelled' ? 'warn' : 'error', action: status, code: row.errorCode, message: `task ${task.status}`, taskId: task.id });
  },
});

// ---------------------------------------------------------------- templates

const TPL = schema.commentTemplates;

/** Own templates, shared ones (user_id null) and, for admins, everyone's. 404 otherwise. */
export async function visibleTemplate(user: AuthUser, id: string) {
  const [row] = await db.select().from(TPL).where(eq(TPL.id, id));
  if (!row || (!isAdmin(user) && row.userId !== null && row.userId !== user.id)) throw notFound('模板不存在', 'comment.template_not_found');
  return row;
}

/** Shared templates are managed by admins only; private ones by their owner (or an admin). */
export function assertTemplateWritable(user: AuthUser, row: { userId: string | null }) {
  if (row.userId === null && !isAdmin(user)) throw forbidden('只有管理员可以修改共享模板', 'comment.admin_only');
}
