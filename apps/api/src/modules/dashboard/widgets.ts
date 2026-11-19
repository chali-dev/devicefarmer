import { eq, inArray, type SQL } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { deviceBusy, deviceHalts } from '../tracked/collector.js';
import { registerDashboardWidget, type DashboardCtx } from './registry.js';

/**
 * Dashboard (仪表板) widgets. Since 2026-11-19 (owner: 「仪表板简化 — 只显示 我的云机状态和媒体号分析数据」) the page has two
 * sections: 我的云机状态 (this widget) and 媒体号分析, which the page reads from GET /api/analytics/summary itself
 * (7 / 30 days switch, same RBAC). Every number is RBAC-scoped through `ctx.scope`: admin = every device,
 * user = granted devices.
 */

const I = schema.instances;

/** Devices visible to the scope user. */
const deviceScope = (ctx: DashboardCtx): SQL | undefined => (ctx.admin ? undefined
  : inArray(I.id, db.select({ id: schema.instanceGrants.instanceId }).from(schema.instanceGrants).where(eq(schema.instanceGrants.userId, ctx.scope.id))));

export type DeviceDashState = 'ok' | 'busy' | 'offline' | 'notRunning' | 'halted';
/** Why a device is listed under 需要处理. */
export type DeviceAttention = 'halted' | 'error' | 'offline' | 'stopped';
const ATTENTION_ORDER: DeviceAttention[] = ['halted', 'error', 'offline', 'stopped'];
const ATTENTION_MAX = 10;

// ---------------------------------------------------------------- 我的云机状态
// The same simplified state as the 云机管理 cards (web components/DeviceState.vue), by priority: 风控暂停 > not running
// > 离线 (running, adb not attached) > 忙 (an automatic operation holds the device lock) > 正常. One query + one
// settings read + one Redis MGET (read only), like GET /api/instances/automation.
// 需要处理 = halted, error, offline and stopped external phones (only admins power those; a stopped local phone was
// stopped on purpose and is not listed).
registerDashboardWidget('devices', async (ctx) => {
  const rows = await db.select({ id: I.id, name: I.name, status: I.status, adbState: I.adbState, sourceId: I.sourceId })
    .from(I).where(deviceScope(ctx)).orderBy(I.name);
  const [halts, busy] = await Promise.all([deviceHalts(), deviceBusy(rows.map((r) => r.id)).catch(() => new Map())]);
  const byState: Record<DeviceDashState, number> = { ok: 0, busy: 0, offline: 0, notRunning: 0, halted: 0 };
  const attention: { id: string; name: string; reason: DeviceAttention; status: string; external: boolean; code: string | null; at: string | null }[] = [];
  for (const r of rows) {
    const h = halts[r.id];
    const external = !!r.sourceId;
    let reason: DeviceAttention | null = null;
    if (h) { byState.halted++; reason = 'halted'; }
    else if (r.status !== 'running') {
      byState.notRunning++;
      if (r.status === 'error') reason = 'error';
      else if (r.status === 'stopped' && external) reason = 'stopped';
    } else if (r.adbState !== 'device') { byState.offline++; reason = 'offline'; }
    else if (busy.has(r.id)) byState.busy++;
    else byState.ok++;
    if (reason) attention.push({ id: r.id, name: r.name, reason, status: r.status, external, code: h?.code ?? null, at: h?.at ?? null });
  }
  attention.sort((a, b) => ATTENTION_ORDER.indexOf(a.reason) - ATTENTION_ORDER.indexOf(b.reason) || a.name.localeCompare(b.name));
  return { total: rows.length, byState, attentionTotal: attention.length, attention: attention.slice(0, ATTENTION_MAX) };
}, { order: 10 });
