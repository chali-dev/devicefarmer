import bcrypt from 'bcryptjs';
import { ne } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema, sqlClient } from './index.js';

if (!config.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required to seed the admin user');

const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
await db.transaction(async (tx) => {
  // Exactly one built-in admin: the configured ADMIN_USERNAME (cannot be deleted, disabled or demoted).
  await tx.update(schema.users).set({ builtin: false }).where(ne(schema.users.username, config.ADMIN_USERNAME));
  await tx.insert(schema.users)
    .values({ username: config.ADMIN_USERNAME, passwordHash, role: 'admin', builtin: true })
    // The password is only set when the account is created: an admin may have changed it in the app.
    // Set ADMIN_RESET_PASSWORD=1 to deliberately reset it to ADMIN_PASSWORD (recovery).
    .onConflictDoUpdate({
      target: schema.users.username,
      set: { role: 'admin', disabled: false, builtin: true, ...(process.env.ADMIN_RESET_PASSWORD === '1' ? { passwordHash } : {}) },
    });
});
console.log(`admin user "${config.ADMIN_USERNAME}" ready${process.env.ADMIN_RESET_PASSWORD === '1' ? ' (password reset to ADMIN_PASSWORD)' : ''}`);
await sqlClient.end();
