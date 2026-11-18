import { eq } from 'drizzle-orm';
import { db, schema } from '../../src/db/index.js';
import { assertDeviceRoom, linkLogs, writeLogs } from '../../src/modules/social/social.js';

/**
 * Test helper: links a social account to a (placeholder) device the way 从云手机同步 does when it binds the
 * phone (modules/social/sync.ts applySync). The account API no longer accepts `instanceId` (read only since
 * 2026-11-18), and placeholder devices have no phone to sync from, so scripts write the sync's result directly:
 * same per (device, platform) limit + advisory lock (assertDeviceRoom: throws social.device_limit /
 * social.platform_disabled), same link log (message "synced from device"). Same DB as the API under test.
 */
export async function linkAccount(accountId: string, instanceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [acc] = await tx.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, accountId)).for('update');
    const [inst] = await tx.select().from(schema.instances).where(eq(schema.instances.id, instanceId));
    if (!acc || !inst) throw new Error(`linkAccount: account ${accountId} or device ${instanceId} not found`);
    if (acc.instanceId === instanceId) return;
    await assertDeviceRoom(tx, inst, acc.platform, acc.id);
    await tx.update(schema.socialAccounts).set({ instanceId }).where(eq(schema.socialAccounts.id, accountId));
    await writeLogs(tx, null, await linkLogs(tx, accountId, acc.instanceId, instanceId, 'synced from device'));
  });
}

/** linkAccount that reports the refusal code instead of throwing (for limit tests). */
export async function tryLink(accountId: string, instanceId: string): Promise<string | null> {
  try { await linkAccount(accountId, instanceId); return null; } catch (err) {
    const code = (err as { code?: string }).code;
    if (!code) throw err;
    return code;
  }
}
