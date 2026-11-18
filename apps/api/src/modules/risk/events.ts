import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

/**
 * 风控记录 (risk_events): one short coded row per problem the automatic device work met (collector visit,
 * account check). Written fire-and-forget (a failed insert never fails the visit), listed on the 风控 page,
 * purged after RETENTION_DAYS by the hourly system maintenance (fixed, like a log: no setting).
 */
export const RISK_RETENTION_DAYS = 90;
const E = schema.riskEvents;

export interface RiskEventInput {
  instance?: { id: string; name: string } | null;
  socialAccountId?: string | null;
  trackedAccountId?: string | null;
  source: 'collector' | 'account_check' | 'feed' | 'reply' | 'publish' | 'following';
  code: string;
  detail?: string | null;
  userId?: string | null;
}

export async function recordRiskEvent(e: RiskEventInput): Promise<void> {
  await db.insert(E).values({
    instanceId: e.instance?.id ?? null, instanceName: e.instance?.name ?? null,
    socialAccountId: e.socialAccountId ?? null, trackedAccountId: e.trackedAccountId ?? null,
    source: e.source, code: e.code, detail: e.detail ? e.detail.slice(0, 300) : null, userId: e.userId ?? null,
  }).catch(() => undefined);
}

export async function listRiskEvents(q: { instanceId?: string; code?: string; source?: string; limit: number; offset: number }) {
  const where: SQL[] = [];
  if (q.instanceId) where.push(eq(E.instanceId, q.instanceId));
  if (q.code) where.push(eq(E.code, q.code));
  if (q.source) where.push(eq(E.source, q.source));
  const cond = where.length ? and(...where) : undefined;
  const [rows, [{ total } = { total: 0 }], codes] = await Promise.all([
    db.select({
      id: E.id, at: E.at, instanceId: E.instanceId, instanceName: E.instanceName, source: E.source, code: E.code, detail: E.detail,
      socialAccountId: E.socialAccountId, trackedAccountId: E.trackedAccountId, userId: E.userId,
      socialHandle: schema.socialAccounts.handle, trackedHandle: schema.trackedAccounts.handle, username: schema.users.username,
    }).from(E)
      .leftJoin(schema.socialAccounts, eq(schema.socialAccounts.id, E.socialAccountId))
      .leftJoin(schema.trackedAccounts, eq(schema.trackedAccounts.id, E.trackedAccountId))
      .leftJoin(schema.users, eq(schema.users.id, E.userId))
      .where(cond).orderBy(desc(E.at), desc(E.id)).limit(q.limit).offset(q.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(E).where(cond),
    db.select({ code: E.code, n: sql<number>`count(*)::int` }).from(E).groupBy(E.code).orderBy(E.code),
  ]);
  return { events: rows, total, codes };
}

export async function purgeRiskEvents(days = RISK_RETENTION_DAYS): Promise<number> {
  const r = await db.delete(E).where(lt(E.at, new Date(Date.now() - days * 86_400_000))).returning({ id: E.id });
  return r.length;
}
