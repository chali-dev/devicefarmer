import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import {
  PERSONA_LEVELS, PERSONA_TONES, type Persona, type PersonaLevel, type PersonaStyle, type PersonaTone,
} from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';

/**
 * 人设风格: ONE style for posts and comments (owner 2026-11-19, merged back from 发文风格 / 评论风格): tone preset +
 * editable note, emoji amount, length (one level → the post range and the comment range of `PERSONA_LENGTHS`), hashtags
 * (posts), audience, notes, topics, banned words (checked on posts AND comments); no fixed opening/closing. The AI drafts prompt uses all of it with the post range; the comment composers show tone/emoji/banned words with the comment
 * range. Banned words: `assertNoBannedWords`, code `persona.banned_word`.
 */

/** Characters per length level: posts (body) and comments (shorter). The UI shows these; comments only get a soft hint. */
export const PERSONA_LENGTHS: Record<'post' | 'comment', Record<PersonaLevel, [number, number]>> = {
  post: { low: [40, 150], medium: [150, 500], high: [500, 1500] },
  comment: { low: [4, 30], medium: [15, 80], high: [60, 200] },
};

/**
 * Prompt texts (Chinese since 2026-11-19, owner 「中文为主」): the preset's name and its default note when the persona's
 * own note is empty (the same note the form pre-fills).
 */
export const TONE_LABEL: Record<PersonaTone, string> = { casual: '亲切日常', pro: '专业干货', funny: '幽默俏皮', cool: '高冷简洁', warm: '温暖治愈' };
export const TONE_PROMPT: Record<PersonaTone, string> = {
  casual: '像朋友聊天一样自然、口语化',
  pro: '给出具体方法和理由，条理清楚',
  funny: '轻松有梗，适度自嘲，不冒犯人',
  cool: '话少而精，不堆形容词',
  warm: '温柔体贴，多鼓励和共情',
};
export const EMOJI_PROMPT: Record<PersonaLevel, string> = {
  low: '最多 1 个，通常不用',
  medium: '在合适的地方用 2 到 4 个',
  high: '自然地多用（5 个或以上）',
};

const Words = (max: number, len: number) => z.array(z.string().trim().min(1).max(len)).max(max);
/**
 * The whole style (PATCH replaces it). Strict: unknown fields (e.g. a `post` / `comment` part or
 * `opening` / `closing`) are refused.
 */
export const PersonaStyleInput = z.object({
  topics: Words(20, 60).optional(),
  bannedWords: Words(50, 50).optional(),
  tone: z.enum(PERSONA_TONES).optional(),
  toneNote: z.string().trim().max(200).optional(),
  emoji: z.enum(PERSONA_LEVELS).optional(),
  length: z.enum(PERSONA_LEVELS).optional(),
  hashtags: Words(15, 50).optional(),
  audience: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

/** Case-insensitive de-duplication (first spelling wins). */
const uniq = (xs: string[] | undefined, map = (x: string) => x) => {
  const seen = new Set<string>();
  return (xs ?? []).map(map).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;

/** Stored form of a style input: lists de-duplicated, hashtags without '#', empty texts dropped. */
export function normaliseStyle(s: z.infer<typeof PersonaStyleInput>): PersonaStyle {
  return defined({
    ...s, topics: uniq(s.topics), bannedWords: uniq(s.bannedWords),
    hashtags: uniq(s.hashtags, (h) => h.replace(/^#+/, '').replace(/\s+/g, '')),
  });
}

/** A style as read (defaults filled). */
export type FullStyle = PersonaStyle & Required<Pick<PersonaStyle, 'topics' | 'bannedWords' | 'hashtags' | 'tone' | 'emoji' | 'length'>>;

/** The style with defaults (亲切日常, 适中, 中). */
export function styleOf(p: { style: PersonaStyle | null | undefined }): FullStyle {
  const s = defined(p.style ?? {});
  return { ...s, topics: s.topics ?? [], bannedWords: s.bannedWords ?? [], hashtags: s.hashtags ?? [], tone: s.tone ?? 'casual', emoji: s.emoji ?? 'medium', length: s.length ?? 'medium' };
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
export function exampleWhere(p: Pick<Persona, 'id' | 'ownerType' | 'ownerId'>) {
  const T = schema.commentTemplates;
  return and(eq(T.personaId, p.id), p.ownerType === 'public' ? isNull(T.userId) : eq(T.userId, p.ownerId!));
}

/** 范例 per persona (one list for posts and comments since 2026-11-19; form + template API: `persona.examples_full`). */
export const MAX_EXAMPLES = 20;
/** 范例 sent with the AI drafts prompt (the oldest ones). */
export const PROMPT_EXAMPLES = 5;
