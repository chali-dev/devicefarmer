import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { and, eq, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Comment, CommentReplyStatus, CommentTask, SocialAccount, Task } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { assertPlatformEnabled } from '../../lib/platforms-enabled.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { connectionFor } from '../platforms/connections.js';
import { isConfigured } from '../platforms/credentials.js';
import { apiListComments, apiReplyToComment, platformCapabilities } from '../platforms/service.js';
import type { PlatformComment } from '../platforms/types.js';
import { visibleAccount, type Tx } from '../social/social.js';
import { cancelTask, createTask, isFinal, registerTaskHandler, type TaskContext } from '../tasks/core.js';

/**
 * Comments & engagement (评论互动, P5).
 *
 * - Received comments are synced per account through the official API (task `comment-sync`, cursor in
 *   comment_sync_states) or entered by hand (platforms without a comment API, e.g. TikTok).
 * - Replies (comment_tasks) are always written by a person, optionally from a saved template. No
 *   generated text, no automatic replies, no "reply to all": one reply task per comment request.
 * - Review: with `requireApproval` (default on) a user's reply needs approval by someone else who can
 *   see it (an admin, or the account owner when an admin wrote it). Admins may approve their own.
 * - Anti-abuse (owner's hard constraint), each block written to comment_logs with a reason code:
 *   one reply per comment (unless the previous one failed / was rejected / cancelled; also a DB
 *   partial unique index), the same text at most `duplicateMax` times per account per
 *   `duplicateWindowHours`, at most `sendsPerHour` sends per account (a send over the limit is
 *   deferred to the next free slot, never dropped or pushed through).
 * - Sending (task `comment-reply`, idempotency key comment-reply:<id>:<round>): official API when the
 *   platform supports replies, the app is configured, the account has a connected OAuth connection
 *   and the comment came from the API; otherwise the reply is handed to an operator
 *   (awaiting_operator), who replies on the phone and records the outcome.
 */

const C = schema.comments;
const R = schema.commentTasks;
export const SYNC_REF = 'comment_sync';
export const REPLY_REF = 'comment_reply';
export const SYNC_TYPE = 'comment-sync';
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
  /** Users' replies need approval before sending. */
  requireApproval: boolean;
  /** Same reply text at most this many times per account within the window. */
  duplicateMax: number;
  duplicateWindowHours: number;
  /** Sends (API or manual hand-over) per account per rolling hour. */
  sendsPerHour: number;
}
const RULES_KEY = 'comments.rules';
export const DEFAULT_RULES: CommentRules = { requireApproval: true, duplicateMax: 3, duplicateWindowHours: 24, sendsPerHour: 20 };

export async function getRules(exec: Exec = db): Promise<CommentRules> {
  const [row] = await exec.select().from(schema.settings).where(eq(schema.settings.key, RULES_KEY));
  const v = (row?.value ?? {}) as Partial<CommentRules>;
  const int = (x: unknown, d: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 ? x : d);
  return {
    requireApproval: typeof v.requireApproval === 'boolean' ? v.requireApproval : DEFAULT_RULES.requireApproval,
    duplicateMax: int(v.duplicateMax, DEFAULT_RULES.duplicateMax),
    duplicateWindowHours: int(v.duplicateWindowHours, DEFAULT_RULES.duplicateWindowHours),
    sendsPerHour: int(v.sendsPerHour, DEFAULT_RULES.sendsPerHour),
  };
}

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

// ---------------------------------------------------------------- capability / method

export interface ReplyMode { mode: 'api' | 'manual'; reason: string | null }

/** How this account can read comments: 'api' (sync) or 'manual' (entry form) with the reason. */
export async function readMode(account: SocialAccount): Promise<ReplyMode> {
  const caps = await platformCapabilities(account.platform);
  if (!caps?.commentsRead) return { mode: 'manual', reason: 'platform.capability_unsupported' };
  if (!(await isConfigured(account.platform))) return { mode: 'manual', reason: 'platform.not_configured' };
  const conn = await connectionFor(account.id);
  if (!conn) return { mode: 'manual', reason: 'platform.not_connected' };
  if (conn.status === 'expired' || conn.status === 'revoked') return { mode: 'manual', reason: 'platform.auth_expired' };
  return { mode: 'api', reason: null };
}

