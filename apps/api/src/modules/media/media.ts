import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { PUBLISH_UNFINISHED, type MediaAsset } from '../../db/schema.js';
import { describeError } from '../../adapters/storage/types.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { enqueueTask } from '../instances/queue.js';
import { registerTaskHandler } from '../tasks/core.js';
import { activeStorage, storageFor } from '../settings/storage.js';
import { formatByExt, MAGIC_BYTES, maxBytes, maxMb, mediaLimits, mimeMatches, type MediaFormat } from './formats.js';
import { analyzeMedia } from './process.js';

export type OwnerType = 'public' | 'user';
export interface Owner { ownerType: OwnerType; ownerId: string | null }

/** Temp dirs under UPLOAD_DIR are also swept by cleanupUploads() if a process dies mid-way. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.resolve(config.UPLOAD_DIR, randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  try { return await fn(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}

/**
 * Storage layout (same for local and S3): public/{images,videos,thumbnails}/<uuid>.<ext> and
 * users/<owner id>/{images,videos,thumbnails}/<uuid>.<ext>. Names are always random.
 */
export function mediaKey(owner: Owner, folder: 'images' | 'videos' | 'thumbnails', ext: string): string {
  const base = owner.ownerType === 'public' ? 'public' : `users/${owner.ownerId}`;
  return `${base}/${folder}/${randomUUID()}.${ext}`;
}

/** Display text only: strips control chars and path separators. */
function cleanName(s: string, max: number): string {
  return s.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(-max);
}

// ---------------------------------------------------------------- access rules

/** Non-admins see public assets only when ready (not disabled/processing/failed) and only their own private ones. */
export function canView(user: AuthUser, a: MediaAsset): boolean {
  if (a.deletedAt) return false;
  if (isAdmin(user)) return true;
  return a.ownerType === 'public' ? a.status === 'ready' : a.ownerId === user.id;
}

/** Public: admins only. Private: the owner, or any admin. */
export function assertCanManage(user: AuthUser, a: MediaAsset): void {
  if (isAdmin(user)) return;
  if (a.ownerType === 'public') throw forbidden('仅管理员可以管理公共素材', 'media.public_admin_only');
  if (a.ownerId !== user.id) throw notFound('media not found', 'media.not_found');
}

export function canManage(user: AuthUser, a: MediaAsset): boolean {
  return isAdmin(user) || (a.ownerType === 'user' && a.ownerId === user.id);
}

export async function getMedia(id: string): Promise<MediaAsset | undefined> {
  const [row] = await db.select().from(schema.mediaAssets).where(and(eq(schema.mediaAssets.id, id), isNull(schema.mediaAssets.deletedAt)));
  return row;
}

/** 404 for assets the user may not see (no existence leak). */
export async function getVisibleMedia(user: AuthUser, id: string): Promise<MediaAsset> {
  const a = await getMedia(id);
  if (!a || !canView(user, a)) throw notFound('media not found', 'media.not_found');
  return a;
}

/** Owner for a requested scope; `public` requires admin. */
export function ownerForScope(user: AuthUser, scope: 'public' | 'mine'): Owner {
  if (scope === 'public') {
    if (!isAdmin(user)) throw forbidden('仅管理员可以管理公共素材', 'media.public_admin_only');
    return { ownerType: 'public', ownerId: null };
  }
  return { ownerType: 'user', ownerId: user.id };
}

/** A category may only hold assets of the same owner. */
export async function assertCategoryFor(owner: Owner, categoryId: string): Promise<void> {
  const [c] = await db.select().from(schema.mediaCategories).where(eq(schema.mediaCategories.id, categoryId));
  if (!c || c.ownerType !== owner.ownerType || c.ownerId !== owner.ownerId) throw badRequest('分类不存在或不属于该素材的范围', 'media.category_mismatch');
}

/**
 * Single extension point for "is this asset still referenced by unfinished work?".
 * Pending/scheduled/running push-asset tasks, and unfinished publish tasks (incl. awaiting_operator)
 * whose media snapshot contains the asset.
 */
