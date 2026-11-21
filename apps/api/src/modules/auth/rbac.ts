import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Role } from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';

/** `roleId` = the user's 自定义角色 (menus only, auth/role-menus.ts); absent/null = 普通用户. Ignored for admins. */
export interface AuthUser { id: string; username: string; role: Role; roleId?: string | null }

/**
 * view    – see status
 * control – remote control (screen/touch/keys/paste/secure input), screenshot, file upload to the phone
 * operate – app install, pushes (powering a phone on/off is admin only, see instances/routes.ts)
 *
 * Both roles may do all three on the devices they can see: `admin` sees every device,
 * `user` only devices granted in `instance_grants`. Adding/deleting devices, user/grant
 * management, storage settings, library deletion and public media management are admin-only
 * (see isAdmin; media rules in modules/media/media.ts).
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
  return assertInstancesAccess(user, [instanceId], action);
}

/** Batch form of assertInstanceAccess: one grant query for all ids (duplicates allowed). */
export async function assertInstancesAccess(user: AuthUser, instanceIds: readonly string[], action: InstanceAction): Promise<void> {
  if (!roleAllows(user.role, action)) throw forbidden(`role "${user.role}" cannot ${action} instances`, 'auth.role_forbidden', { role: user.role, action });
  if (isAdmin(user) || !instanceIds.length) return;
  const ids = [...new Set(instanceIds)];
  const grants = await db.select({ id: schema.instanceGrants.instanceId }).from(schema.instanceGrants)
    .where(and(eq(schema.instanceGrants.userId, user.id), inArray(schema.instanceGrants.instanceId, ids)));
  if (grants.length !== ids.length) throw forbidden('no access to this instance', 'auth.no_instance_access');
}
