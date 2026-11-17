import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { PUBLISH_UNFINISHED, type Content, type ContentStatus, type MediaAsset, type PublishStatus } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { canView } from '../media/media.js';
import { translationLangs } from './languages.js';

/**
 * Content management (内容管理). Rules:
 * - A content is private to its owner (user_id); admins see and manage all. Others' rows are 404.
 * - Media are references to media_assets. The acting user must see the asset, and the content's owner
 *   must be allowed to use it: their own private media or public `ready` media (owner = admin: any).
 * - `status` is derived (refreshContentStatus) from the editor's `stage` and the publish tasks.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;
const c = schema.contents;
const pt = schema.publishTasks;

export async function visibleContent(user: AuthUser, id: string, exec: Exec = db, lock = false): Promise<Content> {
  const q = exec.select().from(c).where(eq(c.id, id));
  const [row] = await (lock ? q.for('update') : q);
  if (!row || (!isAdmin(user) && row.userId !== user.id)) throw notFound('内容不存在', 'content.not_found');
  return row;
}

export async function ownerOf(userId: string): Promise<AuthUser> {
  const [u] = await db.select({ id: schema.users.id, username: schema.users.username, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw badRequest('用户不存在', 'users.not_found');
  return u;
}

/** May `owner` use the asset in their content? Own private media, or public ready media; admins any. */
export function usableBy(owner: AuthUser, a: MediaAsset): boolean {
  if (a.deletedAt) return false;
  if (isAdmin(owner)) return true;
  return a.ownerType === 'public' ? a.status === 'ready' : a.ownerId === owner.id;
}

/** Validates an ordered media list for a content (dedupes, keeps order). Returns the assets in order. */
export async function assertUsableMedia(actor: AuthUser, owner: AuthUser, ids: string[]): Promise<MediaAsset[]> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return [];
  const rows = await db.select().from(schema.mediaAssets).where(and(inArray(schema.mediaAssets.id, uniq), isNull(schema.mediaAssets.deletedAt)));
  return uniq.map((id) => {
    const a = rows.find((r) => r.id === id);
    if (!a || !canView(actor, a)) throw notFound('media not found', 'media.not_found');
    if (!usableBy(owner, a)) throw badRequest(`素材「${a.name}」不能用于该用户的内容`, 'content.media_not_usable', { name: a.name });
    return a;
  });
}

export async function setContentMedia(tx: Tx, contentId: string, assetIds: string[]): Promise<void> {
  await tx.delete(schema.contentMedia).where(eq(schema.contentMedia.contentId, contentId));
  if (assetIds.length) await tx.insert(schema.contentMedia).values(assetIds.map((assetId, position) => ({ contentId, assetId, position })));
}

/** Ordered media rows of a content. */
export async function contentMediaOf(exec: Exec, contentId: string): Promise<MediaAsset[]> {
  const rows = await exec.select({ a: schema.mediaAssets }).from(schema.contentMedia)
    .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.contentMedia.assetId))
    .where(and(eq(schema.contentMedia.contentId, contentId), isNull(schema.mediaAssets.deletedAt)))
    .orderBy(asc(schema.contentMedia.position));
  return rows.map((r) => r.a);
}

// ---------------------------------------------------------------- tags (case-insensitive, first spelling wins)

