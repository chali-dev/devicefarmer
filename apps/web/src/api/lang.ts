import { dateLocale } from '../i18n'

/** Display name of a BCP-47 language code in the UI language (e.g. "hi" → "印地语" / "Hindi"); falls back to the code. */
export function langName(code: string): string {
  try { return new Intl.DisplayNames([dateLocale()], { type: 'language' }).of(code) ?? code } catch { return code }
}

/** Display name of an ISO 3166 country/region code in the UI language (e.g. "IN" → "印度" / "India"); falls back to the code. */
export function countryName(code: string): string {
  try { return new Intl.DisplayNames([dateLocale()], { type: 'region' }).of(code.toUpperCase()) ?? code } catch { return code }
}

/** Canonical BCP-47 form (zh-cn → zh-CN), or null when invalid. */
export function canonicalLang(code: string): string | null {
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code.trim())) return null
  try { return Intl.getCanonicalLocales(code.trim())[0] ?? null } catch { return null }
}

/** Common languages/locales for social media, offered in Settings → 多语言 (any other valid code can be typed). */
export const COMMON_LANGS = [
  'zh-CN', 'zh-TW', 'zh-HK', 'en', 'en-US', 'en-GB', 'en-IN', 'es', 'es-MX', 'pt-BR', 'pt-PT', 'fr', 'de', 'it', 'nl', 'pl',
  'ru', 'uk', 'tr', 'ar', 'fa', 'he', 'hi', 'bn', 'ur', 'ta', 'te', 'mr', 'pa', 'ja', 'ko', 'id', 'ms', 'th', 'vi', 'fil',
  'km', 'my', 'sw', 'el', 'cs', 'ro', 'hu', 'sv',
]
