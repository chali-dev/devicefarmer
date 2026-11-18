import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { PLATFORMS } from '../social/platforms.js';
import { collectorDevices, deviceHalts, deviceUsage, resumeDevice } from '../tracked/collector.js';
import { listRiskEvents, RISK_RETENTION_DAYS } from './events.js';
import { capacityPerHour, getRiskSettings, RiskDeviceInput, riskDefaults, saveRiskSettings } from './settings.js';

/**
 * 风控 page API (admin only). The page also uses the existing APIs of its other sections:
 * 账号上限 = GET/PUT /api/social/settings, 评论回复规则 = GET/PUT /api/comments/settings.
 */
export const riskRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  const settingsView = async () => {
    const device = await getRiskSettings(true);
    return { device, defaults: riskDefaults(), capacityPerHour: capacityPerHour(device), eventRetentionDays: RISK_RETENTION_DAYS };
  };

  /** 云手机节奏 + 社交号自动检测 interval. Env TRACKED_DEVICE_* are the defaults. */
  app.get('/api/risk/settings', async () => settingsView());
  app.put('/api/risk/settings', {
    schema: { body: RiskDeviceInput.partial().strict().refine((b) => Object.keys(b).length > 0, 'nothing to update') },
  }, async (req) => {
    await saveRiskSettings(req.body);
    return settingsView();
  });

  /**
   * 云手机状态: every device used for automatic work (a platform's collector, the device of an account the
   * automatic check covers) plus any halted device: online, halt (code, time, source, account), visits.
   */
  app.get('/api/risk/devices', async () => {
    const checkPlatforms = PLATFORMS.filter((p) => p.deviceCheck).map((p) => p.id);
    const [collectors, halts, accountRows] = await Promise.all([
      collectorDevices(),
      deviceHalts(),
      checkPlatforms.length ? db.select({ instanceId: schema.socialAccounts.instanceId, n: sql<number>`count(*)::int` }).from(schema.socialAccounts)
        .where(and(isNotNull(schema.socialAccounts.instanceId), inArray(schema.socialAccounts.platform, checkPlatforms)))
        .groupBy(schema.socialAccounts.instanceId) : Promise.resolve([]),
    ]);
    const accounts = new Map(accountRows.map((r) => [r.instanceId!, r.n]));
    const ids = [...new Set([...collectors.keys(), ...Object.keys(halts), ...accounts.keys()])];
    if (!ids.length) return { devices: [] };
    const insts = await db.select({ id: schema.instances.id, name: schema.instances.name, status: schema.instances.status, adbState: schema.instances.adbState, sourceId: schema.instances.sourceId })
      .from(schema.instances).where(inArray(schema.instances.id, ids));
    const haltAccIds = Object.values(halts).flatMap((h) => [h.socialAccountId, h.trackedAccountId]).filter((x): x is string => !!x);
    const [social, tracked] = haltAccIds.length ? await Promise.all([
      db.select({ id: schema.socialAccounts.id, platform: schema.socialAccounts.platform, handle: schema.socialAccounts.handle }).from(schema.socialAccounts).where(inArray(schema.socialAccounts.id, haltAccIds)),
      db.select({ id: schema.trackedAccounts.id, platform: schema.trackedAccounts.platform, handle: schema.trackedAccounts.handle }).from(schema.trackedAccounts).where(inArray(schema.trackedAccounts.id, haltAccIds)),
    ]) : [[], []];
    const devices = await Promise.all(insts.map(async (i) => {
      const h = halts[i.id];
      const acc = h?.socialAccountId ? social.find((a) => a.id === h.socialAccountId) : h?.trackedAccountId ? tracked.find((a) => a.id === h.trackedAccountId) : undefined;
      return {
        id: i.id, name: i.name, status: i.status, adbState: i.adbState, external: !!i.sourceId,
        online: i.status === 'running' && i.adbState === 'device',
        collectorFor: collectors.get(i.id) ?? [],
        checkedAccounts: accounts.get(i.id) ?? 0,
        halted: h ? { at: h.at, code: h.code, source: h.source, platform: h.platform, account: acc ? { platform: acc.platform, handle: acc.handle, kind: h.socialAccountId ? 'social' : 'tracked' } : null } : null,
        ...(await deviceUsage(i.id).catch(() => ({ visitsLastHour: 0, lastVisitAt: null }))),
      };
    }));
    devices.sort((a, b) => Number(!!b.halted) - Number(!!a.halted) || a.name.localeCompare(b.name));
    return { devices };
  });

  /** 恢复: clears a device's halt (collector and account checks run again) and recovers its alert. */
  app.post('/api/risk/devices/:id/resume', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const [inst] = await db.select({ id: schema.instances.id }).from(schema.instances).where(eq(schema.instances.id, req.params.id));
    if (!inst) throw notFound('设备不存在', 'instances.not_found');
    return { resumed: await resumeDevice(inst.id) };
  });

  /** 风控记录, newest first; filters by device / code / source. */
  app.get('/api/risk/events', {
    schema: {
      querystring: z.object({
        instanceId: z.string().uuid().optional(),
        code: z.string().trim().max(100).optional(),
        source: z.enum(['collector', 'account_check']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
  }, async (req) => listRiskEvents(req.query));
};
