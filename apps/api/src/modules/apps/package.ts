import { unzipSync } from 'fflate';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../../config.js';
import { badRequest } from '../../lib/errors.js';

export interface PreparedApp {
  /** Original upload file name, for task records */
  name: string;
  apkPaths: string[];
  sizes: number[];
}

const BUNDLE_EXT = ['.apks', '.xapk', '.apkm', '.zip'];

/**
 * Stores an upload in its own directory. A single .apk is used as-is; a split bundle
 * (.apks/.xapk/.apkm/.zip) is unpacked and all contained .apk files are installed
 * together as one app (base + config splits). OBB data and encrypted bundles are not supported.
 */
export async function prepareUpload(stream: Readable & { truncated?: boolean }, filename: string): Promise<PreparedApp> {
  const lower = filename.toLowerCase();
  const isApk = lower.endsWith('.apk');
  if (!isApk && !BUNDLE_EXT.some((e) => lower.endsWith(e))) {
    throw badRequest('支持 .apk，或拆分包 .apks / .xapk / .apkm / .zip');
  }
  const dir = path.resolve(config.UPLOAD_DIR, randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  const raw = path.join(dir, isApk ? 'base.apk' : 'bundle.zip');
  await pipeline(stream, fs.createWriteStream(raw));
  if (stream.truncated) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw badRequest(`文件超过 ${config.MAX_APK_MB} MB 上限`);
  }
  if (isApk) return { name: filename, apkPaths: [raw], sizes: [(await fs.promises.stat(raw)).size] };

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(await fs.promises.readFile(raw), { filter: (f) => f.name.toLowerCase().endsWith('.apk') && !f.name.includes('/') });
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw badRequest(`无法解压拆分包（可能已加密或损坏）：${(err as Error).message}`);
  }
  const names = Object.keys(entries).sort((a, b) => (a === 'base.apk' ? -1 : b === 'base.apk' ? 1 : a.localeCompare(b)));
  if (names.length === 0) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw badRequest('拆分包中没有找到 .apk 文件');
  }
  const apkPaths: string[] = [];
  const sizes: number[] = [];
  for (const [i, n] of names.entries()) {
    const p = path.join(dir, `${i}-${path.basename(n)}`);
    await fs.promises.writeFile(p, entries[n]!);
    apkPaths.push(p);
    sizes.push(entries[n]!.length);
  }
  await fs.promises.rm(raw, { force: true });
  return { name: filename, apkPaths, sizes };
}

/** Uploads are shared by batch tasks; remove directories older than maxAgeMs. */
export async function cleanupUploads(maxAgeMs = 6 * 3600_000): Promise<void> {
  const root = path.resolve(config.UPLOAD_DIR);
  const dirs = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    const p = path.join(root, d.name);
    const st = await fs.promises.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > maxAgeMs) await fs.promises.rm(p, { recursive: true, force: true });
  }
}
