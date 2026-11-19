import { UnrecoverableError } from 'bullmq';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { PUBLISH_UNFINISHED, type Content, type MediaAsset, type PostType, type PublishStatus, type PublishTask, type Task } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { assertPlatformEnabled, isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { publishFailed } from '../notify/triggers.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { assertNoBannedWords } from '../comments/persona-style.js';
import { assertNotPublished, contentMediaOf, refreshContentStatus, uniqueTags, type Tx } from '../content/content.js';
import { textsForAccount, type AccountTexts } from '../content/languages.js';
import { platformAllowed, visibleAccount } from '../social/social.js';
import { cancelTask, createTask, isFinal, registerTaskHandler, type TaskContext } from '../tasks/core.js';
import { onDeviceResumed } from '../tracked/collector.js';
import './device.js'; // registers the `device` method (云手机发帖)
import { MANUAL_METHOD, PublishCheckError, publishMethods, type PublishInput, type PublishLogLevel, type PublishMethodResult } from './methods.js';
import { capabilityOf, composeText, postTypeRule, validateForPlatform } from './platforms.js';
import { getPublishTimeout } from './timeout-settings.js';

export { PublishCheckError };

/**
 * Publish scheduler (排程发布). One publish_tasks row per (content, account); each scheduling round
 * (attempt_no) is one task-centre task of type 'publish' (idempotency key publish:<id>:<attempt_no>,
 * run_at = scheduled time, ONE attempt, timeout from 系统配置 → 发布任务).
 *
 * A run: claim the publish task (only the task-centre task it currently points at may run it), then the
 * checks — account owner, account status, media still ready and valid for the platform, no earlier
 * successful publish of the same content on the same account (unless re-publish), device linked + online
 * and account logged in — each written to publish_logs and the task log. Then the registered methods are tried
 * in order (methods.ts): `device` (云手机发帖, device.ts: the account's cloud phone publishes in the app; no test
 * mode since 2026-11-18: a run only exists because a person distributed the content) when available, else the task is handed to an operator (`manual`, awaiting_operator; the reason the
 * phone couldn't take it is logged), who publishes by hand on the device and records the outcome. Publishing
 * through official platform APIs was removed on 2026-11-18 (owner decision). No automatic retries (owner decision
 * 2026-11-18): any failure (also device offline, a timeout or a device step) ends the round as `failed` with its code;
 * the person edits the content and distributes it again, which creates a NEW publish task with the current texts and
 * media (a failed pair is not "published", so no `republish` is needed). The 风控 limits are not retries and stay: a
 * deferred device run (daily cap, min gap, busy / paced phone) is a new round at the allowed time; a run on a halted
 * phone is parked (scheduled without a task) until the phone is resumed on the 风控 page.
 */

const pt = schema.publishTasks;
export const REF_TYPE = 'publish';
export const TASK_TYPE = 'publish';

// ---------------------------------------------------------------- logs

export async function publishLog(p: Pick<PublishTask, 'id' | 'attemptNo' | 'taskId'>, level: PublishLogLevel, message: string, data?: Record<string, unknown>,
  actor?: AuthUser | null, exec: typeof db | Tx = db): Promise<void> {
  await exec.insert(schema.publishLogs).values({
    publishTaskId: p.id, level, message: message.slice(0, 2000), data: data ?? null, attemptNo: p.attemptNo, taskId: p.taskId,
    actorId: actor?.id ?? null, actorName: actor?.username ?? null,
  });
}

// ---------------------------------------------------------------- distribution

export interface DistributeTarget {
  accountId: string;
  title?: string | null;
  caption?: string | null;
  hashtags?: string[];
  options?: Record<string, unknown>;
  /** null/absent = now */
  scheduledAt?: Date | null;
  /** Default feed. */
  postType?: PostType;
}

export interface DistributeResult { created: PublishTask[]; existing: PublishTask[] }

const lockPair = (tx: Tx, contentId: string, accountId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`publish:${contentId}:${accountId}`}, 0))`);

/**
 * The snapshot of one target: texts of the account's language (`textsForAccount`: its translation, else the source),
 * per-target overrides on top; options (privacy) always from the content.
 */
function postFor(content: Content, texts: AccountTexts, platform: string, t: DistributeTarget) {
  const h = texts.hints[platform] ?? {};
  const opts = ((content.platformHints ?? {}) as AccountTexts['hints'])[platform] ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const cap = capabilityOf(platform);
  const title = cap.title ? (t.title?.trim() || str(h.title) || texts.title) : (t.title?.trim() || null);
  const caption = t.caption ?? str(h.description) ?? str(h.caption) ?? texts.body;
  const postType = t.postType ?? 'feed';
  const options: Record<string, unknown> = { ...(t.options ?? {}) };
  if (cap.privacy && options.privacy === undefined) options.privacy = str(opts.privacy) ?? 'private';
  if (options.privacy !== undefined && (!cap.privacy || !cap.privacy.includes(String(options.privacy)))) {
    throw badRequest(`${platform} 不支持该可见性：${String(options.privacy)}`, 'publish.bad_privacy', { platform, privacy: String(options.privacy) });
  }
  // Types without a caption (Instagram stories) publish no text: don't keep one the operator might copy.
  const noText = postTypeRule(platform, postType)?.caption === false;
  return { title: title ?? null, caption: noText ? '' : caption, hashtags: noText ? [] : uniqueTags(t.hashtags ?? []), options, postType };
}

/**
 * Creates one publish task per target (all validated first; all or nothing). A target whose
 * (content, account) already has an unfinished publish task returns that task (idempotent);
 * one that was already published needs `republish`.
 */
export async function distribute(user: AuthUser, content: Content, targets: DistributeTarget[], opts: { republish?: boolean } = {}): Promise<DistributeResult> {
  if (content.stage === 'archived') throw conflict('已归档的内容不能发布', 'content.archived');
  if (new Set(targets.map((t) => t.accountId)).size !== targets.length) throw badRequest('目标账号重复', 'publish.duplicate_target');
  // 已发布的内容不能编辑: the remaining accounts get the content's own texts, no per-account text overrides.
  if (targets.some((t) => t.title?.trim() || t.caption != null || t.hashtags?.length)) await assertNotPublished(db, content.id);
  const now = new Date();
  const translations = await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, content.id));

  const result = await db.transaction(async (tx) => {
    // 防并发: the content row is locked like 归档 / 删除 lock it, so an archive or delete racing this distribution either
    // waits for it (then refuses: unfinished publish task) or wins (then this one refuses: archived / not found).
    const [locked] = await tx.select({ stage: schema.contents.stage }).from(schema.contents).where(eq(schema.contents.id, content.id)).for('update');
    if (!locked) throw notFound('内容不存在', 'content.not_found');
    if (locked.stage === 'archived') throw conflict('已归档的内容不能发布', 'content.archived');
    // The content's assets are locked (FOR SHARE) before they are read, so a parallel 素材 delete (media.ts deleteMedia)
    // either sees this publish task (media.in_use) or has removed the asset before it is read here.
    await tx.execute(sql`select a.id from content_media cm join media_assets a on a.id = cm.asset_id where cm.content_id = ${content.id} for share of a`);
    const media = await contentMediaOf(tx, content.id);
    const notReady = media.find((m) => m.status !== 'ready');
    if (notReady) throw conflict(`素材「${notReady.name}」尚未就绪（${notReady.status}）`, 'publish.media_not_ready', { name: notReady.name, status: notReady.status });
    const out: DistributeResult = { created: [], existing: [] };
    for (const t of targets) {
      const acc = await visibleAccount(user, t.accountId, tx);
      assertPlatformEnabled(acc.platform);
      if (!isAdmin(user) && acc.userId !== content.userId) throw badRequest('账号不属于内容所有者', 'publish.account_not_owner');
      const texts = textsForAccount(content, translations, acc);
      const post = postFor(content, texts, acc.platform, t);
      await assertNoBannedWords([acc.personaId], [post.title, post.caption, ...post.hashtags], tx);
      const bad = validateForPlatform(acc.platform, media, post);
      if (bad) throw badRequest(`@${acc.handle}: ${bad.message}`, bad.code, { ...bad.params, account: acc.handle });
      if (t.scheduledAt && t.scheduledAt.getTime() > now.getTime() + 366 * 86400_000) throw badRequest('发布时间不能超过一年', 'publish.too_far');
      await lockPair(tx, content.id, acc.id);
      const prior = await tx.select().from(pt).where(and(eq(pt.contentId, content.id), eq(pt.accountId, acc.id), inArray(pt.status, [...PUBLISH_UNFINISHED, 'published'])));
      const unfinished = prior.find((p) => p.status !== 'published');
      if (unfinished) { out.existing.push(unfinished); continue; }
      if (prior.length && !opts.republish) {
        throw conflict(`内容已发布到 @${acc.handle}，如需再次发布请选择“重新发布”`, 'publish.already_published', { account: acc.handle });
      }
      const scheduledAt = t.scheduledAt && t.scheduledAt > now ? t.scheduledAt : now;
      const [row] = await tx.insert(pt).values({
        userId: acc.userId, contentId: content.id, accountId: acc.id, platform: acc.platform,
        title: post.title, caption: post.caption, hashtags: post.hashtags, options: post.options, mediaIds: media.map((m) => m.id), postType: post.postType, lang: texts.lang,
        scheduledAt, status: scheduledAt > now ? 'scheduled' : 'pending', maxAttempts: 1, republish: prior.length > 0, createdBy: user.id,
      }).returning();
      await publishLog(row!, 'info', prior.length ? 'distributed (re-publish)' : 'distributed', {
        account: acc.handle, platform: acc.platform, postType: post.postType, scheduledAt: scheduledAt.toISOString(), media: media.length,
        lang: texts.lang, accountLang: acc.lang, langFallback: texts.fallback,
      }, user, tx);
      out.created.push(row!);
    }
    if (out.created.length && locked.stage === 'draft') await tx.update(schema.contents).set({ stage: 'ready' }).where(eq(schema.contents.id, content.id));
    return out;
  });
  const created: PublishTask[] = [];
  for (const row of result.created) created.push(await scheduleRun(row, null));
  await refreshContentStatus(content.id);
  return { created, existing: result.existing };
}

/** Creates the task-centre task for the publish task's current round and points the row at it. */
async function scheduleRun(row: PublishTask, retryOf: string | null): Promise<PublishTask> {
  const [acc] = await db.select({ handle: schema.socialAccounts.handle }).from(schema.socialAccounts).where(eq(schema.socialAccounts.id, row.accountId));
  const [content] = await db.select({ title: schema.contents.title }).from(schema.contents).where(eq(schema.contents.id, row.contentId));
  try {
    // 系统配置 → 发布任务: the attempt's timeout is stored on the task (a round keeps it). One attempt per round,
    // also for a row an older colour created with more.
    const { timeoutMs } = await getPublishTimeout();
    const { task } = await createTask({
      type: TASK_TYPE, userId: row.userId, label: `${row.platform}${row.postType !== 'feed' ? ` ${row.postType}` : ''} @${acc?.handle ?? '?'} · ${content?.title ?? ''}`.slice(0, 200),
      refType: REF_TYPE, refId: row.id, payload: { publishTaskId: row.id, attemptNo: row.attemptNo },
      runAt: row.scheduledAt, idempotencyKey: `publish:${row.id}:${row.attemptNo}`, maxAttempts: 1, timeoutMs, retryOf,
    });
    const [updated] = await db.update(pt).set({ taskId: task.id }).where(and(eq(pt.id, row.id), eq(pt.attemptNo, row.attemptNo))).returning();
    // 防并发: a newer round (改期 / 重试 at the same time) took over before this task was attached: it would never run
    // this publish task (its runner no longer matches task_id), so it is cancelled instead of lingering as scheduled.
    if (!updated && !isFinal(task.status)) await cancelTask(task, null).catch(() => undefined);
    return updated ?? row;
  } catch (err) {
    const [failed] = await db.update(pt).set({ status: 'failed', error: (err as Error).message.slice(0, 500), errorCode: 'publish.enqueue_failed' })
      .where(and(eq(pt.id, row.id), eq(pt.attemptNo, row.attemptNo), inArray(pt.status, ['pending', 'scheduled']))).returning();
    if (failed) await publishLog(failed, 'error', `could not schedule: ${(err as Error).message}`);
    await refreshContentStatus(row.contentId);
    throw err;
  }
}

// ---------------------------------------------------------------- operator / user actions

async function currentTask(row: PublishTask): Promise<Task | undefined> {
  if (!row.taskId) return undefined;
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId));
  return t;
}

/**
 * Starts a new round (reschedule, manual retry): bumps attempt_no, detaches the old task-centre task
 * (cancelled if still waiting; its runner no longer matches task_id) and schedules a new one.
 */
async function newRound(user: AuthUser, id: string, from: PublishStatus[], scheduledAt: Date | null, action: 'rescheduled' | 'retried'): Promise<PublishTask> {
  const now = new Date();
  const when = scheduledAt && scheduledAt > now ? scheduledAt : now;
  const { prev, next } = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(pt).where(eq(pt.id, id)).for('update');
    if (!cur) throw conflict('发布任务不存在', 'publish.not_found');
    if (!from.includes(cur.status)) throw conflict(`当前状态（${cur.status}）不能执行该操作`, 'publish.bad_status', { status: cur.status });
    assertPlatformEnabled(cur.platform);
    if (action === 'retried' && !cur.republish) {
      const [done] = await tx.select({ id: pt.id }).from(pt).where(and(eq(pt.contentId, cur.contentId), eq(pt.accountId, cur.accountId), eq(pt.status, 'published'), ne(pt.id, cur.id)));
      if (done) throw conflict('该内容已发布到这个账号', 'publish.already_published', { account: cur.accountId });
    }
    const fresh = action === 'retried' || cur.status === 'dry_run';
    const [n] = await tx.update(pt).set({
      status: when > now ? 'scheduled' : 'pending', scheduledAt: when, attemptNo: cur.attemptNo + 1, taskId: null, maxAttempts: 1,
      error: fresh ? null : cur.error, errorCode: fresh ? null : cur.errorCode, method: fresh ? null : cur.method,
    }).where(eq(pt.id, id)).returning().catch((err) => {
      const e = err as { code?: string; cause?: { code?: string } };
      if (e.code === '23505' || e.cause?.code === '23505') throw conflict('该内容在这个账号上已有未完成的发布任务', 'publish.duplicate_unfinished');
      throw err;
    });
    await publishLog(n!, 'info', action, { scheduledAt: when.toISOString(), previousTaskId: cur.taskId, attemptNo: n!.attemptNo }, user, tx);
    return { prev: cur, next: n! };
  });
  const old = await currentTask(prev);
  if (old && !isFinal(old.status)) await cancelTask(old, user.username).catch(() => undefined);
  const row = await scheduleRun(next, action === 'retried' ? prev.taskId : null);
  await refreshContentStatus(row.contentId);
  return row;
}

// retry (POST …/retry) = the same snapshot again: LEGACY for older pages (the UI offers 编辑后重新发布 instead, which
// distributes the edited content as a new publish task). dry_run = a test-mode rehearsal of an old colour (test mode
// removed 2026-11-18; db:migrate turned them into cancelled).
export const reschedulePublish = (user: AuthUser, row: PublishTask, at: Date | null) => newRound(user, row.id, ['pending', 'scheduled'], at, 'rescheduled');
export const retryPublish = (user: AuthUser, row: PublishTask, at: Date | null) => newRound(user, row.id, ['failed', 'cancelled', 'dry_run'], at, 'retried');

/** Cancel while waiting (pending/scheduled) or while handed to an operator. */
export async function cancelPublish(user: AuthUser, row: PublishTask): Promise<PublishTask> {
  if (row.status === 'pending' || row.status === 'scheduled') {
    const t = await currentTask(row);
    if (t && !isFinal(t.status)) {
      if (t.status === 'running') throw conflict('任务正在执行，无法取消', 'publish.bad_status', { status: 'running' });
      await cancelTask(t, user.username); // onFailure marks the publish task cancelled
    }
  } else if (row.status !== 'awaiting_operator') {
    throw conflict(`当前状态（${row.status}）不能取消`, 'publish.bad_status', { status: row.status });
  }
  const [done] = await db.update(pt).set({ status: 'cancelled', errorCode: 'publish.cancelled', error: null })
    .where(and(eq(pt.id, row.id), eq(pt.attemptNo, row.attemptNo), inArray(pt.status, ['pending', 'scheduled', 'awaiting_operator']))).returning();
  if (done) await publishLog(done, 'warn', 'cancelled', { from: row.status }, user);
  await refreshContentStatus(row.contentId);
  const [cur] = await db.select().from(pt).where(eq(pt.id, row.id));
  if (cur?.status !== 'cancelled') throw conflict(`当前状态（${cur?.status}）不能取消`, 'publish.bad_status', { status: cur?.status ?? 'unknown' });
  return cur;
}

/** Operator records the outcome of a manual publish. */
export async function recordOutcome(user: AuthUser, row: PublishTask, o: { result: 'published' | 'failed'; url?: string | null; externalId?: string | null; reason?: string | null }): Promise<PublishTask> {
  if (o.result === 'published' && !o.url && !o.externalId) throw badRequest('请填写帖子链接或平台 ID', 'publish.outcome_needs_link');
  if (o.result === 'failed' && !o.reason?.trim()) throw badRequest('请填写失败原因', 'publish.outcome_needs_reason');
  const set = o.result === 'published'
    ? { status: 'published' as const, url: o.url ?? null, externalId: o.externalId ?? null, publishedAt: new Date(), error: null, errorCode: null }
    : { status: 'failed' as const, error: o.reason!.trim().slice(0, 1000), errorCode: 'publish.operator_failed' };
  const [done] = await db.update(pt).set(set).where(and(eq(pt.id, row.id), eq(pt.status, 'awaiting_operator'))).returning();
  if (!done) throw conflict('只有等待人工处理的任务可以记录结果', 'publish.bad_status', { status: row.status });
  await publishLog(done, o.result === 'published' ? 'info' : 'error', o.result === 'published' ? 'operator recorded: published' : 'operator recorded: failed',
    o.result === 'published' ? { url: o.url ?? null, externalId: o.externalId ?? null } : { reason: set.error }, user);
  await refreshContentStatus(done.contentId);
  return done;
}

/** Edit texts/options while the task waits. */
export async function editPublish(user: AuthUser, row: PublishTask, b: { title?: string | null; caption?: string; hashtags?: string[]; options?: Record<string, unknown> }): Promise<PublishTask> {
  if (row.status !== 'pending' && row.status !== 'scheduled') throw conflict(`当前状态（${row.status}）不能修改`, 'publish.bad_status', { status: row.status });
  // 已发布的内容不能编辑: once a post of the content is online, the other accounts' texts stay the content's.
  if (b.title !== undefined || b.caption !== undefined || b.hashtags !== undefined) await assertNotPublished(db, row.contentId);
  const noText = postTypeRule(row.platform, row.postType)?.caption === false;
  const next = {
    title: b.title !== undefined ? (b.title?.trim() || null) : row.title,
    caption: noText ? '' : b.caption ?? row.caption,
    hashtags: noText ? [] : b.hashtags ? uniqueTags(b.hashtags) : row.hashtags,
    options: b.options ? { ...row.options, ...b.options } : row.options,
    postType: row.postType,
  };
  const cap = capabilityOf(row.platform);
  if (next.options.privacy !== undefined && (!cap.privacy || !cap.privacy.includes(String(next.options.privacy)))) {
    throw badRequest(`${row.platform} 不支持该可见性`, 'publish.bad_privacy', { platform: row.platform, privacy: String(next.options.privacy) });
  }
  const media = await db.select().from(schema.mediaAssets).where(inArray(schema.mediaAssets.id, row.mediaIds.length ? row.mediaIds : ['00000000-0000-0000-0000-000000000000']));
  const bad = validateForPlatform(row.platform, row.mediaIds.map((id) => media.find((m) => m.id === id)).filter((m): m is MediaAsset => !!m), next);
  if (bad) throw badRequest(bad.message, bad.code, bad.params);
  const [done] = await db.update(pt).set({ title: next.title, caption: next.caption, hashtags: next.hashtags, options: next.options })
    .where(and(eq(pt.id, row.id), inArray(pt.status, ['pending', 'scheduled']))).returning();
  if (!done) throw conflict('任务状态已变化', 'publish.bad_status', { status: 'changed' });
  await publishLog(done, 'info', 'edited', { fields: Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined) }, user);
  return done;
}

// ---------------------------------------------------------------- the scheduler task

type Payload = { publishTaskId: string; attemptNo?: number };

async function runPublish(ctx: TaskContext<Payload>): Promise<unknown> {
  const id = ctx.payload.publishTaskId ?? ctx.task.refId;
  // One attempt per round: a task an older colour created with several attempts (or one redelivered after a timeout)
  // does not run again; the round ends failed with the first attempt's code.
  if (ctx.attempt > 1) {
    const code = ctx.task.errorCode ?? 'publish.failed';
    const [cur] = await db.update(pt).set({ status: 'failed', errorCode: code, error: ctx.task.error ?? null })
      .where(and(eq(pt.id, id), eq(pt.taskId, ctx.task.id), inArray(pt.status, ['pending', 'scheduled', 'running']))).returning();
    if (cur) await publishLog(cur, 'error', `failed: ${ctx.task.error ?? code}`, { code, noRetry: true });
    throw new PublishCheckError(code, ctx.task.error ?? 'the round already had its attempt (no automatic retries)');
  }
  // Claim: only the task-centre task this publish task currently points at may run it (a rescheduled /
  // retried round detaches older tasks).
  const [row] = await db.update(pt).set({ status: 'running', error: null, errorCode: null })
    .where(and(eq(pt.id, id), eq(pt.taskId, ctx.task.id), inArray(pt.status, ['pending', 'scheduled']))).returning();
  if (!row) {
    const [cur] = await db.select().from(pt).where(eq(pt.id, id));
    if (!cur) throw new PublishCheckError('publish.target_gone', 'the publish task no longer exists');
    await ctx.log('warn', 'not executed: the publish task is no longer driven by this task', { status: cur.status, currentTaskId: cur.taskId, attemptNo: cur.attemptNo });
    return { skipped: true, status: cur.status };
  }
  const log = async (level: PublishLogLevel, message: string, data?: Record<string, unknown>) => {
    await publishLog(row, level, message, data);
    await ctx.log(level, message, data);
  };
  await refreshContentStatus(row.contentId);
  await log('info', `run started (round ${row.attemptNo})`, { postType: row.postType });
  try {
    const input = await preflight(row, log);
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const reasons: Record<string, string> = {};
    for (const m of publishMethods()) {
      const why = await m.unavailable(input, row);
      if (why) { reasons[m.id] = why; await log('info', `method ${m.id} not available: ${why}`, { code: why }); continue; }
      await db.update(pt).set({ method: m.id }).where(and(eq(pt.id, row.id), eq(pt.taskId, ctx.task.id), eq(pt.status, 'running')));
      await log('info', `method ${m.id}`, { postType: input.postType });
      const r = await m.run(input, { row, task: ctx as TaskContext<unknown>, log });
      if (r.state === 'unavailable') { reasons[m.id] = r.reason; await log('info', `method ${m.id} not available: ${r.reason}`, { code: r.reason }); continue; }
      return await applyResult(row, ctx, m.id, r, log);
    }
    await log('info', 'handed over to an operator: publish by hand on the bound device, then record the outcome', { postType: input.postType, ...(Object.keys(reasons).length ? { reasons } : {}) });
    const [done] = await db.update(pt).set({ status: 'awaiting_operator', method: MANUAL_METHOD })
      .where(and(eq(pt.id, row.id), eq(pt.taskId, ctx.task.id), inArray(pt.status, ['pending', 'scheduled', 'running']))).returning();
    await log('info', 'awaiting operator', { method: MANUAL_METHOD, recorded: !!done });
    return { state: 'awaiting_operator', method: MANUAL_METHOD, ...(Object.keys(reasons).length ? { reasons } : {}) };
  } catch (err) {
    const e = err as { code?: string; message?: string; params?: Record<string, unknown> };
    const code = typeof e.code === 'string' ? e.code : 'publish.failed';
    // Timeout/cancel: the task centre already decided; onFailure mirrors it on the publish task.
    if (ctx.signal.aborted) throw err;
    // No automatic retries: every failure ends the round (the person edits the content and publishes it again).
    await db.update(pt).set({ status: 'failed', error: (e.message ?? String(err)).slice(0, 1000), errorCode: code })
      .where(and(eq(pt.id, row.id), eq(pt.taskId, ctx.task.id), eq(pt.status, 'running')));
    await log('error', `failed: ${e.message}`, { code, ...(e.params ?? {}) });
    throw err instanceof UnrecoverableError ? err : new PublishCheckError(code, e.message ?? String(err), e.params ?? {});
  } finally {
    await refreshContentStatus(row.contentId);
  }
}

type Log = (level: PublishLogLevel, message: string, data?: Record<string, unknown>) => Promise<void>;

/** Writes what a method returned onto the publish task (only while this task still drives it). */
async function applyResult(row: PublishTask, ctx: TaskContext<Payload>, method: string, r: PublishMethodResult, log: Log): Promise<unknown> {
  const mine = and(eq(pt.id, row.id), eq(pt.taskId, ctx.task.id), eq(pt.status, 'running'));
  switch (r.state) {
    case 'published': {
      await db.update(pt).set({ status: 'published', method, externalId: r.externalId, url: r.url, publishedAt: r.publishedAt ?? new Date(), evidence: r.evidence ?? null, error: null, errorCode: null }).where(mine);
      await log('info', 'published from the cloud phone and seen on the profile', { externalId: r.externalId, url: r.url, ...(r.data ?? {}) });
      return { state: 'published', method, externalId: r.externalId, url: r.url };
    }
    case 'awaiting_operator': {
      await db.update(pt).set({ status: 'awaiting_operator', method, evidence: r.evidence ?? null, error: r.message.slice(0, 1000), errorCode: r.code }).where(mine);
      await log('warn', `handed over to an operator: ${r.message}`, { code: r.code });
      return { state: 'awaiting_operator', method, code: r.code };
    }
    case 'deferred': {
      const [n] = await db.update(pt).set({ status: 'scheduled', scheduledAt: r.at, attemptNo: row.attemptNo + 1, taskId: null, errorCode: r.code, error: null }).where(mine).returning();
      await log('warn', `${r.message}, deferred`, { code: r.code, retryAt: r.at.toISOString(), ...(r.data ?? {}) });
      const next = n ? await scheduleRun(n, null) : null;
      return { deferred: true, code: r.code, retryAt: r.at.toISOString(), nextTaskId: next?.taskId ?? null };
    }
    case 'unavailable': return { state: 'unavailable', reason: r.reason };
    case 'parked': {
      await db.update(pt).set({ status: 'scheduled', taskId: null, errorCode: r.code, error: null }).where(mine);
      await log('warn', 'device halted (risk control): waiting until an admin resumes it', { code: r.code, device: r.device });
      return { parked: true, code: r.code };
    }
  }
}

/** After 恢复 on the 风控 page: every publish task parked for that phone gets a new round now. */
export async function resumeParkedPublishes(instanceId: string): Promise<number> {
  const rows = await db.select({ p: pt }).from(pt).innerJoin(schema.socialAccounts, eq(schema.socialAccounts.id, pt.accountId))
    .where(and(eq(schema.socialAccounts.instanceId, instanceId), eq(pt.status, 'scheduled'), isNull(pt.taskId), eq(pt.errorCode, 'publish.device_halted')));
  for (const { p } of rows) {
    const [n] = await db.update(pt).set({ attemptNo: p.attemptNo + 1, errorCode: null, scheduledAt: new Date() })
      .where(and(eq(pt.id, p.id), eq(pt.status, 'scheduled'), isNull(pt.taskId))).returning();
    if (n) { await publishLog(n, 'info', 'device resumed: queued again'); await scheduleRun(n, null); }
  }
  return rows.length;
}
onDeviceResumed(resumeParkedPublishes);

async function preflight(row: PublishTask, log: Log): Promise<PublishInput> {
  if (!isPlatformEnabled(row.platform)) throw new PublishCheckError('platform.disabled', `platform ${row.platform} is disabled`, { platform: row.platform });
  // 1. account + owner
  const [acc] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, row.accountId));
  if (!acc) throw new PublishCheckError('publish.account_gone', 'the social account no longer exists');
  if (acc.userId !== row.userId) throw new PublishCheckError('publish.account_owner_changed', 'the account now belongs to another user');
  await log('info', 'check: account owner ok', { account: acc.handle });
  // 2. account status
  if (acc.accountStatus !== 'active') {
    throw new PublishCheckError('publish.account_inactive', `account status is ${acc.accountStatus}`, { status: acc.accountStatus });
  }
  await log('info', 'check: account active');
  // 2b. platform allowed on the linked device (admins may turn platforms off per device)
  if (acc.instanceId) {
    const [dev] = await db.select({ name: schema.instances.name, allowedPlatforms: schema.instances.allowedPlatforms })
      .from(schema.instances).where(eq(schema.instances.id, acc.instanceId));
    if (dev && !platformAllowed(dev.allowedPlatforms, row.platform)) {
      throw new PublishCheckError('publish.platform_disabled', `${row.platform} is turned off on device ${dev.name}`, { device: dev.name, platform: row.platform });
    }
    await log('info', 'check: platform enabled on the device');
  }
  // 3. media (still present, ready, valid for the platform)
  const rows = row.mediaIds.length ? await db.select().from(schema.mediaAssets).where(and(inArray(schema.mediaAssets.id, row.mediaIds), isNull(schema.mediaAssets.deletedAt))) : [];
  const media = row.mediaIds.map((mid) => rows.find((r) => r.id === mid));
  const missing = media.findIndex((m) => !m || m.status !== 'ready');
  if (missing >= 0) {
    throw new PublishCheckError('publish.media_unavailable', `media ${media[missing]?.name ?? row.mediaIds[missing]} is not available (${media[missing]?.status ?? 'deleted'})`,
      { name: media[missing]?.name ?? row.mediaIds[missing]! });
  }
  const ready = media as MediaAsset[];
  const bad = validateForPlatform(row.platform, ready, row);
  if (bad) throw new PublishCheckError(bad.code, bad.message, bad.params);
  await log('info', 'check: media ready and valid for the platform', { count: ready.length, postType: row.postType });
  // 4. duplicates
  if (!row.republish) {
    const [dup] = await db.select({ id: pt.id }).from(pt).where(and(eq(pt.contentId, row.contentId), eq(pt.accountId, row.accountId), eq(pt.status, 'published'), ne(pt.id, row.id)));
    if (dup) throw new PublishCheckError('publish.duplicate', 'this content was already published on this account', { publishTaskId: dup.id });
  }
  await log('info', 'check: not published before on this account');
  // 5. device + login (the operator publishes on the phone)
  if (!acc.instanceId) throw new PublishCheckError('publish.no_device', 'the account is not linked to a device');
  const [inst] = await db.select({ id: schema.instances.id, name: schema.instances.name, status: schema.instances.status, adbState: schema.instances.adbState })
    .from(schema.instances).where(eq(schema.instances.id, acc.instanceId));
  if (!inst) throw new PublishCheckError('publish.no_device', 'the linked device no longer exists');
  if (inst.status !== 'running' || inst.adbState !== 'device') {
    // No retry: the round fails; publish again once the phone is back.
    throw new PublishCheckError('publish.device_offline', `device ${inst.name} is offline (${inst.status}/${inst.adbState ?? '-'})`);
  }
  await log('info', 'check: device online', { device: inst.name });
  // `unknown` = not checked yet (the automatic account check runs every few hours): allowed; only a known bad state blocks.
  if (acc.loginStatus === 'logged_out' || acc.loginStatus === 'needs_verification') {
    throw new PublishCheckError('publish.not_logged_in', `account login status is ${acc.loginStatus}`, { status: acc.loginStatus });
  }
  await log('info', acc.loginStatus === 'logged_in' ? 'check: account logged in on the device' : 'check: account login not checked yet');
  return {
    publishTaskId: row.id, attemptNo: row.attemptNo, platform: row.platform, account: acc,
    title: row.title ?? undefined, caption: row.caption, hashtags: row.hashtags,
    text: composeText(row.caption, row.hashtags), options: row.options, media: ready, postType: row.postType,
  };
}

registerTaskHandler<Payload>(TASK_TYPE, {
  queue: 'publish',
  concurrency: 4,
  timeoutMs: config.PUBLISH_TIMEOUT_MS,
  // One attempt per round, no automatic retries (owner decision 2026-11-18).
  maxAttempts: 1,
  // No generic task-centre retry: publishing again goes through the content (a new publish task).
  retryable: false,
  run: runPublish,
  /** Task ended failed/cancelled (also timeouts, interruptions, cancel before start): mirror it on the publish task. */
  async onFailure(task) {
    const id = (task.payload as Payload | null)?.publishTaskId ?? task.refId;
    if (!id) return;
    const status = task.status === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    const [row] = await db.update(pt).set({ status, error: task.error, errorCode: task.errorCode ?? (status === 'cancelled' ? 'publish.cancelled' : 'publish.failed') })
      .where(and(eq(pt.id, id), eq(pt.taskId, task.id), inArray(pt.status, ['pending', 'scheduled', 'running']))).returning();
    if (row) {
      await publishLog(row, status === 'cancelled' ? 'warn' : 'error', `${status} (scheduler task ${task.status})`, { code: row.errorCode, error: task.error });
      await refreshContentStatus(row.contentId);
    }
    // Alert once per failed round (the run itself may already have marked the row failed before throwing).
    if (status === 'failed') {
      const [failed] = row ? [row] : await db.select().from(pt).where(and(eq(pt.id, id), eq(pt.taskId, task.id), eq(pt.status, 'failed')));
      if (failed) await publishFailed(failed);
    }
  },
});

