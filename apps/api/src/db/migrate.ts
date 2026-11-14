import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { db, sqlClient } from './index.js';
import { finishInlineProxies, stashInlineProxies } from './proxy-data-migration.js';

// Data migration around the schema migrations (see proxy-data-migration.ts); both steps are idempotent.
const stashed = await stashInlineProxies(sqlClient);
if (stashed) console.log(`proxy pool: staged ${stashed} per-device proxies (encrypted)`);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
await finishInlineProxies(sqlClient);
console.log('migrations applied');
await sqlClient.end();
