import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { Asset } from '../../db/schema.js';
import { describeError } from '../../adapters/storage/types.js';
import { HttpError } from '../../lib/errors.js';
import { activeStorage, storageFor } from '../settings/storage.js';

/** Temp dirs under UPLOAD_DIR are also swept by cleanupUploads() if a process dies mid-way. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.resolve(config.UPLOAD_DIR, randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  try { return await fn(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}

/**
 * Stores an uploaded stream on the ACTIVE backend. The upload is spooled to a temp file first
 * (sha256 + exact size are needed before the object is written, and S3 needs a content length).
 */
export async function createAsset(stream: Readable & { truncated?: boolean }, filename: string, mime: string, userId: string): Promise<Asset> {
  const storage = await activeStorage();
  return withTempDir(async (dir) => {
    const tmp = path.join(dir, 'upload');
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(stream, new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } }), fs.createWriteStream(tmp));
    if (stream.truncated) throw new HttpError(413, `file too large (max ${config.ASSET_MAX_MB} MB)`, 'assets.too_large', { max: config.ASSET_MAX_MB });
    if (size === 0) throw new HttpError(400, 'empty file', 'assets.empty_file');
    const now = new Date();
    const key = `assets/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    try {
      await storage.put(key, tmp, size, mime);
    } catch (err) {
      throw new HttpError(502, `storage (${storage.kind}) write failed: ${describeError(err)}`);
    }
    const name = filename.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(-200) || 'upload';
    const [row] = await db.insert(schema.assets).values({
      name, mime, size, sha256: hash.digest('hex'), storage: storage.kind, key, createdBy: userId,
    }).returning();
    return row!;
  });
}

/** Opens the asset's object on the backend it was written to; 502 with a clear reason if unreadable. */
export async function openAsset(asset: Asset): Promise<Readable> {
  try {
    return await (await storageFor(asset.storage)).getStream(asset.key);
  } catch (err) {
    throw new HttpError(502, `素材文件无法从存储（${asset.storage}）读取：${describeError(err)}`, 'assets.storage_read_failed', { storage: asset.storage, error: describeError(err) });
  }
}

/** Deletes the object, then the row. The row is kept if the object could not be deleted. */
export async function removeAsset(asset: Asset): Promise<void> {
  try {
    await (await storageFor(asset.storage)).delete(asset.key);
  } catch (err) {
    throw new HttpError(502, `素材文件无法从存储（${asset.storage}）删除：${describeError(err)}`, 'assets.storage_delete_failed', { storage: asset.storage, error: describeError(err) });
  }
  await db.delete(schema.assets).where(eq(schema.assets.id, asset.id));
}

export async function getAsset(id: string): Promise<Asset | undefined> {
  const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, id));
  return row;
}

/** Downloads the asset to a temp file and hands it to `fn` (used by the push-asset op). */
export async function withAssetFile<T>(asset: Asset, fn: (localPath: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const local = path.join(dir, 'asset');
    await pipeline(await openAsset(asset), fs.createWriteStream(local));
    const st = await fs.promises.stat(local);
    if (st.size !== asset.size) throw new Error(`downloaded ${st.size} bytes, expected ${asset.size}`);
    return fn(local);
  });
}
