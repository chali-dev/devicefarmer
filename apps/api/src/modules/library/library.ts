import { and, desc, eq, inArray } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import type { LibraryApp } from '../../db/schema.js';
import { adb } from '../../services.js';

export function libraryDir(app: Pick<LibraryApp, 'package' | 'versionCode'>): string {
  return path.resolve(config.LIBRARY_DIR, app.package, app.versionCode);
}

/** Absolute APK paths + sizes in install order, for the install-apk task. */
export function libraryApks(app: LibraryApp): { apkPaths: string[]; sizes: number[] } {
  const dir = libraryDir(app);
  return { apkPaths: app.files.map((f) => path.join(dir, f.name)), sizes: app.files.map((f) => f.size) };
}

/**
 * Imports an app as installed on a device (e.g. from Google Play) into the library.
 * Same package+version imported again replaces the stored files.
 */
export async function importFromDevice(adbPort: number, pkg: string, sourceInstance: string): Promise<LibraryApp> {
  const version = await adb.packageVersion(adbPort, pkg);
  if (!version) throw new Error(`${pkg} is not installed on ${sourceInstance}`);
  const dir = libraryDir({ package: pkg, versionCode: version.versionCode });
  const tmp = `${dir}.tmp-${Date.now()}`;
  try {
    const files = await adb.pullApks(adbPort, pkg, tmp);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.rename(tmp, dir);
    const [row] = await db.insert(schema.libraryApps)
      .values({ package: pkg, versionName: version.versionName, versionCode: version.versionCode, files, sourceInstance })
      .onConflictDoUpdate({
        target: [schema.libraryApps.package, schema.libraryApps.versionCode],
        set: { files, versionName: version.versionName, sourceInstance, createdAt: new Date() },
      })
      .returning();
    // A newer version takes over the preinstall flag from older ones of the same package.
    const older = await db.select().from(schema.libraryApps).where(and(eq(schema.libraryApps.package, pkg), eq(schema.libraryApps.preinstall, true)));
    if (older.some((o) => o.id !== row!.id)) {
      await db.update(schema.libraryApps).set({ preinstall: false }).where(eq(schema.libraryApps.package, pkg));
      await db.update(schema.libraryApps).set({ preinstall: true }).where(eq(schema.libraryApps.id, row!.id));
    }
    return (await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.id, row!.id)))[0]!;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** Latest preinstall-flagged version per package. */
export async function preinstallApps(): Promise<LibraryApp[]> {
  const rows = await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.preinstall, true)).orderBy(desc(schema.libraryApps.createdAt));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.package) ? false : (seen.add(r.package), true)));
}

/** Library entries by id, one per package (a later id of the same package is skipped). Missing ids are ignored. */
export async function libraryAppsByIds(ids: string[]): Promise<LibraryApp[]> {
  if (!ids.length) return [];
  const rows = await db.select().from(schema.libraryApps).where(inArray(schema.libraryApps.id, ids));
  const seen = new Set<string>();
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is LibraryApp => !!r && (seen.has(r.package) ? false : (seen.add(r.package), true)));
}

export async function removeLibraryApp(app: LibraryApp): Promise<void> {
  await db.delete(schema.libraryApps).where(eq(schema.libraryApps.id, app.id));
  await fs.promises.rm(libraryDir(app), { recursive: true, force: true });
}
