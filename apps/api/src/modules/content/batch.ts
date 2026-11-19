import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { PUBLISH_UNFINISHED, type PostType } from '../../db/schema.js';
import { badRequest, conflict, HttpError, notFound, type ErrorParams } from '../../lib/errors.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { cancelPublish, distribute } from '../publish/publish.js';
import { assertCategoryFor } from './categories.js';
import { assertNoUnfinishedPublish, refreshContentStatus, setContentTags, uniqueTags, visibleContent } from './content.js';

/**
 * Batch actions on contents (内容管理 批量操作), `POST /api/contents/batch`.
 *
 * - Any id the caller cannot see fails the whole batch with 404 `content.not_found` (same as the social batch).
 * - Visible rows are processed one by one, each in its own transaction with the single-row rules; a row that a rule
 *   refuses is reported in `skipped` with its error code (+ params) and the others still go through (partial success).
 * - A row that is already in the requested state (unarchive of a non-archived content, tags already there) is `ok`
 *   without a change; `changed` counts real changes.
 */
export const BATCH_ACTIONS = ['delete', 'archive', 'unarchive', 'cancel-publish', 'set-category', 'add-tags', 'remove-tags', 'publish'] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];
export const BATCH_MAX = 200;

export interface BatchSkip { id: string; code: string; params?: ErrorParams }
export interface BatchResult {
  action: BatchAction; count: number; ok: string[]; skipped: BatchSkip[]; changed: number;
  /** cancel-publish: publish tasks cancelled. */
  cancelledTasks?: number;
  /** publish: publish tasks created (dryRun: that would be created) and the target account count per ok content. */
  publish?: { tasks: number; items: { id: string; accounts: number }[] };
}

/** 批量发布 options (POST /api/contents/batch with action publish). */
export interface BatchPublishOpts { scheduledAt?: Date | null; postType?: PostType; includeDrafts?: boolean; dryRun?: boolean }

const c = schema.contents;
const pt = schema.publishTasks;

function skipOf(id: string, err: unknown): BatchSkip {
  if (err instanceof HttpError && err.code && err.statusCode < 500) return { id, code: err.code, ...(err.params ? { params: err.params } : {}) };
  throw err;
}

export async function batchContents(user: AuthUser, b: { ids: string[]; action: BatchAction; categoryId?: string | null; tags?: string[] } & BatchPublishOpts): Promise<BatchResult> {
  const { action } = b;
  const ids = [...new Set(b.ids)];
  if (action === 'set-category' && b.categoryId === undefined) throw badRequest('categoryId is required', 'content.batch_category_required');
  const tags = uniqueTags(b.tags ?? []);
  if ((action === 'add-tags' || action === 'remove-tags') && !tags.length) throw badRequest('tags are required', 'content.batch_tags_required');

  const rows = await db.select({ id: c.id, userId: c.userId }).from(c).where(inArray(c.id, ids)).orderBy(asc(c.id));
  if (rows.length !== ids.length || rows.some((r) => !isAdmin(user) && r.userId !== user.id)) throw notFound('内容不存在', 'content.not_found');

  const res: BatchResult = { action, count: ids.length, ok: [], skipped: [], changed: 0 };
  if (action === 'publish') return publishBatch(user, rows.map((r) => r.id), b, res);
  if (action === 'cancel-publish') res.cancelledTasks = 0;
  // set-category: the category must exist; whether it fits each content's owner is checked per row.
  if (action === 'set-category' && b.categoryId) {
    const [cat] = await db.select({ id: schema.contentCategories.id }).from(schema.contentCategories).where(eq(schema.contentCategories.id, b.categoryId));
    if (!cat) throw badRequest('分类不存在或不能用于这条内容', 'content_category.not_allowed');
  }

  for (const { id } of rows) {
    try {
      const changed = action === 'cancel-publish' ? await cancelAll(user, id, res) : await db.transaction(async (tx) => {
        const cur = await visibleContent(user, id, tx, true);
        switch (action) {
          case 'delete':
            await assertNoUnfinishedPublish(tx, id, 'delete');
            await tx.delete(c).where(eq(c.id, id));
            return true;
          case 'archive':
            if (cur.stage === 'archived') return false;
            await assertNoUnfinishedPublish(tx, id, 'archive');
            await tx.update(c).set({ stage: 'archived', updatedAt: new Date() }).where(eq(c.id, id));
            break;
          case 'unarchive':
            // Same as the row action 取消归档: back to ready (the previous stage is not stored).
            if (cur.stage !== 'archived') return false;
            await tx.update(c).set({ stage: 'ready', updatedAt: new Date() }).where(eq(c.id, id));
            break;
          case 'set-category': {
            const next = b.categoryId ? (await assertCategoryFor(cur.userId, b.categoryId, tx)).id : null;
            if (cur.categoryId === next) return false;
            await tx.update(c).set({ categoryId: next, updatedAt: new Date() }).where(eq(c.id, id));
            return true;
          }
          case 'add-tags':
          case 'remove-tags': {
            const before = (await tx.select({ name: schema.contentTags.name }).from(schema.contentTagLinks)
              .innerJoin(schema.contentTags, eq(schema.contentTags.id, schema.contentTagLinks.tagId))
              .where(eq(schema.contentTagLinks.contentId, id))).map((r) => r.name);
            const lower = new Set(before.map((x) => x.toLowerCase()));
            const drop = new Set(tags.map((x) => x.toLowerCase()));
            const next = action === 'add-tags' ? [...before, ...tags.filter((x) => !lower.has(x.toLowerCase()))] : before.filter((x) => !drop.has(x.toLowerCase()));
            if (next.length === before.length) return false;
            await setContentTags(tx, id, next);
            await tx.update(c).set({ updatedAt: new Date() }).where(eq(c.id, id));
            return true;
          }
        }
        await refreshContentStatus(id, tx);
        return true;
      });
      res.ok.push(id);
      if (changed) res.changed++;
    } catch (err) {
      res.skipped.push(skipOf(id, err));
    }
  }
  return res;
}

