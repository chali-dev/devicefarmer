import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { manageablePersona } from '../comments/personas.js';
import { requestDraftNow } from './drafts.js';
import { AI_MODELS, AiSettingsInput, getAiSettings, saveAiSettings } from './settings.js';

const Id = z.object({ id: z.string().uuid() });

/**
 * 人设每日草稿 (AI): "generate one now" (managers of the persona: personal → owner/admin, public → admin) and the admin
 * AI settings (Anthropic key write-only, model, daily hour, on/off). The persona's AI settings are part of the persona
 * form (POST/PATCH /api/personas).
 */
export const aiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/settings/ai', { preHandler: app.requireAdmin }, async () => ({ ai: await getAiSettings(), models: AI_MODELS }));
  app.put('/api/settings/ai', { preHandler: app.requireAdmin, schema: { body: AiSettingsInput } }, async (req) => ({ ai: await saveAiSettings(req.body), models: AI_MODELS }));

  /** One draft now (task persona-drafts, count 1); at most once per persona per 10 minutes. */
  app.post('/api/personas/:id/drafts/generate', { schema: { params: Id } }, async (req, reply) => {
    const p = await manageablePersona(req.user, req.params.id);
    const task = await requestDraftNow(req.user, p);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });
};
