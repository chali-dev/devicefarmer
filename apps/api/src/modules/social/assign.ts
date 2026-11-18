import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { PUBLISH_UNFINISHED } from '../../db/schema.js';
import { conflict } from '../../lib/errors.js';
import type { AuthUser } from '../auth/rbac.js';
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
 * the user who made them (history). Unassigning moves nothing; assigning the same user again is a no-op.
 */
const SA = schema.socialAccounts;
const REPLY_UNFINISHED = ['draft', 'pending_review', 'approved', 'scheduled', 'sending', 'awaiting_operator'] as const;
export const ASSIGN_MESSAGE = 'phone assigned';

export interface AccountMove { id: string; handle: string; from: string; personaCleared: boolean; targetsRemoved: number }

export async function moveDeviceAccounts(tx: Tx, actor: AuthUser, instanceId: string, toUserId: string): Promise<AccountMove[]> {
  const accounts = await tx.select().from(SA).where(and(eq(SA.instanceId, instanceId), ne(SA.userId, toUserId))).orderBy(SA.handle).for('update');
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a.id);
  const pubs = await tx.select({ accountId: schema.publishTasks.accountId, n: sql<number>`count(*)::int` }).from(schema.publishTasks)
    .where(and(inArray(schema.publishTasks.accountId, ids), inArray(schema.publishTasks.status, [...PUBLISH_UNFINISHED]))).groupBy(schema.publishTasks.accountId);
  const reps = await tx.select({ accountId: schema.commentTasks.accountId, n: sql<number>`count(*)::int` }).from(schema.commentTasks)
    .where(and(inArray(schema.commentTasks.accountId, ids), inArray(schema.commentTasks.status, [...REPLY_UNFINISHED]))).groupBy(schema.commentTasks.accountId);
  const busy = accounts.find((a) => pubs.some((p) => p.accountId === a.id) || reps.some((r) => r.accountId === a.id));
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
    logs.push({ accountId: a.id, action: 'update', field: 'owner', fromValue: name(a.userId), toValue: name(toUserId), message: ASSIGN_MESSAGE });
    if (clearPersona) logs.push({ accountId: a.id, action: 'update', field: 'persona', fromValue: p!.name, toValue: null, message: ASSIGN_MESSAGE });
    out.push({ id: a.id, handle: a.handle, from: a.userId, personaCleared: clearPersona, targetsRemoved: removed.length });
  }
  await writeLogs(tx, actor, logs);
  return out;
}
