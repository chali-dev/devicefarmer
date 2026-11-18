import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';

/**
 * AI settings (设置 → AI, admin): settings key `ai`. The Anthropic API key is entered by an admin, stored sealed with
 * secret-box and write-only (the API only reports `keySet`, like the YouTube key); it is never put in task payloads,
 * logs or audit entries. Used only by 人设每日草稿 (drafts.ts).
 */
const KEY = 'ai';

/** Models offered in the settings (the first is the default). */
export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const DEFAULT_AI_MODEL: AiModel = 'claude-opus-5-5';
export const DEFAULT_AI_HOUR = 6;

interface StoredAi { apiKeyEnc?: string; model?: AiModel; hour?: number; enabled?: boolean }

export interface AiSettings { enabled: boolean; keySet: boolean; model: AiModel; hour: number; updatedAt: Date | null }

export const AiSettingsInput = z.object({
  /** undefined keeps the stored key, null clears it. Format only (sk-ant-…); the key is not tested here. */
  apiKey: z.string().trim().min(20).max(300).regex(/^[A-Za-z0-9_-]+$/, 'invalid API key format').nullable().optional(),
  model: z.enum(AI_MODELS).optional(),
  /** Daily generation hour, API host local time. */
  hour: z.number().int().min(0).max(23).optional(),
  enabled: z.boolean().optional(),
});
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

async function load(): Promise<{ value: StoredAi; updatedAt: Date | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { value: (row?.value as StoredAi | undefined) ?? {}, updatedAt: row?.updatedAt ?? null };
}

const shape = (v: StoredAi, updatedAt: Date | null): AiSettings => ({
  enabled: v.enabled ?? true,
  keySet: Boolean(v.apiKeyEnc),
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
  if (input.model !== undefined) next.model = input.model;
  if (input.hour !== undefined) next.hour = input.hour;
  if (input.enabled !== undefined) next.enabled = input.enabled;
  await db.insert(schema.settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return getAiSettings();
}

/** Settings plus the decrypted key (null when unset). Only for the generation code; never returned or logged. */
export async function aiCredentials(): Promise<AiSettings & { apiKey: string | null }> {
  const { value, updatedAt } = await load();
  return { ...shape(value, updatedAt), apiKey: value.apiKeyEnc ? openSecret(value.apiKeyEnc) : null };
}
