import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';import {
  PERSONA_LEVELS, PERSONA_TONES, type Persona, type PersonaCommentStyle, type PersonaLevel, type PersonaPostStyle, type PersonaStyle, type PersonaTone,
  type PersonaVoice, type StoredPersonaStyle,
} from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';

/**
 * 人设风格 (owner decision 2026-11-18: split into 发文风格 and 评论风格). Shared: topics and banned words (banned words
 * are checked on posts AND comments). 发文风格 `post`: tone preset + editable note, emoji amount, length (post character
 * range), hashtags, fixed opening/closing, audience, notes. 评论风格 `comment`: tone + note, emoji, length (comment
 * range). The AI drafts prompt uses the post style; the persona card of the post editor shows the post style, the one of
 * the comment composers the comment style. Banned words: `assertNoBannedWords`, code `persona.banned_word`.
 */

/** Characters per length level: posts (body) and comments (shorter). The UI shows these; comments only get a soft hint. */
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
const Voice = {
  tone: z.enum(PERSONA_TONES).optional(),
  toneNote: z.string().trim().max(200).optional(),
  emoji: z.enum(PERSONA_LEVELS).optional(),
  length: z.enum(PERSONA_LEVELS).optional(),
};
export const PostStyleInput = z.object({
  ...Voice,
  hashtags: Words(15, 50).optional(),
  audience: z.string().trim().max(200).optional(),
  opening: z.string().trim().max(200).optional(),
  closing: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();
export const CommentStyleInput = z.object(Voice).strict();
/** The whole style (PATCH replaces it): shared lists + 发文风格 + 评论风格. The flat pre-split shape is refused (strict). */
export const PersonaStyleInput = z.object({
  topics: Words(20, 60).optional(),
  bannedWords: Words(50, 50).optional(),
  post: PostStyleInput.optional(),
  comment: CommentStyleInput.optional(),
}).strict();

/** Case-insensitive de-duplication (first spelling wins). */
const uniq = (xs: string[] | undefined, map = (x: string) => x) => {
  const seen = new Set<string>();
  return (xs ?? []).map(map).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};
const dropEmpty = <T extends object>(o: T, keys: (keyof T)[]): T => {
  for (const k of keys) if (!o[k]) delete o[k];
  return o;
};

/** Stored form of a style input (split shape only): lists de-duplicated, hashtags without '#', empty texts dropped. */
export function normaliseStyle(s: z.infer<typeof PersonaStyleInput>): PersonaStyle {
  const post: PersonaPostStyle = dropEmpty({ ...s.post, hashtags: uniq(s.post?.hashtags, (h) => h.replace(/^#+/, '').replace(/\s+/g, '')) },
    ['toneNote', 'audience', 'opening', 'closing', 'notes']);
  const comment: PersonaCommentStyle = dropEmpty({ ...s.comment }, ['toneNote']);
  return { topics: uniq(s.topics), bannedWords: uniq(s.bannedWords), post, comment };
}

type Voiced<T> = T & Required<Pick<PersonaVoice, 'tone' | 'emoji' | 'length'>>;
/** A style as read (defaults filled, both kinds present). */
export interface FullStyle {
  topics: string[];
  bannedWords: string[];
  post: Voiced<PersonaPostStyle> & { hashtags: string[] };
  comment: Voiced<PersonaCommentStyle>;
}
const voiced = <T extends PersonaVoice>(v: T): Voiced<T> => ({ ...v, tone: v.tone ?? 'casual', emoji: v.emoji ?? 'medium', length: v.length ?? 'medium' });
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;

/**
 * The style with defaults (亲切日常, 适中, 中). Reads the flat pre-split shape too: a missing `post` takes the flat
 * tone/note/emoji/length + hashtags/audience/opening/closing/notes, a missing `comment` the flat tone/note/emoji/length,
 * so a persona saved before the split shows its one style as both until it is saved again.
 */
export function styleOf(p: { style: StoredPersonaStyle | null | undefined }): FullStyle {
  const s = p.style ?? {};
  const flatVoice: PersonaVoice = { tone: s.tone, toneNote: s.toneNote, emoji: s.emoji, length: s.length };
  const post: PersonaPostStyle = defined(s.post ?? { ...flatVoice, hashtags: s.hashtags, audience: s.audience, opening: s.opening, closing: s.closing, notes: s.notes });
  const c = s.comment ?? flatVoice;
  return {
    topics: s.topics ?? [], bannedWords: s.bannedWords ?? [],
    post: { ...voiced(post), hashtags: post.hashtags ?? [] },
    comment: voiced(defined({ tone: c.tone, toneNote: c.toneNote, emoji: c.emoji, length: c.length })),
  };
}


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

/** 范例 per persona and kind (form + template API: `persona.examples_full`). */
export const MAX_EXAMPLES = 20;
/** Post 范例 sent with the AI drafts prompt (the oldest ones). */
export const PROMPT_EXAMPLES = 5;

/** A banned word inside the fixed opening/closing of the 发文风格 → 400 `persona.banned_in_style`. */
export const assertStyleOk = (s: PersonaStyle) => {
  if (bannedHits(s.bannedWords, [s.post?.opening, s.post?.closing]).length) {
    throw badRequest('固定开头/结尾包含禁用词', 'persona.banned_in_style');
  }
};