export async function assertMediaNotInUse(assetId: string): Promise<void> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.tasks).where(and(
    eq(schema.tasks.refType, 'media'), eq(schema.tasks.refId, assetId),
    eq(schema.tasks.type, 'push-asset'), inArray(schema.tasks.status, ['pending', 'scheduled', 'running']),
  ));
  const [pub] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.publishTasks).where(and(
    sql`${schema.publishTasks.mediaIds} @> array[${assetId}]::uuid[]`, inArray(schema.publishTasks.status, [...PUBLISH_UNFINISHED]),
  ));
  const n = (row?.n ?? 0) + (pub?.n ?? 0);
  if (n > 0) throw conflict(`素材正被 ${n} 个未完成的任务使用`, 'media.in_use', { tasks: n });
}

// ---------------------------------------------------------------- upload + processing

export interface UploadInput {
  stream: Readable & { truncated?: boolean };
  filename: string;
  mimetype: string;
  owner: Owner;
  categoryId?: string | null;
  userId: string;
}

function rejectType(): HttpError {
  const lim = mediaLimits();
  const exts = [...lim.image.formats, ...lim.video.formats].flatMap((f) => f.exts).join(', ');
  return new HttpError(415, `不支持的文件类型（支持：${exts}）`, 'media.unsupported_type', { exts });
}

/** Reads the stream to the end without keeping it (so the client gets our error, not a reset). */
async function drain(stream: Readable): Promise<void> {
  stream.resume();
  await new Promise<void>((resolve) => { stream.once('end', resolve); stream.once('error', () => resolve()); stream.once('close', resolve); });
}

/**
 * Validates and stores an upload, inserts it as 'processing' and queues the media-process job.
 * Checks: extension (allowed formats) → declared MIME → size limit for the kind → magic bytes.
 * The upload is spooled to a temp file (sha256, exact size and magic bytes are needed before
 * the object is written; S3 needs a content length).
 */
export async function createMedia(input: UploadInput): Promise<MediaAsset> {
  const format = formatByExt(input.filename);
  if (!format) { await drain(input.stream); throw rejectType(); }
  if (!mimeMatches(format, input.mimetype)) {
    await drain(input.stream);
    throw new HttpError(415, `文件类型（${input.mimetype}）与扩展名不符`, 'media.mime_mismatch', { mime: input.mimetype });
  }
  if (input.categoryId) await assertCategoryFor(input.owner, input.categoryId).catch(async (e) => { await drain(input.stream); throw e; });
  const limit = maxBytes(format.kind);
  const storage = await activeStorage();
  return withTempDir(async (dir) => {
    const tmp = path.join(dir, 'upload');
    const hash = createHash('sha256');
    let size = 0;
    let over = false;
    // Past the per-kind limit, keep reading but stop writing, so the client still gets a 413.
    await pipeline(input.stream, new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length;
        if (size > limit) { over = true; return cb(); }
        hash.update(chunk);
        cb(null, chunk);
      },
    }), fs.createWriteStream(tmp));
    if (over || input.stream.truncated) {
      throw new HttpError(413, `文件过大（${format.kind === 'image' ? '图片' : '视频'}上限 ${maxMb(format.kind)} MB）`, 'media.too_large', { kind: format.kind, max: maxMb(format.kind) });
    }
    if (size === 0) throw badRequest('empty file', 'media.empty_file');
    await assertMagic(tmp, format);

    const ext = format.exts[0]!;
    const fileKey = mediaKey(input.owner, format.kind === 'image' ? 'images' : 'videos', ext);
    try {
      await storage.put(fileKey, tmp, size, format.mime);
    } catch (err) {
      throw new HttpError(502, `存储（${storage.kind}）写入失败：${describeError(err)}`, 'media.storage_write_failed', { storage: storage.kind, error: describeError(err) });
    }
    const fileName = cleanName(input.filename, 200) || `upload.${ext}`;
    const name = fileName.replace(/\.[^.]{1,8}$/, '') || fileName;
    let row: MediaAsset;
    try {
      [row] = (await db.insert(schema.mediaAssets).values({
        ownerType: input.owner.ownerType, ownerId: input.owner.ownerId, categoryId: input.categoryId ?? null,
        name, fileName, storage: storage.kind, fileKey, fileType: format.kind, mimeType: format.mime, fileSize: size,
        checksum: hash.digest('hex'), status: 'processing', createdBy: input.userId,
      }).returning()) as [MediaAsset];
    } catch (err) {
      await storage.delete(fileKey).catch(() => undefined);
      throw err;
    }
    try {
      await enqueueTask('media-process', { assetId: row.id }, input.userId, { refType: 'media', refId: row.id, label: `处理素材 ${name}` });
    } catch (err) {
      await purgeMedia(row).catch(() => undefined);
      throw err;
    }
    return row;
  });
}

