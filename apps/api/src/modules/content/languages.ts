import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import type { Content, ContentTranslation, SocialAccount } from '../../db/schema.js';

/**
 * 多语言内容 (simplified 2026-11-18, owner: 「社交号要能绑定语言；发文内容使用社交媒体配置语言，编辑器支持中文和配置的语系」):
 * - Chinese (zh-CN) is the fixed source language of the editor (`contents.lang` of new contents).
 * - 配置语系 = the languages bound to social accounts (`social_accounts.lang`), derived, nothing to configure: a
 *   language only matters once an account posts in it, and binding it to an account is what adds it.
 * - Translations (`content_translations`) are written by people; publishing uses the translation in the target
 *   account's language, else the source text (`textsForAccount`).
 */
export const SOURCE_LANG = 'zh-CN';

/** BCP-47 tag, canonicalised (zh-cn → zh-CN, EN → en). */
export const Lang = z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'invalid language code')
  .transform((v, ctx) => {
    try { return Intl.getCanonicalLocales(v)[0]!; } catch { ctx.addIssue({ code: 'custom', message: 'invalid language code' }); return z.NEVER; }
  });

/**
 * 配置语系: distinct languages bound to social accounts (of `ownerId`, or of everyone when null), without the source
 * language, sorted. One indexed query.
 */
export async function configuredLanguages(ownerId: string | null): Promise<string[]> {
  const sa = schema.socialAccounts;
  const rows = await db.selectDistinct({ lang: sa.lang }).from(sa)
    .where(and(isNotNull(sa.lang), ownerId ? eq(sa.userId, ownerId) : undefined)).orderBy(asc(sa.lang));
  return rows.map((r) => r.lang!).filter((l) => l !== SOURCE_LANG);
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

/** Why the source text is used for an account: no language bound, or no translation in its language. */
export type LangFallback = 'account_no_lang' | 'translation_missing' | null;

export interface AccountTexts {
  /** Language of the texts (null = legacy content without a source language, used as is). */
  lang: string | null;
  source: 'source' | 'translation';
  fallback: LangFallback;
  title: string;
  body: string;
  /** Text hints of that language (the options, e.g. YouTube privacy, always come from the content). */
  hints: Record<string, Record<string, unknown> | undefined>;
}

/**
 * The texts an account publishes: the content itself when the account has no language or the content is written in
 * it; else the translation in the account's language; else the source (fallback `translation_missing`).
 */
export function textsForAccount(content: Pick<Content, 'lang' | 'title' | 'body' | 'platformHints'>, translations: Pick<ContentTranslation, 'lang' | 'title' | 'body' | 'platformHints'>[],
  account: Pick<SocialAccount, 'lang'>): AccountTexts {
  const source = (fallback: LangFallback): AccountTexts => ({
    lang: content.lang, source: 'source', fallback, title: content.title, body: content.body,
    hints: (content.platformHints ?? {}) as AccountTexts['hints'],
  });
  if (!account.lang) return source('account_no_lang');
  if (account.lang === content.lang) return source(null);
  const tr = translations.find((x) => x.lang === account.lang);
  if (!tr) return source('translation_missing');
  return { lang: tr.lang, source: 'translation', fallback: null, title: tr.title || content.title, body: tr.body, hints: (tr.platformHints ?? {}) as AccountTexts['hints'] };
}
