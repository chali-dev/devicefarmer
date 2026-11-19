import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { db, sqlClient } from './index.js';
import { finishInlineProxies, stashInlineProxies } from './proxy-data-migration.js';
import { migrateTaskStatuses } from './task-data-migration.js';
import { migrateTelegramSettings } from './alert-channel-migration.js';
import { migrateTrackedIgSchedule } from './tracked-schedule-migration.js';
import { migrateTrackedPhones } from './tracked-phone-migration.js';
import { migrateTaskTimeouts } from './task-timeouts-migration.js';
import { migratePersonaStyles } from './persona-style-merge-migration.js';

/**
 * Schema migrations plus the idempotent TS data migrations around them (`npm run db:migrate`). Also run by
 * 导入 (modules/system/restore.ts) after a backup of an older schema was restored. Every step is idempotent.
 */
export async function runMigrations(log: (msg: string) => void = console.log): Promise<void> {
  // Data migration around the schema migrations (see proxy-data-migration.ts); both steps are idempotent.
  const stashed = await stashInlineProxies(sqlClient);
  if (stashed) log(`proxy pool: staged ${stashed} per-device proxies (encrypted)`);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  await finishInlineProxies(sqlClient);
  const renamed = await migrateTaskStatuses(sqlClient);
  if (renamed) log(`task centre: renamed the status of ${renamed} tasks (queued→pending, succeeded→success)`);
  await migrateTelegramSettings(sqlClient);
  await migrateTrackedIgSchedule(sqlClient);
  await migrateTrackedPhones(sqlClient);
  if (await migrateTaskTimeouts(sqlClient)) log('task timeouts: publish.timeout moved to tasks.timeouts');
  const styles = await migratePersonaStyles(sqlClient);
  if (styles) log(`personas: ${styles} styles merged into one (post style kept, comment style and fixed opening/closing dropped)`);
}
