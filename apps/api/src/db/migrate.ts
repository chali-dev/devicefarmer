import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { db, sqlClient } from './index.js';
import { finishInlineProxies, stashInlineProxies } from './proxy-data-migration.js';
import { migrateTaskStatuses } from './task-data-migration.js';
import { migrateTelegramSettings } from './alert-channel-migration.js';
import { migratePersonaTexts } from './persona-data-migration.js';
import { migrateContentCategoryTexts } from './content-category-data-migration.js';
import { migrateSocialGroups } from './social-group-data-migration.js';

// Data migration around the schema migrations (see proxy-data-migration.ts); both steps are idempotent.
const stashed = await stashInlineProxies(sqlClient);
if (stashed) console.log(`proxy pool: staged ${stashed} per-device proxies (encrypted)`);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
await finishInlineProxies(sqlClient);
const renamed = await migrateTaskStatuses(sqlClient);
if (renamed) console.log(`task centre: renamed the status of ${renamed} tasks (queued→pending, succeeded→success)`);
await migrateTelegramSettings(sqlClient);
await migratePersonaTexts(sqlClient);
await migrateContentCategoryTexts(sqlClient);
await migrateSocialGroups(sqlClient);
console.log('migrations applied');
await sqlClient.end();
