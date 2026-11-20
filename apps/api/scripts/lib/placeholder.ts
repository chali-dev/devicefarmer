/**
 * Placeholder devices for the no-phone checks. Since redroid was removed (2026-11-20) every `instances` row is an
 * external phone of a device source, so a placeholder is a row of an INERT BitBrowser source: its config
 * `{ apiUrl: 'not a url' }` fails the driver's config parse, the monitor logs and skips the row every round, and the
 * row keeps exactly the status / adb_state the script wrote. No phone, client or tunnel is ever contacted (an
 * adb call on its adb_port just finds nothing there).
 *
 *   const ph = placeholders('ncfake');                        // nothing written yet
 *   const [dev] = await ph.insert({ name: `ncfake-${tag}`, adbPort: 5589, status: 'stopped' });
 *   …
 *   await ph.cleanup();                                       // its rows, then the source (no-op if never used)
 *
 * `insert` fills engine 'bitbrowser', the source, a unique externalId (default = the name) and spec 720×1280@320.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../src/db/index.js';

type InsertInstance = typeof schema.instances.$inferInsert;
export type PlaceholderRow = Omit<InsertInstance, 'engine' | 'sourceId' | 'externalId' | 'spec'>
  & Partial<Pick<InsertInstance, 'externalId' | 'spec'>>;

export const PLACEHOLDER_SPEC = { width: 720, height: 1280, dpi: 320 };

/** One inert device source (type bitbrowser, invalid apiUrl). */
export async function createInertSource(prefix: string): Promise<schema.DeviceSource> {
  const [src] = await db.insert(schema.deviceSources)
    .values({ type: 'bitbrowser', name: `${prefix}-src-${randomBytes(4).toString('hex')}`, config: { apiUrl: 'not a url' } })
    .returning();
  return src!;
}

/** Deletes every device of the source, then the source. */
export async function dropInertSource(sourceId: string): Promise<void> {
  await db.delete(schema.instances).where(eq(schema.instances.sourceId, sourceId));
  await db.delete(schema.deviceSources).where(eq(schema.deviceSources.id, sourceId));
}

export function placeholderValues(sourceId: string, row: PlaceholderRow): InsertInstance {
  return { externalId: row.name, spec: PLACEHOLDER_SPEC, ...row, engine: 'bitbrowser', sourceId };
}

export interface Placeholders {
  /** The inert source (created on first use). */
  source(): Promise<schema.DeviceSource>;
  insert(row: PlaceholderRow): Promise<schema.Instance[]>;
  insert(rows: PlaceholderRow[]): Promise<schema.Instance[]>;
  /** Deletes the rows of this source and the source; safe to call twice or when nothing was inserted. */
  cleanup(): Promise<void>;
}

export function placeholders(prefix: string): Placeholders {
  let src: Promise<schema.DeviceSource> | null = null;
  const source = () => (src ??= createInertSource(prefix));
  return {
    source,
    async insert(rows: PlaceholderRow | PlaceholderRow[]) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return [];
      const s = await source();
      return db.insert(schema.instances).values(list.map((r) => placeholderValues(s.id, r))).returning();
    },
    async cleanup() {
      if (!src) return;
      const s = await src.catch(() => null);
      src = null;
      if (s) await dropInertSource(s.id);
    },
  };
}