/** How a reply to `comment` would be sent now. Manual-entry comments have no platform id to reply to. */
export async function replyMode(account: SocialAccount, comment: Pick<Comment, 'source'>): Promise<ReplyMode> {
  const caps = await platformCapabilities(account.platform);
  if (!caps?.commentsReply) return { mode: 'manual', reason: 'platform.capability_unsupported' };
  if (comment.source !== 'api') return { mode: 'manual', reason: 'comment.manual_source' };
  if (!(await isConfigured(account.platform))) return { mode: 'manual', reason: 'platform.not_configured' };
  const conn = await connectionFor(account.id);
  if (!conn) return { mode: 'manual', reason: 'platform.not_connected' };
  if (conn.status !== 'connected') return { mode: 'manual', reason: conn.status === 'error' ? 'comment.connection_error' : 'platform.auth_expired' };
  return { mode: 'api', reason: null };
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

// ---------------------------------------------------------------- sync

/** Starts (or returns the running) comment-sync task of the account. */
export async function startSync(user: AuthUser, account: SocialAccount): Promise<{ task: Task; created: boolean }> {
  assertPlatformEnabled(account.platform);
  const caps = await platformCapabilities(account.platform);
  if (!caps?.commentsRead) throw conflict('该平台没有读取评论的官方接口，请人工录入评论', 'comment.sync_unsupported', { platform: account.platform });
  const mode = await readMode(account);
  if (mode.mode !== 'api') throw conflict('该账号无法通过官方接口同步评论', mode.reason!, { platform: account.platform });
  const [running] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.type, SYNC_TYPE), eq(schema.tasks.refId, account.id), inArray(schema.tasks.status, ['pending', 'scheduled', 'running'])));
  if (running) return { task: running, created: false };
  const r = await createTask({
    type: SYNC_TYPE, userId: account.userId, label: `${account.platform} @${account.handle}`.slice(0, 200),
    refType: SYNC_REF, refId: account.id, payload: { socialAccountId: account.id },
  });
  await db.insert(schema.commentSyncStates).values({ accountId: account.id, lastTaskId: r.task.id })
    .onConflictDoUpdate({ target: schema.commentSyncStates.accountId, set: { lastTaskId: r.task.id } });
  await commentLog({ accountId: account.id, action: 'sync_requested', taskId: r.task.id, actor: user });
  return r;
}

/** YouTube's cursor is a page token (newest first), Instagram's the newest time seen. */
const SINCE_CURSOR = new Set(['instagram']);
const MAX_PAGES = 5;

async function runSync(ctx: TaskContext<{ socialAccountId: string }>): Promise<unknown> {
  const id = ctx.payload.socialAccountId ?? ctx.task.refId!;
  const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, id));
  if (!acc) throw new UnrecoverableError('the social account no longer exists');
  const [state] = await db.select().from(schema.commentSyncStates).where(eq(schema.commentSyncStates.accountId, acc.id));
  const since = SINCE_CURSOR.has(acc.platform);
  let cursor: string | null = since ? state?.cursor ?? null : null;
  let fetched = 0; let inserted = 0; let updated = 0; let pages = 0;
  const opts = { signal: ctx.signal, log: (m: string, d?: Record<string, unknown>) => ctx.log('info', m, d) };
  try {
    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const page = await apiListComments(acc, cursor, opts);
      pages++;
      fetched += page.comments.length;
      const { inserted: fresh, updated: changed } = await storeSyncedComments(acc, page.comments);
      inserted += fresh;
      updated += changed;
      cursor = page.nextCursor;
      await ctx.log('info', `page ${pages}: ${page.comments.length} comments, ${fresh} new, ${changed} updated`, page.info);
      // Page tokens: stop at the first page with nothing new (older pages were seen before) or the page cap.
      if (since || !cursor || fresh === 0 || pages >= MAX_PAGES) break;
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    await db.insert(schema.commentSyncStates).values({ accountId: acc.id, lastTaskId: ctx.task.id, lastError: (e.message ?? String(err)).slice(0, 500), lastErrorCode: e.code ?? 'comment.sync_failed' })
      .onConflictDoUpdate({ target: schema.commentSyncStates.accountId, set: { lastTaskId: ctx.task.id, lastError: (e.message ?? String(err)).slice(0, 500), lastErrorCode: e.code ?? 'comment.sync_failed' } });
    await commentLog({ accountId: acc.id, level: 'error', action: 'sync_failed', code: e.code ?? 'comment.sync_failed', message: e.message ?? String(err), taskId: ctx.task.id });
    throw err;
  }
  await linkPublishTasks(acc.id);
  const set = { cursor, lastTaskId: ctx.task.id, lastSyncedAt: new Date(), lastFetched: fetched, lastNew: inserted, lastError: null, lastErrorCode: null };
  await db.insert(schema.commentSyncStates).values({ accountId: acc.id, ...set }).onConflictDoUpdate({ target: schema.commentSyncStates.accountId, set });
  await commentLog({ accountId: acc.id, action: 'synced', message: `${fetched} fetched, ${inserted} new, ${updated} updated`, data: { pages, fetched, inserted, updated }, taskId: ctx.task.id });
  return { pages, fetched, inserted, updated };
}

