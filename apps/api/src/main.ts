import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { sqlClient } from './db/index.js';
import { checkHealth } from './health.js';
import { events } from './lib/events.js';
import { HttpError } from './lib/errors.js';
import { startLeaderElection } from './lib/leader.js';
import { closeAllTunnels } from './adapters/bitbrowser-tunnel.js';
import { authPlugin } from './modules/auth/plugin.js';
import { authRoutes } from './modules/auth/routes.js';
import { auditPlugin } from './modules/audit/plugin.js';
import { auditRoutes } from './modules/audit/routes.js';
import { controlRoutes } from './modules/control/session.js';
import { startRelayListener } from './modules/control/scrcpy-relay.js';
import { eventsRoutes } from './modules/control/events-ws.js';
import { instanceRoutes } from './modules/instances/routes.js';
import './modules/instances/queue.js'; // registers the device-op task handlers
import { closeTaskQueues, reconcileTasks, startTaskWorkers } from './modules/tasks/core.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { scheduleTaskCleanup } from './modules/tasks/retention.js'; // registers the tasks-cleanup handler
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { startMonitor } from './modules/monitor/monitor.js';
import { userRoutes } from './modules/users/routes.js';
import { roleRoutes } from './modules/auth/roles.js';
import { appRoutes } from './modules/apps/routes.js';
import { libraryRoutes } from './modules/library/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { mediaCategoryRoutes } from './modules/media/categories.js';
import { purgeDeletedMedia } from './modules/media/media.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { sourceRoutes } from './modules/sources/routes.js';
import { proxyRoutes } from './modules/proxies/routes.js';
import { socialRoutes } from './modules/social/routes.js';
import { trackedRoutes } from './modules/tracked/routes.js';
import { platformRoutes } from './modules/platforms/routes.js';
import { contentCategoryRoutes } from './modules/content/categories.js';
import { contentRoutes } from './modules/content/routes.js';
import { publishRoutes } from './modules/publish/routes.js';
import './modules/publish/publish.js'; // registers the publish task handler (manual publishing)
import { personaRoutes } from './modules/comments/personas.js';
import { aiRoutes } from './modules/ai/routes.js';
import { commentRoutes } from './modules/comments/routes.js'; // also registers the comment-reply task handler
import './modules/comments/dashboard.js'; // comments widget on the dashboard + task-retention keep rule
import { analyticsRoutes } from './modules/analytics/routes.js';
import './modules/analytics/analytics.js'; // analytics dashboard widget (historical data only)
import { trendingRoutes } from './modules/trending/routes.js'; // 趋势热点 + trending-refresh task + dashboard widget
import { scheduleCollection } from './modules/trending/scheduler.js'; // hourly collection tick (tracked schedules, trending)
import { alertsHourly, notifyRoutes } from './modules/notify/routes.js'; // alerts: notifications, rules, alert channels
import { riskRoutes } from './modules/risk/routes.js'; // 风控: device pace, device halts, risk events
import { scheduleAccountDeviceChecks } from './modules/social/check.js'; // 社交号自动检测 (task account-device-check)
import { discoverDeviceAccounts } from './modules/social/sync.js'; // 从云手机同步 + 自动发现 (task account-device-sync)
import { followingRoutes } from './modules/social/following-routes.js'; // 我的媒体号 → 粉丝 / 追踪中
import { scheduleFollowingSyncs } from './modules/social/following.js'; // 追踪中 (task account-following)
import { feedRoutes } from './modules/feed/routes.js'; // 帖子与评论 (account feed): feed API, collect now, post comments, reply evidence
import { scheduleFeedCollects } from './modules/feed/collect.js'; // 帖子与评论采集 (task feed-collect)
import { cleanupUploads } from './modules/apps/package.js';
import { stf } from './services.js';
import { logSink } from './modules/system/logs.js';
import { systemRoutes } from './modules/system/routes.js'; // also registers the db-backup task handler
import { systemHourly } from './modules/system/maintenance.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug', stream: logSink } });
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.setErrorHandler((err, req, reply) => {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.code(400).send({ error: 'validation', message: 'invalid request', details: err.validation });
  }
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.params ? { params: err.params } : {}) });
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'internal error' });
});

await app.register(cors, { origin: config.WEB_ORIGIN, credentials: false });
await app.register(multipart, { limits: { fileSize: config.MAX_APK_MB * 1024 * 1024, files: 1 } });
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
await app.register(authPlugin);
// Before every route: its hooks record mutating requests platform-wide.
await app.register(auditPlugin);
await app.register(authRoutes);
await app.register(userRoutes);
await app.register(roleRoutes);
await app.register(instanceRoutes);
await app.register(controlRoutes);
await app.register(eventsRoutes);
await app.register(appRoutes);
await app.register(libraryRoutes);
await app.register(mediaRoutes);
await app.register(mediaCategoryRoutes);
await app.register(settingsRoutes);
await app.register(sourceRoutes);
await app.register(proxyRoutes);
await app.register(socialRoutes);
await app.register(trackedRoutes);
await app.register(platformRoutes);
await app.register(contentRoutes);
await app.register(contentCategoryRoutes);
await app.register(publishRoutes);
await app.register(commentRoutes);
await app.register(personaRoutes);
await app.register(aiRoutes);
await app.register(analyticsRoutes);
await app.register(trendingRoutes);
await app.register(auditRoutes);
await app.register(taskRoutes);
await app.register(dashboardRoutes);
await app.register(systemRoutes);
await app.register(notifyRoutes);
await app.register(riskRoutes);
await app.register(feedRoutes);
await app.register(followingRoutes);

