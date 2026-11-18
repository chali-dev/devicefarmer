import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { SocialAccount } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { accessibleInstanceIds, assertInstanceAccess, isAdmin, type AuthUser } from '../auth/rbac.js';
import { proxyViews, type InstanceProxyView } from '../proxies/pool.js';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { enabledPlatforms, PLATFORMS, platformById } from './platforms.js';

/**
 * Social accounts (社交账号). Rules:
 * - Owner-only for `user` (others' rows are 404), admins see and manage everything.
 * - Linking a device needs a grant on it; the number of accounts per (device, platform) is capped
 *   (`social.limits` setting, default from the registry), enforced under a per (device, platform)
 *   transaction advisory lock so concurrent links cannot exceed it.
 * - The egress proxy is derived from the device (instances.proxy_id), never stored on the account.
 * - Every change and every link/unlink writes a social_account_logs row.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

const sa = schema.socialAccounts;
const LIMITS_KEY = 'social.limits';
export const MAX_LIMIT = 100;

// ---------------------------------------------------------------- per-device limits

export async function getLimits(exec: Exec = db): Promise<Record<string, number>> {
  const [row] = await exec.select().from(schema.settings).where(eq(schema.settings.key, LIMITS_KEY));
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(PLATFORMS.map((p) => {
    const v = stored[p.id];
    return [p.id, typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : p.defaultLimit];
  }));
}

/** Merges the given platform limits into the stored ones (unknown platforms are rejected by the route schema). */
export async function saveLimits(input: Record<string, number>): Promise<Record<string, number>> {
  const next = { ...(await getLimits()), ...input };
  await db.insert(schema.settings).values({ key: LIMITS_KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return getLimits();
}

export function platformsWithLimits(limits: Record<string, number>) {
  return enabledPlatforms().map((p) => ({ id: p.id, name: p.name, defaultLimit: p.defaultLimit, limit: limits[p.id] ?? p.defaultLimit }));
}

/**
 * Checks that `user` may link `instanceId` and that it has room for one more `platform` account.
 * Must run inside the transaction that then writes the link: the advisory lock is held until commit,
 * so concurrent linkers of the same (device, platform) serialize and the second one sees the first.
 */
export async function assertLinkable(tx: Tx, user: AuthUser, instanceId: string, platform: string, exceptAccountId?: string): Promise<{ id: string; name: string }> {
  const [inst] = await tx.select({ id: schema.instances.id, name: schema.instances.name, allowedPlatforms: schema.instances.allowedPlatforms })
    .from(schema.instances).where(eq(schema.instances.id, instanceId));
  if (!inst) throw notFound('设备不存在', 'instances.not_found');
  await assertInstanceAccess(user, instanceId, 'operate');
  if (!platformAllowed(inst.allowedPlatforms, platform)) {
    const name = platformById(platform)?.name ?? platform;
    throw conflict(`设备 ${inst.name} 未开启 ${name}`, 'social.platform_disabled', { device: inst.name, platform: name });
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`social:${instanceId}:${platform}`}, 0))`);
  const limit = (await getLimits(tx))[platform] ?? 1;
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sa).where(and(
    eq(sa.instanceId, instanceId), eq(sa.platform, platform), exceptAccountId ? sql`${sa.id} <> ${exceptAccountId}` : undefined,
  ));
  if (n >= limit) {
    const name = platformById(platform)?.name ?? platform;
    throw conflict(`设备 ${inst.name} 上的 ${name} 账号已达上限（${limit} 个）`, 'social.device_limit', { device: inst.name, platform: name, limit });
  }
  return { id: inst.id, name: inst.name };
}

/** instances.allowed_platforms: null = every platform. */
export const platformAllowed = (allowed: string[] | null, platform: string) => allowed === null || allowed.includes(platform);

// ---------------------------------------------------------------- visibility

/** The account if `user` may see it (owner or admin), else 404. `lock` = FOR UPDATE inside a transaction. */
export async function visibleAccount(user: AuthUser, id: string, exec: Exec = db, lock = false): Promise<SocialAccount> {
  const q = exec.select().from(sa).where(eq(sa.id, id));
  const [row] = await (lock ? q.for('update') : q);
  if (!row || (!isAdmin(user) && row.userId !== user.id)) throw notFound('账号不存在', 'social.not_found');
  return row;
}

// ---------------------------------------------------------------- tags

function uniqueTags(names: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const n of names.map((x) => x.trim()).filter(Boolean)) if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
  return [...byLower.values()];
}

export async function tagsOf(exec: Exec, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = await exec.select({ accountId: schema.socialAccountTags.accountId, name: schema.socialTags.name }).from(schema.socialAccountTags)
    .innerJoin(schema.socialTags, eq(schema.socialTags.id, schema.socialAccountTags.tagId))
    .where(inArray(schema.socialAccountTags.accountId, ids)).orderBy(asc(schema.socialTags.name));
  for (const r of rows) out.set(r.accountId, [...(out.get(r.accountId) ?? []), r.name]);
  return out;
}

/** Replaces an account's tags (case-insensitive; the first stored spelling wins). Returns the stored names. */
export async function setAccountTags(tx: Tx, accountId: string, names: string[]): Promise<string[]> {
  const uniq = uniqueTags(names);
  await tx.delete(schema.socialAccountTags).where(eq(schema.socialAccountTags.accountId, accountId));
  if (!uniq.length) return [];
  await tx.insert(schema.socialTags).values(uniq.map((name) => ({ name }))).onConflictDoNothing();
  const tags = await tx.select({ id: schema.socialTags.id, name: schema.socialTags.name }).from(schema.socialTags)
    .where(inArray(sql`lower(${schema.socialTags.name})`, uniq.map((n) => n.toLowerCase())));
  await tx.insert(schema.socialAccountTags).values(tags.map((t) => ({ accountId, tagId: t.id }))).onConflictDoNothing();
  return tags.map((t) => t.name).sort();
}

export const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && [...a].map((x) => x.toLowerCase()).sort().join('\n') === [...b].map((x) => x.toLowerCase()).sort().join('\n');

// ---------------------------------------------------------------- logs

export type LogEntry = Omit<typeof schema.socialAccountLogs.$inferInsert, 'id' | 'at' | 'actorId' | 'actorName'>;
const clip = (v: string | null | undefined) => (v == null ? null : v.length > 300 ? `${v.slice(0, 300)}…` : v);

export async function writeLogs(exec: Exec, actor: AuthUser | null, entries: LogEntry[]): Promise<void> {
  if (!entries.length) return;
  await exec.insert(schema.socialAccountLogs).values(entries.map((e) => ({
    ...e, fromValue: clip(e.fromValue), toValue: clip(e.toValue), message: clip(e.message),
    actorId: actor?.id ?? null, actorName: actor?.username ?? null,
  })));
}

/** Device names by id in one query (a missing device falls back to its id). */
export async function instanceNames(exec: Exec, ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = want.length ? await exec.select({ id: schema.instances.id, name: schema.instances.name }).from(schema.instances).where(inArray(schema.instances.id, want)) : [];
  return new Map(want.map((id) => [id, rows.find((r) => r.id === id)?.name ?? id]));
}

/** Link/unlink log rows for a device change (`from` → `to`, either may be null). */
export async function linkLogs(exec: Exec, accountId: string, from: string | null, to: string | null, message?: string): Promise<LogEntry[]> {
  const out: LogEntry[] = [];
  if (from === to) return out;
  const names = await instanceNames(exec, [from, to]);
  if (from) out.push({ accountId, action: 'unlink', field: 'device', fromValue: names.get(from)!, toValue: null, message });
  if (to) out.push({ accountId, action: 'link', field: 'device', fromValue: null, toValue: names.get(to)!, message });
  return out;
}

/**
 * Called before a device row is deleted (same transaction): unlinks its accounts and logs it.
 * The FK (ON DELETE SET NULL) is only the backstop for deletes that bypass this.
 */
export async function unlinkInstanceAccounts(tx: Tx, instanceId: string, instanceName: string): Promise<number> {
  const rows = await tx.select({ id: sa.id }).from(sa).where(eq(sa.instanceId, instanceId)).for('update');
  if (!rows.length) return 0;
  await writeLogs(tx, null, rows.map((r) => ({
    accountId: r.id, action: 'unlink' as const, field: 'device', fromValue: instanceName, toValue: null, message: 'device deleted',
  })));
  await tx.update(sa).set({ instanceId: null }).where(inArray(sa.id, rows.map((r) => r.id)));
  return rows.length;
}

// ---------------------------------------------------------------- shaping

/** Login problems or a restricted account or a recorded error. `unknown` login status is not an exception. */
export const EXCEPTION_SQL = sql`(${sa.loginStatus} in ('logged_out', 'needs_verification') or ${sa.accountStatus} <> 'active' or ${sa.lastError} is not null)`;
export const isException = (a: Pick<SocialAccount, 'loginStatus' | 'accountStatus' | 'lastError'>) =>
  a.loginStatus === 'logged_out' || a.loginStatus === 'needs_verification' || a.accountStatus !== 'active' || a.lastError !== null;

/** Legacy `group_id` (social_account_groups, see schema.ts) is never returned. */
export interface SocialAccountItem extends Omit<SocialAccount, 'groupId'> {
  ownerName: string | null;
  /** 账号人设 name (personaId is on the row). */
  personaName: string | null;
  tags: string[];
  /** Linked device. `accessible` = the viewer has a grant (otherwise no proxy is shown). */
  instance: { id: string; name: string; status: string; accessible: boolean } | null;
  /** Egress proxy, derived from the device's pool binding (non-secret fields only). */
  proxy: InstanceProxyView | null;
  /** Measured egress of the linked device (country/region/city/IP from its proxy status); viewers with a grant only. */
  egress: { ip: string | null; country: string | null; region: string | null; city: string | null; checkedAt: string } | null;
  exception: boolean;
  /** Why 自动检测 can't run for this account (account_check.unsupported_platform | no_device), null = it can. */
  autoCheckUnsupported: string | null;
}

const NONE = '00000000-0000-0000-0000-000000000000';
const idsOf = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].concat(NONE);

export async function toItems(user: AuthUser, rows: SocialAccount[]): Promise<SocialAccountItem[]> {
  if (!rows.length) return [];
  const [tags, owners, insts, access, personas] = await Promise.all([
    tagsOf(db, rows.map((r) => r.id)),
    db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, idsOf(rows.map((r) => r.userId)))),
    db.select({ id: schema.instances.id, name: schema.instances.name, status: schema.instances.status, proxyId: schema.instances.proxyId, proxyStatus: schema.instances.proxyStatus })
      .from(schema.instances).where(inArray(schema.instances.id, idsOf(rows.map((r) => r.instanceId)))),
    accessibleInstanceIds(user),
    db.select({ id: schema.personas.id, name: schema.personas.name }).from(schema.personas).where(inArray(schema.personas.id, idsOf(rows.map((r) => r.personaId)))),
  ]);
  const canSee = (id: string) => access === 'all' || access.has(id);
  const proxies = await proxyViews(insts.filter((i) => i.proxyId && canSee(i.id)).map((i) => i.proxyId!));
  return rows.map(({ groupId: _legacyGroup, ...r }) => {
    const inst = insts.find((i) => i.id === r.instanceId);
    return {
      ...r,
      ownerName: owners.find((o) => o.id === r.userId)?.username ?? null,
      personaName: personas.find((p) => p.id === r.personaId)?.name ?? null,
      tags: tags.get(r.id) ?? [],
      instance: inst ? { id: inst.id, name: inst.name, status: inst.status, accessible: canSee(inst.id) } : null,
      proxy: inst?.proxyId && canSee(inst.id) ? proxies.get(inst.proxyId) ?? null : null,
      egress: inst?.proxyStatus && canSee(inst.id)
        ? { ip: inst.proxyStatus.egressIp, country: inst.proxyStatus.country ?? null, region: inst.proxyStatus.region ?? null, city: inst.proxyStatus.city ?? null, checkedAt: inst.proxyStatus.checkedAt }
        : null,
      exception: isException(r),
      autoCheckUnsupported: !platformById(r.platform)?.deviceCheck || !isPlatformEnabled(r.platform) ? 'account_check.unsupported_platform' : !r.instanceId ? 'account_check.no_device' : null,
    };
  });
}
