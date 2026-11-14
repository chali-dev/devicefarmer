import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { sqlClient } from './db/index.js';
import { events } from './lib/events.js';
import { HttpError } from './lib/errors.js';
import { authPlugin } from './modules/auth/plugin.js';
import { authRoutes } from './modules/auth/routes.js';
import { controlRoutes } from './modules/control/session.js';
import { eventsRoutes } from './modules/control/events-ws.js';
import { instanceRoutes } from './modules/instances/routes.js';
import { opsQueue, startWorker } from './modules/instances/queue.js';
import { startMonitor } from './modules/monitor/monitor.js';
import { userRoutes } from './modules/users/routes.js';
import { appRoutes } from './modules/apps/routes.js';
import { libraryRoutes } from './modules/library/routes.js';
import { cleanupUploads } from './modules/apps/package.js';
import { adb, dockerHost, stf } from './services.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.setErrorHandler((err, req, reply) => {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.code(400).send({ error: 'validation', message: 'invalid request', details: err.validation });
  }
  if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'internal error' });
});

await app.register(cors, { origin: config.WEB_ORIGIN, credentials: false });
await app.register(multipart, { limits: { fileSize: config.MAX_APK_MB * 1024 * 1024, files: 1 } });
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
await app.register(authPlugin);
await app.register(authRoutes);
await app.register(userRoutes);
await app.register(instanceRoutes);
await app.register(controlRoutes);
await app.register(eventsRoutes);
await app.register(appRoutes);
await app.register(libraryRoutes);

/** Dependency health: each check is a real call, nothing is assumed. */
app.get('/api/health', async (_req, reply) => {
  const checks = await Promise.all([
    ['postgres', () => sqlClient`select 1`],
    ['redis', () => events.ping()],
    ['docker', () => dockerHost.listStates()],
    ['adb', () => adb.states()],
    ['stf', () => stf.listDevices()],
  ].map(async ([name, fn]) => {
    try { await (fn as () => Promise<unknown>)(); return [name, 'ok'] as const; }
    catch (err) { return [name, (err as Error).message] as const; }
  }));
  const result = Object.fromEntries(checks);
  const ok = Object.values(result).every((v) => v === 'ok');
  // Capability, not a failure: only the Google emulator engine needs it.
  const kvm = await dockerHost.hasKvm().catch(() => false);
  reply.code(ok ? 200 : 503);
  return { ok, checks: result, capabilities: { kvm } };
});

await events.start();
const worker = startWorker();
const stopMonitor = startMonitor(app.log);
const cleanupTimer = setInterval(() => void cleanupUploads().catch((err) => app.log.warn({ err }, 'upload cleanup failed')), 3600_000);

const shutdown = async () => {
  app.log.info('shutting down');
  stopMonitor();
  clearInterval(cleanupTimer);
  await worker.close();
  await app.close();
  await opsQueue.close();
  stf.close();
  await events.close();
  await sqlClient.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.API_PORT, host: '127.0.0.1' });
