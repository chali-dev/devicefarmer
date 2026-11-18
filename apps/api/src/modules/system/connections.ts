import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { adb } from '../../services.js';
import { isAdmin, type AuthUser } from '../auth/rbac.js';
import { scrcpyInfo } from '../control/scrcpy-hub.js';
import { offlineEventCond } from './history.js';

/**
 * Connection monitoring (连线监控): every device the viewer can see with its live link state. adb round
 * trips are measured by the monitor (`noteAdbRtt`, at most once a minute per device) and cached here;
 * the panel never touches a device. scrcpy state is this process's (the API that relays the sessions).
 */

const RTT_EVERY_MS = 60_000;
const rtt = new Map<string, { ms: number | null; at: number; inflight: boolean }>();

/** Called by the monitor for devices whose adb is `device`; measures a no-op `adb shell` when due. */
export function noteAdbRtt(instanceId: string, adbPort: number): void {
  const e = rtt.get(instanceId) ?? { ms: null, at: 0, inflight: false };
  rtt.set(instanceId, e);
  if (e.inflight || Date.now() - e.at < RTT_EVERY_MS) return;
  e.inflight = true;
  const t = performance.now();
  adb.shell(adbPort, 'true', 5000)
    .then(() => { e.ms = Math.round(performance.now() - t); }, () => { e.ms = null; })
    .finally(() => { e.at = Date.now(); e.inflight = false; });
}

const DAY_MS = 86_400_000;

/** One grouped query: devices (RBAC-scoped) + their last offline event in the last 24 h (the full history is the device log's 连线 tab). */
export async function connectionPanel(viewer: AuthUser, now = new Date()) {
  const I = schema.instances;
  const E = schema.instanceStatusEvents;
  const since = new Date(now.getTime() - DAY_MS);
  const agg = db.select({
    instanceId: E.instanceId,
    lastOfflineAt: sql<string | null>`max(${E.at})`.as('last_offline_at'),
  }).from(E).where(and(gte(E.at, since), offlineEventCond())).groupBy(E.instanceId).as('agg');
  const rows = await db.select({
    id: I.id, name: I.name, engine: I.engine, sourceId: I.sourceId, adbPort: I.adbPort, status: I.status,
    adbState: I.adbState, bootCompleted: I.bootCompleted, stfReady: I.stfReady, lastError: I.lastError,
    proxyId: I.proxyId, proxyStatus: I.proxyStatus, updatedAt: I.updatedAt,
    lastOfflineAt: agg.lastOfflineAt,
  }).from(I).leftJoin(agg, eq(agg.instanceId, I.id))
    .where(isAdmin(viewer) ? undefined : sql`exists (select 1 from ${schema.instanceGrants} g where g.instance_id = ${I.id} and g.user_id = ${viewer.id})`)
    .orderBy(I.name);
  return rows.map(({ adbPort, ...r }) => {
    const m = rtt.get(r.id);
    return {
      ...r,
      lastOfflineAt: r.lastOfflineAt ? new Date(r.lastOfflineAt).toISOString() : null,
      adbRttMs: r.adbState === 'device' ? m?.ms ?? null : null,
      adbRttAt: r.adbState === 'device' && m?.at ? new Date(m.at).toISOString() : null,
      scrcpy: scrcpyInfo(adbPort),
    };
  });
}

/** Status/adb changes of one device in the last `hours` (caller checks access), newest first. */
export async function deviceHistory(instanceId: string, hours: number) {
  const E = schema.instanceStatusEvents;
  return db.select({ id: E.id, field: E.field, from: E.from, to: E.to, status: E.status, at: E.at, offline: sql<boolean>`${offlineEventCond()}` })
    .from(E).where(and(eq(E.instanceId, instanceId), gte(E.at, new Date(Date.now() - hours * 3600_000))))
    .orderBy(desc(E.id)).limit(500);
}
