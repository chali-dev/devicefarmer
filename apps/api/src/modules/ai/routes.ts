import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Persona } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import { manageablePersona } from '../comments/personas.js';
import { assertDraftOwnerCandidate, DRAFT_TASK, DraftSettingsInput, normaliseBrief, requestDraftNow } from './drafts.js';
import { AI_MODELS, AiSettingsInput, getAiSettings, saveAiSettings } from './settings.js';

const Id = z.object({ id: z.string().uuid() });
const P = schema.personas;

/** 内容设定 of a persona + its draft owner's name + the last generation tasks (for the drawer). */
async function draftSettings(p: Persona) {
  const ownerId = p.ownerType === 'user' ? p.ownerId : p.draftOwnerId;
  const [owner] = ownerId ? await db.select({ username: schema.users.username, disabled: schema.users.disabled }).from(schema.users).where(eq(schema.users.id, ownerId)) : [];
  const T = schema.tasks;
  const runs = await db.select({ id: T.id, status: T.status, errorCode: T.errorCode, createdAt: T.createdAt, finishedAt: T.finishedAt, payload: T.payload, result: T.result })
    .from(T).where(and(eq(T.type, DRAFT_TASK), eq(T.refType, 'persona'), eq(T.refId, p.id))).orderBy(desc(T.createdAt)).limit(5);
  return {
    id: p.id, name: p.name, ownerType: p.ownerType, ownerId: p.ownerId,
    draftEnabled: p.draftEnabled, draftsPerDay: p.draftsPerDay, brief: p.brief,
    draftOwnerId: ownerId, draftOwnerName: owner?.username ?? null, draftOwnerDisabled: owner?.disabled ?? null,
    runs: runs.map(({ payload, result, ...r }) => ({
      ...r, trigger: (payload as { trigger?: string } | null)?.trigger ?? null,
      created: Array.isArray((result as { contentIds?: unknown } | null)?.contentIds) ? (result as { contentIds: string[] }).contentIds.length : null,
    })),
  };
}

/**
 * 人设每日草稿 (AI): per-persona 内容设定 (managers of the persona: personal → owner/admin, public → admin), "generate
 * one now", and the admin AI settings (Anthropic key write-only, model, daily hour, on/off).
 */
export const aiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/settings/ai', { preHandler: app.requireAdmin }, async () => ({ ai: await getAiSettings(), models: AI_MODELS }));
  app.put('/api/settings/ai', { preHandler: app.requireAdmin, schema: { body: AiSettingsInput } }, async (req) => ({ ai: await saveAiSettings(req.body), models: AI_MODELS }));

  app.get('/api/personas/:id/drafts', { schema: { params: Id } }, async (req) => {
    const p = await manageablePersona(req.user, req.params.id);
    return { drafts: await draftSettings(p) };
  });

  app.put('/api/personas/:id/drafts', { schema: { params: Id, body: DraftSettingsInput } }, async (req) => {
    const p = await manageablePersona(req.user, req.params.id);
    const b = req.body;
    const set: Partial<typeof P.$inferInsert> = {};
    if (b.draftsPerDay !== undefined) set.draftsPerDay = b.draftsPerDay;
    if (b.brief !== undefined) set.brief = await normaliseBrief(p, b.brief);
    if (b.draftOwnerId !== undefined) {
      if (p.ownerType === 'user' && b.draftOwnerId !== null) throw badRequest('个人人设的草稿归属其所有者', 'persona.draft_owner_personal');
      if (b.draftOwnerId) await assertDraftOwnerCandidate(b.draftOwnerId);
      set.draftOwnerId = b.draftOwnerId;
    }
    if (b.draftEnabled !== undefined) set.draftEnabled = b.draftEnabled;
    const enabled = b.draftEnabled ?? p.draftEnabled;
    const ownerId = set.draftOwnerId !== undefined ? set.draftOwnerId : p.draftOwnerId;
    if (enabled && p.ownerType === 'public' && !ownerId) throw badRequest('公共人设开启每日草稿前须指定草稿归属用户', 'persona.draft_owner_required');
    if (!Object.keys(set).length) throw badRequest('nothing to update', 'common.nothing_to_update');
    const [row] = await db.update(P).set(set).where(eq(P.id, p.id)).returning();
    if (req.audit) req.audit.extra = { draftEnabled: row!.draftEnabled, draftsPerDay: row!.draftsPerDay };
    return { drafts: await draftSettings(row!) };
  });

  /** One draft now (task persona-drafts, count 1); at most once per persona per 10 minutes. */
  app.post('/api/personas/:id/drafts/generate', { schema: { params: Id } }, async (req, reply) => {
    const p = await manageablePersona(req.user, req.params.id);
    const task = await requestDraftNow(req.user, p);
    if (req.audit) req.audit.extra = { taskId: task.id };
    reply.code(202);
    return { task: { id: task.id, status: task.status } };
  });
};