/** Dependency health: each check is a real call, nothing is assumed (see health.ts). */
app.get('/api/health', async (_req, reply) => {
  const h = await checkHealth();
  reply.code(h.ok ? 200 : 503);
  return h;
});

/**
 * Readiness of this process (blue-green switching, container health): the API itself plus its own
 * stores. Unlike /api/health it does not depend on STF, adb or Docker, so a deploy is not blocked by a
 * device-side outage. Never secrets.
 */
app.get('/api/ready', async (_req, reply) => {
  const checks = await Promise.all([
    ['postgres', () => sqlClient`select 1`],
    ['redis', () => events.ping()],
  ].map(async ([name, fn]) => {
    try { await (fn as () => Promise<unknown>)(); return [name, 'ok'] as const; }
    catch (err) { return [name, (err as Error).message] as const; }
  }));
  const ok = checks.every(([, v]) => v === 'ok');
  reply.code(ok ? 200 : 503);
  return {
    ok, checks: Object.fromEntries(checks),
    version: config.APP_VERSION ?? null, color: config.DEPLOY_COLOR ?? null,
    background: config.BACKGROUND_WORK === 'always' ? 'always' : leadership?.isLeader() ? 'leader' : 'standby',
  };
});

await events.start();
if (config.TASKS_TEST_HANDLERS) await import('./modules/tasks/test-handlers.js');

/**
 * Background work: task workers, the monitor (which also opens the BitBrowser tunnels), retention and the
 * hourly schedulers. With BACKGROUND_WORK=leader only the leader process runs it (lib/leader.ts).
 */
let background: { stop(): Promise<void> } | null = null;
let stopping = false;
async function startBackground(): Promise<void> {
  if (background || stopping) return;
  await reconcileTasks(app.log);
  if (stopping) return;
  const workers = startTaskWorkers();
  const stopMonitor = startMonitor(app.log);
  const hourly = () => {
    void cleanupUploads().catch((err) => app.log.warn({ err }, 'upload cleanup failed'));
    void purgeDeletedMedia(app.log).catch((err) => app.log.warn({ err }, 'media purge failed'));
    void scheduleTaskCleanup().catch((err) => app.log.warn({ err }, 'task cleanup scheduling failed'));
    void systemHourly().catch((err) => app.log.warn({ err }, 'system maintenance failed'));
    void scheduleCollection().catch((err) => app.log.warn({ err }, 'collection scheduling failed'));
    void scheduleAccountDeviceChecks().catch((err) => app.log.warn({ err }, 'account check scheduling failed'));
    void discoverDeviceAccounts().catch((err) => app.log.warn({ err }, 'account discovery failed'));
    void scheduleFeedCollects().catch((err) => app.log.warn({ err }, 'feed collection scheduling failed'));
    void scheduleFollowingSyncs().catch((err) => app.log.warn({ err }, 'following sync scheduling failed'));
    alertsHourly(app.log);
  };
  const firstRun = setTimeout(() => {
    void purgeDeletedMedia(app.log).catch((err) => app.log.warn({ err }, 'media purge failed'));
    void scheduleTaskCleanup().catch((err) => app.log.warn({ err }, 'task cleanup scheduling failed'));
    void systemHourly().catch((err) => app.log.warn({ err }, 'system maintenance failed'));
    void scheduleCollection().catch((err) => app.log.warn({ err }, 'collection scheduling failed'));
    void scheduleAccountDeviceChecks().catch((err) => app.log.warn({ err }, 'account check scheduling failed'));
    void discoverDeviceAccounts().catch((err) => app.log.warn({ err }, 'account discovery failed'));
    void scheduleFeedCollects().catch((err) => app.log.warn({ err }, 'feed collection scheduling failed'));
    void scheduleFollowingSyncs().catch((err) => app.log.warn({ err }, 'following sync scheduling failed'));
    alertsHourly(app.log);
  }, 10_000);
  firstRun.unref();
  const cleanupTimer = setInterval(hourly, 3600_000);
  app.log.info('background work started');
  background = {
    async stop() {
      stopMonitor();
      clearTimeout(firstRun);
      clearInterval(cleanupTimer);
      await workers.close(); // waits for running jobs
      closeAllTunnels();
    },
  };
}

const leadership = config.BACKGROUND_WORK === 'leader' ? startLeaderElection(app.log, startBackground) : null;
if (!leadership) await startBackground();

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  app.log.info('shutting down');
  await app.close(); // stops accepting connections, finishes in-flight requests, closes WebSockets
  if (background) await background.stop(); else await closeTaskQueues();
  await leadership?.release(); // only after the workers and tunnels are gone: the next leader may start now
  stf.close();
  await events.close();
  await sqlClient.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.API_PORT, host: config.API_HOST });
startRelayListener(app.log);
