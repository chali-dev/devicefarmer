import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { PUBLISH_UNFINISHED } from '../../db/schema.js';
import { conflict, forbidden } from '../../lib/errors.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { writeLogs, type LogEntry, type Tx } from './social.js';

/**
 * Accounts follow the phone (owner decision 2026-11-18: "云手机分配给 demo-user 了，怎么所有者还是 admin"). When a phone
 * is assigned to a user (PUT /api/instances/:id/grants, the 分配 batch, or a device newly added in
 * PUT /api/users/:id/grants), every social account linked to it (`social_accounts.instance_id`) owned by someone else
 * moves to that user, inside the caller's transaction:
 *   - owner → the new user; account log field `owner` (usernames, from → to), message `phone assigned`;
 *   - a personal persona (of the old owner) is cleared (log field `persona`, like a persona delete); public ones stay;
 *   - content_targets rows putting the account on contents not owned by the new user are removed;
 *   - the account's local comment copies (`comments.user_id` = the account owner) move with it.
 * Refused with 409 `instances.assign_account_busy` (nothing changed) while the account has unfinished publish tasks or
 * comment replies (drafts included): they belong to the old owner's work. Finished publish tasks / replies stay with
 * the user who made them (history). Assigning the same user again changes no grant but still moves linked accounts
 * that don't follow yet (accounts synced before this rule).
 * Unassigning (owner decision 2026-11-19 「不能，转移给新用户，未分配给 ADMIN」): the accounts of users who no longer
 * hold the phone move to the builtin admin (`releaseDeviceAccounts`, message `phone unassigned`, same rules).
 */
const SA = schema.socialAccounts;
const REPLY_UNFINISHED = ['draft', 'scheduled', 'sending', 'awaiting_operator'] as const;
export const ASSIGN_MESSAGE = 'phone assigned';
export const UNASSIGN_MESSAGE = 'phone unassigned';
export const OWNER_DISABLED_MESSAGE = 'owner disabled';
export const OWNER_DELETED_MESSAGE = 'owner deleted';

export interface AccountMove { id: string; handle: string; from: string; personaCleared: boolean; targetsRemoved: number }

interface MoveOptions {
  /** Only accounts owned by these users (default: every account not owned by the target). */
  fromUsers?: string[];
  /** Skip the busy check (user delete: the old owner's unfinished work is deleted with them). */
  force?: boolean;
  message?: string;
}

export async function moveDeviceAccounts(tx: Tx, actor: AuthUser, instanceId: string, toUserId: string, opts: MoveOptions = {}): Promise<AccountMove[]> {
  if (opts.fromUsers && !opts.fromUsers.length) return [];
  const accounts = await tx.select().from(SA).where(and(
    eq(SA.instanceId, instanceId), ne(SA.userId, toUserId), opts.fromUsers ? inArray(SA.userId, opts.fromUsers) : undefined,
  )).orderBy(SA.handle).for('update');
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a.id);
  const message = opts.message ?? ASSIGN_MESSAGE;
  const pubs = await tx.select({ accountId: schema.publishTasks.accountId, n: sql<number>`count(*)::int` }).from(schema.publishTasks)
    .where(and(inArray(schema.publishTasks.accountId, ids), inArray(schema.publishTasks.status, [...PUBLISH_UNFINISHED]))).groupBy(schema.publishTasks.accountId);
  const reps = await tx.select({ accountId: schema.commentTasks.accountId, n: sql<number>`count(*)::int` }).from(schema.commentTasks)
    .where(and(inArray(schema.commentTasks.accountId, ids), inArray(schema.commentTasks.status, [...REPLY_UNFINISHED]))).groupBy(schema.commentTasks.accountId);
  const busy = opts.force ? undefined : accounts.find((a) => pubs.some((p) => p.accountId === a.id) || reps.some((r) => r.accountId === a.id));
  if (busy) {
    const publish = pubs.find((p) => p.accountId === busy.id)?.n ?? 0;
    const replies = reps.find((r) => r.accountId === busy.id)?.n ?? 0;
    throw conflict(`账号 @${busy.handle} 还有 ${publish} 个未完成的发布任务、${replies} 条未完成的回复（含草稿），处理完后再改分配`,
      'instances.assign_account_busy', { handle: busy.handle, publish, replies });
  }
  const userIds = [...new Set([toUserId, ...accounts.map((a) => a.userId)])];
  const users = await tx.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, userIds));
  const name = (id: string) => users.find((u) => u.id === id)?.username ?? id;
  const personaIds = [...new Set(accounts.map((a) => a.personaId).filter((x): x is string => !!x))];
  const personas = personaIds.length
    ? await tx.select({ id: schema.personas.id, name: schema.personas.name, ownerType: schema.personas.ownerType, ownerId: schema.personas.ownerId }).from(schema.personas).where(inArray(schema.personas.id, personaIds))
    : [];

  const out: AccountMove[] = [];
  const logs: LogEntry[] = [];
  for (const a of accounts) {
    const p = a.personaId ? personas.find((x) => x.id === a.personaId) : undefined;
    const clearPersona = !!p && p.ownerType === 'user' && p.ownerId !== toUserId;
    await tx.update(SA).set({ userId: toUserId, ...(clearPersona ? { personaId: null } : {}) }).where(eq(SA.id, a.id));
    const removed = await tx.delete(schema.contentTargets).where(and(
      eq(schema.contentTargets.accountId, a.id),
      sql`${schema.contentTargets.contentId} in (select id from contents where user_id <> ${toUserId})`,
    )).returning({ contentId: schema.contentTargets.contentId });
    await tx.update(schema.comments).set({ userId: toUserId }).where(eq(schema.comments.accountId, a.id));
    logs.push({ accountId: a.id, action: 'update', field: 'owner', fromValue: name(a.userId), toValue: name(toUserId), message });
    if (clearPersona) logs.push({ accountId: a.id, action: 'update', field: 'persona', fromValue: p!.name, toValue: null, message });
    out.push({ id: a.id, handle: a.handle, from: a.userId, personaCleared: clearPersona, targetsRemoved: removed.length });
  }
  await writeLogs(tx, actor, logs);
  return out;
}

