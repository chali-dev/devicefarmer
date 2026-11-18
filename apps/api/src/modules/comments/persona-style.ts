import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { PERSONA_LEVELS, PERSONA_TONES, type Persona, type PersonaLevel, type PersonaStyle, type PersonaTone } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';

/**
 * 人设风格 (owner decision 2026-11-18): one style per persona for posts AND replies — tone preset + editable note,
 * emoji amount, length (a character range per kind), topics, banned words, plus optional hashtags, audience, fixed
 * opening/closing and notes. Used by the AI drafts prompt, the persona card in the post editor / reply composers and
 * the banned-word checks (`assertNoBannedWords`, code `persona.banned_word`) on saving/scheduling posts and replies.
 */

/** Characters per length level: posts (body) and replies (replies are shorter). The UI shows these; replies only get a soft hint. */
export const PERSONA_LENGTHS: Record<'post' | 'comment', Record<PersonaLevel, [number, number]>> = {
  post: { low: [40, 150], medium: [150, 500], high: [500, 1500] },
  comment: { low: [4, 30], medium: [15, 80], high: [60, 200] },
};

/** English tone descriptions for the prompt when the persona's note is empty (the UI pre-fills its own Chinese text). */
export const TONE_PROMPT: Record<PersonaTone, string> = {
  casual: 'friendly and everyday, like chatting with a friend',
  pro: 'professional and practical, concrete tips and clear explanations',
  funny: 'humorous and playful, light wordplay',
  cool: 'aloof and concise, few words, no fuss',
  warm: 'warm and comforting, gentle encouragement',
};
export const EMOJI_PROMPT: Record<PersonaLevel, string> = {
  low: 'at most 1 emoji, often none',
  medium: '2 to 4 emoji where they fit',
  high: 'plenty of emoji (5 or more) where natural',
};

const Words = (max: number, len: number) => z.array(z.string().trim().min(1).max(len)).max(max);
export const PersonaStyleInput = z.object({
  tone: z.enum(PERSONA_TONES).optional(),
  toneNote: z.string().trim().max(200).optional(),
  emoji: z.enum(PERSONA_LEVELS).optional(),
  length: z.enum(PERSONA_LEVELS).optional(),
  topics: Words(20, 60).optional(),
  bannedWords: Words(50, 50).optional(),
  hashtags: Words(15, 50).optional(),
  audience: z.string().trim().max(200).optional(),
  opening: z.string().trim().max(200).optional(),
  closing: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

/** Case-insensitive de-duplication (first spelling wins). */
const uniq = (xs: string[] | undefined, map = (x: string) => x) => {
  const seen = new Set<string>();
  return (xs ?? []).map(map).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};

/** Stored form of a style input: lists de-duplicated, hashtags without '#', empty texts dropped. */
export function normaliseStyle(s: z.infer<typeof PersonaStyleInput>): PersonaStyle {
  const out: PersonaStyle = {
    ...s,
    topics: uniq(s.topics), bannedWords: uniq(s.bannedWords), hashtags: uniq(s.hashtags, (h) => h.replace(/^#+/, '').replace(/\s+/g, '')),
  };
  for (const k of ['toneNote', 'audience', 'opening', 'closing', 'notes'] as const) if (!out[k]) delete out[k];
  return out;
}

/** The style with defaults (亲切日常, 适中, 中). */
export const styleOf = (p: Pick<Persona, 'style'>): Required<Pick<PersonaStyle, 'tone' | 'emoji' | 'length' | 'topics' | 'bannedWords' | 'hashtags'>> & PersonaStyle => ({
  ...p.style, tone: p.style?.tone ?? 'casual', emoji: p.style?.emoji ?? 'medium', length: p.style?.length ?? 'medium',
  topics: p.style?.topics ?? [], bannedWords: p.style?.bannedWords ?? [], hashtags: p.style?.hashtags ?? [],
});

/** Banned words found in the texts (case-insensitive substring), in the persona's order. */
export function bannedHits(words: string[] | undefined, texts: (string | null | undefined)[]): string[] {
  const hay = texts.filter(Boolean).join('\n').toLowerCase();
  return (words ?? []).filter((w) => w.trim() && hay.includes(w.trim().toLowerCase()));
}

type Exec = Pick<typeof db, 'select'>;

/**
 * 400 `persona.banned_word` (params: persona, words = the hits joined by "、") when any text contains a banned word of
 * one of the personas (null ids ignored). Used on saving/scheduling posts and replies; the person edits the text.
 */
export async function assertNoBannedWords(personaIds: (string | null | undefined)[], texts: (string | null | undefined)[], exec: Exec = db): Promise<void> {
  const ids = [...new Set(personaIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  const rows = await exec.select({ name: schema.personas.name, style: schema.personas.style }).from(schema.personas).where(inArray(schema.personas.id, ids));
  for (const p of rows) {
    const hits = bannedHits(p.style?.bannedWords, texts);
    if (hits.length) {
      throw badRequest(`内容包含人设「${p.name}」的禁用词：${hits.join('、')}`, 'persona.banned_word', { persona: p.name, words: hits.join('、') });
    }
  }
}

/** 账号人设 of social accounts (for the banned-word checks). */
export async function accountPersonaIds(accountIds: string[], exec: Exec = db): Promise<string[]> {
  if (!accountIds.length) return [];
  const SA = schema.socialAccounts;
  const rows = await exec.select({ p: SA.personaId }).from(SA).where(and(inArray(SA.id, accountIds), isNotNull(SA.personaId)));
  return rows.map((r) => r.p!);
}

/** The persona's examples (范例): its templates in its own scope (public: shared; personal: its owner's), oldest first. */
export function exampleWhere(p: Pick<Persona, 'id' | 'ownerType' | 'ownerId'>, kind?: 'post' | 'comment') {
  const T = schema.commentTemplates;
  return and(eq(T.personaId, p.id), p.ownerType === 'public' ? isNull(T.userId) : eq(T.userId, p.ownerId!), kind ? eq(T.kind, kind) : undefined);
}

export const MAX_EXAMPLES = 5;

export const assertStyleOk = (s: PersonaStyle) => {
  if ((s.bannedWords ?? []).some((w) => (s.opening ?? '').toLowerCase().includes(w.toLowerCase()) || (s.closing ?? '').toLowerCase().includes(w.toLowerCase()))) {
    throw badRequest('固定开头/结尾包含禁用词', 'persona.banned_in_style');
  }
};
