import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { LibraryApp } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { adb } from '../../services.js';
import { readApkManifest } from '../apps/apk-manifest.js';

export function libraryDir(app: Pick<LibraryApp, 'package' | 'versionCode'>): string {
  return path.resolve(config.LIBRARY_DIR, app.package, app.versionCode);
}

/** Absolute APK paths + sizes in install order, for the install-apk task. */
export function libraryApks(app: LibraryApp): { apkPaths: string[]; sizes: number[] } {
  const dir = libraryDir(app);
  return { apkPaths: app.files.map((f) => path.join(dir, f.name)), sizes: app.files.map((f) => f.size) };
}

/** refType of install-apk tasks created from the library (refId = library_apps.id). */
export const LIBRARY_TASK_REF = 'library_app';

/** install-apk payload for a library app: APKs + which app version (kept in the task even if the entry is deleted). */
export function libraryInstallJob(app: LibraryApp) {
  return { ...libraryApks(app), library: { package: app.package, versionCode: app.versionCode, versionName: app.versionName } };
}
export const libraryTaskRef = (app: Pick<LibraryApp, 'id'>) => ({ refType: LIBRARY_TASK_REF, refId: app.id });

type LibraryFile = LibraryApp['files'][number];

/**
 * Stores one app version: `fill` writes the APKs (base first) into a temp dir and returns them; the dir
 * then replaces any earlier copy of the same package+version, and the row is upserted.
 */
async function saveLibraryApp(
  v: { package: string; versionCode: string; versionName: string | null; sourceInstance: string },
  fill: (tmp: string) => Promise<LibraryFile[]>,
): Promise<LibraryApp> {
  const dir = libraryDir(v);
  const tmp = `${dir}.tmp-${Date.now()}`;
  try {
    const files = await fill(tmp);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.rename(tmp, dir);
    const la = schema.libraryApps;
    const [row] = await db.insert(la)
      .values({ ...v, files })
      .onConflictDoUpdate({ target: [la.package, la.versionCode], set: { files, versionName: v.versionName, sourceInstance: v.sourceInstance, createdAt: new Date() } })
      .returning();
    return row!;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Imports an app as installed on a device (e.g. from Google Play) into the library.
 * Same package+version imported again replaces the stored files.
 */
export async function importFromDevice(adbPort: number, pkg: string, sourceInstance: string): Promise<LibraryApp> {
  const version = await adb.packageVersion(adbPort, pkg);
  if (!version) throw new Error(`${pkg} is not installed on ${sourceInstance}`);
  return saveLibraryApp({ package: pkg, ...version, sourceInstance }, (tmp) => adb.pullApks(adbPort, pkg, tmp));
}

/** sourceInstance of uploaded entries: `upload:<username>` (the UI shows "uploaded by …"). */
export const UPLOAD_SOURCE_PREFIX = 'upload:';

/**
 * Adds an uploaded app (one .apk, or the APKs of a split bundle) to the library. Package and version
 * come from the manifests: exactly one base APK, every APK of the same package and version code.
 */
export async function addUploadToLibrary(apkPaths: string[], username: string): Promise<LibraryApp> {
  const parsed = [];
  for (const p of apkPaths) {
    try { parsed.push({ p, m: await readApkManifest(p) }); }
    catch (err) { throw badRequest(`无法读取 APK：${path.basename(p)}（${(err as Error).message}）`, 'library.bad_apk', { file: path.basename(p), error: (err as Error).message }); }
  }
  const bases = parsed.filter((x) => !x.m.split);
  if (bases.length !== 1) throw badRequest(`需要恰好一个主 APK（找到 ${bases.length} 个）`, 'library.base_apk_count', { n: bases.length });
  const base = bases[0]!.m;
  const odd = parsed.find((x) => x.m.package !== base.package || x.m.versionCode !== base.versionCode);
  if (odd) throw badRequest('拆分包中的 APK 不属于同一个应用或版本', 'library.mixed_bundle', { file: path.basename(odd.p) });
  const ordered = [bases[0]!, ...parsed.filter((x) => x.m.split).sort((a, b) => a.m.split!.localeCompare(b.m.split!))];
  return saveLibraryApp(
    { package: base.package, versionCode: base.versionCode, versionName: base.versionName, sourceInstance: `${UPLOAD_SOURCE_PREFIX}${username}` },
    async (tmp) => {
      await fs.promises.mkdir(tmp, { recursive: true });
      const files: LibraryFile[] = [];
      for (const [i, { p, m }] of ordered.entries()) {
        const name = `${i}-${m.split ? `split_${m.split.replace(/[^\w.-]/g, '_')}` : 'base'}.apk`;
        await fs.promises.copyFile(p, path.join(tmp, name));
        files.push({ name, size: (await fs.promises.stat(p)).size, sha256: await sha256File(p) });
      }
      return files;
    },
  );
}

async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of fs.createReadStream(p)) h.update(c as Buffer);
  return h.digest('hex');
}

export async function removeLibraryApp(app: LibraryApp): Promise<void> {
  await db.delete(schema.libraryApps).where(eq(schema.libraryApps.id, app.id));
  await fs.promises.rm(libraryDir(app), { recursive: true, force: true });
}