export function uniqueTags(names: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const n of names.map((x) => x.trim().replace(/^#+/, '')).filter(Boolean)) if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
  return [...byLower.values()];
}

export async function setContentTags(tx: Tx, contentId: string, names: string[]): Promise<void> {
  const uniq = uniqueTags(names);
  await tx.delete(schema.contentTagLinks).where(eq(schema.contentTagLinks.contentId, contentId));
  if (!uniq.length) return;
  await tx.insert(schema.contentTags).values(uniq.map((name) => ({ name }))).onConflictDoNothing();
  const tags = await tx.select({ id: schema.contentTags.id }).from(schema.contentTags)
    .where(inArray(sql`lower(${schema.contentTags.name})`, uniq.map((n) => n.toLowerCase())));
  await tx.insert(schema.contentTagLinks).values(tags.map((t) => ({ contentId, tagId: t.id }))).onConflictDoNothing();
}

// ---------------------------------------------------------------- derived status

/**
 * stage archived → archived; no (non-cancelled) publish tasks → stage (draft/ready);
 * all published → published; some published → partially_published; any unfinished → scheduled; else failed.
 */
export function deriveStatus(stage: Content['stage'], counts: Partial<Record<PublishStatus, number>>): ContentStatus {
  if (stage === 'archived') return 'archived';
  const n = (s: PublishStatus) => counts[s] ?? 0;
  const total = (Object.keys(counts) as PublishStatus[]).filter((s) => s !== 'cancelled').reduce((a, s) => a + n(s), 0);
  if (!total) return stage;
  if (n('published') === total) return 'published';
  if (n('published') > 0) return 'partially_published';
  if (PUBLISH_UNFINISHED.some((s) => n(s) > 0)) return 'scheduled';
  return 'failed';
}

export async function publishCounts(exec: Exec, contentIds: string[]): Promise<Map<string, Partial<Record<PublishStatus, number>>>> {
  const out = new Map<string, Partial<Record<PublishStatus, number>>>();
  if (!contentIds.length) return out;
  const rows = await exec.select({ id: pt.contentId, s: pt.status, n: sql<number>`count(*)::int` }).from(pt)
    .where(inArray(pt.contentId, contentIds)).groupBy(pt.contentId, pt.status);
  for (const r of rows) out.set(r.id, { ...out.get(r.id), [r.s]: r.n });
  return out;
}

/** Recomputes and stores the content's status (no write when unchanged). */
export async function refreshContentStatus(contentId: string, exec: Exec = db): Promise<ContentStatus | undefined> {
  const [row] = await exec.select({ stage: c.stage }).from(c).where(eq(c.id, contentId));
  if (!row) return undefined;
  const status = deriveStatus(row.stage, (await publishCounts(exec, [contentId])).get(contentId) ?? {});
  await exec.update(c).set({ status }).where(and(eq(c.id, contentId), ne(c.status, status)));
  return status;
}

export async function unfinishedPublishCount(exec: Exec, contentId: string): Promise<number> {
  const [r] = await exec.select({ n: sql<number>`count(*)::int` }).from(pt).where(and(eq(pt.contentId, contentId), inArray(pt.status, [...PUBLISH_UNFINISHED])));
  return r?.n ?? 0;
}

export async function assertNoUnfinishedPublish(exec: Exec, contentId: string, action: 'delete' | 'archive'): Promise<void> {
  const n = await unfinishedPublishCount(exec, contentId);
  if (n > 0) {
    throw conflict(`内容还有 ${n} 个未完成的发布任务`, action === 'delete' ? 'content.has_unfinished_publish' : 'content.archive_unfinished', { count: n });
  }
}

// ---------------------------------------------------------------- shaping

export interface ContentMediaItem {
  id: string; name: string; fileType: 'image' | 'video'; status: MediaAsset['status']; ownerType: MediaAsset['ownerType'];
  width: number | null; height: number | null; duration: number | null; thumbnailUrl: string | null;
}

export const mediaItem = (a: MediaAsset): ContentMediaItem => ({
  id: a.id, name: a.name, fileType: a.fileType, status: a.status, ownerType: a.ownerType, width: a.width, height: a.height, duration: a.duration,
  thumbnailUrl: a.thumbnailKey ? `/api/media/${a.id}/thumbnail` : null,
});

const NONE = '00000000-0000-0000-0000-000000000000';

export async function toContentItems(rows: Content[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [tagRows, mediaRows, owners, counts, langs] = await Promise.all([
    db.select({ contentId: schema.contentTagLinks.contentId, name: schema.contentTags.name }).from(schema.contentTagLinks)
      .innerJoin(schema.contentTags, eq(schema.contentTags.id, schema.contentTagLinks.tagId))
      .where(inArray(schema.contentTagLinks.contentId, ids)).orderBy(asc(schema.contentTags.name)),
    db.select({ contentId: schema.contentMedia.contentId, a: schema.mediaAssets }).from(schema.contentMedia)
      .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.contentMedia.assetId))
      .where(and(inArray(schema.contentMedia.contentId, ids), isNull(schema.mediaAssets.deletedAt))).orderBy(asc(schema.contentMedia.position)),
    db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users)
      .where(inArray(schema.users.id, [...new Set(rows.map((r) => r.userId))].concat(NONE))),
    publishCounts(db, ids),
    translationLangs(ids),
  ]);
  return rows.map((r) => ({
    ...r,
    ownerName: owners.find((o) => o.id === r.userId)?.username ?? null,
    tags: tagRows.filter((t) => t.contentId === r.id).map((t) => t.name),
    media: mediaRows.filter((m) => m.contentId === r.id).map((m) => mediaItem(m.a)),
    publishCounts: counts.get(r.id) ?? {},
    /** Languages with a translation (the source language is `lang`). */
    translations: langs.get(r.id) ?? [],
  }));
}
