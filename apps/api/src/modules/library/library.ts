import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
    // A newer version takes over the preinstall flag from older ones of the same package (one statement).
    const la = schema.libraryApps;
    const moved = await db.update(la).set({ preinstall: sql`${la.id} = ${row!.id}` })
      .where(and(eq(la.package, pkg), sql`exists (select 1 from library_apps o where o.package = ${pkg} and o.preinstall and o.id <> ${row!.id})`))
      .returning();
    return moved.find((r) => r.id === row!.id) ?? row!;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** Keeps the first entry per package (callers order by preference). */
function onePerPackage(apps: LibraryApp[]): LibraryApp[] {
  const seen = new Set<string>();
  return apps.filter((a) => !seen.has(a.package) && !!seen.add(a.package));
}

/** Latest preinstall-flagged version per package. */
export async function preinstallApps(): Promise<LibraryApp[]> {
  return onePerPackage(await db.select().from(schema.libraryApps).where(eq(schema.libraryApps.preinstall, true)).orderBy(desc(schema.libraryApps.createdAt)));
}

/** Library entries by id, in the given order, one per package. Missing ids are ignored. */
export async function libraryAppsByIds(ids: string[]): Promise<LibraryApp[]> {
  if (!ids.length) return [];
  const byId = new Map((await db.select().from(schema.libraryApps).where(inArray(schema.libraryApps.id, ids))).map((r) => [r.id, r]));
  return onePerPackage(ids.flatMap((id) => byId.get(id) ?? []));
}

export async function removeLibraryApp(app: LibraryApp): Promise<void> {
  await db.delete(schema.libraryApps).where(eq(schema.libraryApps.id, app.id));
  await fs.promises.rm(libraryDir(app), { recursive: true, force: true });
}
