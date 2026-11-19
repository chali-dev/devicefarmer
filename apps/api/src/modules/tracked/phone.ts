import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { Instance, TrackedAccount } from '../../db/schema.js';
import { badRequest, conflict, HttpError } from '../../lib/errors.js';
import { getInstance } from '../instances/repo.js';
import { deviceHalts, withDevice, type CollectorDevice } from './collector.js';
import { platformDef } from './platforms.js';

/**
 * 采集手机 (owner decision 2026-11-19, replaces the global collector setting): every tracked account of a platform
 * read in the app (Instagram) is read on ONE cloud phone of its owner, `tracked_accounts.instance_id`. Allowed
 * phones = the devices the OWNER may operate: an admin owner any device, a user the devices granted to them
 * (instance_grants). The rule is checked when a phone is set and again before every read (a phone that has since
 * been assigned to someone else is refused with `tracked.phone_not_allowed`, nothing runs on it).
 */
export const usesPhone = (platform: string) => platformDef(platform).source?.kind === 'device';

const I = schema.instances;
const G = schema.instanceGrants;

async function isAdminUser(userId: string): Promise<boolean> {
  const [u] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId));
  return u?.role === 'admin';
}

/** Devices the owner may pick (id + name + state), by name. */
export async function ownerPhones(ownerId: string) {
  const cols = { id: I.id, name: I.name, status: I.status, adbState: I.adbState, sourceId: I.sourceId };
  return (await isAdminUser(ownerId))
    ? db.select(cols).from(I).orderBy(asc(I.name))
    : db.select(cols).from(I).innerJoin(G, and(eq(G.instanceId, I.id), eq(G.userId, ownerId))).orderBy(asc(I.name));
}

/** Whether `ownerId` may use `instanceId` as a 采集手机. */
export async function phoneAllowed(ownerId: string, instanceId: string): Promise<boolean> {
  return (await phonesAllowed([{ userId: ownerId, instanceId }])).has(`${ownerId}:${instanceId}`);
}

/** Batch form: the allowed `owner:instance` pairs (one users query + one grants query). */
export async function phonesAllowed(pairs: { userId: string; instanceId: string | null }[]): Promise<Set<string>> {
  const list = pairs.filter((p): p is { userId: string; instanceId: string } => !!p.instanceId);
  const out = new Set<string>();
  if (!list.length) return out;
  const userIds = [...new Set(list.map((p) => p.userId))];
  const instIds = [...new Set(list.map((p) => p.instanceId))];
  const [admins, existing, grants] = await Promise.all([
    db.select({ id: schema.users.id }).from(schema.users).where(and(inArray(schema.users.id, userIds), eq(schema.users.role, 'admin'))),
    db.select({ id: I.id }).from(I).where(inArray(I.id, instIds)),
    db.select({ u: G.userId, i: G.instanceId }).from(G).where(and(inArray(G.userId, userIds), inArray(G.instanceId, instIds))),
  ]);
  const adminSet = new Set(admins.map((a) => a.id));
  const exists = new Set(existing.map((e) => e.id));
  const granted = new Set(grants.map((g) => `${g.u}:${g.i}`));
  for (const p of list) {
    const k = `${p.userId}:${p.instanceId}`;
    if (exists.has(p.instanceId) && (adminSet.has(p.userId) || granted.has(k))) out.add(k);
  }
  return out;
}

/** The owner's phone when they have exactly one (default of a new tracked account), else null. */
export async function defaultPhone(ownerId: string): Promise<string | null> {
  const phones = await ownerPhones(ownerId);
  return phones.length === 1 ? phones[0]!.id : null;
}

