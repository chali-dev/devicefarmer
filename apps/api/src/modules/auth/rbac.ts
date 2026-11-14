import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Role } from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';

export interface AuthUser { id: string; username: string; role: Role }

/**
 * view    – see status
 * control – remote control (screen/touch/keys/paste/secure input), screenshot, file upload to the phone
 * operate – lifecycle (start/stop/restart), app install/uninstall, proxy, device settings, pushes
 *
 * Both roles may do all three on the devices they can see: `admin` sees every device,
 * `user` only devices granted in `instance_grants`. Creating/deleting devices, user/grant
 * management, storage settings and library/asset deletion are admin-only (see isAdmin).
 */
export type InstanceAction = 'view' | 'control' | 'operate';

export function isAdmin(user: AuthUser): boolean {
  return user.role === 'admin';
}

const ALL: readonly InstanceAction[] = ['view', 'control', 'operate'];
const ROLE_ACTIONS: Record<Role, readonly InstanceAction[]> = { admin: ALL, user: ALL };

export function roleAllows(role: Role, action: InstanceAction): boolean {
  return ROLE_ACTIONS[role].includes(action);
}

/** Admins see every instance; users only instances granted to them. */
export async function accessibleInstanceIds(user: AuthUser): Promise<Set<string> | 'all'> {
  if (isAdmin(user)) return 'all';
  const rows = await db.select({ id: schema.instanceGrants.instanceId })
    .from(schema.instanceGrants).where(eq(schema.instanceGrants.userId, user.id));
  return new Set(rows.map((r) => r.id));
}

export async function assertInstanceAccess(user: AuthUser, instanceId: string, action: InstanceAction): Promise<void> {
  if (!roleAllows(user.role, action)) throw forbidden(`role "${user.role}" cannot ${action} instances`, 'auth.role_forbidden', { role: user.role, action });
  if (isAdmin(user)) return;
  const [grant] = await db.select().from(schema.instanceGrants)
    .where(and(eq(schema.instanceGrants.userId, user.id), eq(schema.instanceGrants.instanceId, instanceId)));
  if (!grant) throw forbidden('no access to this instance', 'auth.no_instance_access');
}
