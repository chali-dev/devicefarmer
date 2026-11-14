import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { db, schema, sqlClient } from './index.js';

if (!config.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required to seed the admin user');

const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
await db.insert(schema.users)
  .values({ username: config.ADMIN_USERNAME, passwordHash, role: 'admin' })
  .onConflictDoUpdate({ target: schema.users.username, set: { passwordHash, role: 'admin' } });
console.log(`admin user "${config.ADMIN_USERNAME}" ready`);
await sqlClient.end();
