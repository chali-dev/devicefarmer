import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { ContentTranslation } from '../../db/schema.js';

/**
 * 多语言内容: the language list offered in the content editor and the default source language
 * (settings key `content.languages`, admin), plus helpers for content_translations.
 * Translations are written by people; a translation provider could later fill the editor's
 * per-language fields without changing this model.
 */
const KEY = 'content.languages';

/** BCP-47 tag, canonicalised (zh-cn → zh-CN, EN → en). */
export const Lang = z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'invalid language code')
  .transform((v, ctx) => {
    try { return Intl.getCanonicalLocales(v)[0]!; } catch { ctx.addIssue({ code: 'custom', message: 'invalid language code' }); return z.NEVER; }
  });

export interface LanguageSettings { languages: string[]; defaultSource: string | null }
export const DEFAULT_LANGUAGES: LanguageSettings = { languages: ['zh-CN', 'en'], defaultSource: 'zh-CN' };
export const LanguageSettingsInput = z.object({
  languages: z.array(Lang).min(1).max(50),
  defaultSource: Lang.nullable(),
});

export async function getLanguageSettings(): Promise<LanguageSettings & { updatedAt: Date | null }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, KEY));
  return { ...DEFAULT_LANGUAGES, ...(row?.value as LanguageSettings | undefined), updatedAt: row?.updatedAt ?? null };
}

export async function saveLanguageSettings(v: LanguageSettings) {
  const value: LanguageSettings = { languages: [...new Set(v.languages)], defaultSource: v.defaultSource };
  if (value.defaultSource && !value.languages.includes(value.defaultSource)) value.languages.unshift(value.defaultSource);
  await db.insert(schema.settings).values({ key: KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  return getLanguageSettings();
}

export const publicTranslation = (r: ContentTranslation) => ({
  lang: r.lang, title: r.title, body: r.body, platformHints: r.platformHints, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export async function translationsOf(contentId: string) {
  const rows = await db.select().from(schema.contentTranslations).where(eq(schema.contentTranslations.contentId, contentId)).orderBy(asc(schema.contentTranslations.lang));
  return rows.map(publicTranslation);
}

/** Languages with a translation, per content (one query; for the list's language chips). */
export async function translationLangs(contentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!contentIds.length) return out;
  const rows = await db.select({ id: schema.contentTranslations.contentId, lang: schema.contentTranslations.lang }).from(schema.contentTranslations)
    .where(inArray(schema.contentTranslations.contentId, contentIds)).orderBy(asc(schema.contentTranslations.lang));
  for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), r.lang]);
  return out;
}
