import { eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { isAdmin, type AuthUser } from '../modules/auth/rbac.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

/**
 * Shared rules of the scoped name lists (人设 personas, 内容分类 content categories): public rows (owner_id null) are
 * managed by admins and usable by everyone; personal rows belong to one user (others get 404; admins see and manage
 * all). Names are unique per owner, case-insensitive (unique index). Each list keeps its own routes and counts; this
 * module holds the scope checks, error codes (`<code>.not_found|admin_only|exists|merge_same|merge_scope`) and schemas.
 */
export interface ScopedRow { id: string; ownerType: 'public' | 'user'; ownerId: string | null; name: string }
export interface ScopedCols { ownerType: AnyPgColumn; ownerId: AnyPgColumn; sort: AnyPgColumn }

export const ScopedName = z.string().trim().min(1).max(50);
export const ScopedDescription = z.string().trim().max(200).nullable().optional().transform((v) => (v === '' ? null : v));
export const ScopedSort = z.number().int().min(-100000).max(100000);
export const ScopedListQuery = z.object({ scope: z.enum(['public', 'mine', 'all-users']).default('public'), ownerId: z.string().uuid().optional() });
export const ScopedCreateBody = z.object({
  scope: z.enum(['public', 'mine']), ownerId: z.string().uuid().optional(), name: ScopedName, description: ScopedDescription, sort: ScopedSort.optional(),
});
export const ScopedPatchBody = z.object({ name: ScopedName.optional(), description: ScopedDescription, sort: ScopedSort.optional() });

/** `code` = error code prefix (e.g. `persona`), `noun` = Chinese fallback text (e.g. 人设). */
export function scopedList(code: string, noun: string, table: PgTable, cols: ScopedCols) {
  const adminOnly = () => forbidden(`仅管理员可以管理公共${noun}或其他用户的${noun}`, `${code}.admin_only`);

  /** The row if the user may see it (public: everyone; personal: owner or admin), else 404. */
  function visible<T extends ScopedRow>(user: AuthUser, row: T | undefined): T {
    if (!row || (row.ownerType === 'user' && row.ownerId !== user.id && !isAdmin(user))) throw notFound(`${noun}不存在`, `${code}.not_found`);
    return row;
  }
  /** The row if the user may manage it (public: admin; personal: owner or admin). */
  function manageable<T extends ScopedRow>(user: AuthUser, row: T | undefined): T {
    const r = visible(user, row);
    if (r.ownerType === 'public' && !isAdmin(user)) throw adminOnly();
    return r;
  }
  /** List filter: public = public rows; mine = the caller's; all-users = every user's personal rows (admin, optional ownerId). */
  function listWhere(user: AuthUser, scope: 'public' | 'mine' | 'all-users', ownerId?: string): SQL {
    if (scope === 'all-users' && !isAdmin(user)) throw adminOnly();
    return scope === 'public' ? eq(cols.ownerType, 'public') : scope === 'mine' ? eq(cols.ownerId, user.id) : ownerId ? eq(cols.ownerId, ownerId) : isNotNull(cols.ownerId);
  }
  /** Owner (null = public) and next sort for a create body; admins may create a personal row for another user. */
  async function createTarget(user: AuthUser, b: { scope: 'public' | 'mine'; ownerId?: string; sort?: number }): Promise<{ ownerId: string | null; sort: number }> {
    if (b.scope === 'public' && !isAdmin(user)) throw adminOnly();
    if (b.ownerId && b.ownerId !== user.id && !isAdmin(user)) throw adminOnly();
    const ownerId = b.scope === 'public' ? null : b.ownerId ?? user.id;
    if (ownerId && ownerId !== user.id) {
      const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerId));
      if (!u) throw notFound('用户不存在', 'users.not_found');
    }
    const owner = ownerId ? eq(cols.ownerId, ownerId) : isNull(cols.ownerId);
    const sort = b.sort ?? ((await db.select({ max: sql<number | null>`max(${cols.sort})` }).from(table).where(owner))[0]?.max ?? -1) + 1;
    return { ownerId, sort };
  }
  /** Runs an insert/update and turns a unique violation into 409 `<code>.exists`. */
  async function uniqueName<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (err) {
      if (uniqueViolation(err)) throw conflict(`${noun}名称已存在`, `${code}.exists`, { name });
      throw err;
    }
  }
  /** Merge direction: public → public; personal → the same owner's personal row or a public one. */
  function assertMerge(src: ScopedRow, dst: ScopedRow): void {
    if (src.id === dst.id) throw badRequest('不能合并到自身', `${code}.merge_same`);
    const ok = dst.ownerType === 'public' || (src.ownerType === 'user' && dst.ownerId === src.ownerId);
    if (!ok) throw badRequest(`只能合并到同一范围的${noun}（个人${noun}可以合并到公共${noun}）`, `${code}.merge_scope`);
  }
  /** Set of a PATCH body without undefined fields (400 when empty). */
  function patchSet<T extends Record<string, unknown>>(body: T): Partial<T> {
    const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<T>;
    if (!Object.keys(set).length) throw badRequest('nothing to update', 'common.nothing_to_update');
    return set;
  }
  /** A public row fits everything; a personal one only things owned by its owner (`ownerUserId`, null = shared). */
  const fits = (row: ScopedRow, ownerUserId: string | null) => row.ownerType === 'public' || (ownerUserId !== null && row.ownerId === ownerUserId);

  return { visible, manageable, listWhere, createTarget, uniqueName, assertMerge, patchSet, fits, adminOnly };
}

export function uniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}
