import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { isAdmin } from '../auth/rbac.js';
import { youtubeSource } from '../tracked/youtube.js';
import { scheduleCollection } from './scheduler.js';
import {
  assertTrendingAvailable, getTrendingSettings, latestSnapshots, refreshTrendingNow, saveTrendingSettings, slotOf, snapshotItems, trendingAvailable, TRENDING_TYPE,
} from './trending.js';

const S = schema.trendingSnapshots;

const SettingsBody = z.object({
  regions: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2')).max(10),
  categoryId: z.string().trim().regex(/^\d{1,4}$/).nullable(),
  intervalHours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24), z.literal(48), z.literal(168)]),
  maxResults: z.number().int().min(1).max(50),
  retentionDays: z.number().int().min(1).max(365),
});

/**
 * 趋势热点: public chart data (every signed-in user may read it); settings, "refresh now" and the
 * collection tick "run now" are admin only.
 */
export const trendingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/trending', {
    schema: {
      querystring: z.object({
        region: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
        snapshotId: z.string().uuid().optional(),
        q: z.string().trim().max(100).optional(),
      }),
    },
  }, async (req) => {
    const settings = await getTrendingSettings();
    const available = trendingAvailable();
    const configured = available && await youtubeSource.isConfigured();
    const latest = await latestSnapshots();
    const cat = settings.categoryId ?? '';
    let snap: typeof S.$inferSelect | undefined;
    if (req.query.snapshotId) {
      [snap] = await db.select().from(S).where(eq(S.id, req.query.snapshotId));
      if (!snap) throw notFound('快照不存在', 'trending.snapshot_not_found');
    } else {
      const region = req.query.region ?? settings.regions[0] ?? latest[0]?.region;
      snap = latest.find((s) => s.region === region && s.categoryId === cat) ?? latest.find((s) => s.region === region);
    }
    const history = snap ? await db.select({ id: S.id, slotAt: S.slotAt, capturedAt: S.capturedAt, itemCount: S.itemCount }).from(S)
      .where(and(eq(S.region, snap.region), eq(S.categoryId, snap.categoryId))).orderBy(desc(S.slotAt)).limit(60) : [];
    const lastTasks = isAdmin(req.user)
      ? await db.selectDistinctOn([schema.tasks.instanceName], {
        label: schema.tasks.instanceName, status: schema.tasks.status, errorCode: schema.tasks.errorCode, error: schema.tasks.error, createdAt: schema.tasks.createdAt, finishedAt: schema.tasks.finishedAt,
      }).from(schema.tasks).where(eq(schema.tasks.type, TRENDING_TYPE)).orderBy(schema.tasks.instanceName, desc(schema.tasks.createdAt)).limit(50)
      : [];
    const data = snap ? await snapshotItems(snap, req.query.q) : { previous: null, items: [] };
    const now = new Date();
    return {
      configured,
      notice: !available ? 'trending.unavailable' : !configured ? 'tracked.youtube_no_api_key' : !settings.regions.length ? 'trending.no_regions' : null,
      settings,
      nextSlotAt: settings.regions.length && configured ? new Date(slotOf(now, settings.intervalHours).getTime() + settings.intervalHours * 3600_000).toISOString() : null,
      regions: latest.map((s) => ({ id: s.id, region: s.region, categoryId: s.categoryId || null, capturedAt: s.capturedAt, itemCount: s.itemCount })),
      snapshot: snap ? { id: snap.id, region: snap.region, categoryId: snap.categoryId || null, slotAt: snap.slotAt, capturedAt: snap.capturedAt, itemCount: snap.itemCount } : null,
      history,
      lastTasks,
      ...data,
    };
  });

  app.put('/api/trending/settings', { preHandler: app.requireAdmin, schema: { body: SettingsBody } }, async (req) => {
    assertTrendingAvailable();
    return { settings: await saveTrendingSettings(req.body) };
  });

  /** Refreshes the current slot of every configured region now (coded error without regions or API key). */
  app.post('/api/trending/refresh', { preHandler: app.requireAdmin }, async (req, reply) => {
    const taskIds = await refreshTrendingNow(req.user.id);
    if (req.audit) req.audit.extra = { taskIds };
    reply.code(202);
    return { taskIds };
  });

  /** Runs the collection tick now (tracked-account schedules, trending slots, retention) as a task. */
  app.post('/api/collection/run', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { task } = await scheduleCollection(req.user.id, true);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

};
