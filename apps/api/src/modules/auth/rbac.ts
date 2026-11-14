import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Role } from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';

export interface AuthUser { id: string; username: string; role: Role }

/**
 * view    – see status
 * control – remote control (screen/touch/keys/paste)
 * operate – lifecycle (start/stop/restart/delete) + APK install
 */
export type InstanceAction = 'view' | 'control' | 'operate';

const ROLE_ACTIONS: Record<Role, InstanceAction[]> = {
  admin: ['view', 'control', 'operate'],
  operator: ['view', 'control', 'operate'],
  viewer: ['view', 'control'],
};

export function roleAllows(role: Role, action: InstanceAction): boolean {
  return ROLE_ACTIONS[role].includes(action);
}

export function canCreateInstances(user: AuthUser): boolean {
  return user.role === 'admin' || user.role === 'operator';
}

/** Admins see every instance; everybody else only instances granted to them. */
export async function accessibleInstanceIds(user: AuthUser): Promise<Set<string> | 'all'> {
  if (user.role === 'admin') return 'all';
  const rows = await db.select({ id: schema.instanceGrants.instanceId })
    .from(schema.instanceGrants).where(eq(schema.instanceGrants.userId, user.id));
  return new Set(rows.map((r) => r.id));
}

export async function assertInstanceAccess(user: AuthUser, instanceId: string, action: InstanceAction): Promise<void> {
  if (!roleAllows(user.role, action)) throw forbidden(`role "${user.role}" cannot ${action} instances`);
  if (user.role === 'admin') return;
  const [grant] = await db.select().from(schema.instanceGrants)
    .where(and(eq(schema.instanceGrants.userId, user.id), eq(schema.instanceGrants.instanceId, instanceId)));
  if (!grant) throw forbidden('no access to this instance');
}
