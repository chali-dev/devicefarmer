import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { manageablePersona } from '../comments/personas.js';
import { visibleAccount } from '../social/social.js';
import { AccountDraftsInput, previewDraft, PREVIEW_LIMIT, savePreview, setAccountDrafts } from './drafts.js';
import { accountDraftRuns } from './runs.js';
import { AI_MODELS, AiSettingsInput, getAiSettings, saveAiSettings } from './settings.js';

const Id = z.object({ id: z.string().uuid() });

/**
 * AI 草稿: AI测试 preview + save (managers of the persona: personal → owner/admin, public → admin), the daily drafts
 * of a social account (owner/admin, others 404) and the admin AI settings (Anthropic key write-only, model, daily hour,
 * on/off).
 */
export const aiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/settings/ai', { preHandler: app.requireAdmin }, async () => ({ ai: await getAiSettings(), models: AI_MODELS }));
  app.put('/api/settings/ai', { preHandler: app.requireAdmin, schema: { body: AiSettingsInput } }, async (req) => ({ ai: await saveAiSettings(req.body), models: AI_MODELS }));

  /**
   * AI测试: one draft generated synchronously (≤ 90 s; aborted when the client goes away), nothing written. Returns
   * the preview and a single-use save token (10 min). Audit: model, ok, error code only (never texts).
   */
  app.post('/api/personas/:id/drafts/preview', { schema: { params: Id } }, async (req, reply) => {
    const p = await manageablePersona(req.user, req.params.id);
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
    const info: Record<string, unknown> = {};
    try {
      const out = await previewDraft(req.user, p, info, ac.signal);
      if (req.audit) req.audit.extra = { ...info, ok: true };
      return { ...out, limit: PREVIEW_LIMIT };
    } catch (err) {
      if (req.audit) req.audit.extra = { ...info, ok: false, errorCode: (err as { code?: string }).code ?? null };
      throw err;
    }
  });

  /** 「保存为草稿」: the stored preview of this token becomes one AI draft of the caller. */
  app.post('/api/personas/:id/drafts/save', { schema: { params: Id, body: z.object({ token: z.string().min(16).max(100) }) } }, async (req, reply) => {
    const p = await manageablePersona(req.user, req.params.id);
    const out = await savePreview(req.user, p, req.body.token);
    if (req.audit) req.audit.extra = { contentId: out.contentId, model: out.model };
    reply.code(201);
    return out;
  });

  /** 社交号 → AI 草稿: on/off, per day, the account's persona and the last daily runs. */
  app.get('/api/social/accounts/:id/ai-drafts', { schema: { params: Id } }, async (req) => {
    const a = await visibleAccount(req.user, req.params.id);
    const s = await getAiSettings();
    return { enabled: a.aiDraftsEnabled, perDay: a.aiDraftsPerDay, personaId: a.personaId, runs: await accountDraftRuns(a.id), ai: { enabled: s.enabled, keySet: s.keySet, hour: s.hour } };
  });

  app.put('/api/social/accounts/:id/ai-drafts', { schema: { params: Id, body: AccountDraftsInput } }, async (req) => {
    const a = await setAccountDrafts(await visibleAccount(req.user, req.params.id), req.body);
    return { enabled: a.aiDraftsEnabled, perDay: a.aiDraftsPerDay, personaId: a.personaId };
  });
};