/** Picker list (GET /api/tracked-accounts/phones): the owner's phones with state and whether an Instagram account is linked. */
export async function phonePickerList(ownerId: string) {
  const phones = await ownerPhones(ownerId);
  if (!phones.length) return [];
  const ids = phones.map((p) => p.id);
  const [halts, linked] = await Promise.all([
    deviceHalts(),
    db.select({ id: schema.socialAccounts.instanceId, n: sql<number>`count(*)::int` }).from(schema.socialAccounts)
      .where(and(inArray(schema.socialAccounts.instanceId, ids), eq(schema.socialAccounts.platform, 'instagram'), isNotNull(schema.socialAccounts.instanceId)))
      .groupBy(schema.socialAccounts.instanceId),
  ]);
  return phones.map((p) => ({
    id: p.id, name: p.name, status: p.status, external: !!p.sourceId,
    online: p.status === 'running' && p.adbState === 'device',
    halted: !!halts[p.id],
    instagramLinked: linked.some((l) => l.id === p.id),
  }));
}

export interface PhoneView { id: string; name: string; status: string; online: boolean; halted: boolean; allowed: boolean }

/** `phone` of list/detail items (one instances query + the allowed check), keyed by tracked account id. */
export async function phoneViews(rows: Pick<TrackedAccount, 'id' | 'userId' | 'instanceId'>[]): Promise<Map<string, PhoneView>> {
  const out = new Map<string, PhoneView>();
  const ids = [...new Set(rows.map((r) => r.instanceId).filter((x): x is string => !!x))];
  if (!ids.length) return out;
  const [insts, halts, allowed] = await Promise.all([
    db.select({ id: I.id, name: I.name, status: I.status, adbState: I.adbState }).from(I).where(inArray(I.id, ids)),
    deviceHalts(),
    phonesAllowed(rows),
  ]);
  for (const r of rows) {
    const i = r.instanceId ? insts.find((x) => x.id === r.instanceId) : undefined;
    if (!i) continue;
    out.set(r.id, {
      id: i.id, name: i.name, status: i.status, online: i.status === 'running' && i.adbState === 'device',
      halted: !!halts[i.id], allowed: allowed.has(`${r.userId}:${i.id}`),
    });
  }
  return out;
}

/** Why the account's phone can't be used (no phone, not the owner's, halted), as a coded error; null = usable. */
export async function trackedPhoneRefusal(acc: Pick<TrackedAccount, 'userId' | 'instanceId'>): Promise<HttpError | null> {
  if (!acc.instanceId) return badRequest('未设置采集手机', 'tracked.no_phone');
  if (!(await phoneAllowed(acc.userId, acc.instanceId))) return badRequest('采集手机不属于该追踪账号的所有者，请重新选择', 'tracked.phone_not_allowed');
  if ((await deviceHalts())[acc.instanceId]) return conflict('采集手机遇到验证/限制页面，采集已停止，需管理员在云机管理的设备卡片上恢复', 'tracked.collector_halted');
  return null;
}

/** The account's usable phone, or the coded refusal. */
export async function requireTrackedPhone(acc: Pick<TrackedAccount, 'userId' | 'instanceId'>): Promise<Instance> {
  const no = await trackedPhoneRefusal(acc);
  if (no) throw no;
  const inst = await getInstance(acc.instanceId!);
  if (!inst) throw badRequest('未设置采集手机', 'tracked.no_phone');
  return inst;
}

type Log = (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => Promise<void>;

/**
 * Runs one profile visit on the account's 采集手机 under the shared device rules (collector.ts withDevice: lock,
 * pace, busy). Throws the coded refusals (no phone, not allowed, halted, offline) or CollectorDefer.
 */
export async function withTrackedPhone<T>(acc: Pick<TrackedAccount, 'userId' | 'instanceId'>, log: Log, fn: (dev: CollectorDevice) => Promise<T>): Promise<T> {
  const inst = await requireTrackedPhone(acc);
  return withDevice(inst, log, () => new HttpError(503, `采集手机 ${inst.name} 不在线`, 'tracked.collector_offline', { name: inst.name }), fn, { what: 'collect' });
}
