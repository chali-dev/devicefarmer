import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpError } from '../../lib/errors.js';
import { getStorageSettings, saveStorageSettings, StorageInput, testStorage } from './storage.js';

/** Platform settings. Admin only. */
export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/api/settings/storage', async () => ({ storage: await getStorageSettings() }));

  app.put('/api/settings/storage', { schema: { body: StorageInput } }, async (req) => {
    const r = await saveStorageSettings(req.body);
    if (!r.saved) throw new HttpError(400, `存储连接测试失败，未保存：${r.test.error}`, 'settings.storage_test_failed', { error: r.test.error ?? '' });
    return { storage: r.settings };
  });

  /** Tests the submitted config, or the stored active one when the body is omitted. */
  app.post('/api/settings/storage/test', { schema: { body: StorageInput.nullish() } }, async (req) => testStorage(req.body ?? undefined));
};
