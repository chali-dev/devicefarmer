import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { HttpError } from '../../lib/errors.js';
import { manageablePersona } from '../comments/personas.js';
import { toContentItems } from '../content/content.js';
import { distribute } from '../publish/publish.js';
import { toPublishItems } from '../publish/routes.js';
import { visibleAccount } from '../social/social.js';
import {
  AccountDraftSaveInput, AccountDraftsInput, ManualDraftsInput, previewAccountDraft, previewDraft, PreviewInput, PREVIEW_LIMIT, requestAccountDrafts,
  saveAccountDraft, setAccountDrafts,
} from './drafts.js';
import { accountDraftRuns } from './runs.js';
import { AI_MODELS, AiSettingsInput, getAiSettings, saveAiSettings } from './settings.js';

const Id = z.object({ id: z.string().uuid() });

/**
 * AI 草稿: AI测试 preview (managers of the persona: personal → owner/admin, public → admin; a style test, nothing
 * stored), the daily drafts of a social account and its 立即生成 (owner/admin, others 404) and the admin AI settings (Anthropic key write-only, model, daily hour,
 * on/off).
 */
export const aiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/settings/ai', { preHandler: app.requireAdmin }, async () => ({ ai: await getAiSettings(), models: AI_MODELS }));
  app.put('/api/settings/ai', { preHandler: app.requireAdmin, schema: { body: AiSettingsInput } }, async (req) => ({ ai: await saveAiSettings(req.body), models: AI_MODELS }));

  /**
   * AI测试: one draft generated synchronously (≤ 90 s; aborted when the client goes away), only returned (a style test:
   * nothing written, no save). Audit: model, ok, error code only (never texts).
   */
  app.post('/api/personas/:id/drafts/preview', { schema: { params: Id, body: PreviewInput } }, async (req, reply) => {
    const p = await manageablePersona(req.user, req.params.id);
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
    const info: Record<string, unknown> = {};
    try {
      const out = await previewDraft(req.user, p, info, ac.signal, req.body?.topic);
      if (req.audit) req.audit.extra = { ...info, ok: true };
      return { ...out, limit: PREVIEW_LIMIT };
    } catch (err) {
      if (req.audit) req.audit.extra = { ...info, ok: false, errorCode: (err as { code?: string }).code ?? null };
      throw err;
    }
  });

  /** 社交号 → AI 草稿: on/off, per day, the account's persona and the last daily runs. */
  app.get('/api/social/accounts/:id/ai-drafts', { schema: { params: Id } }, async (req) => {
    const a = await visibleAccount(req.user, req.params.id);
    const s = await getAiSettings();
    return { enabled: a.aiDraftsEnabled, perDay: a.aiDraftsPerDay, personaId: a.personaId, runs: await accountDraftRuns(a.id), ai: { keySet: s.keySet, hour: s.hour } };
  });

  app.put('/api/social/accounts/:id/ai-drafts', { schema: { params: Id, body: AccountDraftsInput } }, async (req) => {
    const a = await setAccountDrafts(await visibleAccount(req.user, req.params.id), req.body);
    return { enabled: a.aiDraftsEnabled, perDay: a.aiDraftsPerDay, personaId: a.personaId };
  });

  /** 「AI生成草稿」: drafts for this account now (202 + the account-drafts task; the UI follows it). */
  app.post('/api/social/accounts/:id/ai-drafts/generate', { schema: { params: Id, body: ManualDraftsInput } }, async (req, reply) => {
    const a = await visibleAccount(req.user, req.params.id);
    const task = await requestAccountDrafts(req.user, a, { count: req.body?.count, topic: req.body?.topic });
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });

  /**
   * 「AI生成草稿」 step 1: one draft generated synchronously for this account (≤ 90 s, aborted when the client leaves),
   * nothing written; the person edits it in the modal. Audit: model / ok / error code / topic flag, never texts.
   */
  app.post('/api/social/accounts/:id/ai-drafts/preview', { schema: { params: Id, body: PreviewInput } }, async (req, reply) => {
    const a = await visibleAccount(req.user, req.params.id);
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
    const info: Record<string, unknown> = {};
    try {
      const out = await previewAccountDraft(req.user, a, info, ac.signal, req.body?.topic);
      if (req.audit) req.audit.extra = { ...info, ok: true };
      return { ...out, limit: PREVIEW_LIMIT };
    } catch (err) {
      if (req.audit) req.audit.extra = { ...info, ok: false, errorCode: (err as { code?: string }).code ?? null };
      throw err;
    }
  });

  /**
   * 「AI生成草稿」 step 2: the reviewed draft saved as a content (201), then — with `publish` — distributed to this
   * account through the normal distribute() (feed; scheduledAt null = now). A refused distribution keeps the draft:
   * `publish.error` carries the code (the UI says the draft was kept).
   */
  app.post('/api/social/accounts/:id/ai-drafts/save', { schema: { params: Id, body: SaveBody } }, async (req, reply) => {
    const a = await visibleAccount(req.user, req.params.id);
    const { publish, ...b } = req.body;
    const saved = await saveAccountDraft(req.user, a, b);
    let pub: PublishOutcome | null = null;
    if (publish) {
      const [content] = await db.select().from(schema.contents).where(eq(schema.contents.id, saved.contentId));
      try {
        const res = await distribute(req.user, content!, [{ accountId: a.id, scheduledAt: publish.scheduledAt ? new Date(publish.scheduledAt) : null, postType: 'feed' }]);
        pub = { tasks: await toPublishItems([...res.created, ...res.existing], req.user), error: null };
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        pub = { tasks: [], error: { code: err.code ?? null, message: err.message, params: err.params ?? {} } };
      }
    }
    if (req.audit) {
      req.audit.extra = {
        contentId: saved.contentId, edited: saved.edited, translation: saved.translation,
        ...(pub ? { publishTasks: pub.tasks.map((x) => x.id), publishError: pub.error?.code ?? null } : {}),
      };
    }
    const [row] = await db.select().from(schema.contents).where(eq(schema.contents.id, saved.contentId));
    reply.code(201);
    return { content: (await toContentItems([row!], req.user))[0], publish: pub };
  });
};

const SaveBody = AccountDraftSaveInput.extend({
  /** 立即发布 (scheduledAt null) / 排程发布 (a time); absent = 存草稿. */
  publish: z.object({ scheduledAt: z.string().datetime({ offset: true }).nullable() }).optional(),
});
type PublishOutcome = { tasks: { id: string }[]; error: { code: string | null; message: string; params: Record<string, unknown> } | null };