/** The builtin admin (ADMIN_USERNAME, flagged by the seed), else null. */
export async function builtinAdminId(exec: Tx | typeof db = db): Promise<string | null> {
  const [u] = await exec.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.builtin, true), eq(schema.users.role, 'admin'))).limit(1);
  return u?.id ?? null;
}

/**
 * After a phone's grants changed (unassigned, a user removed from it, a user disabled / deleted): every linked
 * account owned by a role-`user` account that no longer holds the phone moves to the builtin admin (else the acting
 * admin). Accounts of admins stay (admins may use every phone). `except` = users treated as not holding it although
 * their grant row still exists in this transaction (a user being disabled / deleted).
 */
export async function releaseDeviceAccounts(tx: Tx, actor: AuthUser, instanceId: string, opts: { force?: boolean; except?: string[] } = {}): Promise<AccountMove[]> {
  const holders = (await tx.select({ id: schema.instanceGrants.userId }).from(schema.instanceGrants).where(eq(schema.instanceGrants.instanceId, instanceId)))
    .map((g) => g.id).filter((id) => !opts.except?.includes(id));
  const owners = await tx.selectDistinct({ id: SA.userId }).from(SA)
    .innerJoin(schema.users, eq(schema.users.id, SA.userId))
    .where(and(eq(SA.instanceId, instanceId), eq(schema.users.role, 'user'), holders.length ? notInArray(SA.userId, holders) : undefined));
  if (!owners.length) return [];
  const to = (await builtinAdminId(tx)) ?? actor.id;
  return moveDeviceAccounts(tx, actor, instanceId, to, { fromUsers: owners.map((o) => o.id), force: opts.force, message: UNASSIGN_MESSAGE });
}

// ---------------------------------------------------------------- account-level device actions need the grant

/**
 * The `owner:instance` pairs where the owner may still use the phone: an enabled admin any phone, an enabled user a
 * phone granted to them (owner decision 2026-11-19).
 */
export async function devicesHeld(pairs: { userId: string; instanceId: string | null }[]): Promise<Set<string>> {
  const list = pairs.filter((p): p is { userId: string; instanceId: string } => !!p.instanceId);
  const out = new Set<string>();
  if (!list.length) return out;
  const userIds = [...new Set(list.map((p) => p.userId))];
  const instIds = [...new Set(list.map((p) => p.instanceId))];
  const [users, grants] = await Promise.all([
    db.select({ id: schema.users.id, role: schema.users.role }).from(schema.users).where(and(inArray(schema.users.id, userIds), eq(schema.users.disabled, false))),
    db.select({ u: schema.instanceGrants.userId, i: schema.instanceGrants.instanceId }).from(schema.instanceGrants)
      .where(and(inArray(schema.instanceGrants.userId, userIds), inArray(schema.instanceGrants.instanceId, instIds))),
  ]);
  const role = new Map(users.map((u) => [u.id, u.role]));
  const granted = new Set(grants.map((g) => `${g.u}:${g.i}`));
  for (const p of list) {
    const k = `${p.userId}:${p.instanceId}`;
    if (role.get(p.userId) === 'admin' || (role.get(p.userId) === 'user' && granted.has(k))) out.add(k);
  }
  return out;
}

export const DEVICE_NOT_GRANTED = 'social.device_not_granted';

/** Whether the account's owner may still use its linked phone (true without a phone: nothing runs on one). */
export async function ownerHoldsDevice(acc: { userId: string; instanceId: string | null }): Promise<boolean> {
  if (!acc.instanceId) return true;
  return (await devicesHeld([acc])).has(`${acc.userId}:${acc.instanceId}`);
}

/**
 * An action that makes the account's phone do something (检测, 同步, 采集, 追踪中 同步, 排程 / 改期 a reply): a
 * non-admin caller must hold the phone (instance_grants), else 403 social.device_not_granted. Admins unaffected.
 */
export async function assertAccountDevice(user: AuthUser, acc: { instanceId: string | null }): Promise<void> {
  if (isAdmin(user) || !acc.instanceId) return;
  if (!(await devicesHeld([{ userId: user.id, instanceId: acc.instanceId }])).size) {
    throw forbidden('该账号的云手机未分配给你，不能让它执行操作', DEVICE_NOT_GRANTED);
  }
}