async function assertMagic(file: string, format: MediaFormat): Promise<void> {
  const fh = await fs.promises.open(file, 'r');
  const head = Buffer.alloc(MAGIC_BYTES);
  let n = 0;
  try { n = (await fh.read(head, 0, MAGIC_BYTES, 0)).bytesRead; } finally { await fh.close(); }
  if (!format.magic(head.subarray(0, n))) {
    throw new HttpError(415, `文件内容不是有效的 ${format.id.toUpperCase()}（扩展名与内容不符）`, 'media.content_mismatch', { format: format.id });
  }
}

/** Downloads the asset's file to a temp file and hands it to `fn` (processing, push to device). */
export async function withMediaFile<T>(asset: MediaAsset, fn: (localPath: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const local = path.join(dir, `file.${asset.fileKey.split('.').pop()}`);
    await pipeline(await openMedia(asset, 'file'), fs.createWriteStream(local));
    const st = await fs.promises.stat(local);
    if (st.size !== asset.fileSize) throw new Error(`downloaded ${st.size} bytes, expected ${asset.fileSize}`);
    return fn(local);
  });
}

/**
 * media-process job: metadata (sharp / ffprobe) + JPEG thumbnail / video cover, then 'ready'.
 * Errors set 'failed' with the reason and fail the task. If the asset was deleted meanwhile,
 * the freshly written thumbnail is removed again (no orphans).
 */
export async function processMedia(assetId: string): Promise<void> {
  const asset = await getMedia(assetId);
  if (!asset) return; // deleted before processing: nothing to do
  try {
    const storage = await storageFor(asset.storage);
    await withMediaFile(asset, async (local) => {
      const thumb = `${local}.thumb.jpg`;
      const info = await analyzeMedia(asset.fileType, local, thumb);
      const owner: Owner = { ownerType: asset.ownerType, ownerId: asset.ownerId };
      const thumbnailKey = mediaKey(owner, 'thumbnails', 'jpg');
      const st = await fs.promises.stat(thumb);
      await storage.put(thumbnailKey, thumb, st.size, 'image/jpeg');
      const done = await db.update(schema.mediaAssets)
        .set({ ...info, thumbnailKey, status: 'ready', error: null })
        .where(and(eq(schema.mediaAssets.id, asset.id), isNull(schema.mediaAssets.deletedAt), eq(schema.mediaAssets.status, 'processing')))
        .returning({ id: schema.mediaAssets.id });
      if (!done.length) await storage.delete(thumbnailKey).catch(() => undefined);
    });
  } catch (err) {
    const msg = describeError(err).slice(0, 500);
    await db.update(schema.mediaAssets).set({ status: 'failed', error: msg })
      .where(and(eq(schema.mediaAssets.id, asset.id), isNull(schema.mediaAssets.deletedAt)));
    throw new Error(msg);
  }
}

/**
 * media-process in the task centre (task-ops queue, device-less). If the task ends without
 * processMedia deciding (timeout, interrupted by a restart, cancelled), the asset is marked
 * failed here so it never stays 'processing'. A manual retry puts a failed asset back to processing.
 */
registerTaskHandler<{ assetId: string }>('media-process', {
  queue: 'task-ops',
  concurrency: 2,
  timeoutMs: 15 * 60_000,
  run: (ctx) => processMedia(ctx.payload.assetId ?? ctx.task.refId!),
  async onFailure(task) {
    const assetId = (task.payload as { assetId?: string } | null)?.assetId ?? task.refId;
    if (!assetId) return;
    await db.update(schema.mediaAssets).set({ status: 'failed', error: (task.error ?? task.errorCode ?? task.status).slice(0, 500) })
      .where(and(eq(schema.mediaAssets.id, assetId), isNull(schema.mediaAssets.deletedAt), eq(schema.mediaAssets.status, 'processing')));
  },
  async beforeRetry(task) {
    const assetId = (task.payload as { assetId?: string } | null)?.assetId ?? task.refId;
    const a = assetId ? await getMedia(assetId) : undefined;
    if (!a) throw conflict('任务的目标已不存在', 'tasks.target_gone');
    if (a.status !== 'failed') throw conflict('只有处理失败的素材可以重新处理', 'media.not_failed');
    await db.update(schema.mediaAssets).set({ status: 'processing', error: null }).where(eq(schema.mediaAssets.id, a.id));
  },
});

