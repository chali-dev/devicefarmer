import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';

/**
 * AI settings (设置 → AI, admin): settings key `ai`. The Anthropic API key is entered by an admin, stored sealed with
 * secret-box and write-only (the API only reports `keySet`, like the YouTube key); it is never put in task payloads,
 * logs or audit entries. Used only by AI drafts (drafts.ts). There is no global on/off (removed 2026-11-18, owner:
 * 「系统配置 AI KEY 模型；启用放在媒体号里」): only the key decides, drafts are switched on per social account
 * (`social_accounts.ai_drafts_enabled`). A stored `enabled` of an older release is ignored (a stored false blocks
 * nothing) and dropped on the next save; a PUT with it from an older page is accepted and ignores it (zod strips it).
 */
const KEY = 'ai';

/** Models offered in the settings (the first is the default). */
export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const DEFAULT_AI_MODEL: AiModel = 'claude-opus-5-5';
export const DEFAULT_AI_HOUR = 6;

interface StoredAi { apiKeyEnc?: string; workspaceId?: string; model?: AiModel; hour?: number; /** LEGACY: ignored, dropped on save */ enabled?: boolean }

/**
 * `workspaceId`: an Anthropic API key that isn't scoped to a workspace (personal / service account key created for "all
 * workspaces") must name the workspace in the `anthropic-workspace-id` header on every request, or the API answers 400
 * "This API key is not scoped to a workspace…" (seen on the owner's key, 2026-11-18). Not secret (an id like
 * wrkspc_01…, Console → Settings → Workspaces → ID column); null = key scoped to one workspace, no header.
 */
export interface AiSettings { keySet: boolean; workspaceId: string | null; model: AiModel; hour: number; updatedAt: Date | null }

export const AiSettingsInput = z.object({
  /** undefined keeps the stored key, null clears it. Format only (sk-ant-…); the key is not tested here. */
  apiKey: z.string().trim().min(20).max(300).regex(/^[A-Za-z0-9_-]+$/, 'invalid API key format').nullable().optional(),
  /** undefined keeps, null/'' clears. */
  workspaceId: z.union([z.string().trim().regex(/^wrkspc_[A-Za-z0-9]{8,64}$/, 'invalid workspace id'), z.literal(''), z.null()]).optional(),
  model: z.enum(AI_MODELS).optional(),
  /** Daily generation hour, API host local time. */
  hour: z.number().int().min(0).max(23).optional(),
  // `enabled` (removed): not listed, so zod strips it from an older page's body.
});
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

async function load(): Promise<{ value: StoredAi; updatedAt: Date | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { value: (row?.value as StoredAi | undefined) ?? {}, updatedAt: row?.updatedAt ?? null };
}

const shape = (v: StoredAi, updatedAt: Date | null): AiSettings => ({
  keySet: Boolean(v.apiKeyEnc),
  workspaceId: v.workspaceId ?? null,
  model: v.model && (AI_MODELS as readonly string[]).includes(v.model) ? v.model : DEFAULT_AI_MODEL,
  hour: v.hour ?? DEFAULT_AI_HOUR,
  updatedAt,
});

export async function getAiSettings(): Promise<AiSettings> {
  const { value, updatedAt } = await load();
  return shape(value, updatedAt);
}

export async function saveAiSettings(input: AiSettingsInput): Promise<AiSettings> {
  const { value: cur } = await load();
  const next: StoredAi = { ...cur };
  if (input.apiKey === null) delete next.apiKeyEnc;
  else if (input.apiKey !== undefined) next.apiKeyEnc = sealSecret(input.apiKey);
  if (input.workspaceId === null || input.workspaceId === '') delete next.workspaceId;
  else if (input.workspaceId !== undefined) next.workspaceId = input.workspaceId;
  if (input.model !== undefined) next.model = input.model;
  if (input.hour !== undefined) next.hour = input.hour;
  delete next.enabled;
  await db.insert(schema.settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return getAiSettings();
}

/** Settings plus the decrypted key (null when unset). Only for the generation code; never returned or logged. */
export async function aiCredentials(): Promise<AiSettings & { apiKey: string | null }> {
  const { value, updatedAt } = await load();
  return { ...shape(value, updatedAt), apiKey: value.apiKeyEnc ? openSecret(value.apiKeyEnc) : null };
}
