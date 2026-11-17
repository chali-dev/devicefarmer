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
import { authPlugin } from './modules/auth/plugin.js';
import { authRoutes } from './modules/auth/routes.js';
import { startAuditRetention } from './modules/audit/audit.js';
import { auditPlugin } from './modules/audit/plugin.js';
import { auditRoutes } from './modules/audit/routes.js';
import { controlRoutes } from './modules/control/session.js';
import { startRelayListener } from './modules/control/scrcpy-relay.js';
import { eventsRoutes } from './modules/control/events-ws.js';
import { instanceRoutes } from './modules/instances/routes.js';
import './modules/instances/queue.js'; // registers the device-op task handlers
import { reconcileTasks, startTaskWorkers } from './modules/tasks/core.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { scheduleTaskCleanup } from './modules/tasks/retention.js'; // registers the tasks-cleanup handler
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { startMonitor } from './modules/monitor/monitor.js';
import { userRoutes } from './modules/users/routes.js';
import { appRoutes } from './modules/apps/routes.js';
import { libraryRoutes } from './modules/library/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { purgeDeletedMedia } from './modules/media/media.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { sourceRoutes } from './modules/sources/routes.js';
import { proxyRoutes } from './modules/proxies/routes.js';
import { socialRoutes } from './modules/social/routes.js';
import { trackedRoutes } from './modules/tracked/routes.js';
import { platformRoutes } from './modules/platforms/routes.js';
import { contentRoutes } from './modules/content/routes.js';
import { publishRoutes } from './modules/publish/routes.js';
import './modules/publish/publish.js'; // registers the publish task handler + manual methods
import './modules/publish/api-methods.js'; // official-API publish methods (modules/platforms)
import { commentRoutes } from './modules/comments/routes.js'; // also registers the comment-sync / comment-reply task handlers
import './modules/comments/dashboard.js'; // comments widget on the dashboard + task-retention keep rule
import { analyticsRoutes } from './modules/analytics/routes.js';
import { scheduleDailyAccountStats } from './modules/analytics/analytics.js'; // account-stats task handler + dashboard widget
import { cleanupUploads } from './modules/apps/package.js';
import { stf } from './services.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });
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
await app.register(instanceRoutes);
await app.register(controlRoutes);
await app.register(eventsRoutes);
await app.register(appRoutes);
await app.register(libraryRoutes);
await app.register(mediaRoutes);
await app.register(settingsRoutes);
await app.register(sourceRoutes);
await app.register(proxyRoutes);
await app.register(socialRoutes);
await app.register(trackedRoutes);
await app.register(platformRoutes);
await app.register(contentRoutes);
await app.register(publishRoutes);
await app.register(commentRoutes);
await app.register(analyticsRoutes);
await app.register(auditRoutes);
await app.register(taskRoutes);
await app.register(dashboardRoutes);

/** Dependency health: each check is a real call, nothing is assumed (see health.ts). */
app.get('/api/health', async (_req, reply) => {
  const h = await checkHealth();
  reply.code(h.ok ? 200 : 503);
  return h;
});

await events.start();
if (config.TASKS_TEST_HANDLERS) await import('./modules/tasks/test-handlers.js');
await reconcileTasks(app.log);
const workers = startTaskWorkers();
const stopMonitor = startMonitor(app.log);
const stopAuditRetention = startAuditRetention(app.log);
const hourly = () => {
  void cleanupUploads().catch((err) => app.log.warn({ err }, 'upload cleanup failed'));
  void purgeDeletedMedia(app.log).catch((err) => app.log.warn({ err }, 'media purge failed'));
  void scheduleTaskCleanup().catch((err) => app.log.warn({ err }, 'task cleanup scheduling failed'));
  void scheduleDailyAccountStats().catch((err) => app.log.warn({ err }, 'account stats scheduling failed'));
};
setTimeout(() => {
  void purgeDeletedMedia(app.log).catch((err) => app.log.warn({ err }, 'media purge failed'));
  void scheduleTaskCleanup().catch((err) => app.log.warn({ err }, 'task cleanup scheduling failed'));
  void scheduleDailyAccountStats().catch((err) => app.log.warn({ err }, 'account stats scheduling failed'));
}, 10_000).unref();
const cleanupTimer = setInterval(hourly, 3600_000);

const shutdown = async () => {
  app.log.info('shutting down');
  stopMonitor();
  clearInterval(cleanupTimer);
  stopAuditRetention();
  await app.close();
  await workers.close();
  stf.close();
  await events.close();
  await sqlClient.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.API_PORT, host: '127.0.0.1' });
startRelayListener(app.log);