/**
 * 取消发布: cancels every unfinished publish task of the content that the caller may act on (users: tasks whose
 * user_id is themselves, like POST /api/publish/tasks/:id/cancel). Published posts stay on the platforms.
 * Skipped with `content.no_unfinished_publish` when there is nothing to cancel, or with the first refusal's code
 * (e.g. a running task: `publish.bad_status`) when some task could not be cancelled; the others are still cancelled.
 */
async function cancelAll(user: AuthUser, contentId: string, res: BatchResult): Promise<boolean> {
  const tasks = await db.select().from(pt)
    .where(and(eq(pt.contentId, contentId), inArray(pt.status, [...PUBLISH_UNFINISHED]), isAdmin(user) ? undefined : eq(pt.userId, user.id)))
    .orderBy(asc(pt.scheduledAt), asc(pt.id));
  if (!tasks.length) throw badRequest('内容没有可取消的发布任务', 'content.no_unfinished_publish');
  let first: unknown;
  let n = 0;
  for (const t of tasks) {
    try { await cancelPublish(user, t); n++; } catch (err) { first ??= err; }
  }
  res.cancelledTasks! += n;
  await refreshContentStatus(contentId);
  if (first) {
    const s = skipOf(contentId, first);
    throw new HttpError(409, 'partial', s.code, { ...s.params, cancelled: n, total: tasks.length });
  }
  return true;
}

/**
 * 批量发布: each content goes to its own 发布目标 (content_targets in order, enabled platforms only, minus accounts it was
 * already published to: no re-publishing in a batch) at one time (null = now) as one post type, through the same
 * `distribute()` as the single 分发 (one transaction per content, all or nothing, banned words / media / platform
 * checks included). Refused contents are reported in `skipped`:
 * - `content.batch_publish_draft`: a draft (unless `includeDrafts`; distribute then moves it to ready),
 * - `content.archived`, `content.batch_publish_unfinished` (any unfinished publish task of the content),
 * - `content.batch_publish_no_targets` (no usable default target), `content.batch_publish_done` (all already published),
 * - any 4xx distribute throws (its code + params).
 * `dryRun` runs only these pre-checks and creates nothing (`changed` 0, `publish.tasks` = tasks that would be created).
 */
async function publishBatch(user: AuthUser, ids: string[], o: BatchPublishOpts, res: BatchResult): Promise<BatchResult> {
  if (o.scheduledAt && o.scheduledAt.getTime() > Date.now() + 366 * 86400_000) throw badRequest('发布时间不能超过一年', 'publish.too_far');
  res.publish = { tasks: 0, items: [] };
  const ctg = schema.contentTargets;
  const acc = schema.socialAccounts;
  const [contents, targets, tasks] = await Promise.all([
    db.select().from(c).where(inArray(c.id, ids)),
    db.select({ contentId: ctg.contentId, accountId: ctg.accountId, platform: acc.platform }).from(ctg)
      .innerJoin(acc, eq(acc.id, ctg.accountId)).where(inArray(ctg.contentId, ids)).orderBy(asc(ctg.position)),
    db.select({ contentId: pt.contentId, accountId: pt.accountId, status: pt.status }).from(pt)
      .where(and(inArray(pt.contentId, ids), inArray(pt.status, [...PUBLISH_UNFINISHED, 'published']))),
  ]);
  const byId = new Map(contents.map((x) => [x.id, x]));
  for (const id of ids) {
    const content = byId.get(id)!;
    try {
      if (content.stage === 'archived') throw conflict('已归档的内容不能发布', 'content.archived');
      if (content.stage === 'draft' && !o.includeDrafts) throw badRequest('草稿需先设为待发布', 'content.batch_publish_draft');
      const mine = tasks.filter((x) => x.contentId === id);
      const unfinished = mine.filter((x) => x.status !== 'published').length;
      if (unfinished) throw conflict('内容已有未完成的发布任务', 'content.batch_publish_unfinished', { n: unfinished });
      const usable = targets.filter((x) => x.contentId === id && isPlatformEnabled(x.platform));
      if (!usable.length) throw badRequest('内容没有可用的默认发布目标', 'content.batch_publish_no_targets');
      const done = new Set(mine.map((x) => x.accountId));
      const todo = usable.filter((x) => !done.has(x.accountId));
      if (!todo.length) throw conflict('内容已发布到所有默认目标', 'content.batch_publish_done', { n: usable.length });
      if (!o.dryRun) {
        const r = await distribute(user, content, todo.map((x) => ({ accountId: x.accountId, scheduledAt: o.scheduledAt ?? null, postType: o.postType ?? 'feed' })));
        res.changed++;
        res.publish.tasks += r.created.length;
      } else res.publish.tasks += todo.length;
      res.ok.push(id);
      res.publish.items.push({ id, accounts: todo.length });
    } catch (err) {
      res.skipped.push(skipOf(id, err));
    }
  }
  return res;
}
