import { sqlClient } from './index.js';
import { runMigrations } from './run-migrations.js';

await runMigrations();
console.log('migrations applied');
await sqlClient.end();