/**
 * Stores synced API comments of `acc`: new ones are inserted; for ones already stored, the mutable fields
 * (text, like and reply counts) are updated only when they changed (then fetched_at moves too). Idempotent:
 * the same comments twice → { inserted: 0, updated: 0 }.
 */
export async function storeSyncedComments(acc: SocialAccount, comments: PlatformComment[]): Promise<{ inserted: number; updated: number }> {
  let inserted = 0; let updated = 0;
  for (const c of comments) {
    const [row] = await db.insert(C).values({
      userId: acc.userId, accountId: acc.id, platform: acc.platform, source: 'api', externalId: c.id, parentExternalId: c.parentId,
      externalPostId: c.postId, authorName: c.authorName, text: c.text, likeCount: c.likeCount, replyCount: c.replyCount,
      publishedAt: c.publishedAt ? new Date(c.publishedAt) : null, postUrl: postUrlOf(acc.platform, c.postId),
    }).onConflictDoUpdate({
      target: [C.accountId, C.externalId],
      set: { text: sql`excluded.text`, likeCount: sql`excluded.like_count`, replyCount: sql`excluded.reply_count`, fetchedAt: sql`now()` },
      setWhere: sql`(${C.text}, ${C.likeCount}, ${C.replyCount}) is distinct from (excluded.text, excluded.like_count, excluded.reply_count)`,
    }).returning({ inserted: sql<boolean>`xmax = 0` });
    if (!row) continue;
    if (row.inserted) inserted++; else updated++;
  }
  return { inserted, updated };
}

function postUrlOf(platform: string, postId: string | null): string | null {
  if (!postId) return null;
  if (platform === 'youtube') return `https://www.youtube.com/watch?v=${encodeURIComponent(postId)}`;
  return null;
}

registerTaskHandler<{ socialAccountId: string }>(SYNC_TYPE, {
  queue: 'task-ops',
  timeoutMs: 5 * 60_000,
  maxAttempts: 1,
  run: runSync,
});

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
  if (r.status !== 'draft' && r.status !== 'pending_review') throw conflict(`当前状态（${r.status}）不能修改`, 'comment.bad_status', { status: r.status });
  if (r.status === 'pending_review' && !isAdmin(user) && r.authorId !== user.id) throw forbidden('只有作者可以修改待审核的回复', 'comment.not_author');
  const text = b.text !== undefined ? b.text.trim() : r.text;
  if (!text) throw badRequest('回复内容不能为空', 'comment.text_empty');
  if (b.templateId) await visibleTemplate(user, b.templateId);
  return db.transaction(async (tx) => {
    const set = { text, textHash: textHash(text), ...(b.scheduledAt !== undefined ? { scheduledAt: b.scheduledAt } : {}), ...(b.templateId !== undefined ? { templateId: b.templateId } : {}) };
    if (r.status === 'pending_review' && set.textHash !== r.textHash) await assertNotDuplicate(tx, user, { ...r, textHash: set.textHash }, await getRules(tx));
    const [done] = await tx.update(R).set(set).where(and(eq(R.id, r.id), inArray(R.status, ['draft', 'pending_review']))).returning();
    if (!done) throw conflict('回复状态已变化', 'comment.bad_status', { status: 'changed' });
    await replyLog(done, { action: 'edited', data: { textChanged: text !== r.text, scheduledAt: done.scheduledAt?.toISOString() ?? null }, actor: user }, tx);
    return done;
  });
}

