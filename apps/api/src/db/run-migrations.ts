import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { db } from './index.js';

/**
 * The drizzle schema migrations (`npm run db:migrate`), also run by 导入 (modules/system/restore.ts) after a
 * restore. Idempotent: applied migrations are recorded in drizzle.__drizzle_migrations. The migrations were
 * squashed into one baseline on 2026-11-19: backups taken before that do not fit this schema.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}