// ---------------------------------------------------------------- read / delete

export async function openMedia(asset: MediaAsset, which: 'file' | 'thumbnail'): Promise<Readable> {
  const key = which === 'file' ? asset.fileKey : asset.thumbnailKey;
  if (!key) throw notFound('thumbnail not available', 'media.no_thumbnail');
  try {
    return await (await storageFor(asset.storage)).getStream(key);
  } catch (err) {
    throw new HttpError(502, `素材文件无法从存储（${asset.storage}）读取：${describeError(err)}`, 'media.storage_read_failed', { storage: asset.storage, error: describeError(err) });
  }
}

/**
 * Deletion order (documented choice): 1) soft-delete the row (deleted_at: hidden everywhere at
 * once, processing won't touch it), 2) delete file + thumbnail from storage (idempotent),
 * 3) hard-delete the row (tags and favorites cascade). If step 2 fails the row stays
 * soft-deleted and purgeDeletedMedia() retries, so neither orphan files nor dangling rows remain.
 */
export async function purgeMedia(asset: MediaAsset): Promise<void> {
  if (!asset.deletedAt) await db.update(schema.mediaAssets).set({ deletedAt: new Date() }).where(eq(schema.mediaAssets.id, asset.id));
  // Re-read: processing may have set the thumbnail key in the meantime.
  const [cur] = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, asset.id));
  const row = cur ?? asset;
  try {
    const storage = await storageFor(row.storage);
    for (const key of [row.fileKey, row.thumbnailKey]) if (key) await storage.delete(key);
  } catch (err) {
    throw new HttpError(502, `素材文件无法从存储（${row.storage}）删除：${describeError(err)}`, 'media.storage_delete_failed', { storage: row.storage, error: describeError(err) });
  }
  await db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, asset.id));
}

/** Delete with permission + in-use checks (single and batch delete). */
export async function deleteMedia(user: AuthUser, asset: MediaAsset): Promise<void> {
  assertCanManage(user, asset);
  await assertMediaNotInUse(asset.id);
  await purgeMedia(asset);
}

/** Retries purges that failed earlier (startup + hourly). */
export async function purgeDeletedMedia(log: FastifyBaseLogger): Promise<void> {
  const rows = await db.select().from(schema.mediaAssets).where(isNotNull(schema.mediaAssets.deletedAt)).limit(500);
  for (const r of rows) {
    try { await purgeMedia(r); } catch (err) { log.warn({ err, id: r.id }, 'media purge retry failed'); }
  }
}

/** Removes every private asset (files + rows) of a user; called before the user is deleted. */
export async function purgeOwnerMedia(userId: string): Promise<void> {
  const rows = await db.select().from(schema.mediaAssets).where(and(eq(schema.mediaAssets.ownerType, 'user'), eq(schema.mediaAssets.ownerId, userId)));
  for (const r of rows) await purgeMedia(r);
}

/** Replaces an asset's tags (names are unique case-insensitively; the stored spelling wins). */
export async function setTags(assetId: string, names: string[]): Promise<void> {
  const byLower = new Map<string, string>();
  for (const n of names.map((x) => x.trim()).filter(Boolean)) if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
  const uniq = [...byLower.values()];
  await db.transaction(async (tx) => {
    await tx.delete(schema.mediaAssetTags).where(eq(schema.mediaAssetTags.assetId, assetId));
    if (!uniq.length) return;
    await tx.insert(schema.mediaTags).values(uniq.map((name) => ({ name }))).onConflictDoNothing();
    const tags = await tx.select({ id: schema.mediaTags.id }).from(schema.mediaTags)
      .where(inArray(sql`lower(${schema.mediaTags.name})`, uniq.map((n) => n.toLowerCase())));
    await tx.insert(schema.mediaAssetTags).values(tags.map((t) => ({ assetId, tagId: t.id }))).onConflictDoNothing();
  });
}