/** draft → pending_review (review required) or approved (+ send scheduled). */
export async function submitReply(user: AuthUser, r: CommentTask, scheduledAt?: Date | null): Promise<CommentTask> {
  if (r.status !== 'draft') throw conflict(`当前状态（${r.status}）不能提交`, 'comment.bad_status', { status: r.status });
  const rules = await getRules();
  const needsReview = rules.requireApproval && !isAdmin(user);
  const row = await db.transaction(async (tx) => {
    await assertNotDuplicate(tx, user, r, rules);
    const now = new Date();
    const [done] = await tx.update(R).set({
      status: needsReview ? 'pending_review' : 'approved', submittedAt: now,
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      ...(needsReview ? {} : { reviewerId: user.id, reviewerName: user.username, reviewedAt: now, reviewNote: rules.requireApproval ? 'admin' : 'review not required' }),
    }).where(and(eq(R.id, r.id), eq(R.status, 'draft'))).returning();
    if (!done) throw conflict('回复状态已变化', 'comment.bad_status', { status: 'changed' });
    await replyLog(done, { action: 'submitted', message: needsReview ? 'waiting for review' : 'approved without review', data: { needsReview }, actor: user }, tx);
    return done;
  });
  return needsReview ? row : scheduleSend(row, user);
}

/** Who may review: anyone who sees the reply and is not its author; admins also their own. */
function assertReviewer(user: AuthUser, r: CommentTask) {
  if (!isAdmin(user) && r.authorId === user.id) throw forbidden('不能审核自己撰写的回复', 'comment.self_approval');
}

export async function approveReply(user: AuthUser, r: CommentTask, note?: string | null): Promise<CommentTask> {
  if (r.status !== 'pending_review') throw conflict(`当前状态（${r.status}）不能审核`, 'comment.bad_status', { status: r.status });
  try { assertReviewer(user, r); } catch (err) {
    await replyLog(r, { level: 'warn', action: 'blocked', code: 'comment.self_approval', message: 'self-approval refused', actor: user });
    throw err;
  }
  const row = await db.transaction(async (tx) => {
    await assertNotDuplicate(tx, user, r, await getRules(tx));
    const [done] = await tx.update(R).set({ status: 'approved', reviewerId: user.id, reviewerName: user.username, reviewedAt: new Date(), reviewNote: note?.trim() || null })
      .where(and(eq(R.id, r.id), eq(R.status, 'pending_review'))).returning();
    if (!done) throw conflict('回复状态已变化', 'comment.bad_status', { status: 'changed' });
    await replyLog(done, { action: 'approved', message: note ?? null, actor: user }, tx);
    return done;
  });
  return scheduleSend(row, user);
}

export async function rejectReply(user: AuthUser, r: CommentTask, reason: string): Promise<CommentTask> {
  if (r.status !== 'pending_review') throw conflict(`当前状态（${r.status}）不能审核`, 'comment.bad_status', { status: r.status });
  assertReviewer(user, r);
  const [done] = await db.update(R).set({ status: 'rejected', reviewerId: user.id, reviewerName: user.username, reviewedAt: new Date(), reviewNote: reason.trim() })
    .where(and(eq(R.id, r.id), eq(R.status, 'pending_review'))).returning();
  if (!done) throw conflict('回复状态已变化', 'comment.bad_status', { status: 'changed' });
  await replyLog(done, { level: 'warn', action: 'rejected', message: reason.trim(), actor: user });
  return done;
}

// ---------------------------------------------------------------- replies: sending

/** Creates the task-centre task of the reply's current round (runAt = scheduledAt). */
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
    const [done] = await db.update(R).set({ taskId: task.id, status: when ? 'scheduled' : 'approved' })
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
/**
 * Only errors that certainly happened before the platform accepted the reply are retried (429): a
 * timeout or network failure may have posted it already, and a second post would be a duplicate.
 */
const RETRYABLE = new Set(['platform.rate_limited']);

type ReplyPayload = { commentTaskId: string; round?: number };

async function runReply(ctx: TaskContext<ReplyPayload>): Promise<unknown> {
  const id = ctx.payload.commentTaskId ?? ctx.task.refId!;
  const rules = await getRules();
  // Claim + rate limit under a per-account lock: concurrent sends of one account serialize.
  const claim = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(R).where(eq(R.id, id)).for('update');
    if (!r) return { kind: 'gone' as const };
    if (r.taskId === ctx.task.id && r.status === 'sending') {
      // An earlier attempt of this task was cut off while sending (timeout / crash): the platform may have
      // the reply already. Never send twice: fail and let a person check the platform.
      const [n] = await tx.update(R).set({ status: 'failed', errorCode: 'comment.send_uncertain', error: 'a previous attempt was interrupted while sending; check the platform before writing a new reply' })
        .where(eq(R.id, r.id)).returning();
      await replyLog(n!, { level: 'error', action: 'failed', code: 'comment.send_uncertain', message: 'previous attempt interrupted while sending: not sent again', taskId: ctx.task.id }, tx);
      return { kind: 'uncertain' as const };
    }
    if (r.taskId !== ctx.task.id || !['approved', 'scheduled'].includes(r.status)) return { kind: 'skip' as const, r };
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
  if (claim.kind === 'uncertain') throw new ReplyCheckError('comment.send_uncertain', 'a previous attempt was interrupted while sending');
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
    const mode = await replyMode(acc, comment);
    await log('info', 'method', `method: ${mode.mode}`, { method: mode.mode, reason: mode.reason });
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (mode.mode === 'manual') {
      const [done] = await db.update(R).set({ status: 'awaiting_operator', method: 'manual', handedAt: new Date() })
        .where(and(eq(R.id, r.id), eq(R.taskId, ctx.task.id), eq(R.status, 'sending'))).returning();
      await log('info', 'handed_over', 'handed over to an operator: reply by hand on the phone, then record the outcome', { reason: mode.reason, recorded: !!done });
      return { state: 'awaiting_operator', method: 'manual', reason: mode.reason };
    }
    const res = await apiReplyToComment(acc, comment.externalId, r.text, { signal: ctx.signal, log: (m, d) => ctx.log('info', m, d) });
    const [done] = await db.update(R).set({ status: 'sent', method: 'api', externalReplyId: res.id, sentAt: new Date(), senderId: null, senderName: null })
      .where(and(eq(R.id, r.id), eq(R.taskId, ctx.task.id), eq(R.status, 'sending'))).returning();
    if (done) await markReplied(r.commentId);
    await log('info', 'sent', 'sent via the official API', { externalReplyId: res.id, recorded: !!done });
    return { state: 'sent', method: 'api', externalReplyId: res.id };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const code = typeof e.code === 'string' ? e.code : 'comment.failed';
    if (!ctx.signal.aborted) {
      const final = err instanceof UnrecoverableError || !RETRYABLE.has(code) || ctx.attempt >= ctx.task.maxAttempts;
      await db.update(R).set({ status: final ? 'failed' : 'approved', method: 'api', error: (e.message ?? String(err)).slice(0, 1000), errorCode: code })
        .where(and(eq(R.id, r.id), eq(R.taskId, ctx.task.id), eq(R.status, 'sending')));
      await log(final ? 'error' : 'warn', final ? 'failed' : 'retry', final ? `failed: ${e.message}` : `attempt failed, will retry: ${e.message}`, undefined, code);
      if (final && !(err instanceof UnrecoverableError)) throw new ReplyCheckError(code, e.message ?? String(err));
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
